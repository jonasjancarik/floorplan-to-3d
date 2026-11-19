// Geometry helpers. Plan coordinates are millimetres with +Y pointing north;
// the scene is metres with +Y up, so plan (x, y, z) lands on scene (x, z, -y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const MM = 0.001;
export const toScene = (x, y, z = 0) => new THREE.Vector3(x * MM, z * MM, -y * MM);

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Texture coordinates in metres, projected along the dominant axis of each face, so a
// texture keeps its real size on every piece. `long` names the scene axis that should
// run along the texture's u direction (the grain of a board).
export function triplanarUV(g, long = null) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const c = { x: p.getX(i), y: p.getY(i), z: p.getZ(i) };
    const a = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const face = a[0] >= a[1] && a[0] >= a[2] ? 'x' : a[1] >= a[2] ? 'y' : 'z';
    let [u, v] = { x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y'] }[face];
    if (long === v) [u, v] = [v, u];
    uv[i * 2] = c[u];
    uv[i * 2 + 1] = c[v];
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Flat mapping for floors: metres, turned by `angle` so the herringbone runs along the walls.
export function planarUV(g, angle = 0) {
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    uv[i * 2] = x * c + z * s;
    uv[i * 2 + 1] = -x * s + z * c;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const longAxis = (w, h, d) => (w >= h && w >= d ? 'x' : h >= d ? 'y' : 'z');

// Axis-aligned box from plan millimetres, optionally with rounded edges.
export function boxGeo(x0, y0, x1, y1, z0, z1, radius = 0) {
  const w = Math.abs(x1 - x0) * MM, h = Math.abs(z1 - z0) * MM, d = Math.abs(y1 - y0) * MM;
  const r = Math.min(radius * MM, w / 2.01, h / 2.01, d / 2.01);
  const g = r > 0 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d);
  g.translate((x0 + x1) / 2 * MM, (z0 + z1) / 2 * MM, -(y0 + y1) / 2 * MM);
  return triplanarUV(g, longAxis(w, h, d));
}

function flipWinding(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
}

// Box laid along a direction in plan: `origin` and unit vectors `u`, `v` are plan mm,
// the box spans a0..a1 along u, b0..b1 along v and z0..z1 in height.
export function orientedBoxGeo(origin, u, v, a0, a1, b0, b1, z0, z1) {
  const g = new THREE.BoxGeometry(Math.abs(a1 - a0) * MM, Math.abs(z1 - z0) * MM, Math.abs(b1 - b0) * MM);
  const U = new THREE.Vector3(u[0], 0, -u[1]), V = new THREE.Vector3(v[0], 0, -v[1]);
  const m = new THREE.Matrix4().makeBasis(U, new THREE.Vector3(0, 1, 0), V);
  const ac = (a0 + a1) / 2, bc = (b0 + b1) / 2;
  m.setPosition(toScene(origin[0] + u[0] * ac + v[0] * bc, origin[1] + u[1] * ac + v[1] * bc, (z0 + z1) / 2));
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  return triplanarUV(g);
}

function shapeOf(polygon, holes = []) {
  const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x * MM, y * MM)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x * MM, y * MM))));
  return shape;
}

