# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "fast-simplification"]
# ///
"""The house fronts seen from the flat's windows, as flat walls with straight-on pictures.

    uv run build_fronts.py

IPR's photo model (see build_surroundings.py) is flown from above, so the fronts across the
street and the courtyard are photographed at a slant, a few centimetres per pixel at best,
and their shape is lumpy. This script works out which fronts can actually be seen from the
windows, and for each of them writes

  - fronts/fronts.json: where its wall stands (from the land register's building outline,
    set onto the photo model's front), how high it reaches, and how much of the view from
    the windows it fills;
  - fronts/<id>-photo.png: the aerial photo of that front flattened into a straight-on
    picture at 4 cm a pixel, every triangle sampled across its whole area;
  - fronts/<id>-brief.txt: the request for the image generator to redraw it sharp.

The sharp pictures are then made from these by hand with Codex image generation (the
codex-imagegen skill; see README.md) and saved as fronts/<id>.png. They are kept in git,
since they cannot be generated again identically. build_surroundings.py then replaces the
photo model's faces of these fronts by the flat walls carrying those pictures.

Building outlines come from the land register (RÚIAN) map service, asked for an area around
the flat in S-JTSK; nothing but the shapes is requested. They are cached in data/ruian/.
"""
import io
import json
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

import build_surroundings as bs

HERE = Path(__file__).parent
FRONTS = HERE / "fronts"
OUTLINES = HERE / "data" / "ruian" / "outlines.json"
RUIAN = "https://ags.cuzk.cz/arcgis/rest/services/RUIAN/Prohlizeci_sluzba_nad_daty_RUIAN/MapServer/3/query"
REACH = 90                 # m around the flat looked at
STEP = np.radians(0.5)     # angular size of a pixel of the view from a window
SHARE = 0.02               # a front filling at least this share of the view from the windows is rebuilt
NEAR_OUTLINE = 1.5         # m: a surface this close to an outline's edge belongs to that front
SLAB = 1.2                 # m in front of and behind a wall that counts as part of that front
RES = 0.04                 # m a pixel of the flattened pictures
UPPER = 0.55               # share of a front, from the top, whose brightness the redrawn picture is matched to
SAME_LINE = (np.radians(8), 0.6, 4.0)       # edges of one building in line: angle, offset (m), gap (m)

# What the aerial photo gets wrong or hides about a front, by land-register building number,
# told to the image generator. Written after looking at the flattened photos and, for the
# street, at street-level photos (which go along as references; not kept in git).
NOTES = {
    1597485: "In the middle of the lower floors two rounded oriels (bay windows) flank a wide glazed balcony over the "
             "entrance; in Image 1 they are a smeared jumble. The ground floor is grey stone with barred windows and a "
             "tall wooden entrance door under the balcony. The top floor has small arched windows.",
    1597486: "Plain plaster with horizontal bands on the lower floors, windows in pairs and singles, small ornaments over "
             "the second-floor windows and arched windows on the top floor; one wooden entrance door on the ground floor.",
    1597512: "Plaster with ornament between the upper windows, windows in pairs with dark red-brown frames and flower "
             "boxes, an arched entrance with a dark green door in the middle of the ground floor.",
    1597484: "Rusticated (banded) plaster on the lower two floors, a portal with columns around the entrance in the "
             "middle of the ground floor, windows with moulded surrounds.",
    1597471: "A plain courtyard back of an apartment house: smooth plaster, simple windows in regular rows, a drainpipe. "
             "The lower floors are hidden by trees in Image 1: continue the same facade down to the ground, no trees.",
    1597472: "A plain courtyard back of an apartment house: smooth plaster, simple windows in regular rows. The dark "
             "vertical strip in the middle is a stair tower standing in front of the wall: draw plain wall there. "
             "The lower floors are partly hidden by trees in Image 1: continue the same facade down to the ground.",
    1597480: "A plain courtyard wall of an apartment house with simple windows; tall and narrow.",
}

# The colour of a front's plaster (sRGB) where it is known better than from the aerial photo, by
# land-register building number. The aerial photo makes the house opposite the living room look
# cream; it is ochre (a colour sample from the owners).
WALL_COLOURS = {
    1597485: (208, 187, 161),
}


