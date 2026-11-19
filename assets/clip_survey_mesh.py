"""Remove photographic surfaces inside the surveyed volumes, preserving cut edges and UVs."""

import numpy as np


def split(polygon, column, limit, sign):
    """Split a convex polygon of (x,y,height,u,v) vertices on a plane."""
    outside, inside = [], []
    a = polygon[-1]
    da = (a[column] - limit) * sign
    for b in polygon:
        db = (b[column] - limit) * sign
        if (da < 0) != (db < 0):
            hit = a + (b - a) * (da / (da - db))
            inside.append(hit)
            outside.append(hit)
        (inside if db >= 0 else outside).append(b)
        a, da = b, db
    return outside, inside


def subtract_boxes(points, uv, faces, tex_faces, boxes):
    """Keep original indices away from a cut. Only triangles crossing it need new vertices."""
    for lo, hi in boxes:
        corners = points[faces]
        small, large = corners.min(axis=1), corners.max(axis=1)
        overlap = ((large > lo) & (small < hi)).all(axis=1)
        if not overlap.any():
            continue
        contained = ((small >= lo) & (large <= hi)).all(axis=1)
        vertices, triangles = [], []
        for i in np.flatnonzero(overlap & ~contained):
            remainder = np.column_stack([corners[i], uv[tex_faces[i]]])
            for axis in range(3):
                for bound, sign in [(lo[axis], 1), (hi[axis], -1)]:
                    if len(remainder) < 3:
                        break
                    outside, remainder = split(remainder, axis, bound, sign)
                    if len(outside) >= 3:
                        start = len(vertices)
                        vertices.extend(outside)
                        triangles.extend((start, start + k, start + k + 1) for k in range(1, len(outside) - 1))
        faces, tex_faces = faces[~overlap], tex_faces[~overlap]
        if vertices:
            v, f = np.array(vertices), np.array(triangles)
            faces = np.concatenate([faces, f + len(points)])
            tex_faces = np.concatenate([tex_faces, f + len(uv)])
            points = np.concatenate([points, v[:, :3]])
            uv = np.concatenate([uv, v[:, 3:]])
    return points, uv, faces, tex_faces
