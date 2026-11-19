# The real site: true sun and real surroundings

Worked example: `~/projects/melnicka-floorplan/` (`SITE` in `build_plan.py`, `build_surroundings.py`, `build_fronts.py`,
`viewer/src/neighbourhood.js`, `viewer/src/sun.js`, and the outside parts of `viewer/src/bake.js`). The bundled `assets/` provide the earlier window-view generator and viewer modules. For the later
close-range exterior and flight implementation, see [Modelling the view from the street](exterior-flight.md).

Do this once the plan is right. It needs the address, the floor, and which rooms face the street. Ask for all three in
one go; a house number is the user's to give, and guessing from geometry only narrows it down.

## Finding where the flat is

Sheets rarely carry a north arrow, and an assumed "living room faces south" can be exactly wrong (here it faced north).

1. **House outline from the land register.** For Czech addresses the RÚIAN map service
   (`ags.cuzk.cz/arcgis/rest/services/RUIAN/Prohlizeci_sluzba_nad_daty_RUIAN/MapServer`) returns streets (layer 4),
   address points with house numbers (layer 1) and building outlines with storey counts (layer 3) for an envelope,
   in S-JTSK when asked with `outSR=5514`. Query by area, not by name.
2. **Compare depths.** Measure each candidate house's depth along its front and compare with the flat's depth from
   street wall to courtyard wall. Here that alone told the side of the street (14.1 m against 16.2 m).
3. **Which half of the house.** A stepped rear front, a stair bay or an unequal pair of gable ends decides it.
4. **Confirm against the photo model.** Draw the house front from the model as an orthophoto (sample each triangle
   densely enough for its size, splat by plan x and height, nearest wins) and overlay the plan's window positions.
   The four street windows landed within 7 cm, which also gives the floor's height from the window sills.
5. **True bearing.** S-JTSK's grid north is not true north (7.85° off in Prague). Convert two points to WGS84 and
   take the geodesic bearing.

Record the result in the plan generator as `site`: latitude, longitude, `plan_north` (bearing of plan +Y), the plan
origin and +X direction in the projected system, floor and street heights. Keep scene coordinates plan-aligned and turn
the sun into the plan; do not rotate the flat.

## Sun

`sun.js` takes `site`. Declination and the equation of time from the day of the year, clock time to solar time by
longitude and daylight saving, then east/north turned by `plan_north`. Let the time slider reach before sunrise and
after sunset in summer, and say in words where the sun is: it makes a north-facing room understandable at a glance.

## City photo models

Prague: IPR Praha publishes a textured mesh of the whole city (2023, about 5 cm per pixel, CC BY 4.0, credit
"data base © IPR Praha") as OBJ tiles of about 1.5 GB.

- The tile index is a feature layer with a `direct_download_url` per tile:
  `services5.arcgis.com/SBTXIEUGWbqzUecw/arcgis/rest/services/3D_mesh_klad/FeatureServer/0`. Query it with an
  envelope; the English geoportal page still says the data is "to come", the Czech one links the download map.
- The files sit on SharePoint, which returns a sign-in page unless the client keeps cookies across the redirect
  (`curl -L -c jar -b jar`, or a `CookieJar` opener).
- A tile holds some 24 parts named after their south-west corner in S-JTSK, each an OBJ in real coordinates
  (x, y in EPSG:5514, z above sea level) with one JPEG of about 8 500 px. Faces are `f v/vt/ v/vt/ v/vt/`.
- Large flat areas are a few big triangles, so anything that samples per triangle must adapt to triangle size.

Other cities publish similar meshes (often as OBJ, 3D Tiles or I3S); the steps below carry over.

## Cutting it down (`build_surroundings.py`)

1. Parse only the parts that reach into the area; cache the arrays, a part takes seconds to parse.
2. Transform into the viewer's coordinates (plan metres, floor at 0, plan +Y on −Z), so the viewer adds no transform.
3. Keep faces within the required view distance (about 170 m here). Use triangle bounds to find candidates for the
   apartment cut. Where the cut meets a visible neighbouring façade, split the triangles as described in the
   [exterior geometry guide](exterior-flight.md).
4. Repack the textures. Faces sharing texture corners form a patch (connected components); crop each patch from the
   source with 2 px of padding, scale it by distance (full within 45 m, half to 110 m, a quarter beyond), and pack
   rows into 4096 px sheets, tallest first. Tens of thousands of patches pack in seconds this way; three sheets
   covered 170 m.
5. Split the mesh into squares of about 70 m per sheet, so that frustum culling drops what is out of view.
6. Write a `.glb` by hand (positions, UVs, indices, `KHR_materials_unlit`). Make it small and light on the GPU:
   - **Corners as 16-bit numbers** (`KHR_mesh_quantization`): per mesh, store the corners as normalised int16
     around the mesh's middle and put the middle and half-size into the node's translation and scale; texture
     corners as normalised uint16. Within a 70 m piece that is 2 mm, and three.js reads it with no decoder.
     Better than Draco or meshopt here: nothing to decode, and it shrinks GPU memory too.
   - **Photos as KTX2** (`KHR_texture_basisu`, `basisu -etc1s -quality 255 -mipmap -ktx2 -srgb`, cached by a
     hash of the pixels): they stay compressed in graphics memory (about 25 MB instead of about 220 MB for three
     4096 px sheets with mipmaps). ETC1S was sharp enough for 5 cm aerial photos; UASTC keeps more fine detail
     but is about four times larger. Fall back to JPEG when `basisu` is missing.
   - The viewer needs `KTX2Loader` with the transcoder from `three/examples/jsm/libs/basis/`, served at `/basis/`
     by a small Vite plugin (see `assets/viewer/vite.config.js`), and `detectSupport(renderer)` after the renderer
     is ready. Here the file went from 29 MB to 21 MB.
