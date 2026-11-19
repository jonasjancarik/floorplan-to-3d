# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "fast-simplification"]
# ///
"""The street and the courtyard around the flat, cut out of IPR's 3D photo model of Prague.

    uv run build_surroundings.py

IPR Praha publishes a textured mesh of the whole city as open data (photographed in summer
2023, about 5 cm per pixel, CC BY 4.0, "data base © IPR Praha"), in tiles of about 1.5 GB:
https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh
The tile is downloaded once into data/ipr/ (not kept in git). From it this script writes
viewer/public/surroundings.glb, in the viewer's own coordinates (metres, +Y up, the flat's
floor at 0, plan +Y on -Z), holding

  - `surroundings`: everything within 170 m of the flat with its photo texture, sharpest
    near the flat and coarser further out, with the flat's own stretch of the house cut away;
  - `blockers`: the same shapes within 120 m in a few tens of thousands of triangles, each
    corner carrying the colour of the surface there, and beyond that the rest of the tile
    as a coarse surface over the rooftops and the hill (Petřín rises a hundred metres
    within half a kilometre to the west). The viewer uses it to work out where the houses
    and the hill hide the sun and the sky, and what light the houses throw back.

Where the flat is comes from `site` in out/melnicka-floorplan.json (see build_plan.py).
"""
import hashlib
import http.cookiejar
import io
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import fast_simplification
import numpy as np
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

HERE = Path(__file__).parent
DATA = HERE / "data" / "ipr"
TILE = "ML-57-13"
TILE_URL = "https://iprprahaeu.sharepoint.com/:u:/s/SPIsharing/EafVuO9-fI1LvJk8lTMgI5sBDiBv367IN41Rm8Nm6_ka6g?download=1"
OUT = HERE / "viewer" / "public" / "surroundings.glb"

CENTRE = (4.5, 6.5)                    # middle of the flat, plan metres
BANDS = [(45, 1.0), (110, 0.5), (170, 0.25)]      # (out to this distance in m, share of the photo's sharpness kept)
BLOCKERS_REACH = 120                   # m
BLOCKERS_TRIANGLES = 40000
FAR_CELL = 8                           # m: beyond the blockers' reach only the highest point of each square this size is kept
FAR_COLOUR = (0.16, 0.17, 0.14)        # roofs and trees far away, as linear light
CHUNK = 70                             # m: the surroundings are cut into squares this size, so that only those in view are drawn
HOUSE = (-9.4, 9.25, -1.5, 15.0)       # our house in plan metres: x0, x1, y0, y1 (the flat is its x >= -0.2 half)
CUT = (-0.25, 9.2, -1.5, 15.0, -0.7, 4.0)         # cut away around the flat: plan x0, x1, y0, y1, then height from, to
ATLAS = 4096
PAD = 2                                # px of the photo kept around each patch
BASISU_OPTIONS = "-etc1s -quality 255 -mipmap -ktx2 -srgb"
FRONT_BASISU_OPTIONS = BASISU_OPTIONS     # the redrawn house fronts (see build_fronts.py)
FRONT_LONGEST = 2048                       # px: a redrawn picture longer than this is scaled down before it is fitted to its wall


def fetch():
    """The tile from IPR. SharePoint hands the file over only to a client that keeps its cookie."""
    target = DATA / f"{TILE}.zip"
    if target.exists():
        return target
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"downloading {TILE}.zip (1.5 GB) from IPR ...")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    with opener.open(TILE_URL) as response, open(target.with_suffix(".part"), "wb") as out:
        while chunk := response.read(1 << 22):
            out.write(chunk)
    target.with_suffix(".part").rename(target)
    return target


