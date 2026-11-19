// Bakes daylight into the scene so that it can be walked through in real time.
//
// The method is instant radiosity. Daylight is first turned into a fixed list of small
// lights:
//   - spots spread over every window opening, each standing for a piece of sky;
//   - "bounce lights" wherever light lands in the rooms. They are found by following light
//     in from the windows (along the sun's rays, and in all directions for the sky) and on
//     around the room for a few bounces.
// Then every point where light is stored, each with one slot in a storage buffer, adds up
// what it receives from each of those lights. That runs in a WebGPU compute shader, with a
// ray against a BVH of the whole flat deciding whether a light is visible from there. All
// points use the same lights, so the result is smooth from one to the next.
//
// Light is stored in two ways:
//   - walls, floors and ceilings carry a grid of texels 5 cm apart on each flat face (a
//     light map), read and blended per pixel, so the shadow under a shelf or beside a door
//     frame keeps its shape;
//   - everything else (furniture, trim, fittings) stores light at its vertices.
//
// The work is spread over frames, a block of points and a handful of lights at a time, and
// the meshes read their slots while drawing, so the light simply fills in over the first
// seconds. When the sun or a door moves later, the light already on show stays and fades
// into the new light as that adds up. Direct sunlight is not baked: it comes from an
// ordinary light with a shadow map, which keeps its edges crisp.
//
// Lamps work the same way, each with a light list of its own (a few points on the lamp
// and the bounce lights its light leaves in the rooms). Light adds up, so daylight and
// every lamp are kept as separate layers, and what is drawn is their sum, each times how
// far its lamp is turned up. Switching a lamp is then only a new sum. A lamp's layer is
// worked out the first time the lamp is switched on, and again after a door has moved.
//
// Door leaves are not part of the BVH. Each counts as a thin rectangle, tested by itself,
// so that swinging a door needs nothing rebuilt.
//
// What stands outside (the houses across the street and around the courtyard, see setOutside)
// is not part of that BVH either. It matters in two places only: a ray towards the sun says
// whether the sun reaches a window at all, and for every window a small picture is made of
// what it looks out on, direction by direction: open sky, or a house front with the light
// it throws back. The sky spots in the window read that picture in place of the bare sky.
import * as THREE from 'three/webgpu';
import { Fn, If, attribute, float, instanceIndex, instancedArray, max, mix, storage, uint, uniform, varying, vec2, vec3, vec4 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import { BVHComputeData, rayStruct, wgslTagFn } from 'three-mesh-bvh/webgpu';
import { inRing, rng } from './geometry.js';

const BLOCK = 16384;             // points handled by one run of the compute shader
const LIGHT_SLOTS = 4096;        // room in the light list
const LEAF_SLOTS = 16;           // room for door leaves, kept after the lights in the same buffer
const LAYER_SLOTS = 16;          // and after those, how far each layer is turned up
const WEIGHTS = (LIGHT_SLOTS + LEAF_SLOTS) * 3;
const NONE = 9999;               // no layer is being worked out
const PER_STEP = 8;              // lights added to each point per step
const TEXEL = 0.05;              // m between light map texels
const REACH = 0.75;              // a texel this close (in texels) to a face still belongs to it
const SHIFT = 0.146;             // texels: keeps the grid off round millimetres, where the faces' edges are
const INSET = 0.012 / TEXEL;     // texels: a texel beyond the edge of a face gathers this far inside it
const WINDOW_GRID = [4, 6];      // sky spots across and up each window
const SUN_PATHS = 140;           // light paths followed in along the sun's rays
const SKY_PATHS = 300;           // light paths followed in from the sky
const BOUNCES = 4;
const NEAR = 0.35;               // m²: bounce lights closer than about 0.6 m count as that far away
const FADE = 1;                  // part of a new bake over which the light shown before fades out
const QUICK_FADE = 0.3;          // the same after the sun moved, when the old light is simply wrong
const LAMP_LIGHT = new THREE.Color(1, 0.8, 0.58).multiplyScalar(2);   // what a lamp gives off, in the units of the sun and sky
const LAMP_SPOTS = 8;            // points on a lamp that light the room directly
const LAMP_PATHS = 100;          // light paths followed out from a lamp
const OUTLOOK = [24, 16];        // what each window looks out on, as a small picture: directions across and up
const OUTLOOK_WINDOWS = 12;      // room for that many windows
const OUTLOOK_START = WEIGHTS + LAYER_SLOTS;
const HOUSE_SHADE = 0.3;         // share of the sky's light that reaches a wall in a street or a courtyard

export class LightBaker {
  // `model` supplies the rooms and openings; the windows are where daylight comes in.
  constructor(renderer, model) {
    this.renderer = renderer;
    this.rooms = model.rooms;
    this.top = model.wall_height / 1000;      // m: the top of the walls; nothing above it is indoors
    this.inside = [...model.rooms.map(r => r.polygon), ...model.openings.map(o => o.polygon), model.platform.polygon];
    const corners = model.solids.flatMap(s => s.polygon);      // the flat's outer faces lie on this rectangle
    this.extent = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
    this.light = null;            // sun and sky, set by setLight
    this.lightTotal = 0;
    this.done = 0;                // lights already added to every point
    this.cursor = 0;              // next point of the current step
    this.blocks = 2;              // compute runs per frame; follows the frame time
    this.count = 0;               // points: light map texels first, then vertices
    this.texels = 0;
    this.capacity = 0;
    this.keep = 0;                // points whose stored light is kept when the next bake starts
    this.leaves = [];             // door leaves as they stand, see setDoors
    // Daylight, then one layer per lamp. `weight` is how far it is turned up, `stale` that it
    // needs working out, `baked` that it has been before, `brightness` what it gives each room.
    const layer = (id, weight, lamp) => ({ id, weight, lamp, stale: true, baked: false, fade: FADE, brightness: {} });
    this.layers = [layer('day', 1), ...(model.lamps ?? []).slice(0, LAYER_SLOTS - 1).map(l => layer(l.id, 0, {
      kind: l.kind, at: new THREE.Vector3(l.at[0] / 1000, l.at[2] / 1000, -l.at[1] / 1000),
      radius: (l.radius ?? 130) / 1000, light: LAMP_LIGHT.clone().multiplyScalar(l.power ?? 1),
    }))];
    this.baking = -1;             // the layer being worked out
    this.dirty = false;           // the sum on show needs making again
    this.lit = new Set();         // materials that show the baked light
    this.mapped = new Set();      // those of them that read it from a light map

    this.u = {
      offset: uniform(0, 'uint'), count: uniform(0, 'uint'),
      firstLight: uniform(0, 'uint'), lightCount: uniform(0, 'uint'), lightTotal: uniform(0, 'uint'),
      leaves: uniform(0, 'uint'), kept: uniform(0, 'uint'), fade: uniform(1),
      layer: uniform(NONE, 'uint'), outdoors: uniform(1),
      skyZenith: uniform(new THREE.Color()), skyHorizon: uniform(new THREE.Color()), ground: uniform(new THREE.Color()),
      // a trace of light everywhere, so that rooms far from any window do not go completely black
      fill: uniform(new THREE.Color(0, 0, 0)),
    };
    // The light list, three entries per light (a compute shader may only use a few buffers):
    //   place  - xyz, w = 1 for a sky spot in a window, 2 for a bounce light,
    //            3 for a point of a lamp that shines all round, 4 for one that shines the way it faces
    //   facing - xyz = the way it faces, w = area of window a sky spot stands for
    //   colour - light sent out by a bounce light or a lamp
    // The door leaves follow, also three entries each:
    //   hinge  - xyz at the floor, w = the leaf's length
    //   along  - xy = the way the leaf runs from its hinge (in x and z), z = its height, w = 1 if glazed
    //   pane   - the glazed part, which lets light through: from, to along the leaf, then from, to in height
    // then one entry per layer, x = how far it is turned up,
    // and last the picture of what each window looks out on, row by row from below.
    this.lights = instancedArray(OUTLOOK_START + OUTLOOK_WINDOWS * OUTLOOK[0] * OUTLOOK[1], 'vec4');
    this.outside = null;          // what stands around the house, see setOutside
    this.awaitingOutside = true;  // until setOutside is first called

    // Window openings as rectangles on the outside face of the wall.
    const ys = model.rooms.flatMap(r => r.polygon.map(p => p[1])), centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.windows = model.openings.filter(o => o.type === 'window').slice(0, OUTLOOK_WINDOWS).map((o, index) => {
      const [x0, y0, x1, y1] = o.rect;
      const outer = Math.abs(y0 - centreY) > Math.abs(y1 - centreY) ? y0 : y1, inner = outer === y0 ? y1 : y0;
      return {
        index,
        centre: new THREE.Vector3((x0 + x1) / 2000, (o.sill + o.height / 2) / 1000, -outer / 1000),
        u: new THREE.Vector3((x1 - x0) / 2000, 0, 0), v: new THREE.Vector3(0, o.height / 2000, 0),
        inward: new THREE.Vector3(0, 0, -Math.sign(inner - outer)), area: (x1 - x0) * o.height / 1e6,
      };
    });
  }

  // Storage for the points: where each gathers light, which way it faces, and its running sum.
  allocate(capacity) {
    this.capacity = capacity;
    // two entries per point: where it gathers light (xyz, w = 1 indoors, 2 outdoors, 0 unused) and the way it faces
    this.places = instancedArray(capacity * 2, 'vec4');
    // Two entries per point as well:
    //   shown   - rgb = its light as drawn (all layers together), a = whether it has any
    //   running - rgb = light added so far in the bake in progress, a = number of lights added
    this.sums = instancedArray(capacity * 2, 'vec4');
    // What each layer came to at each point: rgb and whether there is a result, as four
    // half floats in two numbers. Only the compute passes below read these.
    const L = this.layers.length;
    this.results = instancedArray(capacity * L * 2, 'uint');
    this.keep = 0;
    for (const layer of this.layers) layer.baked = false;
    const sums = storage(this.sums.value, 'vec4', capacity * 2).toReadOnly();
    const lightAt = index => {                                // a point's light, and whether it has any yet
      const slot = sums.element(index.mul(2));
      return slot.w.greaterThan(0).select(vec4(slot.xyz, 1), vec4(0));
    };
    // What a material lit at its vertices adds: their light, blended over the vertices that have any.
    const atVertex = varying(lightAt(attribute('bakeIndex', 'float').toUint()), 'vBakedLight');
    this.bakedNode = atVertex.xyz.div(max(atVertex.w, 0.001)).add(this.u.fill);
    // What a light-mapped material adds: the four texels around the pixel, blended by
    // distance, again leaving out those that have no light.
    this.mapNode = Fn(() => {
      const chart = varying(attribute('lightChart', 'vec3'), 'vLightChart')
        .setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.FIRST).add(0.5).floor();
      const size = chart.yz, at = attribute('lightUv', 'vec2').sub(0.5);
      const corner = at.floor().clamp(vec2(0), size.sub(2)).toVar();
      const part = at.sub(corner).clamp(0, 1).toVar();
      const first = chart.x.toUint().add(corner.y.toUint().mul(size.x.toUint())).add(corner.x.toUint()).toVar();
      const width = size.x.toUint();
      const blended = mix(
        mix(lightAt(first), lightAt(first.add(1)), part.x),
        mix(lightAt(first.add(width)), lightAt(first.add(width).add(1)), part.x), part.y).toVar();
      return blended.xyz.div(max(blended.w, 0.001)).add(this.u.fill);
    })();
    for (const material of this.lit) material.needsUpdate = true;

    const { u, places, lights, results } = this, all = this.sums;
    // Run at the start of a bake: the running sums go back to nothing, and so do the stored
    // results of points that are not kept or no longer gather light.
    this.clear = Fn(() => {
      const keep = instanceIndex.lessThan(u.kept).and(places.element(instanceIndex.mul(2)).w.greaterThan(0.5));
      all.element(instanceIndex.mul(2).add(1)).assign(vec4(0));
      If(keep.not(), () => {
        for (let n = 0; n < L * 2; n++) results.element(instanceIndex.mul(L * 2).add(n)).assign(uint(0));
      });
    })().compute(capacity);

    const stored = wgslTagFn/* wgsl */`
      fn bakeStored( slot: u32 ) -> vec4f {
        return vec4f( unpack2x16float( ${ results }[ slot * 2u ] ), unpack2x16float( ${ results }[ slot * 2u + 1u ] ) );
      }
    `;
    // What a layer gives a point. For the layer being worked out that is its stored result
    // fading into the new estimate while the first lights are added. A point of the daylight
    // layer with nothing stored shows the estimate at once; a lamp's light simply adds up.
    const layerLight = wgslTagFn/* wgsl */`
      fn bakeLayer( i: u32, l: u32 ) -> vec4f {
        var value = ${ stored }( i * ${ L }u + l );
        if ( l == ${ u.layer } ) {
          let run = ${ all }[ i * 2u + 1u ];
          if ( run.w > 0.0 ) {
            var share = min( run.w / ${ u.fade }, 1.0 );
            if ( l == 0u && value.w < 0.5 ) { share = 1.0; }
            value = vec4f( mix( value.xyz, run.xyz / run.w, share ), 1.0 );
          }
        }
        return value;
      }
    `;
    const summed = wgslTagFn/* wgsl */`
      fn bakeSummed( i: u32 ) -> vec4f {
        if ( ${ places }[ i * 2u ].w < 0.5 ) { return vec4f( 0.0 ); }
        var sum = vec3f( 0.0 );
        var lit = 0.0;
        for ( var l = 0u; l < ${ L }u; l = l + 1u ) {
          let value = ${ layerLight }( i, l );
          if ( l == 0u ) { lit = value.w; }
          sum += value.xyz * ${ lights }[ ${ WEIGHTS }u + l ].x;
        }
        return vec4f( sum, lit );
      }
    `;
    const packed = wgslTagFn/* wgsl */`
      fn bakePacked( i: u32, half: u32 ) -> u32 {
        let value = min( ${ layerLight }( i, ${ u.layer } ), vec4f( 60000.0 ) );
        if ( half == 0u ) { return pack2x16float( value.xy ); }
        return pack2x16float( value.zw );
      }
    `;
    // Makes the sum that is drawn.
    this.compose = Fn(() => {
      all.element(instanceIndex.mul(2)).assign(summed(instanceIndex));
    })().compute(capacity);
    // Stores what the layer being worked out has on show as its result, finished or not.
    this.commit = Fn(() => {
      const slot = instanceIndex.mul(L).add(u.layer).mul(2);
      const first = packed(instanceIndex, uint(0)).toVar(), second = packed(instanceIndex, uint(1)).toVar();
      results.element(slot).assign(first);
      results.element(slot.add(1)).assign(second);
      all.element(instanceIndex.mul(2).add(1)).assign(vec4(0));
    })().compute(capacity);
  }

  // The compute shader: for a block of points, add the light of the current few lights.
  makeKernel() {
    const { u, places, sums, lights } = this;
    // What a window looks out on in direction d (pointing out of the room), from its picture.
    const [across, up] = OUTLOOK;
    const outlook = wgslTagFn/* wgsl */`
      fn bakeOutlook( window: u32, inward: vec3f, d: vec3f ) -> vec3f {
        let x = clamp( ( atan2( dot( d, vec3f( inward.z, 0.0, - inward.x ) ), - dot( d, inward ) ) / 3.14159265 + 0.5 ) * ${ across }.0 - 0.5, 0.0, ${ across - 1 }.0 );
        let y = clamp( ( asin( clamp( d.y, -1.0, 1.0 ) ) / 3.14159265 + 0.5 ) * ${ up }.0 - 0.5, 0.0, ${ up - 1 }.0 );
        let x0 = u32( x );
        let y0 = u32( y );
        let x1 = min( x0 + 1u, ${ across - 1 }u );
        let y1 = min( y0 + 1u, ${ up - 1 }u );
        let first = ${ OUTLOOK_START }u + window * ${ across * up }u;
        let below = mix( ${ lights }[ first + y0 * ${ across }u + x0 ], ${ lights }[ first + y0 * ${ across }u + x1 ], fract( x ) );
        let above = mix( ${ lights }[ first + y1 * ${ across }u + x0 ], ${ lights }[ first + y1 * ${ across }u + x1 ], fract( x ) );
        return mix( below, above, fract( y ) ).xyz;
      }
    `;
    // Whether a door leaf stands between p and a point `reach` away towards d.
    const leaves = wgslTagFn/* wgsl */`
      fn bakeLeaves( p: vec3f, d: vec3f, reach: f32 ) -> bool {
        for ( var j = 0u; j < ${ u.leaves }; j = j + 1u ) {
          let hinge = ${ lights }[ ${ LIGHT_SLOTS * 3 }u + j * 3u ];
          let along = ${ lights }[ ${ LIGHT_SLOTS * 3 + 1 }u + j * 3u ];
          let across = vec2f( - along.y, along.x );
          let closing = dot( d.xz, across );
          if ( abs( closing ) < 0.00001 ) { continue; }
          let t = dot( hinge.xz - p.xz, across ) / closing;
          if ( t <= 0.0 || t >= reach ) { continue; }
          let at = p + d * t;
          let s = dot( at.xz - hinge.xz, along.xy );
          if ( s < 0.0 || s > hinge.w || at.y < hinge.y || at.y > hinge.y + along.z ) { continue; }
          let pane = ${ lights }[ ${ LIGHT_SLOTS * 3 + 2 }u + j * 3u ];
          if ( along.w > 0.5 && s > pane.x && s < pane.y && at.y > hinge.y + pane.z && at.y < hinge.y + pane.w ) { continue; }
          return true;
        }
        return false;
      }
    `;
    const gather = wgslTagFn/* wgsl */`
      fn bakeGather( p: vec3f, n: vec3f, first: u32, count: u32 ) -> vec3f {
        var sum = vec3f( 0.0 );
        for ( var k = 0u; k < count; k = k + 1u ) {
          let place = ${ lights }[ ( first + k ) * 3u ];
          let facing = ${ lights }[ ( first + k ) * 3u + 1u ];
          var d = place.xyz - p;
          let dist2 = dot( d, d );
          let away = sqrt( dist2 );
          d = d / away;
          let atSurface = dot( n, d );
          let atLight = - dot( facing.xyz, d );
          if ( atSurface <= 0.0 || dist2 > 72.0 ) { continue; }                       // facing away, or too far to matter
          if ( atLight <= 0.0 && ( place.w < 2.5 || place.w > 3.5 ) ) { continue; }   // the light faces away
          var ray: ${ rayStruct };
          ray.origin = p;
          ray.direction = d;
          ray.maxDist = away - 0.02;
          if ( ${ leaves }( p, d, ray.maxDist ) || ${ this.gpuBvh.fns.raycastAnyHit }( ray ) ) { continue; }
          if ( place.w < 1.5 ) {
            sum += ${ outlook }( u32( ${ lights }[ ( first + k ) * 3u + 2u ].x ), facing.xyz, d ) * ( atSurface * atLight * facing.w / max( dist2, 0.04 ) );
          } else if ( place.w < 2.5 ) {
            sum += ${ lights }[ ( first + k ) * 3u + 2u ].xyz * ( atSurface * atLight * 0.31830989 / max( dist2, ${ NEAR } ) );
          } else if ( place.w < 3.5 ) {
            sum += ${ lights }[ ( first + k ) * 3u + 2u ].xyz * ( atSurface * 0.07957747 / max( dist2, 0.01 ) );
          } else {
            sum += ${ lights }[ ( first + k ) * 3u + 2u ].xyz * ( atSurface * atLight * 0.31830989 / max( dist2, 0.01 ) );
          }
        }
        return sum;
      }
    `;
    this.kernel = Fn(() => {
      const i = instanceIndex.add(u.offset);
      If(i.lessThan(u.count), () => {
        const point = places.element(i.mul(2)), normal = places.element(i.mul(2).add(1)), added = float(u.lightCount);
        If(point.w.greaterThan(0.5), () => {
          const arrived = vec3(0).toVar();
          If(point.w.greaterThan(1.5), () => {          // outside: open sky, roughly (and no lamp light)
            arrived.assign(mix(u.ground, u.skyHorizon, normal.y.mul(0.5).add(0.5)).mul(0.6).mul(added).mul(u.outdoors));
          }).Else(() => {
            // Each light counts as if it were the only one, times their number; the average over
            // all of them is then exactly their sum, and a fair estimate of it at any moment before.
            arrived.assign(gather(point.xyz, normal.xyz, u.firstLight, u.lightCount).mul(float(u.lightTotal)));
          });
          sums.element(i.mul(2).add(1)).addAssign(vec4(arrived, added));
        });
      });
    })().compute(BLOCK);
  }

  // `lit` meshes receive baked light, `blockers` are everything that stops light.
  // Returns how many points were set up.
  setScene(lit, blockers) {
    this.halt();
    // -- what blocks and bounces light
    const parts = blockers.map(mesh => {
      mesh.updateWorldMatrix(true, false);
      const source = mesh.userData.coarse ?? mesh.geometry;
      const g = (source.index ? source.toNonIndexed() : source.clone()).applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
      const colour = mesh.material.userData.albedo ?? mesh.material.color, n = g.attributes.position.count;
      const colours = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) colours.set([colour.r, colour.g, colour.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      return g;
    });
    this.blockers = mergeGeometries(parts, false);
    // Used here for half a million short rays (see place) and packed for the graphics card.
    // Built the slower, careful way (SAH, small leaves): the walls are huge triangles whose
    // boxes overlap, and this tree answers those rays about twice as fast.
    this.bvh = new MeshBVH(this.blockers, { strategy: SAH, targetLeafSize: 4 });
    this.blockers.boundsTree = this.bvh;
    this.gpuBvh = new BVHComputeData(new THREE.Mesh(this.blockers));
    this.gpuBvh.update();

    // -- where light is gathered. Light map texels come first: their number only depends
    // on the walls, floors and ceilings, so their slots stay where they are when furniture
    // comes and goes.
    const mapped = lit.filter(mesh => this.mapped.has(mesh.material)), plain = lit.filter(mesh => !this.mapped.has(mesh.material));
    let texels = 0;
    for (const mesh of mapped) {
      const map = mesh.userData.lightMap ??= chartMesh(mesh, this.top);
      if (map.first !== texels) {
        map.first = texels;
        const chart = mesh.geometry.attributes.lightChart;
        for (let i = 0; i < chart.count; i++) chart.setX(i, texels + map.offsets[i]);
        chart.needsUpdate = true;
      }
      texels += map.count;
    }
    this.texels = texels;

    // One point per distinct vertex of the other meshes.
    const points = [], normals = [], pull = [], index = new Map();
    for (const mesh of plain) {
      const slots = new Float32Array(mesh.geometry.attributes.position.count);
      const body = mesh.userData.moving ?? 0;       // a door leaf shares no points with what stands still
      corners(mesh, (i, p, n, cx, cy, cz) => {
        // Vertices within about 3 cm that face the same way share a point; that mostly merges the
        // corners of small objects, which do not need lighting finer than that.
        const key = `${body},${Math.round(p.x * 33)},${Math.round(p.y * 33)},${Math.round(p.z * 33)},${Math.round(n.x * 4)},${Math.round(n.y * 4)},${Math.round(n.z * 4)}`;
        let slot = index.get(key);
        if (slot === undefined) {
          slot = points.length / 3;
          index.set(key, slot);
          points.push(p.x, p.y, p.z); normals.push(n.x, n.y, n.z); pull.push(0, 0, 0);
        }
        pull[slot * 3] += cx - p.x; pull[slot * 3 + 1] += cy - p.y; pull[slot * 3 + 2] += cz - p.z;   // towards the surface's inside
        slots[i] = texels + slot;
      });
      mesh.geometry.setAttribute('bakeIndex', new THREE.BufferAttribute(slots, 1));
    }

    const vertices = points.length / 3, count = texels + vertices;
    // Texels keep their slots, so their light can stay on show; vertices are numbered afresh.
    if (count > this.capacity) this.allocate(Math.ceil(count * 1.15));
    else this.keep = Math.min(this.keep, texels);
    const placeData = this.places.value.array;
    placeData.fill(0);

    for (const mesh of mapped) {
      const map = mesh.userData.lightMap;
      for (const chart of map.charts) {
        const [nx, ny, nz] = chart.normal, size = chart.width * chart.height, from = map.first + chart.offset;
        const state = new Uint8Array(size);              // 0 not on a face, 1 gathers light, 2 buried
        for (let k = 0; k < size; k++) {
          if (!chart.on[k]) continue;
          state[k] = this.place(from + k, chart.at[k * 3], chart.at[k * 3 + 1], chart.at[k * 3 + 2], nx, ny, nz) ? 1 : 2;
        }
        // Buried texels next to uncovered ones gather where those do, so that the face is
        // lit right up to the edge of what covers it.
        for (let ring = 0; ring < 2; ring++) {
          const filled = [];
          for (let k = 0; k < size; k++) {
            if (state[k] !== 2) continue;
            const x = k % chart.width, y = (k - x) / chart.width;
            for (const [dx, dy] of AROUND) {
              const ox = x + dx, oy = y + dy, o = oy * chart.width + ox;
              if (ox < 0 || oy < 0 || ox >= chart.width || oy >= chart.height || state[o] !== 1) continue;
              filled.push(k, o);
              break;
            }
          }
          for (let f = 0; f < filled.length; f += 2) {
            placeData.copyWithin((from + filled[f]) * 8, (from + filled[f + 1]) * 8, (from + filled[f + 1]) * 8 + 8);
            state[filled[f]] = 1;
          }
        }
      }
    }
    for (let i = 0; i < vertices; i++) {
      this.placeVertex(texels + i, points[i * 3], points[i * 3 + 1], points[i * 3 + 2], normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2],
        pull[i * 3], pull[i * 3 + 1], pull[i * 3 + 2]);
    }
    this.places.value.needsUpdate = true;
    this.count = this.u.count.value = count;
    this.makeKernel();
    this.invalidate();
    return count;
  }

  // A vertex gathers a little inside its surface (the pull is towards the middle of its
  // triangles), never exactly on an edge or in a corner.
  placeVertex(slot, x, y, z, nx, ny, nz, px, py, pz) {
    const len = Math.hypot(px, py, pz), inwards = len > 1e-4 ? 0.012 / len : 0;
    return this.place(slot, x + px * inwards, y + py * inwards, z + pz * inwards, nx, ny, nz);
  }

  // The door leaves as they now stand: for each its hinge at the floor (scene metres), the
  // angle it is turned to about the vertical, its length and height, its colour, and the
  // glazed part if it has one ([from, to] along the leaf, then [from, to] in height).
  // `moved` are the meshes of the leaves that changed, already in their new position.
  setDoors(leaves, moved = []) {
    this.leaves = leaves.slice(0, LEAF_SLOTS);
    if (!this.count) return;
    this.halt();
    const again = new Map();                            // their points keep their slots
    for (const mesh of moved) {
      const slots = mesh.geometry.attributes.bakeIndex;
      if (!slots) continue;
      corners(mesh, (i, p, n, cx, cy, cz) => {
        const slot = slots.getX(i);
        let s = again.get(slot);
        if (!s) again.set(slot, s = [p.x, p.y, p.z, n.x, n.y, n.z, 0, 0, 0]);
        s[6] += cx - p.x; s[7] += cy - p.y; s[8] += cz - p.z;
      });
    }
    for (const [slot, s] of again) this.placeVertex(slot, ...s);
    if (again.size) this.places.value.needsUpdate = true;
    this.invalidate();
  }

  // How far a lamp is turned up, from 0 (off) to 1.
  setLamp(id, weight) {
    const index = this.layers.findIndex(layer => layer.id === id), layer = this.layers[index];
    if (!layer || !layer.lamp || layer.weight === weight) return;
    layer.weight = weight;
    this.dirty = true;
    if (weight === 0 && this.baking === index) this.halt();      // it stays to be worked out when next switched on
  }

  // How bright the layers together make a room, for setting the camera's exposure: the
  // light their bounce lights send out there, per square metre of floor.
  brightness(roomId) {
    let sum = 0;
    for (const layer of this.layers) sum += layer.weight * (layer.brightness[roomId] ?? 0);
    return sum;
  }

  // Works out where the point of a surface at (bx, by, bz), facing (nx, ny, nz), gathers its
  // light, and writes that to its slot. Answers false for a point that gathers none.
  place(slot, bx, by, bz, nx, ny, nz) {
    const probe = this.probe ??= new THREE.Ray();
    // Where something thin lies on the surface (door trim, a skirting board, a rug), step
    // out through it, so that the covered point takes the light of what covers it.
    probe.direction.set(nx, ny, nz);
    // A point still covered after stepping through four surfaces within 4 cm is buried,
    // as is one that ends up inside a wall: it gathers nothing and is left out when its
    // neighbours' light is blended across the surface.
    let lift = 0, buried = true;
    for (let tries = 0; tries < 4; tries++) {
      probe.origin.set(bx, by, bz).addScaledVector(probe.direction, lift + 0.0005);
      const hit = this.bvh.raycastFirst(probe, THREE.DoubleSide, 0, 0.04 - lift);
      if (!hit) { buried = false; break; }
      lift += hit.distance + 0.0005;
    }
    const off = lift + 0.005;
    const x = bx + nx * off, z = bz + nz * off;
    let y = by + ny * off;
    // Walls run a few centimetres past the ceilings and down to the floor line; keep the
    // gathering point inside the room it faces.
    const px = (x + nx * 0.03) * 1000, py = -(z + nz * 0.03) * 1000;
    let room = null, indoors = false;
    for (const r of this.rooms) if (inRing(r.polygon, px, py)) { room = r; break; }
    if (room && y > -0.05 && y < room.ceiling_height / 1000 + 0.15) y = Math.min(Math.max(y, 0.012), room.ceiling_height / 1000 - 0.02);
    if (y < this.top - 0.005) for (const polygon of this.inside) if (inRing(polygon, px, py)) { indoors = true; break; }
    // Within the flat but in no room or opening means inside a wall, where there is no light to gather.
    const [west, south, east, north] = this.extent;
    if (!indoors && px > west && px < east && py > south && py < north) buried = true;
    const data = this.places.value.array, o = slot * 8;
    data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = buried ? 0 : indoors ? 1 : 2;
    data[o + 4] = nx; data[o + 5] = ny; data[o + 6] = nz;
    return !buried;
  }

  // What stands around the house, as a geometry in scene coordinates with a colour at each
  // corner. It hides the sun and the sky from the windows and throws some light back.
  // Daylight is not worked out before this has been called once (with null when there is
  // nothing outside), so that it is not worked out twice at the start.
  setOutside(geometry) {
    this.outside = geometry ? { bvh: new MeshBVH(geometry), colours: geometry.attributes.color } : null;
    const first = this.awaitingOutside;
    this.awaitingOutside = false;
    if (this.light && !first) this.invalidate([this.layers[0]], QUICK_FADE);
  }

  // Whether something outside stands between a point and whatever lies in a direction.
  hidden(from, direction) {
    return Boolean(this.outside?.bvh.raycastFirst(new THREE.Ray(from, direction), THREE.DoubleSide));
  }

  // Sun and sky: { sunDirection, sunLight, skyZenith, skyHorizon, ground }.
  setLight(light) {
    this.light = light;
    this.u.skyZenith.value.copy(light.skyZenith);
    this.u.skyHorizon.value.copy(light.skyHorizon);
    this.u.ground.value.copy(light.ground);
    this.u.fill.value.copy(light.skyHorizon).multiplyScalar(0.012);
    this.invalidate([this.layers[0]], QUICK_FADE);
  }

  // Turns the daylight, or the light of one lamp, into the list of small lights described
  // at the top of this file.
  makeLights(layer) {
    const { sunDirection, sunLight, skyZenith, skyHorizon, ground } = this.light;
    const random = rng(2026), lights = [];
    const brightness = layer.brightness = {};
    const sky = d => {
      const up = skyHorizon.clone().lerp(skyZenith, Math.pow(Math.max(d.y, 0), 0.55));
      return ground.clone().lerp(up, THREE.MathUtils.smoothstep(d.y, -0.02, 0.06));
    };
    const spot = (w, a, b) => w.centre.clone().addScaledVector(w.u, 2 * a - 1).addScaledVector(w.v, 2 * b - 1);
    const scatter = n => {           // cosine-weighted direction around n
      const a = 2 * Math.PI * random(), r = Math.sqrt(random());
      const t = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      const b = new THREE.Vector3().crossVectors(n, t);
      return t.multiplyScalar(r * Math.cos(a)).addScaledVector(b, r * Math.sin(a)).addScaledVector(n, Math.sqrt(Math.max(0, 1 - r * r))).normalize();
    };
    const colours = this.blockers.attributes.color, ray = new THREE.Ray();
    // What stands outside. `shaded` says whether it hides the sun from a point; `seen` is the
    // light that comes in along d from outside: the sky, or what a house front throws back
    // (its own colour times the sunlight and the sky light that land on it).
    const out = this.outside, probe = new THREE.Ray(), sunShines = sunLight.r + sunLight.g + sunLight.b > 0;
    const shaded = from => {
      if (!out) return false;
      probe.origin.copy(from);
      probe.direction.copy(sunDirection);
      return Boolean(out.bvh.raycastFirst(probe, THREE.DoubleSide));
    };
    const wholeSky = skyHorizon.clone().lerp(skyZenith, 0.5).multiplyScalar(Math.PI);       // on a surface open to all of it
    const seen = (origin, d) => {
      probe.origin.copy(origin);
      probe.direction.copy(d);
      const hit = out?.bvh.raycastFirst(probe, THREE.DoubleSide);
      if (!hit) return sky(d);
      const normal = hit.face.normal;
      if (normal.dot(d) > 0) normal.negate();
      const light = wholeSky.clone().multiplyScalar(HOUSE_SHADE + 0.5 * Math.max(normal.y, 0));
      if (sunShines) {
        const towardsSun = normal.dot(sunDirection);
        light.add(sunLight.clone().multiplyScalar(0.06 * Math.max(sunDirection.y, 0)));      // bounced around the street
        if (towardsSun > 0 && !shaded(hit.point.addScaledVector(normal, 0.05))) light.add(sunLight.clone().multiplyScalar(towardsSun));
      }
      const colour = new THREE.Color().fromBufferAttribute(out.colours, hit.face.a);
      const clamp = v => Math.min(0.8, Math.max(0.03, v));
      return light.multiply(colour.setRGB(clamp(colour.r), clamp(colour.g), clamp(colour.b))).multiplyScalar(1 / Math.PI);
    };
    const leaves = this.leaves.map(l => ({ ...l, ax: Math.cos(l.angle), az: -Math.sin(l.angle) }));   // the way each runs from its hinge
    // The first thing light meets: a surface in the BVH, or a door leaf in front of it.
    const meet = (origin, direction) => {
      ray.origin.copy(origin);
      ray.direction.copy(direction);
      const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
      let found = hit && { distance: hit.distance, normal: hit.face.normal.clone(), colour: new THREE.Color().fromBufferAttribute(colours, hit.face.a) };
      for (const l of leaves) {
        const closing = direction.x * -l.az + direction.z * l.ax;
        if (Math.abs(closing) < 1e-5) continue;
        const t = ((l.hinge.x - origin.x) * -l.az + (l.hinge.z - origin.z) * l.ax) / closing;
        if (t <= 0 || (found && t >= found.distance)) continue;
        const s = (origin.x + direction.x * t - l.hinge.x) * l.ax + (origin.z + direction.z * t - l.hinge.z) * l.az, y = origin.y + direction.y * t - l.hinge.y;
        if (s < 0 || s > l.length || y < 0 || y > l.height) continue;
        if (l.pane && s > l.pane[0] && s < l.pane[1] && y > l.pane[2] && y < l.pane[3]) continue;
        found = { distance: t, normal: new THREE.Vector3(-l.az, 0, l.ax), colour: l.colour };
      }
      return found;
    };
    // Follows light carrying `power` into the room and leaves a bounce light at every surface it meets.
    const follow = (origin, direction, power) => {
      for (let b = 0; b < BOUNCES; b++) {
        const hit = meet(origin, direction);
        if (!hit) return;
        const normal = hit.normal;
        if (normal.dot(direction) > 0) normal.negate();
        power = power.clone().multiply(hit.colour);
        origin = origin.clone().addScaledVector(direction, hit.distance).addScaledVector(normal, 0.003);
        lights.push({ kind: 2, place: origin, facing: normal, colour: power, area: 0 });
        const room = this.rooms.find(r => inRing(r.polygon, origin.x * 1000, -origin.z * 1000));
        if (room) brightness[room.id] = (brightness[room.id] ?? 0) + (0.2126 * power.r + 0.7152 * power.g + 0.0722 * power.b) / room.area_m2;
        direction = scatter(normal);
      }
    };

    const [across, up] = WINDOW_GRID;
    if (layer.lamp) {
      // A few points on the lamp light the room directly; a globe on a cord shines all
      // round, a lamp under a shade or on the ceiling downwards. Then its light is followed
      // out into the room like daylight.
      const { kind, at, radius, light } = layer.lamp, allRound = kind === 'pendant', down = new THREE.Vector3(0, -1, 0);
      const spots = [];
      for (let k = 0; k < LAMP_SPOTS; k++) {
        const turn = k * 2.399963, t = (k + 0.5) / LAMP_SPOTS;
        const place = allRound
          ? at.clone().add(new THREE.Vector3().setFromSphericalCoords(radius * 0.5, Math.acos(1 - 2 * t), turn))
          : new THREE.Vector3(at.x + Math.cos(turn) * radius * 0.7 * Math.sqrt(t), at.y - (kind === 'ceiling' ? 0.075 : 0.012), at.z + Math.sin(turn) * radius * 0.7 * Math.sqrt(t));
        spots.push(place);
        lights.push({ kind: allRound ? 3 : 4, place, facing: down, colour: light.clone().multiplyScalar(1 / LAMP_SPOTS), area: 0 });
      }
      for (let i = 0; i < LAMP_PATHS; i++) {
        const direction = allRound ? new THREE.Vector3().randomDirection() : scatter(down);
        follow(spots[i % LAMP_SPOTS], direction, light.clone().multiplyScalar(1 / LAMP_PATHS));
      }
    } else for (const w of this.windows) {
      for (let i = 0; i < across; i++) for (let j = 0; j < up; j++) {
        lights.push({ kind: 1, place: spot(w, (i + random()) / across, (j + random()) / up), facing: w.inward, colour: null, area: w.area / (across * up), window: w.index });
      }
    }
    const sunny = layer.lamp ? [] : this.windows.filter(w => w.inward.dot(sunDirection) < 0 && sunLight.r + sunLight.g + sunLight.b > 0);
    for (const w of sunny) {
      const paths = Math.ceil(SUN_PATHS / sunny.length), entering = -w.inward.dot(sunDirection);
      for (let i = 0; i < paths; i++) {
        const from = spot(w, random(), random()).addScaledVector(sunDirection, 0.05);
        if (!shaded(from)) follow(from, sunDirection.clone().negate(), sunLight.clone().multiplyScalar(entering * w.area / paths));
      }
    }
    for (const w of layer.lamp ? [] : this.windows) {
      const paths = Math.ceil(SKY_PATHS / this.windows.length);
      for (let i = 0; i < paths; i++) {
        const direction = scatter(w.inward);          // the light comes from the opposite way
        const from = spot(w, random(), random());
        follow(from, direction, seen(from, direction.clone().negate()).multiplyScalar(Math.PI * w.area / paths));
      }
    }
    // Shuffled, so that a part of the list is a fair sample of all of it. A lamp coming on
    // for the first time keeps its own points first instead: its direct light is there at
    // once and the bounced light fills in after it.
    if (!layer.lamp || layer.baked) for (let i = lights.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [lights[i], lights[j]] = [lights[j], lights[i]];
    }

    const data = this.lights.value.array;
    lights.length = Math.min(lights.length, LIGHT_SLOTS);
    lights.forEach((l, i) => {
      data.set([l.place.x, l.place.y, l.place.z, l.kind, l.facing.x, l.facing.y, l.facing.z, l.area], i * 12);
      data.set(l.colour ? [l.colour.r, l.colour.g, l.colour.b, 1] : [l.window, 0, 0, 0], i * 12 + 8);
    });
    // The picture of what each window looks out on: four directions looked along per entry.
    const [wide, tall] = OUTLOOK, d = new THREE.Vector3();
    for (const w of layer.lamp ? [] : this.windows) {
      const right = new THREE.Vector3(w.inward.z, 0, -w.inward.x), first = (OUTLOOK_START + w.index * wide * tall) * 4;
      for (let j = 0; j < tall; j++) for (let i = 0; i < wide; i++) {
        const sum = new THREE.Color(0, 0, 0);
        for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const turn = ((i + a) / wide - 0.5) * Math.PI, rise = ((j + b) / tall - 0.5) * Math.PI;
          d.copy(w.inward).multiplyScalar(-Math.cos(turn) * Math.cos(rise)).addScaledVector(right, Math.sin(turn) * Math.cos(rise));
          d.y = Math.sin(rise);
          sum.add(seen(w.centre, d));
        }
        data.set([sum.r / 4, sum.g / 4, sum.b / 4, 0], first + (j * wide + i) * 4);
      }
    }
    leaves.forEach((l, i) => {
      data.set([l.hinge.x, l.hinge.y, l.hinge.z, l.length, l.ax, l.az, l.height, l.pane ? 1 : 0, ...(l.pane ?? [0, 0, 0, 0])], (LIGHT_SLOTS + i) * 12);
    });
    this.u.leaves.value = leaves.length;
    this.lights.value.needsUpdate = true;
    this.lightTotal = this.u.lightTotal.value = lights.length;
  }

  // Marks layers (all of them if none are given) to be worked out again, e.g. after the sun
  // or a door moved. Daylight then fades from what is on show over the first part of its
  // bake (`fade`, as a share of it).
  invalidate(layers = this.layers, fade = FADE) {
    this.halt();
    for (const layer of layers) layer.stale = true;
    this.layers[0].fade = fade;
  }

  // Stops the bake in progress and keeps what it has put on show as that layer's result.
  halt() {
    if (this.baking < 0) return;
    if (this.done > 0 || this.cursor > 0) {
      this.renderer.compute(this.commit);
      this.layers[this.baking].baked = true;
    }
    this.baking = -1;
    this.u.layer.value = NONE;
    this.dirty = true;
  }

  // Starts on the next layer that needs working out: daylight first, then the lamps that are on.
  next() {
    if (!this.count || !this.light || this.awaitingOutside) return;
    const index = this.layers.findIndex(layer => layer.stale && layer.weight > 0);
    if (index < 0) return;
    const layer = this.layers[index];
    this.makeLights(layer);
    this.u.layer.value = index;
    this.u.outdoors.value = layer.lamp ? 0 : 1;
    this.u.kept.value = this.keep;
    this.u.fade.value = Math.max(1, this.lightTotal * (layer.lamp ? 1 : layer.fade));
    this.renderer.compute(this.clear);
    this.keep = this.count;
    this.baking = index;
    this.done = 0;
    this.cursor = 0;
  }

  get finished() { return !this.count || !this.light || (!this.awaitingOutside && this.baking < 0 && !this.layers.some(layer => layer.stale && layer.weight > 0)); }
  get progress() {
    if (this.finished) return 1;
    if (this.baking < 0) return 0;
    return (this.done + PER_STEP * this.cursor / this.count) / this.lightTotal;
  }

  // Call once a frame. Adds a few more lights to a few blocks of points of the layer being
  // worked out, and makes the sum on show again if anything changed. `frameMs` is how long
  // the last frame took; the number of blocks follows it, leaving about 30 frames a second
  // for walking while the light fills in.
  step(frameMs) {
    if (!this.count || !this.light) return;
    if (this.baking < 0) this.next();
    if (this.baking >= 0) {
      // (in steps of an eighth: a lamp's layer is far less work per block than daylight)
      if (frameMs > 36) this.blocks = Math.max(1, Math.floor(this.blocks * 0.85));
      else if (frameMs < 30) this.blocks = Math.min(256, this.blocks + Math.max(1, this.blocks >> 3));
      const u = this.u;
      for (let b = 0; b < this.blocks && this.done < this.lightTotal; b++) {
        u.firstLight.value = this.done;
        u.lightCount.value = Math.min(PER_STEP, this.lightTotal - this.done);
        u.offset.value = this.cursor;
        this.renderer.compute(this.kernel);
        this.cursor += BLOCK;
        if (this.cursor >= this.count) { this.cursor = 0; this.done += u.lightCount.value; }
      }
      if (this.done >= this.lightTotal) {
        const layer = this.layers[this.baking];
        this.renderer.compute(this.commit);
        layer.stale = false;
        layer.baked = true;
        this.baking = -1;
        u.layer.value = NONE;
      }
      this.dirty = true;
    }
    if (this.dirty) {
      const data = this.lights.value.array;
      this.layers.forEach((layer, i) => { data[(WEIGHTS + i) * 4] = layer.weight; });
      this.lights.value.needsUpdate = true;
      this.renderer.compute(this.compose);
      this.dirty = false;
    }
  }

  // Makes a material show the baked light, as light arriving at its surface. With `mapped`
  // its meshes get a light map; they must then be flat-faced, like walls and floors.
  apply(material, mapped = false) {
    this.lit.add(material);
    if (mapped) this.mapped.add(material);
    material.setupLightMap = () => new THREE.IrradianceNode(mapped ? this.mapNode : this.bakedNode);
    material.needsUpdate = true;
    return material;
  }
}