def outlines(site):
    """Building outlines around the flat as rings in plan metres, from the land register."""
    if not OUTLINES.exists():
        x, y = site["origin_sjtsk"]
        query = dict(geometry=f"{x - 120},{y - 120},{x + 120},{y + 120}", geometryType="esriGeometryEnvelope", inSR=5514,
                     outSR=5514, spatialRel="esriSpatialRelIntersects", returnGeometry="true", outFields="objectid", f="json")
        OUTLINES.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"{RUIAN}?{urllib.parse.urlencode(query)}") as response:
            OUTLINES.write_bytes(response.read())
    origin, ux = np.array(site["origin_sjtsk"]), np.array(site["x_axis_sjtsk"])
    uy = np.array([-ux[1], ux[0]])
    rings = []
    for feature in json.loads(OUTLINES.read_text())["features"]:
        for ring in feature["geometry"]["rings"]:
            r = np.array(ring) - origin
            rings.append((feature["attributes"]["objectid"], np.stack([r @ ux, r @ uy], axis=1)))
    return rings


def windows(model):
    """Each window as (id, middle of its outer face in plan metres and height above the floor, outward direction)."""
    found = []
    for o in model["openings"]:
        if o["type"] != "window":
            continue
        x0, y0, x1, y1 = (v / 1000 for v in o["rect"])
        street = y1 <= 0.01                 # the street windows sit at the plan's y = 0 side
        found.append((o["id"], np.array([(x0 + x1) / 2, y0 if street else y1, (o["sill"] + o["height"] / 2) / 1000]),
                      np.array([0.0, -1.0 if street else 1.0, 0.0])))
    return found


def lines(rings, ours):
    """The outlines' edges, those of one building that lie in line joined into one: (building, a, b, outward normal)."""
    found = []
    for building, ring in rings:
        if building == ours:
            continue
        area = 0.5 * np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1])
        edges = []
        for a, b in zip(ring[:-1], ring[1:]):
            d = b - a
            if np.hypot(*d) < 0.3:
                continue
            t = d / np.hypot(*d)
            normal = np.array([t[1], -t[0]]) * np.sign(area)          # pointing out of the building
            edges.append([a, b, t, normal])
        merged = True
        while merged:                                                  # join edges in line with each other
            merged = False
            for i in range(len(edges)):
                for j in range(i + 1, len(edges)):
                    a, b, t, n = edges[i]
                    c, d, s, m = edges[j]
                    if np.arccos(np.clip(t @ s, -1, 1)) > SAME_LINE[0] or abs((c - a) @ n) > SAME_LINE[1] or abs((d - a) @ n) > SAME_LINE[1]:
                        continue
                    span = sorted([(a - a) @ t, (b - a) @ t]), sorted([(c - a) @ t, (d - a) @ t])
                    if max(span[0][0], span[1][0]) - min(span[0][1], span[1][1]) > SAME_LINE[2]:
                        continue
                    low, high = min(span[0][0], span[1][0]), max(span[0][1], span[1][1])
                    edges[i] = [a + t * low, a + t * high, t, n]
                    del edges[j]
                    merged = True
                    break
                if merged:
                    break
        found += [(building, a, b, n) for a, b, t, n in edges]
    return found