def parts(archive, site):
    """Every part of the tile as (name, corners, texture corners, faces, near). Only the parts
    that reach into the area around the flat are read in full; of the others just the corners."""
    origin = np.array(site["origin_sjtsk"])
    reach = BANDS[-1][0] + 12
    cache = DATA / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    for name in sorted(n[:-9] for n in archive.namelist() if n.endswith("-mesh.obj")):
        west, south = (float(v) for v in name.replace("--", " -").split())                 # named after its south-west corner
        near = west - reach < origin[0] < west + 330 + reach and south - reach < origin[1] < south + 330 + reach   # parts are at most 310 m across
        full, corners_only = cache / f"{name}.npz", cache / f"{name}-corners.npy"
        if near and full.exists():
            d = np.load(full)
            V, VT, F = d["V"], d["VT"], d["F"]
        elif not near and corners_only.exists():
            V, VT, F = np.load(corners_only), None, None
        else:
            v, vt, f = [], [], []
            for line in archive.read(name + "-mesh.obj").split(b"\n"):
                if line.startswith(b"v "):
                    v.append(line[2:])
                elif near and line.startswith(b"vt "):
                    vt.append(line[3:])
                elif near and line.startswith(b"f "):
                    f.append(line[2:].replace(b"/", b" "))
            V = np.array(b" ".join(v).split(), dtype=np.float64).reshape(-1, 3)
            if near:
                VT = np.array(b" ".join(vt).split(), dtype=np.float64).reshape(-1, 2)
                F = np.array(b" ".join(f).split(), dtype=np.int64).reshape(-1, 6) - 1      # corner, texture corner, three times
                np.savez(full, V=V, VT=VT, F=F)
            else:
                VT = F = None
                np.save(corners_only, V)
        yield name, V, VT, F, near and bool((np.linalg.norm(V[:, :2] - origin, axis=1) < reach).any())


