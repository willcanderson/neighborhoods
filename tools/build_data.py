#!/usr/bin/env python3
"""Build the boundary data bundle used by the web app.

Downloads the City of Chicago neighborhood and community-area boundary files,
simplifies them to roughly GPS precision, and writes a single JavaScript file
that the app can load with a plain <script> tag (so the app also works when
opened straight off the filesystem, where fetch() of a local JSON is blocked).

Usage:  python3 tools/build_data.py [--out data/boundaries.js]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.request

# Latitude of Chicago, used to make the x axis comparable to the y axis when
# measuring simplification error in degrees.
LAT0 = 41.84
LON_SCALE = math.cos(math.radians(LAT0))
M_PER_DEG_LAT = 111_132.0

# Simplification tolerance in degrees of latitude (~2.2 m), comfortably finer
# than a phone's GPS fix.
TOLERANCE = 0.00002
PRECISION = 5  # ~1.1 m

SOURCES = {
    "neighborhood": {
        "label": "Neighborhood",
        "name_field": "name",
        "attribution": "City of Chicago - Boundaries: Neighborhoods",
        "urls": [
            "https://data.cityofchicago.org/api/geospatial/bbvz-uum9?method=export&format=GeoJSON",
            "https://raw.githubusercontent.com/blackmad/neighborhoods/master/chicago.geojson",
        ],
    },
    "community": {
        "label": "Community area",
        "name_field": "community",
        "attribution": "City of Chicago - Boundaries: Community Areas",
        "urls": [
            "https://data.cityofchicago.org/api/geospatial/cauq-8yn6?method=export&format=GeoJSON",
            "https://raw.githubusercontent.com/thisisdaryn/data/master/geo/chicago/Comm_Areas.geojson",
        ],
    },
}

# The source files carry a few typos and machine-readable spellings. Everything
# else is passed through untouched.
RENAMES = {
    "Sauganash,Forest Glen": "Sauganash / Forest Glen",
    "Little Italy, UIC": "Little Italy / UIC",
    "Mckinley Park": "McKinley Park",
    "Millenium Park": "Millennium Park",
    "Rush & Division": "Rush & Division",
    "Boystown": "Boystown (Northalsted)",
    "Grand Crossing": "Greater Grand Crossing",
}


def fetch(urls: list[str], cache_dir: str) -> dict:
    """Return the first source that downloads, caching the raw file on disk."""
    os.makedirs(cache_dir, exist_ok=True)
    last_error: Exception | None = None
    for url in urls:
        digest = hashlib.sha1(url.encode()).hexdigest()[:12]
        cache = os.path.join(cache_dir, digest + ".geojson")
        if os.path.exists(cache):
            with open(cache) as fh:
                return json.load(fh)
        try:
            sys.stderr.write(f"  fetching {url}\n")
            with urllib.request.urlopen(url, timeout=120) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            with open(cache, "w") as fh:
                fh.write(raw)
            return data
        except Exception as exc:  # try the next mirror
            last_error = exc
            sys.stderr.write(f"  failed: {exc}\n")
    raise SystemExit(f"could not download boundary data: {last_error}")


def title_case(name: str) -> str:
    """Community areas ship as SHOUTED names; neighborhoods are already cased."""
    if name != name.upper():
        return name
    small = {"of", "the", "and"}
    words = []
    for i, word in enumerate(name.split()):
        if word in ("OHARE", "O'HARE"):
            words.append("O'Hare")
        elif word.startswith("MC") and len(word) > 2:
            words.append("Mc" + word[2:].capitalize())
        elif word.lower() in small and i > 0:
            words.append(word.lower())
        else:
            words.append(word.capitalize())
    return " ".join(words)


def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative so deep rings can't blow the stack."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = (bx - ax) * LON_SCALE, by - ay
        den = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k]
            qx, qy = (px - ax) * LON_SCALE, py - ay
            if den == 0:
                dist = math.hypot(qx, qy)
            else:
                t = min(1.0, max(0.0, (qx * dx + qy * dy) / den))
                dist = math.hypot(qx - t * dx, qy - t * dy)
            if dist > best:
                best, best_i = dist, k
        if best > eps:
            keep[best_i] = True
            stack.append((i, best_i))
            stack.append((best_i, j))
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring: list[tuple[float, float]]) -> float:
    total = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        total += (x1 * LON_SCALE) * y2 - (x2 * LON_SCALE) * y1
    return total / 2.0


def clean_ring(ring: list[list[float]]) -> list[tuple[float, float]] | None:
    pts = [(round(p[0], PRECISION), round(p[1], PRECISION)) for p in ring]
    deduped = [pts[0]]
    for p in pts[1:]:
        if p != deduped[-1]:
            deduped.append(p)
    if deduped[0] != deduped[-1]:
        deduped.append(deduped[0])
    if len(deduped) < 4:
        return None
    simplified = rdp(deduped, TOLERANCE)
    if simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    if len(simplified) < 4:
        return None
    return simplified


def point_in_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def dist_to_ring(x: float, y: float, ring: list[tuple[float, float]]) -> float:
    best = float("inf")
    for i in range(len(ring) - 1):
        ax, ay = ring[i]
        bx, by = ring[i + 1]
        dx, dy = (bx - ax) * LON_SCALE, by - ay
        qx, qy = (x - ax) * LON_SCALE, y - ay
        den = dx * dx + dy * dy
        t = 0.0 if den == 0 else min(1.0, max(0.0, (qx * dx + qy * dy) / den))
        best = min(best, math.hypot(qx - t * dx, qy - t * dy))
    return best


def label_point(polygons: list[list[list[tuple[float, float]]]]) -> tuple[float, float]:
    """A point well inside the shape, for placing the map label."""
    biggest = max(
        (poly for poly in polygons),
        key=lambda poly: abs(ring_area(poly[0])),
    )
    outer, holes = biggest[0], biggest[1:]
    xs = [p[0] for p in outer]
    ys = [p[1] for p in outer]
    best_pt, best_d = (sum(xs) / len(xs), sum(ys) / len(ys)), -1.0
    steps = 24
    for gx in range(steps):
        for gy in range(steps):
            x = min(xs) + (max(xs) - min(xs)) * (gx + 0.5) / steps
            y = min(ys) + (max(ys) - min(ys)) * (gy + 0.5) / steps
            if not point_in_ring(x, y, outer):
                continue
            if any(point_in_ring(x, y, hole) for hole in holes):
                continue
            d = dist_to_ring(x, y, outer)
            for hole in holes:
                d = min(d, dist_to_ring(x, y, hole))
            if d > best_d:
                best_d, best_pt = d, (x, y)
    return round(best_pt[0], PRECISION), round(best_pt[1], PRECISION)


def build_layer(key: str, spec: dict, cache_dir: str) -> dict:
    sys.stderr.write(f"layer {key}\n")
    raw = fetch(spec["urls"], cache_dir)
    features = []
    for feature in raw["features"]:
        props = feature["properties"]
        name = props.get(spec["name_field"])
        if not name:
            continue
        name = RENAMES.get(name.strip(), title_case(name.strip()))
        geom = feature["geometry"]
        if geom is None:
            continue
        source_polys = (
            geom["coordinates"]
            if geom["type"] == "MultiPolygon"
            else [geom["coordinates"]]
        )
        polygons = []
        for poly in source_polys:
            rings = [r for r in (clean_ring(ring) for ring in poly) if r]
            if rings:
                polygons.append(rings)
        if not polygons:
            continue
        xs = [p[0] for poly in polygons for p in poly[0]]
        ys = [p[1] for poly in polygons for p in poly[0]]
        features.append(
            {
                "n": name,
                "b": [
                    round(min(xs), PRECISION),
                    round(min(ys), PRECISION),
                    round(max(xs), PRECISION),
                    round(max(ys), PRECISION),
                ],
                "c": list(label_point(polygons)),
                # Rings flattened to [x0,y0,x1,y1,...] to keep the bundle small
                # and cheap to parse. Ring 0 of each polygon is the outline,
                # any others are holes.
                "p": [[[v for pt in ring for v in pt] for ring in poly] for poly in polygons],
            }
        )
    features.sort(key=lambda f: f["n"])
    vertices = sum(len(ring) // 2 for f in features for poly in f["p"] for ring in poly)
    sys.stderr.write(f"  {len(features)} features, {vertices} vertices\n")
    return {
        "key": key,
        "label": spec["label"],
        "attribution": spec["attribution"],
        "features": features,
    }


def encode(value) -> str:
    """Compact JSON: no spaces, and floats without trailing zeros."""
    if isinstance(value, float):
        text = f"{value:.{PRECISION}f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(encode(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{encode(v)}" for k, v in value.items()) + "}"
    raise TypeError(type(value))


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.join(root, "data", "boundaries.js"))
    parser.add_argument("--cache", default=os.path.join(root, ".cache"))
    args = parser.parse_args()

    layers = {key: build_layer(key, spec, args.cache) for key, spec in SOURCES.items()}
    payload = {
        "tolerance_m": round(TOLERANCE * M_PER_DEG_LAT, 1),
        "layers": layers,
    }
    with open(args.out, "w") as fh:
        fh.write("// Generated by tools/build_data.py - do not edit by hand.\n")
        fh.write("// Boundaries: City of Chicago open data, simplified to ~2 m.\n")
        fh.write("window.CHICAGO_BOUNDARIES = ")
        fh.write(encode(payload))
        fh.write(";\n")
    sys.stderr.write(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)\n")


if __name__ == "__main__":
    main()
