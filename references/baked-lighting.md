# Baked daylight

The code is `assets/viewer/src/bake.js` (also at `~/projects/melnicka-floorplan/viewer/src/bake.js`). Read its header
comment first. This note says how it works, how to wire it in, and what went wrong on the way to it.

## The idea

Only the sun is a real-time light. Everything else (sky through the windows, and light bounced around the rooms) is
worked out once and stored in the scene, then again whenever the sun, a door or the furniture changes.

The method is instant radiosity:

1. Daylight is turned into a fixed list of about 1 300 small lights. Sky "spots" are spread over each window opening
   (4 × 6 per window). "Bounce lights" are left wherever light lands when it is followed in from the windows, along
   the sun's rays (140 paths) and from the sky (300 paths), for four bounces. This part runs on the CPU with
   `three-mesh-bvh`, a few thousand rays.
2. Every point that stores light adds up what it receives from each of those lights. That is a WGSL compute kernel:
   for each light a facing and distance test, then one any-hit ray against a BVH of the whole flat
   (`three-mesh-bvh/webgpu`).
3. The work is spread over frames, 16 384 points and 8 lights per run, with the number of runs per frame following
   the frame time. The meshes read the running sums while drawing, so the rooms simply brighten over a few seconds.

All points share the same lights, which is why the result is smooth. Sampling lights at random per point gives a
patchwork.

## Where light is stored

One storage buffer holds two entries per point: the light as drawn, and the running sum of the bake in progress
(`rgb` = light, `a` = number of lights added). A second buffer holds what each layer (daylight, and every lamp)
came to at each point; see "Lamps" below.

- **Light maps for walls, floors and ceilings.** Triangles in one plane that touch share a grid of texels 5 cm apart
  (a chart). There is no texture atlas: each vertex carries its position on the chart and the chart's first slot,
  width and height, and the fragment shader blends the four texels around the pixel, leaving out any with no light.
  Charts by plane, not by connectivity, mean the separate wall pieces over doors and under sills blend without seams.
- **Vertices for everything else.** Vertices within 3 cm that face the same way share a point. These meshes are
  subdivided to edges of at most 26 cm so that there are enough vertices to carry gradients.

The example bakes 363 000 texels and 110 000 vertices against 1 266 lights. On a MacBook Air setting up the points
takes about 0.9 s and the light settles in 3 to 4 s, after which the scene runs at 60 frames a second at pixel ratio 2.

## Changes after the first bake

When the sun, a door or the furniture changes, the bake runs again, but the light already on show stays and fades
into the new light while it adds up. Without this every change makes the whole flat dip dark for a moment.

- The compute kernel writes the drawn value itself: `shown = old × (1 − f) + estimate × f`, where `f` rises from 0
  to 1 over the first part of the bake. The old light needs no buffer of its own; it is what is on show less the
  share of the estimate already mixed in.
- With `f` rising over the whole bake the change is purely additive and never flickers (used for doors). After the
  sun moves the old light is simply wrong, so there it fades out over the first 30%.
- Points that are new, or had no light before, show the running estimate straight away. Light map texels keep
  their slots when furniture comes and goes, so only the vertices start afresh then.
- The buffer is cleared by a small compute pass, never from the CPU: uploading the CPU copy would wipe what the
  graphics card worked out.

**Doors that swing** are kept out of the BVH. Each leaf is a thin rectangle (hinge, direction, length, height, and a
glazed part that lets light through) stored after the light list and tested by itself for every ray, in the kernel
and in the CPU code that follows light into the rooms. Opening a door then costs no rebuild: the rectangles are
rewritten, the leaf's own vertices are placed again in their old slots, and the bake restarts. Give the baker the
position the door is going to as soon as it starts to move, so the rooms change while it swings, and redraw the
sun's shadow map on every frame of the swing. In the example a click costs about 35 ms and the light settles in
about 2 s at 45 frames a second.

## Lamps

Light adds up, so daylight and each lamp are baked as separate layers and the drawn light is their sum, each
times how far its lamp is turned up. Switching a lamp is then one cheap compute pass over the points, not a bake.

- **A lamp's light list** is a few points on the lamp (8 in the example) and the bounce lights left by following
  its light out into the rooms (100 paths, four bounces: about 400 lights). A globe shines all round; a lamp under
  a shade or on the ceiling shines the way it faces, like a bounce light without the nearness limit.
- **The lit part of a fitting** (globe, bulb) is left out of the BVH, or the lamp would be shut inside it. Its
  material glows by an emissive node driven by the same 0-to-1 level as the layer's weight.