def main():
    import build_fronts                    # imports this file in turn, so not at the top
    site = json.loads((HERE / "out" / "melnicka-floorplan.json").read_text())["site"]
    fronts = build_fronts.rebuilt()        # house fronts seen from the windows, rebuilt as flat walls with sharp pictures
    origin, ux = np.array(site["origin_sjtsk"]), np.array(site["x_axis_sjtsk"])
    uy = np.array([-ux[1], ux[0]])
    archive = zipfile.ZipFile(fetch())
    Image.MAX_IMAGE_PIXELS = None

    patches = []              # one per connected patch of the photo that is kept
    shown = []                # per part: corners in plan metres, texture corners, faces, patch of each face
    solid_points, solid_colours, solid_faces = [], [], []
    far = []                  # corners of everything, for the coarse surface far away
    for name, V, VT, F, near in parts(archive, site):
        d = V[:, :2] - origin
        P = np.stack([d @ ux, d @ uy, V[:, 2] - site["floor_level"]], axis=1)              # plan x, plan y, height above our floor
        far.append(P.astype(np.float32))
        if not near:
            continue
        photo = Image.open(io.BytesIO(archive.read(name + "-texture-0.jpg"))).convert("RGB")
        size = np.array(photo.size)
        tri, tex = F[:, 0::2], F[:, 1::2]
        corners = P[tri]
        middle = corners.mean(axis=1)
        away = np.linalg.norm(middle[:, :2] - CENTRE, axis=1)
        low, high = corners.min(axis=1), corners.max(axis=1)
        ours = (middle[:, 0] > HOUSE[0]) & (middle[:, 0] < HOUSE[1]) & (middle[:, 1] > HOUSE[2]) & (middle[:, 1] < HOUSE[3])
        in_cut = ours & (high[:, 0] > CUT[0]) & (low[:, 0] < CUT[1]) & (high[:, 1] > CUT[2]) & (low[:, 1] < CUT[3]) \
            & (high[:, 2] > CUT[4]) & (low[:, 2] < CUT[5])
        replaced = np.zeros(len(tri), bool)          # faces of the fronts that are rebuilt, shown and lit as flat walls instead
        for front in fronts:
            replaced |= build_fronts.belongs(front, corners)
        keep = (away < BANDS[-1][0]) & ~in_cut & ~replaced
        if not keep.any():
            continue

        # for the light: plain shapes with a colour at each corner, without our own house
        solid = (away < BLOCKERS_REACH) & ~ours & ~replaced
        used, back = np.unique(tri[solid], return_inverse=True)
        first = np.full(len(V), -1)
        first[tri[solid].ravel()[::-1]] = tex[solid].ravel()[::-1]                          # a texture corner for each corner
        at = (VT[first[used]] * [1, -1] + [0, 1]) * size
        pixels = np.asarray(photo)[np.clip(at[:, 1].astype(int), 0, size[1] - 1), np.clip(at[:, 0].astype(int), 0, size[0] - 1)]
        solid_faces.append(back.reshape(-1, 3) + sum(len(p) for p in solid_points))
        solid_points.append(P[used])
        solid_colours.append(pixels)

        # patches of the photo: faces that share texture corners
        tex_kept = tex[keep]
        n, label = connected_components(coo_matrix((np.ones(len(tex_kept) * 2), (np.r_[tex_kept[:, 0], tex_kept[:, 1]],
                                                    np.r_[tex_kept[:, 1], tex_kept[:, 2]])), shape=(len(VT), len(VT))), directed=False)
        of_face = label[tex_kept[:, 0]]
        ids, of_face = np.unique(of_face, return_inverse=True)
        px = (VT[tex_kept] * [1, -1] + [0, 1]) * size                                     # pixel places, y down
        order = np.argsort(of_face)
        starts = np.r_[0, np.flatnonzero(np.diff(of_face[order])) + 1]
        x0 = np.minimum.reduceat(px[order, :, 0].min(axis=1), starts)
        x1 = np.maximum.reduceat(px[order, :, 0].max(axis=1), starts)
        y0 = np.minimum.reduceat(px[order, :, 1].min(axis=1), starts)
        y1 = np.maximum.reduceat(px[order, :, 1].max(axis=1), starts)
        nearest = np.minimum.reduceat(away[keep][order], starts)
        base = len(patches)
        for k in range(len(ids)):
            keep_share = next(share for reach, share in BANDS if nearest[k] < reach)
            box = (max(0, int(np.floor(x0[k])) - PAD), max(0, int(np.floor(y0[k])) - PAD),
                   min(size[0], int(np.ceil(x1[k])) + PAD), min(size[1], int(np.ceil(y1[k])) + PAD))
            patches.append(dict(photo=len(shown), box=box, share=keep_share))
        shown.append(dict(photo=photo, P=P, VT=VT, tri=tri[keep], tex=tex_kept, patch=of_face + base, size=size))
        print(f"{name}: {keep.sum()} faces kept in {len(ids)} patches")

    # ---- pack the patches into new images, row by row, tallest first
    for p in patches:
        w, h = p["box"][2] - p["box"][0], p["box"][3] - p["box"][1]
        p["share"] = min(p["share"], (ATLAS - 2) / max(w, h))
        p["w"], p["h"] = max(1, round(w * p["share"])), max(1, round(h * p["share"]))
    sheets, x, y, row = [], 0, 0, 0
    for p in sorted(patches, key=lambda p: -p["h"]):
        if x + p["w"] > ATLAS:
            x, y, row = 0, y + row, 0
        if y + p["h"] > ATLAS or not sheets:
            sheets.append(Image.new("RGB", (ATLAS, ATLAS)))
            x, y, row = 0, 0, 0
        source = shown[p["photo"]]["photo"].crop(p["box"])
        sheets[-1].paste(source if p["share"] == 1 else source.resize((p["w"], p["h"]), Image.LANCZOS), (x, y))
        p["sheet"], p["at"] = len(sheets) - 1, (x, y)
        x, row = x + p["w"], max(row, p["h"])
    used_height = y + row
    if used_height < ATLAS:
        sheets[-1] = sheets[-1].crop((0, 0, ATLAS, 1 << (used_height - 1).bit_length()))

    # ---- one mesh per image, in the viewer's coordinates
    of_sheet = np.array([p["sheet"] for p in patches])
    meshes = {}               # (image, square of ground) -> its corners and faces
    for part in shown:
        corner, tex_corner = part["tri"].ravel(), part["tex"].ravel()
        patch = np.repeat(part["patch"], 3)
        box = np.array([patches[k]["box"][:2] for k in range(patch.min(), patch.max() + 1)])[patch - patch.min()]
        share = np.array([patches[k]["share"] for k in range(patch.min(), patch.max() + 1)])[patch - patch.min()]
        at = np.array([patches[k]["at"] for k in range(patch.min(), patch.max() + 1)])[patch - patch.min()]
        px = (part["VT"][tex_corner] * [1, -1] + [0, 1]) * part["size"]
        place = (px - box) * share[:, None] + at
        middle = part["P"][part["tri"]].mean(axis=1)
        square = np.repeat(np.floor(middle[:, 0] / CHUNK) * 1000 + np.floor(middle[:, 1] / CHUNK), 3)
        sheet = of_sheet[patch]
        for s, q in {(int(a), float(b)) for a, b in zip(sheet[::3], square[::3])}:
            mine = (sheet == s) & (square == q)
            mesh = meshes.setdefault((s, q), dict(sheet=s, points=[], places=[], faces=[], count=0))
            pairs, back = np.unique(np.stack([corner[mine], tex_corner[mine]], axis=1), axis=0, return_inverse=True)
            which = np.empty(len(pairs), dtype=np.int64)
            which[back] = np.flatnonzero(mine)
            P = part["P"][pairs[:, 0]]
            mesh["points"].append(np.stack([P[:, 0], P[:, 2], -P[:, 1]], axis=1))
            mesh["places"].append(place[which] / sheets[s].size)
            mesh["faces"].append(back.reshape(-1, 3) + mesh["count"])
            mesh["count"] += len(pairs)

    # ---- the plain shapes for the light, thinned out
    points, faces = np.concatenate(solid_points), np.concatenate(solid_faces)
    colours = (np.concatenate(solid_colours) / 255.0) ** 2.2                               # to linear light
    thin_points, thin_faces = points.astype(np.float32), faces.astype(np.int32)
    for _ in range(4):                                                                     # it stops early at the many open edges
        if len(thin_faces) <= BLOCKERS_TRIANGLES * 1.1:
            break
        thin_points, thin_faces = fast_simplification.simplify(thin_points, thin_faces, target_count=BLOCKERS_TRIANGLES, agg=9)
    _, nearest = cKDTree(points).query(thin_points, k=4)
    thin_colours = colours[nearest].mean(axis=1)

    # ---- far away: the highest point in each square of ground, joined into one surface
    P = np.concatenate(far)
    cell = np.floor(P[:, :2] / FAR_CELL).astype(int)
    low = cell.min(axis=0)
    shape = cell.max(axis=0) - low + 1
    height = np.full(shape, -np.inf)
    np.maximum.at(height, tuple((cell - low).T), P[:, 2])
    padded = np.pad(height, 1, constant_values=-np.inf)
    corner_height = np.maximum.reduce([padded[:-1, :-1], padded[1:, :-1], padded[:-1, 1:], padded[1:, 1:]])   # at each corner, the highest square around it
    ix, iy = np.meshgrid(np.arange(shape[0] + 1), np.arange(shape[1] + 1), indexing="ij")
    far_points = np.stack([(ix + low[0]) * FAR_CELL, (iy + low[1]) * FAR_CELL, corner_height], axis=-1).reshape(-1, 3)
    index = (ix * (shape[1] + 1) + iy)
    a, b, c, e = index[:-1, :-1], index[1:, :-1], index[1:, 1:], index[:-1, 1:]
    centre_x, centre_y = (ix[:-1, :-1] + low[0] + 0.5) * FAR_CELL, (iy[:-1, :-1] + low[1] + 0.5) * FAR_CELL
    wanted = np.isfinite(height) & (np.hypot(centre_x - CENTRE[0], centre_y - CENTRE[1]) > BLOCKERS_REACH - FAR_CELL)
    far_faces = np.concatenate([np.stack([a[wanted], b[wanted], c[wanted]], axis=1), np.stack([a[wanted], c[wanted], e[wanted]], axis=1)])
    used, back = np.unique(far_faces, return_inverse=True)
    far_points, far_faces = far_points[used], back.reshape(-1, 3)
    print(f"for the light: {len(faces)} faces nearby thinned to {len(thin_faces)}, and {len(far_faces)} far away")

    # ---- the rebuilt fronts: a flat wall each, carrying its picture; for the light, the same
    # wall in the picture's average colour
    shown, textures = list(meshes.values()), [(sheet, BASISU_OPTIONS) for sheet in sheets]
    wall_points, wall_colours, wall_faces = [], [], []
    for front in fronts:
        left, right = np.array(front["left"]), np.array(front["right"])
        corners = np.array([[*left, front["bottom"]], [*right, front["bottom"]], [*right, front["top"]], [*left, front["top"]]])
        picture = front["picture"]
        scale = min(1, FRONT_LONGEST / max(picture.size))
        width = max(4, round(picture.width * scale / 4) * 4)
        height = max(4, round(width * (front["top"] - front["bottom"]) / np.linalg.norm(right - left) / 4) * 4)
        picture = picture.resize((width, height), Image.LANCZOS)
        shown.append(dict(sheet=len(textures), name=front["id"], points=[corners[:, [0, 2, 1]] * [1, 1, -1]],
                          places=[np.array([[0, 1], [1, 1], [1, 0], [0, 0]], float)], faces=[np.array([[0, 1, 2], [0, 2, 3]])]))
        textures.append((picture, FRONT_BASISU_OPTIONS))
        colour = ((np.asarray(picture) / 255.0) ** 2.2).reshape(-1, 3).mean(axis=0)               # as linear light, like the blockers' corners
        wall_faces.append(np.array([[0, 1, 2], [0, 2, 3]]) + 4 * len(wall_points))
        wall_points.append(corners)
        wall_colours.append(np.tile(colour, (4, 1)))
        print(f"{front['id']}: wall {np.linalg.norm(right - left):.1f} x {front['top'] - front['bottom']:.1f} m, picture {width} x {height} px, "
              f"average colour {np.round(colour, 3).tolist()}")

    solid_points = np.concatenate([thin_points, far_points, *wall_points])
    solid_colours = np.concatenate([thin_colours, np.tile(FAR_COLOUR, (len(far_points), 1)), *wall_colours])
    solid_faces = np.concatenate([thin_faces, far_faces + len(thin_points), *(f + len(thin_points) + len(far_points) for f in wall_faces)])
    write_glb(shown, textures, np.stack([solid_points[:, 0], solid_points[:, 2], -solid_points[:, 1]], axis=1), solid_colours, solid_faces)