def view_from(at, outward, T, rng):
    """What a window looks out on: for each pixel of its view (half a degree), the surface seen there.
    Triangles are sampled in proportion to the part of the view they cover. Returns the points seen,
    the triangle each lies on, and the share of the view each pixel stands for (by solid angle,
    times how squarely it faces the window)."""
    rel = T - at
    ahead = rel.mean(axis=1) @ outward > 0.3
    index = np.flatnonzero(ahead)
    R = rel[ahead]
    area = 0.5 * np.linalg.norm(np.cross(R[:, 1] - R[:, 0], R[:, 2] - R[:, 0]), axis=1)
    distance = np.linalg.norm(R.mean(axis=1), axis=1)
    count = np.clip(np.ceil(3 * area / distance ** 2 / STEP ** 2), 1, 4000).astype(int)
    owner = np.repeat(np.arange(len(R)), count)
    u, v = rng.random(len(owner)), rng.random(len(owner))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    points = R[owner, 0] + u[:, None] * (R[owner, 1] - R[owner, 0]) + v[:, None] * (R[owner, 2] - R[owner, 0])
    side = np.cross([0, 0, 1.0], outward)
    forward = points @ outward
    across = np.arctan2(points @ side, forward)
    up = np.arctan2(points[:, 2], np.hypot(forward, points @ side))
    ok = (np.abs(across) < np.radians(85)) & (forward > 0)
    key = ((across + np.pi / 2) / STEP).astype(int) * 1000 + ((up + np.pi / 2) / STEP).astype(int)
    key, far = key[ok], np.linalg.norm(points, axis=1)[ok]
    order = np.lexsort((far, key))
    first = order[np.r_[True, np.diff(key[order]) != 0]]
    weight = np.cos(up[ok][first]) * np.cos(across[ok][first]) * STEP ** 2
    return points[ok][first] + at, index[owner[ok][first]], weight


def normals(T):
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)


