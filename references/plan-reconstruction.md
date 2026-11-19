# Redrawing the plan

Worked example: `~/projects/melnicka-floorplan/build_plan.py` (about 480 lines) and the "How reliable the numbers are"
section of that project's `README.md`.

## Reading the sheets

- Look at every photo at full size before choosing a coordinate system. Sheets overlap, repeat rooms at different
  scales and sometimes disagree.
- Written dimensions beat anything measured off a photo. Photos of paper are skewed and curved; use them only for
  what has no number, and say so.
- Find **dimension chains** that should close: a row of rooms and walls along one facade, and an independent row
  along a corridor, must end on the same wall line. When two or three independent chains land on the same line to the
  millimetre, the reading is right. When they miss, look for the cause before spreading the error around.
- A small miss is often real geometry. In the example a room was 4 250 wide at one end and 4 330 at the other: the
  wall between two rooms was not square to the facades. The user spotted it; look for pairs of dimensions across the
  same room that differ.
- Renovation sheets colour-code walls (commonly red for new, yellow for removed). Decide with the user which state is
  drawn and whether everything was built. Once the state is fixed, draw all walls alike; the JSON can still record
  `existing` or `new`.
- Ceiling heights are written per room (`s.v.` on Czech sheets). Lowered ceilings, platforms and lofts are easy to
  miss and matter a lot in 3D.

## The generator

One script holds every number as named constants and tables, and writes all outputs. Use `uv` with `ezdxf`, `shapely`
and `matplotlib`.

```
ROOMS, WALLS_*, OPENINGS, PLATFORM, FIXTURES, FURNITURE   tables of rectangles and polygons in mm
build_geometry()   union the wall footprints, subtract openings, split into prisms
build_json(geo)    the model for 3D
build_dxf(geo)     layered drawing with dimensions and labels
render_png(doc)    preview through ezdxf's matplotlib backend
```

- **Coordinates**: millimetres, origin at an inside corner of a main room, +X along its window wall, +Y to the north,
  +Z up with the finished floor at 0. Write this into the JSON and the README.
- **Walls**: give each wall as a footprint rectangle (or a polygon when it is skewed), union them with shapely, then
  subtract the openings. Run `shapely.set_precision(geom, 0.1)` on the result: cutting a skewed wall leaves hair-thin
  slivers that make invalid polygons.
- **Prisms for 3D**: for each opening emit the piece of wall under the sill and the piece over the head as their own
  prisms with `z0`/`z1`, and cut the full-height wall at the opening's edges. The 3D side then only extrudes.
- **Openings** carry everything a door or window needs: footprint, sill, height, and for doors the hinge point, leaf
  length and closed and open angles.
- **Helper functions for anything not square**, for example `x_wall(y)` for a skewed wall, so every polygon that
  touches it stays consistent.
- **Furniture and fittings** go in as boxes with a material name, marked approximate. Keep loose furniture on a DXF
  layer that is off by default.

## The JSON model

This is the contract with the viewer and with any other engine.

```json
{
  "units": "mm", "coordinate_system": "...", "wall_height": 3300,
  "rooms":    [{ "id": "02", "name_en": "Living room", "ceiling_height": 3260, "area_m2": 24.8, "center": [x, y], "polygon": [[x, y], ...] }],
  "solids":   [{ "id": "wall-existing-0", "kind": "existing|new|low", "z0": 0, "z1": 3300, "polygon": [...], "holes": [] }],
  "openings": [{ "id": "D5r", "type": "door|window|passage|niche", "rect": [x0, y0, x1, y1], "polygon": [...], "sill": 0, "height": 1970,
                 "leaves": [{ "hinge": [x, y], "length": 800, "closed_angle": 90, "open_angle": 0 }] }],
  "platform": { "polygon": [...], "underside": 2100, "thickness": 150 },
  "fixtures": [{ "id": "kitchen-counter", "height": 900, "polygon": [...] }],
  "furniture": [{ "id": "sofa-seat", "material": "fabric_dark", "box": [x0, y0, x1, y1], "z": [0, 420] }],
  "lamps":    [{ "id": "lamp-living", "room": "02", "kind": "pendant|ceiling|shade", "at": [x, y, z], "power": 1 }]
}
```

Room polygons are the clear floor area between wall faces. The light baker uses them, the opening polygons and the
platform polygon to decide what is indoors, so they must not overlap the walls.

## The DXF

DXF R2013, millimetres, AIA-style layers: `A-WALL` and `A-WALL-PATT` (outline and fill), `A-WALL-LOW`, `A-DOOR`,
`A-GLAZ`, `A-FLOR-FIXT`, `A-FLOR-OVHD` (dashed, things overhead), `A-FURN` and `A-AREA` (off by default),
`A-ANNO-ROOM`, `A-ANNO-DIMS`, `A-ANNO-TAGS`. Add the dimension chains you used as real dimensions, so that the
drawing can be checked against the sheets.

## What to hand over with it

A README section with two lists: what was taken from written dimensions and closes, and a numbered list of what was
scaled or assumed, each with the value used and why. Typical entries: exterior wall thicknesses (rarely dimensioned),
partitions whose thickness follows only from neighbouring rooms, door positions that are not dimensioned, structural
openings against clear leaf widths, ceiling heights of merged rooms, anything placed from photos.