def gpu_texture(sheet, options=BASISU_OPTIONS):
    """A photo sheet as a KTX2 file in Basis Universal's ETC1S format, with its mipmaps, or None
    when the `basisu` tool is not installed (brew install basis_universal). The graphics card
    keeps it compressed, a quarter of the memory of the same picture from a JPEG, and the file
    is a little smaller too. Encoding takes about a minute a sheet, so results are kept in
    data/ipr/cache/ktx2 under a hash of the picture."""
    tool = shutil.which("basisu")
    if not tool:
        return None
    raw = sheet.tobytes()
    target = DATA / "cache" / "ktx2" / f"{hashlib.sha1(raw + repr(sheet.size).encode() + options.encode()).hexdigest()}.ktx2"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as work:
            png = Path(work) / "sheet.png"
            sheet.save(png)
            subprocess.run([tool, *options.split(), "-output_file", str(Path(work) / "sheet.ktx2"), str(png)],
                           check=True, stdout=subprocess.DEVNULL)
            shutil.move(Path(work) / "sheet.ktx2", target)
    return target.read_bytes()


def quantised(points):
    """Corners as 16-bit numbers (KHR_mesh_quantization), with the node's translation and scale
    that turn them back into metres: a millimetre or two of precision over a 70 m square, in
    two thirds of the room (8 bytes a corner, padded, against 12)."""
    low, high = points.min(axis=0), points.max(axis=0)
    middle, half = (low + high) / 2, np.maximum((high - low) / 2, 1e-6)
    q = np.zeros((len(points), 4), dtype=np.int16)
    q[:, :3] = np.round((points - middle) / half * 32767)
    return q, middle.tolist(), half.tolist()


