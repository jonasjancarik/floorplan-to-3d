# The three.js viewer

Worked example: `~/projects/melnicka-floorplan/viewer/` (three r187, `three-mesh-bvh` 0.9.18, Vite 8; about 2 000
lines). Reusable parts are in this skill's `assets/viewer/`:

| File | What it gives you |
|---|---|
| `src/geometry.js` | mm-to-scene helpers, box, prism and flat-polygon geometry with sensible UVs, `subdivide`, the `Batch` class, `inRing` |
| `src/bake.js` | The light baker; see [baked lighting](baked-lighting.md) |
| `src/sun.js` | Sun direction from month and clock time for a `site` (latitude, longitude, bearing of plan +Y) |
| `src/neighbourhood.js` | Loads real surroundings cut from a city photo model; see [real surroundings](real-surroundings.md) |
| `src/export.js` | `.glb` export, one named node per element |
| `vite.config.js`, `package.json` | Dev server on all interfaces, plus two dev-only endpoints for saving screenshots and the exported model |

## Layout

```
viewer/index.html          panel: mode, toggles, sun sliders, room buttons, download
viewer/src/main.js         renderer, sun, unseen surroundings, baker, post-processing, walking, UI, test hooks
viewer/src/architecture.js walls, floors, ceilings, skirting, windows, radiators, door frames and leaves
viewer/src/furniture.js    kitchen, bathroom fittings, furniture and the small things on it
viewer/src/lamps.js        lamp fittings, each with a material that glows as far as the lamp is turned up
viewer/src/materials.js    one node material per name
viewer/src/textures.js     procedural canvas textures and loaders for generated images
viewer/src/outside.js      houses opposite and the ground, unlit
```

The viewer reads only the JSON model. Run the plan generator and the page reloads.

## Conventions

- Scene units are metres, +Y up, plan +Y (north) on −Z. Convert once in a `toScene(x, y, z)` helper.
- Build everything through `Batch`: `batch.part('window-O2-1').add('paint', geometry)`, then `batch.build(materials)`.
  The result is one mesh per material, with its unsubdivided geometry kept in `mesh.userData.coarse` (the baker traces
  light against that) and the pieces per element kept in `group.userData.parts` (the export uses those).
- Materials are `MeshStandardNodeMaterial`s in one table keyed by name. A textured material carries
  `userData.albedo`, the texture's average colour, which the baker uses for bounced light.
- Texture tiling follows `repeat = 1 / metres`, with UVs in metres from `triplanarUV` or `planarUV`. Something shown
  once (a rug, a house front) gets UVs from 0 to 1 over its extent instead.
- Door leaves hang on a pivot object at the hinge, so they can swing in the viewer and in whatever imports the `.glb`.

## Looks

- **Renderer**: `WebGPURenderer`, ACES tone mapping, exposure around 6.5 with the sky and sun values in `main.js`.
  The picture is finished in a `RenderPipeline`: a first pass with normals feeds `GTAONode` at half resolution, the
  main pass takes it through `builtinAOContext` so that it only dims the baked light, and a faint bloom (0.07) is
  added around the windows. Keep the `GTAONode` to what light maps cannot resolve, the last few centimetres where
  things touch: `radius` 0.08 m, `scale` 0.7, and its output passed through `DenoiseNode` (`depthPhi` 0.05 for a
  scene in metres) into a half-resolution texture. With a longer reach it shades corners a second time and shows
  as grain and dark halos.
- **Frame rate**: the pixel ratio follows the frame time once the bake has finished (finer when there is time to
  spare, coarser when not), so the picture is as sharp as the machine allows.
- **Metal** reflects a small studio environment map at low intensity; nothing else uses an environment map, because
  the bake supplies the light. Scale that intensity every frame by the brightness of the room that sets the exposure
  (`envMapIntensity = 0.07 * brightness / BRIGHT_ROOM`, capped, eased like the exposure). At a fixed intensity the
  raised exposure of a dim room multiplies the studio, and brass looks lit from within and steel turns white. Keep
  metalness around 0.65 for brushed brass so that some of the baked light shows on it.