def main():
    model = json.loads((HERE / "out" / "melnicka-floorplan.json").read_text())
    site = model["site"]
    archive = zipfile.ZipFile(bs.fetch())
    Image.MAX_IMAGE_PIXELS = None

    # ---- the photo model around the flat, without our own house, in plan metres
    parts = []
    for name, V, VT, F, near in bs.parts(archive, site):
        if not near:
            continue
        d = V[:, :2] - np.array(site["origin_sjtsk"])
        ux = np.array(site["x_axis_sjtsk"])
        P = np.stack([d @ ux, d @ np.array([-ux[1], ux[0]]), V[:, 2] - site["floor_level"]], axis=1)
        tri, tex = F[:, 0::2], F[:, 1::2]
        middle = P[tri].mean(axis=1)
        ours = (middle[:, 0] > bs.HOUSE[0]) & (middle[:, 0] < bs.HOUSE[1]) & (middle[:, 1] > bs.HOUSE[2]) & (middle[:, 1] < bs.HOUSE[3])
        keep = (np.linalg.norm(middle[:, :2] - bs.CENTRE, axis=1) < REACH) & ~ours
        parts.append(dict(name=name, T=P[tri[keep]], UV=VT[tex[keep]]))
    T = np.concatenate([p["T"] for p in parts])
    N = normals(T)
    print(f"{len(T)} faces within {REACH} m")

    # ---- which fronts the windows look at
    rings = outlines(site)
    ours = next(b for b, ring in rings if bs_inside(ring, bs.CENTRE))
    walls = lines(rings, ours)
    A = np.array([w[1] for w in walls]); B = np.array([w[2] for w in walls]); O = np.array([w[3] for w in walls])
    seen = np.zeros(len(walls))
    rng = np.random.default_rng(2026)
    for wid, at, outward in windows(model):
        points, face, weight = view_from(at, outward, T, rng)
        upright = np.abs(N[face, 2]) < 0.5
        best, gap = np.zeros(len(points), int), np.full(len(points), np.inf)
        ab = B - A
        for s in range(0, len(points), 4000):                          # nearest edge facing the same way, a batch at a time
            p = points[s:s + 4000, None, :2]
            t = np.clip(((p - A) * ab).sum(-1) / (ab * ab).sum(-1), 0, 1)
            g = np.linalg.norm(p - (A + t[..., None] * ab), axis=-1)
            g[np.abs((N[face[s:s + 4000], None, :2] * O[None]).sum(-1)) < 0.6] = np.inf
            best[s:s + 4000], gap[s:s + 4000] = g.argmin(axis=1), g.min(axis=1)
        close = upright & (gap < NEAR_OUTLINE)
        np.add.at(seen, best[close], weight[close])
        print(f"{wid}: {len(points)} directions, {close.mean():.0%} on a house front")
    share = seen / seen.sum()

    # ---- the walls: along the outline, set onto the photo model's front, from the ground to the eaves
    FRONTS.mkdir(exist_ok=True)
    chosen = []
    for k in np.argsort(-share):
        if share[k] < SHARE:
            break
        building, a, b, outward = walls[k]
        along = (b - a) / np.linalg.norm(b - a)
        length = float(np.linalg.norm(b - a))
        middle = T.mean(axis=1)
        u = (middle[:, :2] - a) @ along
        d = (middle[:, :2] - a) @ outward
        upright = (np.abs(N[:, 2]) < 0.3) & (np.abs(N[:, :2] @ outward) > 0.8)
        band = (u > 0.5) & (u < length - 0.5) & (np.abs(d) < 2.0)
        face = band & upright
        area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
        order = np.argsort(d[face])
        cumulative = np.cumsum(area[face][order])
        offset = float(d[face][order][np.searchsorted(cumulative, cumulative[-1] / 2)])       # area-weighted median
        on = band & (np.abs(d - offset) < 0.8) & upright
        heights = T[on][:, :, 2].ravel()
        # The eaves: the highest height at which most of the front's width still stands in the
        # wall's plane. A roof, even a steep one, leans back from it; dormers and chimneys above
        # are left to the photo model.
        reach = band & (np.abs(N[:, 2]) < 0.2) & (np.abs(d - offset) < 0.35)    # within about 12° of upright: a mansard leans back more
        cells = np.zeros((int(np.ceil(length / 0.5)), 400), bool)          # half a metre across, a quarter up, from 50 m below the floor
        for corners in T[reach]:
            cu, z = (corners[:, :2] - a) @ along, corners[:, 2]
            cells[max(0, int(cu.min() / 0.5)):int(cu.max() / 0.5) + 1, max(0, int((z.min() + 50) / 0.25)):int((z.max() + 50) / 0.25)] = True
        full = np.flatnonzero(cells.mean(axis=0) > 0.6)
        top = full.max() * 0.25 - 50 + 0.25 if len(full) else None
        top = float(top if top is not None else np.percentile(T[on][:, :, 2], 99))
        heights = T[on][:, :, 2].ravel()
        ground = band & (d - offset > 0.3) & (d - offset < 4) & (N[:, 2] ** 2 > 0.7)
        bottom = float(np.percentile(T[ground][:, :, 2], 10)) if ground.any() else float(heights.min())
        if (b - a) @ np.array([-outward[1], outward[0]]) < 0:          # left to right as seen from in front
            a, b = b, a
        chosen.append(dict(id=f"front-{len(chosen) + 1}", building=int(building), side="street" if a[1] < 0 else "courtyard",
                           share=round(float(share[k]), 3), left=(a + outward * offset).round(3).tolist(),
                           right=(b + outward * offset).round(3).tolist(), outward=outward.round(4).tolist(),
                           bottom=round(bottom, 2), top=round(top, 2), shift=round(offset, 2)))
        if int(building) in WALL_COLOURS:
            chosen[-1]["wall_colour"] = list(WALL_COLOURS[int(building)])
        print(f"{chosen[-1]['id']}: building {building}, {chosen[-1]['side']}, {share[k]:.1%} of the view, {length:.1f} m wide, "
              f"{bottom:.1f} to {top:.1f} m, set {offset:+.2f} m from the outline")

    # ---- each front's photo flattened into a straight-on picture
    for front in chosen:
        picture, covered = flatten(front, parts, archive)
        Image.fromarray(picture).save(FRONTS / f"{front['id']}-photo.png")
        front["photo_size"] = [picture.shape[1], picture.shape[0]]
        front["covered"] = round(float(covered), 3)
        (FRONTS / f"{front['id']}-brief.txt").write_text(brief(front))
        print(f"{front['id']}: {picture.shape[1]} x {picture.shape[0]} px, {covered:.0%} of it from the photo")
    (FRONTS / "fronts.json").write_text(json.dumps(dict(
        note="Walls that replace the photo model's lumpy house fronts seen from the windows; written by build_fronts.py. "
             "Plan metres, heights above the flat's floor; left and right as seen from in front of the wall.",
        resolution=RES, fronts=chosen), indent=1))