const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

// Calls `visit` for every triangle corner of a mesh as it stands in the scene, with the
// corner's number, its place, the way it faces and the middle of its triangle.
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _normalMatrix = new THREE.Matrix3();
function corners(mesh, visit) {
  mesh.updateWorldMatrix(true, false);
  _normalMatrix.getNormalMatrix(mesh.matrixWorld);
  const pos = mesh.geometry.attributes.position, nor = mesh.geometry.attributes.normal;
  for (let t = 0; t < pos.count; t += 3) {
    for (let k = 0; k < 3; k++) _corner[k].fromBufferAttribute(pos, t + k).applyMatrix4(mesh.matrixWorld);
    const cx = (_corner[0].x + _corner[1].x + _corner[2].x) / 3, cy = (_corner[0].y + _corner[1].y + _corner[2].y) / 3, cz = (_corner[0].z + _corner[1].z + _corner[2].z) / 3;
    for (let k = 0; k < 3; k++) {
      _n.fromBufferAttribute(nor, t + k).applyMatrix3(_normalMatrix).normalize();
      visit(t + k, _p.copy(_corner[k]), _n, cx, cy, cz);
    }
  }
}

// Lays a grid of texels over every flat face of a mesh. Triangles in one plane that touch
// share a grid (a "chart"), so light blends across them without a seam. Gives the mesh the
// attributes `lightUv` (the position on its chart, in texels) and `lightChart` (the chart's
// first slot, width and height), and returns the charts with, for each texel, whether it
// lies on a face and the point of the face nearest to it.
function chartMesh(mesh, top) {
  mesh.updateWorldMatrix(true, false);
  const geometry = mesh.geometry, position = geometry.attributes.position, normals = geometry.attributes.normal;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), facing = new THREE.Vector3();

  // Triangles by the plane they lie in.
  const planes = new Map(), triangles = position.count / 3;
  for (let t = 0; t < triangles; t++) {
    a.fromBufferAttribute(position, t * 3).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    n.subVectors(b, a).cross(facing.subVectors(c, a));
    if (n.length() < 1e-8) continue;                                  // no area
    n.normalize();
    if (n.dot(facing.fromBufferAttribute(normals, t * 3).applyMatrix3(normalMatrix)) < 0) n.negate();
    // The tops of full-height walls and the undersides of everything standing on the
    // floor are never seen.
    if ((n.y > 0.9 && a.y > top - 0.01) || (n.y < -0.9 && a.y < 0.01)) continue;
    const distance = n.dot(a);
    const key = `${Math.round(n.x * 500)},${Math.round(n.y * 500)},${Math.round(n.z * 500)},${Math.round(distance * 1000 + 0.3)}`;
    if (!planes.has(key)) {
      // across and up the face
      const u = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(n).normalize();
      planes.set(key, { normal: n.clone(), distance, u, v: n.clone().cross(u).normalize(), triangles: [] });
    }
    const plane = planes.get(key);
    plane.triangles.push({ t, flat: [a, b, c].flatMap(q => [q.dot(plane.u) / TEXEL + SHIFT, q.dot(plane.v) / TEXEL + SHIFT]) });   // in texels
  }

  const charts = [{ offset: 0, width: 2, height: 2, normal: [0, 1, 0], on: new Uint8Array(4), at: new Float32Array(12) }];   // for the triangles left out
  const uv = new Float32Array(position.count * 2).fill(1), chartOf = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) chartOf.set([0, 2, 2], i * 3);
  const offsets = new Float32Array(position.count);
  let count = 4;
  for (const plane of planes.values()) {
    // Triangles whose outlines come within a texel of each other go on one chart.
    const list = plane.triangles, group = list.map((_, i) => i);
    const find = i => { while (group[i] !== i) i = group[i] = group[group[i]]; return i; };
    for (const tri of list) {
      const f = tri.flat;
      tri.box = [Math.min(f[0], f[2], f[4]), Math.min(f[1], f[3], f[5]), Math.max(f[0], f[2], f[4]), Math.max(f[1], f[3], f[5])];
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = list[i].box, q = list[j].box;
      if (p[0] <= q[2] + 1 && q[0] <= p[2] + 1 && p[1] <= q[3] + 1 && q[1] <= p[3] + 1) group[find(i)] = find(j);
    }
    const clusters = new Map();
    list.forEach((tri, i) => { const g = find(i); if (!clusters.has(g)) clusters.set(g, []); clusters.get(g).push(tri); });

    for (const cluster of clusters.values()) {
      // The grid lines are the same for every chart of the plane; this one covers the
      // cluster and a texel around it.
      const x0 = Math.floor(Math.min(...cluster.map(tri => tri.box[0]))) - 1, y0 = Math.floor(Math.min(...cluster.map(tri => tri.box[1]))) - 1;
      const width = Math.ceil(Math.max(...cluster.map(tri => tri.box[2]))) + 1 - x0, height = Math.ceil(Math.max(...cluster.map(tri => tri.box[3]))) + 1 - y0;
      const size = width * height, near = new Float32Array(size).fill(Infinity), spot = new Float32Array(size * 2);
      for (const tri of cluster) {
        const f = tri.flat;
        for (let k = 0; k < 3; k++) {
          uv.set([f[k * 2] - x0, f[k * 2 + 1] - y0], (tri.t * 3 + k) * 2);
          chartOf.set([0, width, height], (tri.t * 3 + k) * 3);
          offsets[tri.t * 3 + k] = count;
        }
        const turn = Math.sign((f[2] - f[0]) * (f[5] - f[1]) - (f[4] - f[0]) * (f[3] - f[1]));
        for (let y = Math.max(0, Math.floor(tri.box[1]) - y0 - 1); y <= Math.min(height - 1, Math.ceil(tri.box[3]) - y0); y++) {
          for (let x = Math.max(0, Math.floor(tri.box[0]) - x0 - 1); x <= Math.min(width - 1, Math.ceil(tri.box[2]) - x0); x++) {
            const cx = x0 + x + 0.5, cy = y0 + y + 0.5, k = y * width + x;
            if (near[k] === 0) continue;
            // inside the triangle, or else the nearest point on its outline
            let inside = true, best = Infinity, bx = 0, by = 0;
            for (let e = 0; e < 3; e++) {
              const px = f[e * 2], py = f[e * 2 + 1], qx = f[(e + 1) % 3 * 2], qy = f[(e + 1) % 3 * 2 + 1];
              const ex = qx - px, ey = qy - py;
              if (((cx - px) * ey - (cy - py) * ex) * turn > 0) inside = false;
              const along = Math.min(1, Math.max(0, ((cx - px) * ex + (cy - py) * ey) / (ex * ex + ey * ey || 1)));
              const nx = px + ex * along, ny = py + ey * along, d = (cx - nx) ** 2 + (cy - ny) ** 2;
              if (d < best) { best = d; bx = nx; by = ny; }
            }
            if (inside) { near[k] = 0; spot[k * 2] = cx; spot[k * 2 + 1] = cy; }
            else if (best < near[k]) { near[k] = best; spot[k * 2] = bx; spot[k * 2 + 1] = by; }
          }
        }
      }
      const on = new Uint8Array(size), at = new Float32Array(size * 3);
      for (let k = 0; k < size; k++) {
        if (near[k] > REACH * REACH) continue;
        on[k] = 1;
        let sx = spot[k * 2], sy = spot[k * 2 + 1];
        if (near[k] > 1e-9) {
          // Not exactly on the edge, where it would be a toss-up which room the point is in.
          const cx = x0 + k % width + 0.5, cy = y0 + Math.floor(k / width) + 0.5, far = Math.sqrt(near[k]);
          sx += (sx - cx) / far * INSET; sy += (sy - cy) / far * INSET;
        }
        a.copy(plane.normal).multiplyScalar(plane.distance).addScaledVector(plane.u, (sx - SHIFT) * TEXEL).addScaledVector(plane.v, (sy - SHIFT) * TEXEL);
        at.set([a.x, a.y, a.z], k * 3);
      }
      charts.push({ offset: count, width, height, normal: plane.normal.toArray(), on, at });
      count += size;
    }
  }
  geometry.setAttribute('lightUv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('lightChart', new THREE.BufferAttribute(chartOf, 3));
  return { charts, count, offsets, first: -1 };
}