- **Sinks and basins** need depth: a flat plate on the worktop reads as a sheet of paper. Cut an opening in the
  worktop and cabinet with `prismGeo`'s holes and line it with a rim, sides and a bottom.
- **Procedural textures** are canvases drawn at load: herringbone parquet with roughness and normal maps, tiles,
  bouclé, linen, worktop. Keep these procedural: they tile cleanly and cost nothing to download.
- **Generated images** suit things seen once and wood grain. In the example they are four house fronts, a rug and
  oak, about 2 MB as JPEG in `viewer/public/textures/`.
  - Prompt for a flat, straight-on, evenly lit view with no shadows, no perspective and the subject filling the frame.
  - Make a grain texture seamless by cross-fading its edges, and scale its colour to the average you want.
  - Set `userData.albedo` to the image's average colour.
  - Keep personal details out of the prompts.
- **Outside the windows**: unlit boxes at street distance carrying the house-front images, and a ground plane far
  below. Their brightness is a plain factor tied to the sun's height. They take no part in the lighting.
- **Small things make it read as lived in**: books and jars on shelves (per-colour materials, not vertex colours),
  cushions, a plant, place settings, curtains as a wavy sheet, radiators with ribs, window casements and sills,
  skirting, door casings and handles.

## Walking

Pointer lock for looking, W A S D and arrows for moving, Shift to go faster, eye height 1.6 m. Collision is a point
test of the next position against the wall polygons, sills and fixtures; furniture does not block. A second mode shows
the flat from above without ceilings, with orbit controls. Room buttons drop the camera into a room, and
`#walk=<room>,<degrees>` in the URL does the same, which makes every check repeatable.

A click on a door swings it (0.7 s, eased), within arm's reach when walking. With the pointer locked the door in the
middle of the picture is used, marked by a small dot. A shut door blocks walking through its doorway polygon; if it
shut where the walker stands, doors are ignored until they have stepped out. Set every leaf to its shut angle when
it is built, or the ones that never open are drawn at angle 0. See [baked lighting](baked-lighting.md) for what a
moving door does to the light.

## Test hooks and dev endpoints

`window.viewer` exposes the camera, the walk state, the baker, `stats` (frame time, pixel ratio, gather points),
`show(part)` to look at one ingredient of the picture, and `capture(name)`, which posts the canvas to `/__render` so
that the dev server writes `out/renders/<name>.jpg`. `/__model` does the same for the exported `.glb`. Both exist only
in the dev server. `capture` draws twice with a short pause before reading the canvas, because the picture read back
can lag one frame behind; and count a light's `shadow.needsUpdate` as "still changing" only while that light is
visible, or the draw-on-demand loop never stops after sunset.

## Drawing only when something changes

Stop the animation loop (`renderer.setAnimationLoop(null)`) after a few frames in which nothing moved: not
walking or turning, no door swinging, no lamp fading, the light not settling or fading, the exposure not
changing, the sun's shadow map not waiting to be redrawn. Wake it on keys, clicks, wheel, slider input and
resize (capture listeners on `window`), on pointer moves only while dragging or with the pointer locked, and on
the orbit controls' `change`. On the first frame after waking, use a fixed step (1/60 s) and leave the frame-time
average alone, or the idle gap shows up as one huge step. Expose `viewer.wake()` for tests, and give the page
`viewer.marks`, the milliseconds at which each stage of opening finished (`performance.now()` at script start,
renderer ready, flat built, surroundings loaded, light set up, first frame, light settled).

## Export for Unreal or Blender

`export.js` rebuilds the scene from the batches' parts with the plain geometry: one node per element, one mesh per
material inside it named `element--material`, grouped under `architecture`, `ceilings`, `kitchen-and-bathrooms` and
`furniture`. Texture tiling is multiplied into the UVs, so no glTF extension is needed. Lighting is not exported.
Metres, +Y up; Unreal converts on import. Run the result through the Khronos glTF validator. Embedded photo textures
are written as PNG and make the file several megabytes larger.

## Serving it

Bind the dev server to `0.0.0.0`, pick a fixed port, register it where the user tracks local servers, and give the
loopback, `.local` and Tailscale addresses. Only localhost (or HTTPS) can run WebGPU.
