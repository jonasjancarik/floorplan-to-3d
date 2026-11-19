---
name: floorplan-to-3d
description: Reconstruct photographed or scanned floor plans as dimensioned CAD and 3D models. Build or extend a three.js WebGPU walk-through with baked daylight, light maps, live sun and GLB export for Blender or Unreal. Use for apartment interiors and their real surroundings, including street and courtyard geometry, façades, roofs and flight through apartment windows.
---

# Floor plan to 3D walk-through

How to get from photographed drawings to a flat you can walk through in the browser. It comes from one finished
project, `~/projects/melnicka-floorplan` (November 2026): six phone photos of renovation sheets became a dimensioned
DXF, a JSON model, a WebGPU viewer with baked daylight at 60 frames a second, and a `.glb`. That project's `README.md`
and code are the worked example; read them when a step here is too brief.

The bundled code in `assets/viewer/` is that project's reusable core. Copy it in rather than rewriting it: the light
baker alone took most of the project's time to get right.

| Read this | When |
|---|---|
| [references/plan-reconstruction.md](references/plan-reconstruction.md) | Reading the sheets, writing the plan generator, the DXF and the JSON model |
| [references/viewer.md](references/viewer.md) | Building the three.js viewer: modules, materials, textures, the view outside, walking, export |
| [references/baked-lighting.md](references/baked-lighting.md) | Lighting: how the bake works, how to wire it in, and every fault met on the way |
| [references/real-surroundings.md](references/real-surroundings.md) | Placing the flat in the real world: finding the house and its bearing, true sun, and the street and courtyard from a city's 3D photo model, and sharp redrawn fronts for the houses nearest the windows |
| [Exterior geometry and window re-entry](references/exterior-flight.md) | Rebuilding surfaces seen from the street, modelling roofs, cars and planting, or flying out and back through a measured apartment window |

Related skills: `threejs-webgpu-performance` when the viewer is slow, `codex-imagegen` for generated textures, `cad`
only if the user wants solid-model CAD (STEP) rather than a drawing.

## Ask these before starting

For a new reconstruction, ask about the points below that the drawings and user have yet to settle. For work on an
existing viewer, start from its plan, site alignment and current controls.

1. **Which state should be drawn?** Renovation sheets show old, removed and new walls together, usually colour-coded.
   The user wanted the state after the renovation, and that was not what the sheets alone suggested.
2. **Was everything built as drawn?** One planned partition had not been built. Ask which walls and fittings differ
   from the sheets.
3. **What is it for?** A walk-through you move around in, or still images. These lead to different renderers: the
   project lost a day to a path tracer that makes beautiful stills and cannot be walked through.
4. **Where is it, which way do the windows face, and which floor?** Needed for the sun and for the view outside. The
   sheets may have no north arrow. Ask for the house number, the floor and which rooms face the street outright: an
   assumed direction was exactly wrong here, and the address unlocks the real surroundings.
5. **Are there photos of the real rooms?** They give the furniture, colours, floor pattern and what is seen through
   the windows.
6. **Where are the lamps, and should doors and lamps work?** Sheets rarely show lamps. If the walk-through should
   have doors that open and lamps that switch, say so early: the light baker handles both (see
   [baked lighting](references/baked-lighting.md)), and lamp positions belong in the plan model.
7. **Renderer and materials.** This user prefers WebGPU and procedural materials, with generated images where a
   procedural texture falls short. Check `MEMORY.md` for the current preference before asking.

## The order of work

Commit at the end of each step. Each one leaves something the user can open and judge.

1. **Read every sheet before drawing anything.** List the written dimensions, find chains that should add up, and
   note what conflicts. See [plan reconstruction](references/plan-reconstruction.md).
2. **Write one generator script that holds every number** and produces the DXF, the JSON model and a PNG preview.
   Nothing is ever drawn by hand, so a correction is one edit and one rerun.
3. **Show the preview and a numbered list of what was assumed or scaled off the photos.** Expect corrections here:
   the user knows the flat. Keep the list in the README under "check on site".
4. **Build the viewer from the JSON alone**: walls, floors, ceilings, openings, doors, windows, then furniture from
   the photos. Get walking, room buttons and the URL for a fixed viewpoint working before any lighting, because every
   later check uses them.
