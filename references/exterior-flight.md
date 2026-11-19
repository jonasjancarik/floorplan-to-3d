# Modelling the view from the street

Choose detail by the route a person will take through the model. A textured elevation can work through a distant window. On an oblique approach, a bay window needs a curved face and side returns. At pavement height, the underside of its balcony, the kerb and the wheels of a parked car enter the picture. Keep the surveyed mesh where it already holds up at the intended distance.

## Read the building from three directions

Make a straight-on elevation to place openings and cornices, a plan view to locate roof lights, trees and cars, and vertical sections through the survey to measure projections and changes of level. A roof light and a dormer can look similar in plan. The section shows whether the glazing follows the pitch or stands upright. Street photographs or a façade repair drawing can settle details hidden from the air. Record which dimensions came from the plan or survey and which finishes were estimated.

## Replace the survey surface cleanly

In the Prague example, clip in plan metres, with the apartment floor at height zero. When writing the Y-up GLB, map each plan point `(x, y, height)` to `(x, height, -y)`. The viewer can then place both the exterior and the flat at the same origin.

Clip the visible survey triangles where the new surfaces meet them. A centroid test can leave a sliver across a window, while deleting an entire intersecting triangle can open a wedge in the house next door. Use the [NumPy clipper](../assets/clip_survey_mesh.py) before repacking the photo atlas. Its `subtract_boxes(points, uv, faces, tex_faces, boxes)` accepts separate position and texture indices and returns the updated arrays in that order. Each box is a pair of minimum and maximum corners in the same axes as the points. The helper splits crossing edges and interpolates their UVs. For a frontage oblique to the plan axes, transform the points into a wall-aligned frame for clipping and transform the resulting points back.

Inspect each party wall at a grazing angle. If the clipped survey edge wanders behind the modelled wall, bring just the nearby survey vertices onto the new façade line and taper the adjustment into the original mesh. At the foot of the building, connect the graded pavement to the recessed doorstep. Daylight showing under a door can come from this short missing surface.

## Build the close views

- **Façades.** Trace the openings on a rectified elevation. Recess the glazing and give sills, cornices and balconies their measured depth. Texture the front from the elevation and sample plaster or stone for the side returns. Projecting a photographed window bar across a reveal produces a streak. Remove old photographed shadows where new mouldings will cast the same shadow.
- **Roofs.** Fit planes through the eaves and ridge, then place dormer cheeks, roof windows, gutters and chimney groups from the survey. Mask roof lights and chimneys before sampling the tile colour beneath them. Keep an intricate rear stair roof or inset terrace from the original mesh when it is better documented there.
- **Courtyards.** Take ground heights on both sides of a retaining wall. Close the vertical step and fill any ground hidden beneath a removed canopy. Match a nearby tree's crown height and spread, then build a trunk, branches and leaf clusters with gaps that reveal the wall behind them. A coarse canopy volume can still serve the daylight calculation.
- **Parked cars.** Trace the observed parking rows, including the angles, gaps and approximate colours. Replace the old car shapes and their photographic footprints together, then seat the tyres on the road camber. Inspect at wheel height. Recessed rims, sidewall profiles, door seams and handles below the glazing matter at that distance. A panorama made from the local façades can supply moving reflections in glass and paint. Preserve the licence and credit for reused vehicle bodies.

## Connect the apartment to its own façade

Use the plan's opening rectangles, sill heights and heads to cut the occupied storey. End each reveal at the existing wall face so the viewer sees the actual room and its casements. Keep decorative glazing for other flats in a separate part of the mesh. Match the outside faces of the live frames to the façade's daylight while retaining the room lighting on the inside. At a box window, sight the approach through a clear pane in **both** casements. An oblique path can clear the outer sash and hit the inner mullion.

For free flight, start at the current eye position, including any lean over the sill. Keep walking collisions and eye height in walk mode. To retrace a straight flight exactly, turn the yaw by half a revolution and reverse the pitch. On returning indoors, set exposure from the brightness of the room containing the camera. When the person switches to walking, use the point beneath the camera if it is inside a room and clear of obstacles. Keep the last safe indoor position for a switch made outside.

## Verify the return trip

1. Cast a grid of short rays from outside the façade through **each** intended opening, normal to the wall and ending just inside it. Every ray through the clear aperture should pass. Exclude the separate apartment model and daylight occluders from this shell test. Probe the jambs, sill and head beside each opening as positive controls. In the worked example, a 9 × 11 grid passed through each of four openings and the surrounding plaster registered hits.
2. In the live viewer, fly out, turn around in the street and fly back through the same pane. Switch to walking. You should stand on the floor beneath the re-entry position and be able to continue into that room. Inspect the façade joins from the side and the roof from above. A room preset can be useful for setup, but using it for the return skips the crossing being tested.
3. Open the scenery GLB's default scene and check that it contains the visible exterior. Put simplified daylight occluders in a separate scene and keep both exports aligned to the same origin. A glTF validator checks the file structure. Verify compressed textures in the actual loader and report any importers tested separately.

## Worked implementation

In `~/projects/melnicka-floorplan`, `build_surroundings.py` assembles the export. The façade and courtyard work is in `facade_geometry.py`, `courtyard_geometry.py` and `courtyard_surfaces.py`. For roofs, cars and pavements, see `street_roofs.py`, `parked_cars.py`, `vehicle_details.py` and `street_geometry.py`. The host building and window cuts are in `own_building.py` and `own_roof.py`. Window approaches, flight and the transition to walking are in `viewer/src/main.js`. These modules contain site-specific traces.
