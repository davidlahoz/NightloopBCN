#!/usr/bin/env python3
"""Bake real OSM street names for the Barcelona world.

Queries Overpass for named drivable ways in the manifest's bbox, projects
lon/lat -> EPSG:25831 (UTM 31N, GRS80 — Snyder's Transverse Mercator, no
pyproj needed; validated against the manifest's own origin), converts to
world metres (x = east - origin_e, z = -(north - origin_n)) and writes a
compact res://barcelona/street_names.json:

    {"streets": [[name, [x0, z0, x1, z1, ...]], ...]}

Data © OpenStreetMap contributors (ODbL) — same license as the tiles.

Usage: python3 tools/bake_street_names.py  (run from the godot/ directory)
"""
import json
import math
import sys
import urllib.parse
import urllib.request

MANIFEST = "barcelona/manifest.json"
OUT = "barcelona/street_names.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
SKIP = "footway|steps|path|cycleway|track|bridleway|corridor|platform|proposed|construction|raceway"

# GRS80 / UTM zone 31N
A_ = 6378137.0
F_ = 1.0 / 298.257222101
K0 = 0.9996
LON0 = math.radians(3.0)
FE = 500000.0
E2 = F_ * (2.0 - F_)
EP2 = E2 / (1.0 - E2)


def utm31(lon_deg: float, lat_deg: float):
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    n = A_ / math.sqrt(1.0 - E2 * sin_lat * sin_lat)
    t = tan_lat * tan_lat
    c = EP2 * cos_lat * cos_lat
    a = cos_lat * (lon - LON0)
    m = A_ * (
        (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * lat
        - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * math.sin(2 * lat)
        + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * math.sin(4 * lat)
        - (35 * E2 ** 3 / 3072) * math.sin(6 * lat)
    )
    easting = FE + K0 * n * (
        a + (1 - t + c) * a ** 3 / 6
        + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120
    )
    northing = K0 * (
        m + n * tan_lat * (
            a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24
            + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720
        )
    )
    return easting, northing


def main():
    mf = json.load(open(MANIFEST))
    origin = mf["origin"]
    lon0, lat0 = origin["lon"], origin["lat"]
    e0, n0 = utm31(lon0, lat0)
    err = math.hypot(e0 - origin["easting"], n0 - origin["northing"])
    print(f"projection self-check: {err * 1000:.1f} mm vs manifest origin")
    if err > 0.5:
        sys.exit("projection disagrees with the manifest — aborting")

    w, s, e, n = mf["bbox"]  # lon/lat bbox
    query = (
        f'[out:json][timeout:300];'
        f'way[highway][name][highway!~"^({SKIP})$"]({s},{w},{n},{e});'
        f'out geom;'
    )
    print("querying overpass…")
    req = urllib.request.Request(
        OVERPASS,
        data=("data=" + urllib.parse.quote(query)).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "NightLoopBCN-bake/1.0",
        })
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)

    oe, on = origin["easting"], origin["northing"]
    streets = []
    pts_total = 0
    for el in data.get("elements", []):
        name = el.get("tags", {}).get("name")
        geom = el.get("geometry")
        if not name or not geom or len(geom) < 2:
            continue
        coords = []
        for p in geom:
            ee, nn = utm31(p["lon"], p["lat"])
            coords.append(round(ee - oe, 1))
            coords.append(round(-(nn - on), 1))
        streets.append([name, coords])
        pts_total += len(geom)

    with open(OUT, "w") as f:
        json.dump({"attribution": mf["attribution"], "streets": streets}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT}: {len(streets)} ways, {pts_total} points")


if __name__ == "__main__":
    main()
