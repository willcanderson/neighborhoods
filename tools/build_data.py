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
import re
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

# Most Chicago neighborhood boundaries run down the middle of a street, so we
# can name them by matching each stretch of boundary against the city's street
# centerlines. A stretch that follows no street - a rail embankment, a park
# edge - simply stays unlabelled, which is more honest than guessing.
MATCH_M = 35.0          # how close the boundary must run to a street
MATCH_ANGLE = 20.0      # and how nearly parallel, in degrees
MIN_RUN_M = 120.0       # shorter stretches aren't worth a label
LABEL_SPACING_M = 700.0  # repeat the name along a long stretch
STREET_CELL = 0.003     # spatial index cell, about 250 m

# Ramps (9) and lower-level roadways (7) share their names with the surface
# street above them and would only produce duplicate or nonsense labels.
SKIP_STREET_CLASSES = {"9", "7", None}
# Everything except proposed, vacated and under-construction streets.
KEEP_STREET_STATUS = {"N"}

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

STREET_SOURCE = {
    "attribution": "City of Chicago - Street Center Lines (MIT licensed)",
    "urls": [
        "https://raw.githubusercontent.com/Chicago/osd-street-center-line/master/data/Transportation.geojson",
    ],
}

# Street-type abbreviations, cased the way a map would print them.
STREET_TYPES = {
    "AVE": "Ave", "ST": "St", "BLVD": "Blvd", "RD": "Rd", "DR": "Dr",
    "PL": "Pl", "PKWY": "Pkwy", "EXPY": "Expy", "HWY": "Hwy", "LN": "Ln",
    "CT": "Ct", "TER": "Ter", "SQ": "Sq", "WAY": "Way", "PLZ": "Plz",
    "XING": "Xing", "CRES": "Cres", "PATH": "Path", "ROW": "Row",
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


def street_label(props: dict) -> str | None:
    """A printable street name: "N WESTERN AVE" becomes "Western Ave"."""
    stem = (props.get("STREET_NAM") or "").strip()
    if not stem:
        return None
    # The river features abbreviate their branch: "N BRANCH CHICAGO RIVER".
    expand = "BRANCH" in stem or "RIVER" in stem
    directions = {"N": "North", "S": "South", "E": "East", "W": "West"}
    words = []
    for position, word in enumerate(stem.split()):
        if expand and position == 0 and word in directions:
            words.append(directions[word])
        elif re.fullmatch(r"\d+(ST|ND|RD|TH)", word):
            words.append(word[:-2] + word[-2:].lower())
        elif word.startswith("MC") and len(word) > 2:
            words.append("Mc" + word[2:].capitalize())
        else:
            words.append(word.capitalize())
    kind = (props.get("STREET_TYP") or "").strip()
    if kind:
        words.append(STREET_TYPES.get(kind, kind.capitalize()))
    # The direction prefix is dropped: on a map "Western Ave" reads better than
    # "N Western Ave", and no two Chicago streets differ only by it.
    return " ".join(words)


def load_streets(cache_dir: str):
    """Street segments plus a grid index, for nearest-street lookups."""
    sys.stderr.write("streets\n")
    raw = fetch(STREET_SOURCE["urls"], cache_dir)
    segments = []
    grid: dict = {}
    for feature in raw["features"]:
        props = feature["properties"]
        if props.get("CLASS") in SKIP_STREET_CLASSES:
            continue
        if props.get("STATUS") not in KEEP_STREET_STATUS:
            continue
        name = street_label(props)
        if not name:
            continue
        geom = feature["geometry"]
        if geom is None:
            continue
        lines = (
            geom["coordinates"]
            if geom["type"] == "MultiLineString"
            else [geom["coordinates"]]
        )
        for line in lines:
            for i in range(len(line) - 1):
                ax, ay = line[i][0], line[i][1]
                bx, by = line[i + 1][0], line[i + 1][1]
                index = len(segments)
                segments.append((ax, ay, bx, by, name))
                for cx in range(int(min(ax, bx) / STREET_CELL), int(max(ax, bx) / STREET_CELL) + 1):
                    for cy in range(int(min(ay, by) / STREET_CELL), int(max(ay, by) / STREET_CELL) + 1):
                        grid.setdefault((cx, cy), []).append(index)
    sys.stderr.write(f"  {len(segments)} street segments indexed\n")
    return segments, grid


def heading(ax: float, ay: float, bx: float, by: float) -> float:
    """Undirected orientation of a segment, 0-180 degrees."""
    return math.degrees(math.atan2(by - ay, (bx - ax) * LON_SCALE)) % 180


def point_seg_distance(px, py, ax, ay, bx, by) -> float:
    dx = (bx - ax) * LON_SCALE * M_PER_DEG_LAT
    dy = (by - ay) * M_PER_DEG_LAT
    qx = (px - ax) * LON_SCALE * M_PER_DEG_LAT
    qy = (py - ay) * M_PER_DEG_LAT
    den = dx * dx + dy * dy
    t = 0.0 if den == 0 else min(1.0, max(0.0, (qx * dx + qy * dy) / den))
    return math.hypot(qx - t * dx, qy - t * dy)


def nearest_street(px, py, orientation, streets) -> str | None:
    """The closest roughly-parallel street within MATCH_M, if any."""
    segments, grid = streets
    best_name = None
    best_distance = MATCH_M
    cx, cy = int(px / STREET_CELL), int(py / STREET_CELL)
    for i in range(cx - 1, cx + 2):
        for j in range(cy - 1, cy + 2):
            for index in grid.get((i, j), ()):
                ax, ay, bx, by, name = segments[index]
                distance = point_seg_distance(px, py, ax, ay, bx, by)
                if distance >= best_distance:
                    continue
                offset = abs(heading(ax, ay, bx, by) - orientation)
                if min(offset, 180 - offset) > MATCH_ANGLE:
                    continue
                best_distance = distance
                best_name = name
    return best_name


def screen_angle(ax, ay, bx, by) -> float:
    """Text angle on screen (y grows downward), kept upright."""
    angle = math.degrees(math.atan2(-(by - ay), (bx - ax) * LON_SCALE))
    while angle <= -90:
        angle += 180
    while angle > 90:
        angle -= 180
    return angle


def _run_labels(run: list, name: str, out: list) -> None:
    """Place one or more labels along a stretch of boundary on one street."""
    lengths = [
        math.hypot((b[0] - a[0]) * LON_SCALE, b[1] - a[1]) * M_PER_DEG_LAT
        for a, b in zip(run, run[1:])
    ]
    total = sum(lengths)
    if total < MIN_RUN_M:
        return
    count = max(1, round(total / LABEL_SPACING_M))
    for k in range(count):
        target = total * (k + 0.5) / count
        walked = 0.0
        for (a, b), length in zip(zip(run, run[1:]), lengths):
            if walked + length >= target or (a, b) == (run[-2], run[-1]):
                t = 0.0 if length == 0 else (target - walked) / length
                t = min(1.0, max(0.0, t))
                out.append(
                    {
                        "n": name,
                        "x": round(a[0] + (b[0] - a[0]) * t, PRECISION),
                        "y": round(a[1] + (b[1] - a[1]) * t, PRECISION),
                        "a": round(screen_angle(a[0], a[1], b[0], b[1]), 1),
                        "l": round(total),
                    }
                )
                break
            walked += length


def label_borders(features: list, streets) -> list:
    """Name every stretch of boundary that follows a street.

    Interior borders belong to two neighborhoods and would otherwise be
    labelled twice in the same spot, so near-duplicates are dropped.
    """
    labels: list = []
    for feature in features:
        for polygon in feature["p"]:
            for ring in polygon:
                points = [
                    (ring[2 * i], ring[2 * i + 1]) for i in range(len(ring) // 2)
                ]
                run: list = []
                run_name = None
                for a, b in zip(points, points[1:]):
                    name = nearest_street(
                        (a[0] + b[0]) / 2,
                        (a[1] + b[1]) / 2,
                        heading(a[0], a[1], b[0], b[1]),
                        streets,
                    )
                    if name and name == run_name:
                        run.append(b)
                        continue
                    if run_name and len(run) > 1:
                        _run_labels(run, run_name, labels)
                    run_name = name
                    run = [a, b] if name else []
                if run_name and len(run) > 1:
                    _run_labels(run, run_name, labels)

    deduped = []
    seen = set()
    for label in labels:
        key = (label["n"], round(label["x"] / 0.0005), round(label["y"] / 0.0004))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(label)
    return deduped


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
    parser.add_argument(
        "--no-streets",
        action="store_true",
        help="skip the street-name pass (avoids an 87 MB download)",
    )
    args = parser.parse_args()

    layers = {key: build_layer(key, spec, args.cache) for key, spec in SOURCES.items()}
    payload = {
        "tolerance_m": round(TOLERANCE * M_PER_DEG_LAT, 1),
        "streets": [],
        "layers": layers,
    }

    if not args.no_streets:
        streets = load_streets(args.cache)
        names: list = []
        index: dict = {}
        for key, layer in layers.items():
            borders = label_borders(layer["features"], streets)
            for label in borders:
                if label["n"] not in index:
                    index[label["n"]] = len(names)
                    names.append(label["n"])
                label["n"] = index[label["n"]]
            layer["borders"] = borders
            sys.stderr.write(f"  {key}: {len(borders)} street labels\n")
        payload["streets"] = names
    with open(args.out, "w") as fh:
        fh.write("// Generated by tools/build_data.py - do not edit by hand.\n")
        fh.write("// Boundaries: City of Chicago open data, simplified to ~2 m.\n")
        fh.write("window.CHICAGO_BOUNDARIES = ")
        fh.write(encode(payload))
        fh.write(";\n")
    sys.stderr.write(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)\n")


if __name__ == "__main__":
    main()