7. For the light, write `blockers`: the houses within 120 m without the flat's own house, thinned with
   `fast-simplification` (call it repeatedly; it stops early on open edges) to 40 000 triangles, each corner with
   the photo's colour there. Beyond that add the rest of the tile as a height surface: the highest point per 8 m
   square, joined corner to corner. A hill half a kilometre away decides when the evening sun goes.

## Sharp fronts near the windows (`build_fronts.py`)

`NOTES` in the bundled copy describes that project's houses for the briefs; replace it.

The photo model is about 5 cm per pixel from the air, so the fronts across a street look smeared from a window.
Rebuild only the few that fill most of the view; the rest can stay soft.

1. **Find them by looking out.** From each window, splat the photo model's triangles into a picture of
   directions (0.5° a pixel, nearest wins), keep near-vertical hits, and give each hit to the nearest edge of the
   land register's building outlines (merge collinear edges first). Rank edges by solid angle; here seven fronts
   held 92% of the view.
2. **Place each as a flat wall** on its outline edge, moved to the area-weighted median distance of the model's
   faces in front of it. Take the eaves from an occupancy grid of near-vertical faces in the wall's plane (the top
   of the cells more than 60% covered), and the foot from the ground in front.
3. **Flatten its photo**: rasterise every face of the front (by barycentric coordinates, so large faces are
   filled), the one further out winning; fill holes from the nearest photographed pixel.
4. **Redraw it** with image generation: the flattened photo as the image to redraw, Street View shots of street
   fronts as a guide to detail, a brief that says the aspect ratio and what must stay (every window, floor and
   cornice, the colours) and what must go (trees, cars, people, signs, house numbers). Keep the address out of
   prompts. Seven fronts took seven generations, none redone.
5. **Check each against its photo**: correlate column and row profiles of darkness, per quarter of the width,
   at the photo's scale. Accept up to about half a metre; a narrow front came back in a different aspect and was
   simply resized onto its wall.
6. **Match brightness to the photo** (per channel in linear light, over the upper floors, which trees do not
   hide): generated pictures come out evenly lit, while the photo model carries the light of the day it was
   flown, and a courtyard front in shade would otherwise glow beside its neighbours. The photo's tint can be
   wrong too (a front the owners know as ochre came out cream): where the colour is known, give the plaster
   that hue and saturation in L\*a\*b\* after the match and keep its lightness. Plaster separates from frames,
   glass and stone (no tint) and wood (strong tint) by b\* alone.
7. **Replace, don't cover**: drop the model's faces of each front (within 1.2 m of the wall, between its ends,
   above its foot) from both the shown mesh and the light blockers, then add the wall as one textured quad, and to
   the blockers in the picture's average linear colour.

## In the viewer

- Start fetching it as the first thing the page does, show the flat as soon as it is built, and parse the file
  once the renderer exists. Hold the first bake until it is in (or has failed), so the light is worked out once,
  with the houses in place; say so in the status line meanwhile. Fall back on made-up scenery when the file is
  missing.
- Draw it unlit, the photo times a daylight factor (0.12 here against indoor exposure).
- Keep it out of the pass that feeds contact shading: give that pass a camera of its own on layer 0 and put the
  surroundings on layer 1. `PassNode.setLayers` broke the render lists in r187.
- Seen from above, discard what stands between the eye and the flat (a cone from the eye, plus anything within a few
  metres of the eye). Slicing every house at floor level shows hollow shells and reads badly. A dark slab at floor
  level under the opened houses closes them.
- Window glass must receive shadows, or the sun lights a pane on the shaded side of the house and hazes the view.
- Credit the source in the panel.

## In the light

- **Sun shadows**: the blockers cast into the sun's shadow map; move the light back and widen its depth range to
  reach them (160 m here). The far surface is too far for that, so switch the sun off when a ray from above the
  roof ridge towards the sun hits it.
- **Bake**: the outside is not in the GPU BVH, because rays between points indoors and the window never reach it.
  Instead, on the CPU and for each window, make a small picture of the outlook (24 × 16 directions, four rays
  each): open sky, or a house front whose radiance is its colour times the sunlight (if a ray from it reaches the
  sun) and a share of the sky light, over π. Store the pictures after the light list and have the sky spots look up
  the direction they are seen from, in place of the bare sky function. Start light paths along the sun's rays only
  where the sun reaches the window, and weight sky paths by the same radiance.
- Report when the sun reaches each side: scan months and half hours and test a few points per window. Users ask
  exactly this ("does the living room ever get sun?").

## Faults met

| What it looked like | Cause | Fix |
|---|---|---|
| Download was a 60 kB "zip" | SharePoint sign-in page | Keep cookies across the redirect |
| Orthophoto of a façade was a sparse dot pattern | Fixed samples per triangle; façade triangles are metres wide | Sample by triangle size |
| View from the window washed out white | Glass lit by the sun through the house | Glass receives shadows |
| `Cannot destructure property 'object' of 'renderList[i]'`, 100 ms frames | `PassNode.setLayers` on the pre-pass | A second camera for that pass |
| From above: white voids and inside-out shells | Houses sliced at floor level are hollow | Cone cut towards the flat, dark slab below |
| Roof in the way from above although the cone was on | Sideways distance computed with the axis vector not normalised | Divide by the length once, not twice |
| Blockers stayed at 170 000 triangles | The thinning stops at open edges | Run it again until the target is met |