def rebuilt():
    """The fronts that have a redrawn picture (fronts/<id>.jpg), each with that picture as `picture`."""
    if not (FRONTS / "fronts.json").exists():
        return []
    found = []
    for front in json.loads((FRONTS / "fronts.json").read_text())["fronts"]:
        path = FRONTS / f"{front['id']}.jpg"
        if path.exists():
            picture = Image.open(path).convert("RGB")
            picture = matched(picture, Image.open(FRONTS / f"{front['id']}-photo.png").convert("RGB"))
            if "wall_colour" in front:
                picture = repainted(picture, front["wall_colour"])
            found.append(dict(front, picture=picture))
    return found


def lab(rgb):
    """sRGB (0 to 1) to CIE L*a*b* (D65)."""
    c = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    t = xyz / np.array([0.95047, 1.0, 1.08883])
    f = np.where(t > 216 / 24389, np.cbrt(t), (24389 / 27 * t + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def srgb(lab_):
    """CIE L*a*b* (D65) back to sRGB (0 to 1)."""
    fy = (lab_[..., 0] + 16) / 116
    f = np.stack([fy + lab_[..., 1] / 500, fy, fy - lab_[..., 2] / 200], axis=-1)
    t = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * np.array([0.95047, 1.0, 1.08883])
    c = t @ np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]).T
    return np.clip(np.where(c > 0.0031308, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055, 12.92 * c), 0, 1)


def repainted(picture, colour):
    """The plaster of a redrawn front given the hue and saturation of `colour`, its lightness left as matched to
    the aerial photo. Plaster is told apart by its tint: warm and pale, against white or grey window frames,
    glass and stone (no tint) and wooden doors (strongly red-yellow); mouldings are plaster and keep their shading."""
    def step(x, e0, e1):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)
    L = lab(np.asarray(picture, float) / 255)
    plaster = step(L[..., 2], 3, 7) * (1 - step(L[..., 2], 24, 30)) * (1 - step(L[..., 1], 8, 12)) * step(L[..., 0], 25, 35)
    target = lab(np.array(colour, float) / 255)
    shift = target[1:] - L[plaster > 0.9][:, 1:].mean(axis=0)
    L[..., 1:] += plaster[..., None] * shift
    return Image.fromarray((srgb(L) * 255 + 0.5).astype(np.uint8))