// Vertical prism over a plan polygon.
export function prismGeo(polygon, holes, z0, z1) {
  const g = new THREE.ExtrudeGeometry(shapeOf(polygon, holes), { depth: (z1 - z0) * MM, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, z0 * MM, 0);
  return triplanarUV(g);
}

// Horizontal face over a plan polygon, facing up, or down for a ceiling.
export function flatGeo(polygon, holes, z, uvAngle = 0, faceDown = false) {
  const g = new THREE.ShapeGeometry(shapeOf(polygon, holes));
  g.rotateX(-Math.PI / 2);
  g.translate(0, z * MM, 0);
  if (faceDown) {
    flipWinding(g);
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setY(i, -n.getY(i));
  }
  return planarUV(g, uvAngle);
}

// Splits every triangle edge longer than `maxEdge` (metres) until none is left. Furniture
// and fittings store their lighting per vertex, so they need enough vertices to carry its
// gradients.
// Whether an edge is split depends only on its length, so neighbours always agree and no
// cracks appear.
export function subdivide(geometry, maxEdge) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const P = src.attributes.position.array, N = src.attributes.normal.array, U = src.attributes.uv.array;
  let verts = new Array(P.length / 3 * 8);
  for (let i = 0; i < P.length / 3; i++) {
    verts[i * 8] = P[i * 3]; verts[i * 8 + 1] = P[i * 3 + 1]; verts[i * 8 + 2] = P[i * 3 + 2];
    verts[i * 8 + 3] = N[i * 3]; verts[i * 8 + 4] = N[i * 3 + 1]; verts[i * 8 + 5] = N[i * 3 + 2];
    verts[i * 8 + 6] = U[i * 2]; verts[i * 8 + 7] = U[i * 2 + 1];
  }
  const max2 = maxEdge * maxEdge;
  for (let pass = 0; pass < 12; pass++) {
    const out = [];
    let changed = false;
    const long = (a, b) => (verts[a] - verts[b]) ** 2 + (verts[a + 1] - verts[b + 1]) ** 2 + (verts[a + 2] - verts[b + 2]) ** 2 > max2;
    const put = v => { for (let k = 0; k < 8; k++) out.push(v[k]); };
    const at = a => verts.slice(a, a + 8);
    const mid = (a, b) => { const m = new Array(8); for (let k = 0; k < 8; k++) m[k] = (verts[a + k] + verts[b + k]) / 2; return m; };
    const tri = (a, b, c) => { put(a); put(b); put(c); };
    for (let t = 0; t < verts.length; t += 24) {
      const i = [t, t + 8, t + 16];
      const split = [long(i[0], i[1]), long(i[1], i[2]), long(i[2], i[0])];
      const count = split[0] + split[1] + split[2];
      if (count === 0) { for (let k = t; k < t + 24; k++) out.push(verts[k]); continue; }
      changed = true;
      if (count === 3) {
        const [a, b, c] = i.map(at), ab = mid(i[0], i[1]), bc = mid(i[1], i[2]), ca = mid(i[2], i[0]);
        tri(a, ab, ca); tri(ab, b, bc); tri(ca, bc, c); tri(ab, bc, ca);
      } else if (count === 1) {
        const r = split.indexOf(true), [a, b, c] = [i[r], i[(r + 1) % 3], i[(r + 2) % 3]];   // a-b is the long edge
        const m = mid(a, b);
        tri(at(a), m, at(c)); tri(m, at(b), at(c));
      } else {
        const r = (split.indexOf(false) + 1) % 3, [a, b, c] = [i[r], i[(r + 1) % 3], i[(r + 2) % 3]];  // c-a is the short edge
        const ab = mid(a, b), bc = mid(b, c);
        tri(ab, at(b), bc); tri(at(a), ab, bc); tri(at(a), bc, at(c));
      }
    }
    verts = out;
    if (!changed) break;
  }
  const count = verts.length / 8, p = new Float32Array(count * 3), n = new Float32Array(count * 3), u = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    p.set(verts.slice(i * 8, i * 8 + 3), i * 3); n.set(verts.slice(i * 8 + 3, i * 8 + 6), i * 3); u.set(verts.slice(i * 8 + 6, i * 8 + 8), i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
  return g;
}

export function mergeAll(geos) {
  const keep = new Set(['position', 'normal', 'uv']);
  const clean = geos.map(src => {
    const g = src.index ? src.toNonIndexed() : src;
    for (const name of Object.keys(g.attributes)) if (!keep.has(name)) g.deleteAttribute(name);
    g.morphAttributes = {};
    return g;
  });
  return mergeGeometries(clean, false);
}

// Materials of the big flat room surfaces, whose baked light is stored in a light map.
export const LIGHT_MAPPED = ['wall', 'ceiling', 'parquet', 'tiles'];

// Collects geometry per material and turns each pile into a single mesh.
export class Batch {
  constructor() { this.piles = new Map(); this.parts = new Map(); this.current = 'other'; }

  // Names the element (a window, a chair, ...) that the geometry added next belongs to.
  // The viewer draws everything of one material as a single mesh; the names are kept so
  // that the model can also be handed on element by element (see export.js).
  part(name) { this.current = name; return this; }

  add(key, ...geos) {
    const added = geos.flat();
    if (!this.piles.has(key)) this.piles.set(key, []);
    this.piles.get(key).push(...added);
    if (!this.parts.has(this.current)) this.parts.set(this.current, new Map());
    const part = this.parts.get(this.current);
    if (!part.has(key)) part.set(key, []);
    part.get(key).push(...added);
    return this;
  }

  // Each mesh keeps its plain geometry in `userData.coarse` (used for tracing light). Walls,
  // floors and ceilings are drawn as they are and get a light map; the rest is shown as a
  // finely divided copy that carries baked light at its vertices.
  build(materials, into = new THREE.Group(), maxEdge = 0.26) {
    for (const [key, geos] of this.piles) {
      if (!materials[key]) throw new Error(`No material called "${key}"`);
      const coarse = mergeAll(geos), seeThrough = materials[key].transparent;
      const plain = seeThrough || key === 'wallCut' || key === 'gap' || LIGHT_MAPPED.includes(key);
      const mesh = new THREE.Mesh(plain ? coarse : subdivide(coarse, maxEdge), materials[key]);
      mesh.name = key;
      mesh.userData.coarse = coarse;
      mesh.castShadow = !seeThrough;
      mesh.receiveShadow = true;          // glass too, or a pane in the shade would glare as if the sun were on it
      into.add(mesh);
    }
    into.userData.parts = this.parts;
    return into;
  }
}

export const signedArea = pts => pts.reduce((s, [x, y], i) => {
  const [x2, y2] = pts[(i + 1) % pts.length];
  return s + (x * y2 - x2 * y) / 2;
}, 0);

export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