5. **Light it**: live sun with a shadow map, everything else baked. See [baked lighting](references/baked-lighting.md).
6. **Make it look real**: materials, textures, what is outside the windows, contact shading, a little bloom.
   When the address is known, use the real surroundings and the true sun: see
   [real surroundings](references/real-surroundings.md).
7. **Export the `.glb`** from the same geometry and check it with a glTF validator.
8. **Write the README** as you go: how to run it, how the light works, what is approximate, what is missing.

## Decisions that held up

- **A generator script, not a drawing.** Python with `uv`, `ezdxf` for the DXF, `shapely` to join walls and cut
  openings. Millimetres, origin at an inside corner of a main room, +Y to the north.
- **A JSON model between the plan and the 3D.** Wall pieces are already cut around openings (the bit under a sill and
  the bit over a door head are their own prisms), so the viewer and any other engine only extrude, never subtract.
- **three.js on WebGPU**, plain modules served by Vite, no framework. WebGPU only works on localhost or HTTPS; say so
  in the README, since the page will not run from another device over plain HTTP.
- **One mesh per material.** A small `Batch` class collects geometry per material and remembers which element each
  piece belongs to, which gives few draw calls for the viewer and one named node per element for the export.
- **Baked light by instant radiosity**, worked out in a compute shader in a few seconds whenever the sun, a door or
  the furniture changes. Walls, floors and ceilings store it in light maps, small objects at their vertices.
- **The sun stays a real light** with one large shadow map that is redrawn only on request, so its edges are crisp.
- **Unseen building around the flat**: slabs above and below and the neighbours' walls, drawn into shadows and the
  bake but not on screen. Without them sunlight and sky leak in along every joint.
- **Draw only while something changes.** The loop stops when nothing moves and wakes on input, so an idle page
  leaves the GPU alone (see [the viewer](references/viewer.md)).
- **Procedural textures for anything that tiles** (parquet, tiles, fabric), **generated images for things seen once**
  (house fronts opposite, a rug) and for wood grain.

## What was tried and dropped

| Tried | Why it went |
|---|---|
| Progressive path tracing (`three-gpu-pathtracer`) with a denoiser | Stills only; the user wanted to walk. The denoiser on WebGPU beside the WebGL tracer also crashed the GPU process. |
| Random light sampling per vertex | Every vertex saw different lights, so walls came out as a patchwork. A fixed list of lights shared by all points is smooth. |
| Light stored only at vertices | Needed 14 cm triangles everywhere and still gave jagged shade under shelves. Light maps on the flat surfaces fixed it and cut 200k triangles. |
| three.js `SSRNode` for the lacquered floor | Blotchy at this exposure and cost sharpness. |
| WebGL | Worked, but the user prefers WebGPU and the compute bake is far faster there. |

## Checking the work

Look at the result after every change that can be seen; most faults in this kind of project are visible long before
they are measurable.

- Give the page test hooks: `window.viewer = { walk, baker, stats, capture(name), show(part) }`. Move the camera by
  setting `viewer.walk.x/y/yaw/pitch`, wait for `viewer.baker.finished`, then take a screenshot.
- Check visible changes in the running WebGPU viewer, using the in-app browser when available. For GPU timings,
  run one active copy of the scene so competing renderers do not distort the measurement.
- Check the dark rooms as well as the bright ones, and once at three times the exposure
  (`viewer.renderer.toneMappingExposure *= 3`). Light leaks hide in bright rooms and stand out in a dark hallway.
- Crop screenshots and look closely at where surfaces meet: wall to ceiling, wall to floor, door frames, shelf ends.
- After a lighting change, compare the counts of indoor, outdoor and unlit gather points before and after; a refactor
  that should change nothing must leave them identical.
- Do not run a production build to test. The dev server reloads on save and a build can take minutes.

## Working with the user

- Answer questions before changing code, and commit in small steps with a body that says why.
- Say plainly what is scaled or guessed. A plan that looks exact but hides a guessed wall thickness is worse than one
  that lists it.
- Self-contained side jobs, such as generating texture images and wiring them in, can go to a cheaper model when the
  user has allowed delegation. Give it a short list of files it may touch and keep the lighting work yourself.
- Never put the address, the user's name or other personal details into image-generation prompts or any other
  outside service; describe buildings generically.
- What only the user can supply (measurements on site, what is in rooms with no photos) goes in a short list at the
  end of each report, not into guesses in the model.