def matched(picture, photo):
    """The redrawn picture made as bright, and of the same tint, as the aerial photo of its upper floors (the
    lower ones are often behind trees). The photo carries the light of the day it was taken, like the rest of
    the photo model around the rebuilt front, so the two join without a jump in brightness."""
    def linear_mean(image):
        a = (np.asarray(image, float) / 255) ** 2.2
        return a[: int(a.shape[0] * UPPER)].reshape(-1, 3).mean(axis=0)
    gain = np.clip(linear_mean(photo) / linear_mean(picture.resize(photo.size, Image.LANCZOS)), 0.3, 2.0)
    a = (np.asarray(picture, float) / 255) ** 2.2 * gain
    return Image.fromarray((np.clip(a, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8))


def bs_inside(ring, point):
    x, y = point
    inside = False
    for (x0, y0), (x1, y1) in zip(ring[:-1], ring[1:]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def frame(front):
    """The wall's own axes: origin at its left end at the bottom, across to the right, and outwards."""
    left, right = np.array(front["left"]), np.array(front["right"])
    across = (right - left) / np.linalg.norm(right - left)
    return left, across, np.array(front["outward"]), float(np.linalg.norm(right - left))


def belongs(front, T):
    """Which triangles (corners in plan metres and height) make up this front in the photo model."""
    left, across, outward, length = frame(front)
    middle = T.mean(axis=1)
    u = (middle[:, :2] - left) @ across
    d = (middle[:, :2] - left) @ outward
    return (u > 0) & (u < length) & (np.abs(d) < SLAB) & (middle[:, 2] > front["bottom"] + 0.4) & (middle[:, 2] < front["top"])


def flatten(front, parts, archive):
    """The front's aerial photo as seen straight on, RES metres a pixel. Every triangle of the front
    is filled across its area (front triangles are metres wide); where two overlap the one further
    out wins. Gaps take the colour of the nearest photographed pixel."""
    left, across, outward, length = frame(front)
    width, height = int(np.ceil(length / RES)), int(np.ceil((front["top"] - front["bottom"]) / RES))
    picture = np.zeros((height, width, 3), np.uint8)
    depth = np.full((height, width), -np.inf)
    for part in parts:
        mine = belongs(front, part["T"])
        if not mine.any():
            continue
        photo = np.asarray(Image.open(io.BytesIO(archive.read(part["name"] + "-texture-0.jpg"))).convert("RGB"))
        size = np.array([photo.shape[1], photo.shape[0]])
        for corners, uv in zip(part["T"][mine], part["UV"][mine]):
            x = ((corners[:, :2] - left) @ across) / RES
            y = (front["top"] - corners[:, 2]) / RES
            d = (corners[:, :2] - left) @ outward
            src = (uv * [1, -1] + [0, 1]) * size
            x0, x1 = max(0, int(np.floor(x.min()))), min(width - 1, int(np.ceil(x.max())))
            y0, y1 = max(0, int(np.floor(y.min()))), min(height - 1, int(np.ceil(y.max())))
            if x0 > x1 or y0 > y1:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            det = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
            if abs(det) < 1e-9:
                continue
            w0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / det
            w1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / det
            w2 = 1 - w0 - w1
            inside = (w0 >= -0.01) & (w1 >= -0.01) & (w2 >= -0.01)
            if not inside.any():
                continue
            here = w0 * d[0] + w1 * d[1] + w2 * d[2]
            rows, cols = np.nonzero(inside)
            rows_g, cols_g = rows + y0, cols + x0
            better = here[rows, cols] > depth[rows_g, cols_g]
            rows, cols, rows_g, cols_g = rows[better], cols[better], rows_g[better], cols_g[better]
            sx = w0[rows, cols] * src[0, 0] + w1[rows, cols] * src[1, 0] + w2[rows, cols] * src[2, 0]
            sy = w0[rows, cols] * src[0, 1] + w1[rows, cols] * src[1, 1] + w2[rows, cols] * src[2, 1]
            picture[rows_g, cols_g] = photo[np.clip(sy.astype(int), 0, size[1] - 1), np.clip(sx.astype(int), 0, size[0] - 1)]
            depth[rows_g, cols_g] = here[rows, cols]
    covered = np.isfinite(depth)
    if covered.any() and not covered.all():
        _, (iy, ix) = ndimage.distance_transform_edt(~covered, return_indices=True)
        picture = picture[iy, ix]
    return picture, covered.mean()


def brief(front):
    side = "on a city street" if front["side"] == "street" else "facing an inner courtyard of a city block"
    references = "; Images 2 and on are street-level photos of the same facade at a slant, for its ornament, materials and window details only" \
        if front["side"] == "street" else ""
    return f"""$imagegen
Asset: one texture of a building facade: a straight-on orthographic elevation with no perspective, the same aspect ratio as Image 1 ({front['photo_size'][0]}:{front['photo_size'][1]}), about 1500 px on the long side
Input images: Image 1 is the facade to redraw, a blurry, smeared aerial photo flattened to a straight-on view{references}
Request: redraw Image 1 as a sharp, realistic photograph-like elevation of the same facade of a 19th or early 20th century apartment house {side}
Preserve exactly: the frame of Image 1 (the facade fills it edge to edge), every window and door in its place and size, the number of floors and of window columns, cornices and floor bands at their heights, the colour and brightness of the walls and the window frames as in Image 1
About this facade: {NOTES.get(front['building'], '')}
Improve: crisp window frames and sills, glass with dark interiors and soft reflections, plaster texture, mouldings; remove smears, holes and melted shapes
Light: soft even daylight, no cast shadows; nothing in front of the facade (no trees, cars, people, street furniture), no sky
Constraints: no text, signs, house numbers, watermark or border
"""


if __name__ == "__main__":
    sys.exit(main())