- **Storage**: per point and layer `rgb` plus a "has a result" flag, as four half floats in two `u32`
  (`pack2x16float`). Twelve layers over 540 000 points come to about 50 MB; as plain `vec4` it would be twice that.
  Only compute passes read this buffer, so the drawing shaders are unchanged.
- **Passes**: the kernel only adds to the running sum of the layer being baked. `compose` writes the drawn sum
  (run on any frame where something changed), `commit` stores what a layer has on show as its result, `clear`
  empties the running sum. Stopping a bake half way commits first, so nothing on screen jumps back.
- **When to bake**: a lamp's layer is baked the first time it is switched on, and again after a door has moved if
  the lamp is on (otherwise when it is next switched on). Baking every lamp in the background was rejected: the
  adaptive pixel ratio leaves no spare frame time, so it would cost frames for light nobody sees.
- **A lamp coming on for the first time** keeps its own points first in its list, unshuffled, and shows the plain
  partial sum: direct light appears within a frame or two and the bounced light fills in. A rebake of a lamp that
  already has a result uses the shuffled list and the usual fade.
- **Strength**: in the example a lamp gives off 2 units against a sun of 5 and a sky of about 2, which makes a
  lamp-lit living room about a quarter as bright as the same room by day. Small rooms need much less (0.2 to 0.6).

**Exposure.** With lamps a fixed exposure no longer works: evening rooms come out far too dark. The example
measures a room's brightness without reading anything back from the graphics card: while following light, the
baker adds up the light its bounce lights send out in each room, per square metre of floor, for each layer. The
viewer sums that over the layers by their weights for the room the walker stands in (the three brightest rooms in
the view from above) and raises the exposure by `(reference / brightness)^0.7`, at most four times and never
below the daylight setting, eased over 0.7 s. A dim hallway by day brightens the same way.

Measured in the example: about 1 s for one lamp's first bake, 11 s for all eleven at once, and 8 s for daylight
and nine lit lamps after a door moved, at about 30 frames a second while it runs.

## Wiring it in

```js
const baker = new LightBaker(renderer, model);                 // model: rooms, openings, platform, solids, wall_height
for (const [key, material] of Object.entries(M))
  if (!material.transparent) baker.apply(material, LIGHT_MAPPED.includes(key));   // true = light map
baker.setScene(litMeshes, [...litMeshes, ...unseenSurroundings]);                 // again when geometry changes
baker.setLight({ sunDirection, sunLight, skyZenith, skyHorizon, ground });        // again when the sun moves
baker.setDoors(leaves, meshesOfMovedLeaves);                                      // again when a door is set off
baker.setLamp(id, level);                                                         // 0 to 1, as often as you like
// every frame:
baker.step(frameMs); pipeline.render();
```

If the surroundings load after the flat, construct the baker so that it waits (`awaitingOutside`) and starts with
the first `setOutside(geometry or null)`; otherwise it bakes once without the houses and again with them, which
here cost three seconds on opening.

`apply` hooks into the material's `setupLightMap`, so the baked light arrives as irradiance and is dimmed by ambient
occlusion like any light map. Light-mapped materials must be used only on flat-faced meshes.

Each gather point is placed with care (`place()` in the code):

- 5 mm off the surface, and for vertices 12 mm in from the edge;
- stepped out through thin covers such as skirting, door trim and rugs, so that what is covered takes the light of
  its cover;
- kept inside the height of the room it faces;
- then classed as indoors (gathers from the lights), outdoors (a rough open-sky value), or unlit.

## The real-time sun

A `DirectionalLight` with one 4096 shadow map covering the flat, `shadow.autoUpdate = false` and redrawn only when
something changes. Three settings matter:

- `material.shadowSide = FrontSide` on everything. three.js draws shadows from back faces by default, and then
  sunlight creeps in wherever a wall meets a floor or ceiling.
- A small bias (`bias = -0.0001`, `normalBias = 0.02`).
- The unseen building: a slab above, a slab below and the neighbours' walls, with `colorWrite: false` so they cast
  shadows and block the bake without being drawn. The slabs are drawn in a near-black tone instead, so a hairline
  joint shows dark rather than sky.

## Faults met, and their causes