def write_glb(meshes, textures, solid_points, solid_colours, solid_faces):
    """A .glb with unlit textured meshes under `surroundings` (each mesh names its image in `textures`,
    a list of (picture, basisu options)), and `blockers` with corner colours."""
    chunks, views, accessors = [], [], []

    def view(data, target=None, stride=None):
        offset = sum(len(c) for c in chunks)
        chunks.append(data + b"\0" * (-len(data) % 4))
        views.append(dict(buffer=0, byteOffset=offset, byteLength=len(data), **({"target": target} if target else {}),
                          **({"byteStride": stride} if stride else {})))
        return len(views) - 1

    def accessor(array, kind, component, target, bounds=False, normalized=False, stride=None, columns=None):
        array = np.ascontiguousarray(array)
        shown = array[:, :columns] if columns else array
        accessors.append(dict(bufferView=view(array.tobytes(), target, stride), componentType=component, count=len(array), type=kind,
                              **({"normalized": True} if normalized else {}),
                              **({"min": shown.min(axis=0).tolist(), "max": shown.max(axis=0).tolist()} if bounds else {})))
        return len(accessors) - 1

    gltf = dict(asset=dict(version="2.0", generator="build_surroundings.py", copyright="data base © IPR Praha, CC BY 4.0"),
                extensionsUsed=["KHR_materials_unlit", "KHR_mesh_quantization"], extensionsRequired=["KHR_mesh_quantization"],
                scene=0, scenes=[dict(nodes=[0, 1])],
                nodes=[dict(name="surroundings", children=[]), dict(name="blockers", mesh=len(meshes))],
                meshes=[], materials=[], textures=[], images=[], samplers=[dict(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071)])
    for s, (sheet, options) in enumerate(textures):
        ktx2 = gpu_texture(sheet, options)
        if ktx2:
            gltf["images"].append(dict(bufferView=view(ktx2), mimeType="image/ktx2"))
            gltf["textures"].append(dict(sampler=0, extensions=dict(KHR_texture_basisu=dict(source=s))))
            for key in ("extensionsUsed", "extensionsRequired"):
                if "KHR_texture_basisu" not in gltf[key]:
                    gltf[key].append("KHR_texture_basisu")
        else:
            jpeg = io.BytesIO()
            sheet.save(jpeg, "JPEG", quality=84, subsampling=1)
            gltf["images"].append(dict(bufferView=view(jpeg.getvalue()), mimeType="image/jpeg"))
            gltf["textures"].append(dict(source=s, sampler=0))
        gltf["materials"].append(dict(name=f"photo-{s}", pbrMetallicRoughness=dict(baseColorTexture=dict(index=s), metallicFactor=0, roughnessFactor=1),
                                      extensions=dict(KHR_materials_unlit={})))
    if not shutil.which("basisu"):
        print("basisu not found: the photos are stored as JPEG (brew install basis_universal for GPU-compressed textures)")
    for k, mesh in enumerate(meshes):
        count = sum(len(p) for p in mesh["points"])
        corners, middle, half = quantised(np.concatenate(mesh["points"]))
        places = np.round(np.clip(np.concatenate(mesh["places"]), 0, 1) * 65535).astype(np.uint16)
        name = mesh.get("name", f"surroundings-{k}")
        gltf["meshes"].append(dict(name=name, primitives=[dict(
            attributes=dict(POSITION=accessor(corners, "VEC3", 5122, 34962, True, True, 8, 3),
                            TEXCOORD_0=accessor(places, "VEC2", 5123, 34962, normalized=True)),
            indices=accessor(np.concatenate(mesh["faces"]).astype(np.uint16 if count < 65536 else np.uint32).ravel(), "SCALAR",
                             5123 if count < 65536 else 5125, 34963), material=mesh["sheet"])]))
        gltf["nodes"].append(dict(name=name, mesh=k, translation=middle, scale=half))
        gltf["nodes"][0]["children"].append(len(gltf["nodes"]) - 1)
    gltf["materials"].append(dict(name="blockers", pbrMetallicRoughness=dict(metallicFactor=0, roughnessFactor=1)))
    gltf["meshes"].append(dict(name="blockers", primitives=[dict(
        attributes=dict(POSITION=accessor(solid_points.astype(np.float32), "VEC3", 5126, 34962, True),
                        COLOR_0=accessor(solid_colours.astype(np.float32), "VEC3", 5126, 34962)),
        indices=accessor(solid_faces.astype(np.uint32).ravel(), "SCALAR", 5125, 34963), material=len(textures))]))
    binary = b"".join(chunks)
    gltf["bufferViews"], gltf["accessors"], gltf["buffers"] = views, accessors, [dict(byteLength=len(binary))]
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as out:
        out.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(binary)))
        out.write(struct.pack("<I4s", len(text), b"JSON") + text)
        out.write(struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    faces = sum(len(f) for m in meshes for f in m["faces"])
    print(f"{OUT.relative_to(HERE)}: {OUT.stat().st_size / 1e6:.1f} MB, {faces} faces in {len(meshes)} pieces, {len(textures)} images")


if __name__ == "__main__":
    sys.exit(main())