| What it looked like | Cause | Fix |
|---|---|---|
| Walls lit as a patchwork of triangles | Each vertex sampled different random lights | One fixed, shuffled list of lights for all points |
| Compute shader would not compile | It used 10 storage buffers; the limit is 8 | Pack position with normal, and all light fields, into one buffer each |
| Bright lines of sun along floor and ceiling joints | Shadows drawn from back faces; nothing above or beside the flat | `shadowSide = FrontSide`, small bias, the unseen building |
| A whole ceiling or a loft lit like the open sky | Points classed as outdoors by a fixed height, or the area was in no room polygon | Take the height from `wall_height`; add platform and opening polygons to what counts as indoors |
| Dark smudges on walls beside trim | Covered vertices gathered inside the trim | Probe along the normal and step out through thin covers |
| Jagged shade under shelves | Light only at vertices | Light maps |
| Thin bright lines around the walls of a dark room | Texels beyond a face's edge gathered exactly on the room's outline, where "which room?" is a toss-up | Gather 12 mm inside the face; shift the grid off round millimetres |
| A light sliver on a door edge in a dark hallway | A point that ended up inside a wall counted as outdoors | Inside the flat's extent but in no room or opening means unlit |
| Setting up the points froze the page for 2 s | `inRing` destructured each polygon point | Index the arrays directly (2.0 s to 0.9 s) |
| `mergeGeometries` returned null | Indexed and non-indexed geometry mixed | `toNonIndexed()` before merging |
| Chart numbers off by one at triangle edges | Large integers interpolated across a triangle | A varying with flat interpolation, and round in the shader |
| Books black in an early path-traced version | Vertex colours unsupported there | One small material per colour |
| Bake and frame times twice as slow as expected | A hidden browser pane was running a second copy of the viewer | Point the other tab elsewhere while measuring |
| The whole flat went dark for a moment on every change | The sums were cleared and drawn directly | Keep the drawn light apart from the running sum and fade between them |
| The picture got coarser after every few rebakes | The adaptive pixel ratio judged frames that were slow only because of the bake | Start its count of steady frames again while a bake runs |
| Bake seemed to take 13 s in a test | The test read the canvas back while the bake was queued on the graphics card | Time bakes from the baker's own counters, without reading pixels |
| Grainy, sooty corners and dark halos on walls behind books | Screen-space contact shading reaching 30 cm darkened what the light maps already shade, unsmoothed | Reach of 8 cm, `scale` 0.7, and `DenoiseNode` over the result at half resolution |

## Limits worth stating in the README

- Rooms without windows are only as bright as daylight through their doors, until their lamp is on.
- Lamps leave no glint on shiny floors; their light is diffuse only.
- No mirrors or reflections on the floor.

## Screen-space light on top: tried, not adopted

three.js ships `SSGINode` and `TRAANode` (`three/addons/tsl/display/`), which work out bounced light from what is on
screen every frame, with temporal anti-aliasing to hide the noise. They cannot replace the bake: light only bounces
off what the camera sees, and a room lit through a doorway gets nothing. The example project tried them layered over
the bake in place of the contact shading (`setScreenLight` in its `main.js`, off by default).

What it took to wire in (r187):

- Give the scene pass `{ samples: 0 }`; TRAA does not work with MSAA.
- MRT outputs `output`, `diffuseColor`, `normal: packNormalToRGB(normalView)` and `velocity`.
- The node's two results come from `getAONode().r` and `getGINode().rgb`. Using the node itself as a `vec4`, as older
  examples do, reads only the shading texture and washes the picture out.
- Compose as `beauty * ao + diffuseColor * gi`, then `traa(...)`, then bloom.
- Settings that suited an interior in metres: `giIntensity` 4 (the default 10 doubles the bounce the bake already
  has), `radius` 3, `thickness` 0.3, one slice of 12 steps.

What it cost and gave, on a MacBook Air at 1400 × 780 CSS pixels:

| Pixel ratio | Baked light + contact shading | With SSGI at full resolution | With SSGI at half resolution |
|---|---|---|---|
| 1 | 16.5 ms | 20.9 ms | |
| 1.25 | 16.8 ms | | 19.6 ms |
| 1.5 | 21.9 ms | 41 ms | 23.2 ms |
| 2 | 33.9 ms | 75 ms | |

At full resolution the picture was a little brighter and softer, with wider shading in the corners and well-smoothed
edges, and some grain on white walls. At half resolution it left speckles on the white window frames and washed out
the colours. Neither was worth the cost there; on a desktop graphics card it may be.

When measuring this kind of change, hold the pixel ratio fixed (`viewer.pin(ratio)` in the example). A viewer that
lowers its resolution to keep its frame rate will otherwise hide the cost and then stay at the lower resolution.
