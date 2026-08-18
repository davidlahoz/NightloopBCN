#!/usr/bin/env python3
"""NightLoop Mapillary facade harvester.

Discovers, filters and downloads 360° street-level imagery of Barcelona from
Mapillary, matches panos to Cadastre building facades, and reprojects
rectified straight-on facade crops for game textures. Run from godot/.

ON-DISK LAYOUT
==============
  .env                                    MAPILLARY_CLIENT_TOKEN=... (gitignored)
  barcelona/manifest.json                 world origin + EPSG:25831 (read-only)
  work/cadastre/                          stage 0: INSPIRE zip + buildingparts.parquet
  work/mapillary/tiles/{z}_{x}_{y}.mvt    stage 1 tile cache
  work/mapillary/candidates.parquet       stage 1
  work/mapillary/filtered.parquet         stage 2
  work/mapillary/matches.parquet          stage 3
  work/mapillary/meta.parquet             stage 4 (signed URLs never persisted)
  work/mapillary/raw/{image_id}.jpg       stage 5 (resumable)
  work/mapillary/rejected.csv             image_id, stage, reason
  out/facades/{ref}_{edge}_{image}.png    stage 6 crops
  out/facades/contact_sheet_{z}_{x}_{y}.jpg
  out/facades/manifest.json               stage 7 provenance
  out/facades/ATTRIBUTION.md              CC BY-SA 4.0 credits

Stages skip when their output exists (--force re-runs); --dry-run reports the
plan at every stage. Mapillary imagery is CC BY-SA 4.0 (share-alike).
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import requests
from dotenv import load_dotenv

# --------------------------------------------------------------------------
# CONFIG — every tunable in one place; CLI flags override.
# --------------------------------------------------------------------------
CONFIG = {
    "bbox": (1.95, 41.28, 2.30, 41.52),
    "tile_zoom": 14,
    "tiles_url": "https://tiles.mapillary.com/maps/vtp/mly1_computed_public/2/{z}/{x}/{y}",
    "graph_url": "https://graph.mapillary.com",

    # catastro moved from minhap.es (dead DNS) to hacienda.gob.es; its TLS is
    # signed by the Spanish FNMT CA which is absent from certifi, so cadastre
    # requests run with verify=False — public open data, host-pinned, loud.
    "cadastre_atom": "https://www.catastro.hacienda.gob.es/INSPIRE/buildings/08/ES.SDGC.BU.atom_08.xml",
    "cadastre_municipality": "08900",
    "min_floors_default": 4,

    "require_pano": True,
    "min_quality_score": 0.7,
    "max_age_years": 6,
    "local_tz": "Europe/Madrid",
    "daylight_window": (10, 17),
    "sequence_dedupe_m": 25.0,

    "min_facade_len_m": 4.0,
    "candidate_range_m": (8.0, 30.0),
    "ideal_standoff_m": 18.0,
    "top_k_per_edge": 2,
    "score_weights": {"standoff": 1.0, "incidence": 2.0, "quality": 0.5},
    "street_face_max_road_dist_m": 30.0,

    "meta_fields": "id,thumb_2048_url,computed_geometry,computed_compass_angle,"
                   "computed_rotation,camera_type,captured_at,creator,width,height",
    "meta_batch": 50,
    "workers": 8,
    "est_bytes_per_image": 600_000,
    "volume_sanity_gb": 6.0,

    "out_size": 1024,
    "fov_margin": 1.10,
    "max_hfov_deg": 90.0,
    "min_hfov_deg": 22.0,
    "floor_height_m": 3.0,
    "camera_height_m": 2.2,
    "contact_sheet_cols": 10,
    "contact_thumb": 256,
}

WORKDIR = "work"
MLY = os.path.join(WORKDIR, "mapillary")
CAD = os.path.join(WORKDIR, "cadastre")
OUTDIR = os.path.join("out", "facades")
MANIFEST_PATH = os.path.join("barcelona", "manifest.json")

# GRS80 UTM zone 31N (EPSG:25831) — forward, no pyproj needed
_A = 6378137.0
_F = 1.0 / 298.257222101
_K0 = 0.9996
_LON0 = math.radians(3.0)
_FE = 500000.0
_E2 = _F * (2.0 - _F)
_EP2 = _E2 / (1.0 - _E2)


def utm31(lon_deg, lat_deg):
    lon, lat = math.radians(lon_deg), math.radians(lat_deg)
    s, c, t = math.sin(lat), math.cos(lat), math.tan(lat)
    n = _A / math.sqrt(1 - _E2 * s * s)
    tt, cc = t * t, _EP2 * c * c
    a = c * (lon - _LON0)
    m = _A * ((1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256) * lat
              - (3 * _E2 / 8 + 3 * _E2**2 / 32 + 45 * _E2**3 / 1024) * math.sin(2 * lat)
              + (15 * _E2**2 / 256 + 45 * _E2**3 / 1024) * math.sin(4 * lat)
              - (35 * _E2**3 / 3072) * math.sin(6 * lat))
    e = _FE + _K0 * n * (a + (1 - tt + cc) * a**3 / 6
                         + (5 - 18 * tt + tt * tt + 72 * cc - 58 * _EP2) * a**5 / 120)
    nn = _K0 * (m + n * t * (a * a / 2 + (5 - tt + 9 * cc + 4 * cc * cc) * a**4 / 24
                             + (61 - 58 * tt + tt * tt + 600 * cc - 330 * _EP2) * a**6 / 720))
    return e, nn


def token() -> str:
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
    t = os.environ.get("MAPILLARY_CLIENT_TOKEN", "")
    if not t:
        sys.exit("MAPILLARY_CLIENT_TOKEN missing — put it in godot/.env")
    return t


def scrub(url: str) -> str:
    return re.sub(r"access_token=[^&]+", "access_token=***", url)


def reject(image_id, stage, reason):
    new = not os.path.exists(os.path.join(MLY, "rejected.csv"))
    with open(os.path.join(MLY, "rejected.csv"), "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["image_id", "stage", "reason"])
        w.writerow([image_id, stage, reason])


def banner(stage, msg):
    print(f"\n=== [{stage}] {msg} ===")


# --------------------------------------------------------------------------
# slippy tiles
# --------------------------------------------------------------------------
def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def tile_bounds_merc(x, y, z):
    n = 2 ** z
    size = 2 * math.pi * 6378137.0
    ox = -size / 2 + x / n * size
    oy = size / 2 - y / n * size
    return ox, oy - size / n, ox + size / n, oy   # west, south, east, north


def merc_to_lonlat(mx, my):
    lon = math.degrees(mx / 6378137.0)
    lat = math.degrees(2 * math.atan(math.exp(my / 6378137.0)) - math.pi / 2)
    return lon, lat


def tiles_for_bbox(bbox, z):
    x0, y0 = lonlat_to_tile(bbox[0], bbox[3], z)   # NW
    x1, y1 = lonlat_to_tile(bbox[2], bbox[1], z)   # SE
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


# --------------------------------------------------------------------------
# STAGE 0 — Cadastre footprints
# --------------------------------------------------------------------------
def stage0_footprints(args):
    out = os.path.join(CAD, "buildingparts.parquet")
    if os.path.exists(out) and not args.force:
        banner(0, f"reuse {out}")
        return
    banner(0, "cadastre INSPIRE buildings (08900 Barcelona)")
    if args.dry_run:
        print("dry-run: would download the 08900 buildings zip and parse buildingpart GML")
        return
    os.makedirs(CAD, exist_ok=True)
    from lxml import etree

    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    print("[0] NOTE: catastro.hacienda.gob.es uses the FNMT CA (not in certifi) — "
          "fetching this public dataset with TLS verification disabled")
    zip_path = os.path.join(CAD, "A.ES.SDGC.BU.08900.zip")
    if not os.path.exists(zip_path):
        atom = requests.get(CONFIG["cadastre_atom"], timeout=120, verify=False)
        atom.raise_for_status()
        root = etree.fromstring(atom.content)
        url = None
        for entry in root.iter("{*}entry"):
            txt = etree.tostring(entry, encoding="unicode")
            if CONFIG["cadastre_municipality"] in txt:
                for link in entry.iter("{*}link"):
                    href = link.get("href", "")
                    if href.lower().endswith(".zip"):
                        url = href
                        break
                if url is None:
                    for elid in entry.iter("{*}id"):
                        if elid.text and elid.text.lower().endswith(".zip"):
                            url = elid.text
                            break
            if url:
                break
        if not url:
            sys.exit("could not find the 08900 zip in the cadastre ATOM feed")
        print(f"[0] downloading {url}")
        with requests.get(url, stream=True, timeout=600, verify=False) as r:
            r.raise_for_status()
            with open(zip_path + ".part", "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        os.rename(zip_path + ".part", zip_path)
    print(f"[0] zip: {os.path.getsize(zip_path)/1e6:.1f} MB")

    zf = zipfile.ZipFile(zip_path)
    gml_name = next((n for n in zf.namelist() if "buildingpart" in n.lower()
                     and n.lower().endswith(".gml")), None)
    if gml_name is None:
        sys.exit(f"no buildingpart gml inside {zip_path}: {zf.namelist()[:8]}")
    print(f"[0] parsing {gml_name}")
    refs, floors_l, xs_l, ys_l = [], [], [], []
    swapped = None
    with zf.open(gml_name) as fh:
        for _ev, el in etree.iterparse(fh, events=("end",)):
            if not el.tag.endswith("BuildingPart"):
                continue
            ref = el.get("{http://www.opengis.net/gml/3.2}id") or ""
            floors = -1
            for fl in el.iter("{*}numberOfFloorsAboveGround"):
                try:
                    floors = int(fl.text)
                except (TypeError, ValueError):
                    pass
                break
            pos = next(iter(el.iter("{*}posList")), None)
            if pos is not None and pos.text:
                vals = [float(v) for v in pos.text.split()]
                if len(vals) >= 8:
                    a, b = vals[0], vals[1]
                    if swapped is None:
                        swapped = a > 1_000_000   # (N,E) axis order in this file
                    xs = vals[1::2] if swapped else vals[0::2]
                    ys = vals[0::2] if swapped else vals[1::2]
                    refs.append(ref)
                    floors_l.append(floors)
                    xs_l.append(xs)
                    ys_l.append(ys)
            el.clear()
    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.table({
        "ref": refs, "floors": floors_l, "xs": xs_l, "ys": ys_l}), out)
    print(f"[0] {len(refs)} building parts -> {out} (axis order swapped={swapped})")


# --------------------------------------------------------------------------
# STAGE 1 — discover via vector tiles
# --------------------------------------------------------------------------
def stage1_discover(args):
    out = os.path.join(MLY, "candidates.parquet")
    tiles = _wanted_tiles(args)
    if os.path.exists(out) and not args.force:
        banner(1, f"reuse {out}")
        return
    banner(1, f"discover: {len(tiles)} z14 tiles")
    if args.dry_run:
        print(f"dry-run: would fetch/decode {len(tiles)} tiles")
        return
    os.makedirs(os.path.join(MLY, "tiles"), exist_ok=True)
    import mapbox_vector_tile
    tok = token()
    rows = {k: [] for k in ("image_id", "lon", "lat", "captured_at",
                            "compass_angle", "is_pano", "sequence_id",
                            "quality_score", "tile_x", "tile_y")}
    z = CONFIG["tile_zoom"]
    t0 = time.time()
    fetched = 0
    for i, (x, y) in enumerate(tiles):
        cache = os.path.join(MLY, "tiles", f"{z}_{x}_{y}.mvt")
        if os.path.exists(cache):
            data = open(cache, "rb").read()
        else:
            url = CONFIG["tiles_url"].format(z=z, x=x, y=y) + f"?access_token={tok}"
            r = requests.get(url, timeout=60)
            if r.status_code == 404:
                data = b""
            else:
                r.raise_for_status()
                data = r.content
            open(cache, "wb").write(data)
            fetched += 1
        if not data:
            continue
        decoded = mapbox_vector_tile.decode(data)
        layer = decoded.get("image")
        if not layer:
            continue
        extent = layer.get("extent", 4096)
        w, s, e, n = tile_bounds_merc(x, y, z)
        for feat in layer["features"]:
            p = feat.get("properties", {})
            gx, gy = feat["geometry"]["coordinates"][:2]
            mx = w + gx / extent * (e - w)
            my = s + gy / extent * (n - s)     # y origin bottom (lib un-flips)
            lon, lat = merc_to_lonlat(mx, my)
            rows["image_id"].append(int(p.get("id", feat.get("id", 0))))
            rows["lon"].append(lon)
            rows["lat"].append(lat)
            rows["captured_at"].append(int(p.get("captured_at", 0)))
            rows["compass_angle"].append(float(p.get("compass_angle", -1.0)))
            rows["is_pano"].append(bool(p.get("is_pano", False)))
            rows["sequence_id"].append(str(p.get("sequence_id", "")))
            q = p.get("quality_score")
            rows["quality_score"].append(float(q) if q is not None else float("nan"))
            rows["tile_x"].append(x)
            rows["tile_y"].append(y)
        if (i + 1) % 25 == 0:
            print(f"[1] {i+1}/{len(tiles)} tiles ({fetched} fetched)")
    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.table(rows), out)
    n_img = len(rows["image_id"])
    n_pano = sum(rows["is_pano"])
    ts = [t for t in rows["captured_at"] if t > 0]
    dr = ""
    if ts:
        dr = f"{datetime.fromtimestamp(min(ts)/1000, tz=timezone.utc):%Y-%m} .. " \
             f"{datetime.fromtimestamp(max(ts)/1000, tz=timezone.utc):%Y-%m}"
    print(f"[1] tiles={len(tiles)} images={n_img} panos={n_pano} dates {dr} "
          f"({time.time()-t0:.0f}s)")


def _wanted_tiles(args):
    if args.tiles:
        x, y = (int(v) for v in args.tiles.split(","))
        return [(x, y)]
    bbox = tuple(float(v) for v in args.bbox.split(",")) if args.bbox else CONFIG["bbox"]
    return tiles_for_bbox(bbox, CONFIG["tile_zoom"])


# --------------------------------------------------------------------------
# STAGE 2 — filter
# --------------------------------------------------------------------------
def stage2_filter(args):
    out = os.path.join(MLY, "filtered.parquet")
    if os.path.exists(out) and not args.force:
        banner(2, f"reuse {out}")
        return
    banner(2, "filter")
    import pyarrow.parquet as pq
    import pyarrow as pa
    t = pq.read_table(os.path.join(MLY, "candidates.parquet")).to_pydict()
    n0 = len(t["image_id"])
    if args.dry_run:
        print(f"dry-run: would filter {n0} candidates")
        return

    idx = list(range(n0))
    # 1. panos only — HARD requirement (perspective images rectify into smear)
    keep = [i for i in idx if t["is_pano"][i]]
    for i in set(idx) - set(keep):
        reject(t["image_id"][i], 2, "not-pano")
    print(f"[2] pano:            {len(keep)}/{n0}")
    idx = keep

    # 2. quality score (null dropped) — unless the tile source doesn't carry it
    n_scored = sum(1 for i in idx if not math.isnan(t["quality_score"][i]))
    if idx and n_scored < 0.1 * len(idx):
        print(f"[2] WARNING: quality_score present on only {n_scored}/{len(idx)} "
              f"tile features — the vector tiles don't carry it here. SKIPPING "
              f"the score filter (deviation from spec, flagged for review).")
    else:
        keep = [i for i in idx if not math.isnan(t["quality_score"][i])
                and t["quality_score"][i] > CONFIG["min_quality_score"]]
        for i in set(idx) - set(keep):
            reject(t["image_id"][i], 2, "quality")
        idx = keep
    print(f"[2] quality:         {len(idx)}")

    # 3. age
    cutoff = (datetime.now(tz=timezone.utc).timestamp()
              - CONFIG["max_age_years"] * 365.25 * 86400) * 1000
    keep = [i for i in idx if t["captured_at"][i] >= cutoff]
    for i in set(idx) - set(keep):
        reject(t["image_id"][i], 2, "too-old")
    idx = keep
    print(f"[2] age<= {CONFIG['max_age_years']}y:        {len(idx)}")

    # 4. local daylight window
    tz = ZoneInfo(CONFIG["local_tz"])
    lo, hi = CONFIG["daylight_window"]
    keep = []
    for i in idx:
        h = datetime.fromtimestamp(t["captured_at"][i] / 1000, tz=tz).hour
        if lo <= h < hi:
            keep.append(i)
        else:
            reject(t["image_id"][i], 2, "off-hours")
    idx = keep
    print(f"[2] daylight {lo}-{hi}h:   {len(idx)}")

    # 5. sequence dedupe: one image per 25 m of travel per sequence
    by_seq = {}
    for i in idx:
        by_seq.setdefault(t["sequence_id"][i], []).append(i)
    keep = []
    for seq, members in by_seq.items():
        members.sort(key=lambda i: t["captured_at"][i])
        last_e, last_n = None, None
        for i in members:
            e, n = utm31(t["lon"][i], t["lat"][i])
            if last_e is None or math.hypot(e - last_e, n - last_n) >= CONFIG["sequence_dedupe_m"]:
                keep.append(i)
                last_e, last_n = e, n
            else:
                reject(t["image_id"][i], 2, "seq-dedupe")
    idx = keep
    print(f"[2] seq dedupe:      {len(idx)}")

    cols = {k: [t[k][i] for i in idx] for k in t}
    es, ns = [], []
    for i in range(len(cols["image_id"])):
        e, n = utm31(cols["lon"][i], cols["lat"][i])
        es.append(e)
        ns.append(n)
    cols["e"], cols["n"] = es, ns
    pq.write_table(pa.table(cols), out)
    print(f"[2] -> {out}")


# --------------------------------------------------------------------------
# STAGE 3 — match panos to street-facing facade edges
# --------------------------------------------------------------------------
def stage3_match(args):
    out = os.path.join(MLY, "matches.parquet")
    if os.path.exists(out) and not args.force:
        banner(3, f"reuse {out}")
        return
    banner(3, "match facades")
    import pyarrow.parquet as pq
    import pyarrow as pa
    cad = pq.read_table(os.path.join(CAD, "buildingparts.parquet")).to_pydict()
    imgs = pq.read_table(os.path.join(MLY, "filtered.parquet")).to_pydict()
    n_img = len(imgs["image_id"])
    if args.dry_run:
        print(f"dry-run: would match {len(cad['ref'])} parts x {n_img} panos")
        return

    # limit to the area actually covered by the selected tiles (+margin)
    z = CONFIG["tile_zoom"]
    boxes = []
    for x, y in {(imgs["tile_x"][i], imgs["tile_y"][i]) for i in range(n_img)}:
        w, s, e, n = tile_bounds_merc(x, y, z)
        lo = merc_to_lonlat(w, s)
        hi = merc_to_lonlat(e, n)
        e0, n0 = utm31(lo[0], lo[1])
        e1, n1 = utm31(hi[0], hi[1])
        boxes.append((min(e0, e1) - 50, min(n0, n1) - 50, max(e0, e1) + 50, max(n0, n1) + 50))

    def in_area(e, n):
        return any(b[0] <= e <= b[2] and b[1] <= n <= b[3] for b in boxes)

    # pano spatial grid (32 m)
    grid = {}
    for i in range(n_img):
        key = (int(imgs["e"][i] // 32), int(imgs["n"][i] // 32))
        grid.setdefault(key, []).append(i)

    # roads: reuse the baked OSM street polylines (world -> EPSG:25831)
    mf = json.load(open(MANIFEST_PATH))
    oe, on = mf["origin"]["easting"], mf["origin"]["northing"]
    streets = json.load(open(os.path.join("barcelona", "street_names.json")))["streets"]
    rgrid = {}
    for _name, coords in streets:
        for i in range(0, len(coords) - 2, 2):
            for tpar in (0.0, 0.5):
                px = coords[i] + (coords[i + 2] - coords[i]) * tpar + oe
                pz = coords[i + 1] + (coords[i + 3] - coords[i + 1]) * tpar
                pn = -(pz) + on - 2 * 0  # z = -(N - on) -> N = on - z
                pn = on - (coords[i + 1] + (coords[i + 3] - coords[i + 1]) * tpar)
                key = (int(px // 32), int(pn // 32))
                rgrid.setdefault(key, []).append((px, pn))

    def near_road(mx, my, nx, ny):
        best = None
        kx, ky = int(mx // 32), int(my // 32)
        r = int(CONFIG["street_face_max_road_dist_m"] // 32) + 1
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for (px, pn) in rgrid.get((kx + dx, ky + dy), ()):
                    d = math.hypot(px - mx, pn - my)
                    if d <= CONFIG["street_face_max_road_dist_m"] and \
                            (px - mx) * nx + (pn - my) * ny > 0:
                        if best is None or d < best:
                            best = d
        return best is not None

    w_s = CONFIG["score_weights"]["standoff"]
    w_i = CONFIG["score_weights"]["incidence"]
    w_q = CONFIG["score_weights"]["quality"]
    lo_d, hi_d = CONFIG["candidate_range_m"]
    rows = {k: [] for k in ("ref", "edge", "image_id", "m_e", "m_n", "n_e", "n_n",
                            "facade_len", "floors", "standoff", "incidence_deg",
                            "score", "tile_x", "tile_y")}
    skipped_short = skipped_nocand = edges_total = 0

    for bi in range(len(cad["ref"])):
        xs, ys = cad["xs"][bi], cad["ys"][bi]
        if not in_area(xs[0], ys[0]):
            continue
        # ring orientation for outward normals
        area2 = sum(xs[i] * ys[(i + 1) % len(xs)] - xs[(i + 1) % len(xs)] * ys[i]
                    for i in range(len(xs)))
        ccw = area2 > 0
        for ei in range(len(xs) - 1):
            ax, ay, bx, by = xs[ei], ys[ei], xs[ei + 1], ys[ei + 1]
            flen = math.hypot(bx - ax, by - ay)
            if flen < CONFIG["min_facade_len_m"]:
                skipped_short += 1
                continue
            edges_total += 1
            mx, my = (ax + bx) / 2, (ay + by) / 2
            dx, dy = (bx - ax) / flen, (by - ay) / flen
            nx, ny = (dy, -dx) if ccw else (-dy, dx)
            if not near_road(mx, my, nx, ny):
                continue
            # candidates
            cands = []
            kx, ky = int(mx // 32), int(my // 32)
            for gx in range(kx - 1, kx + 2):
                for gy in range(ky - 1, ky + 2):
                    for ii in grid.get((gx, gy), ()):
                        ce, cn = imgs["e"][ii], imgs["n"][ii]
                        side = (ce - mx) * nx + (cn - my) * ny
                        if side <= 0:
                            continue
                        d = math.hypot(ce - mx, cn - my)
                        if d < lo_d or d > hi_d:
                            continue
                        vx, vy = (mx - ce) / d, (my - cn) / d
                        cosi = -(vx * nx + vy * ny)
                        if cosi <= 0:
                            continue
                        q = imgs["quality_score"][ii]
                        qv = 0.5 if math.isnan(q) else q
                        score = (w_s * math.exp(-((d - CONFIG["ideal_standoff_m"]) / 7.0) ** 2)
                                 + w_i * cosi * cosi + w_q * qv)
                        cands.append((score, ii, d, math.degrees(math.acos(min(cosi, 1.0)))))
            if not cands:
                skipped_nocand += 1
                continue
            cands.sort(reverse=True)
            for score, ii, d, inc in cands[:CONFIG["top_k_per_edge"]]:
                rows["ref"].append(cad["ref"][bi])
                rows["edge"].append(ei)
                rows["image_id"].append(imgs["image_id"][ii])
                rows["m_e"].append(mx)
                rows["m_n"].append(my)
                rows["n_e"].append(nx)
                rows["n_n"].append(ny)
                rows["facade_len"].append(flen)
                rows["floors"].append(cad["floors"][bi])
                rows["standoff"].append(d)
                rows["incidence_deg"].append(inc)
                rows["score"].append(score)
                rows["tile_x"].append(imgs["tile_x"][ii])
                rows["tile_y"].append(imgs["tile_y"][ii])
    pq.write_table(pa.table(rows), out)
    print(f"[3] edges considered={edges_total} matches={len(rows['ref'])} "
          f"unique images={len(set(rows['image_id']))}")
    print(f"[3] skipped: short={skipped_short} no-candidate={skipped_nocand}")


# --------------------------------------------------------------------------
# STAGE 4 — metadata (selected images only)
# --------------------------------------------------------------------------
def _fetch_meta(ids, tok):
    url = f"{CONFIG['graph_url']}/?ids={','.join(str(i) for i in ids)}&fields={CONFIG['meta_fields']}"
    for attempt in range(6):
        r = requests.get(url, headers={"Authorization": f"OAuth {tok}"}, timeout=60)
        if r.status_code == 200:
            d = r.json()
            return list(d.get("data", d.values() if isinstance(d, dict) else []))
        body = r.text[:200]
        if '"code":4' in body or r.status_code in (429, 500, 502, 503):
            time.sleep(2 ** attempt)
            continue
        raise RuntimeError(f"graph error {r.status_code}: {scrub(body)}")
    raise RuntimeError("graph API: retries exhausted")


def stage4_metadata(args):
    out = os.path.join(MLY, "meta.parquet")
    if os.path.exists(out) and not args.force:
        banner(4, f"reuse {out}")
        return
    banner(4, "fetch metadata")
    import pyarrow.parquet as pq
    import pyarrow as pa
    m = pq.read_table(os.path.join(MLY, "matches.parquet")).to_pydict()
    ids = sorted(set(m["image_id"]))
    if args.dry_run:
        print(f"dry-run: would fetch metadata for {len(ids)} images")
        return
    tok = token()
    batches = [ids[i:i + CONFIG["meta_batch"]] for i in range(0, len(ids), CONFIG["meta_batch"])]
    rows = {k: [] for k in ("image_id", "cam_lon", "cam_lat", "compass", "rot_x",
                            "rot_y", "rot_z", "camera_type", "captured_at",
                            "creator", "width", "height")}
    _thumb_urls.clear()
    with ThreadPoolExecutor(max_workers=CONFIG["workers"]) as ex:
        futs = [ex.submit(_fetch_meta, b, tok) for b in batches]
        for fu in as_completed(futs):
            for ent in fu.result():
                geo = ent.get("computed_geometry", {}).get("coordinates", [0, 0])
                rot = ent.get("computed_rotation") or [0.0, 0.0, 0.0]
                rows["image_id"].append(int(ent["id"]))
                rows["cam_lon"].append(float(geo[0]))
                rows["cam_lat"].append(float(geo[1]))
                rows["compass"].append(float(ent.get("computed_compass_angle", -1.0)))
                rows["rot_x"].append(float(rot[0]))
                rows["rot_y"].append(float(rot[1]))
                rows["rot_z"].append(float(rot[2]))
                rows["camera_type"].append(str(ent.get("camera_type", "")))
                rows["captured_at"].append(int(ent.get("captured_at", 0)))
                creator = ent.get("creator", {})
                rows["creator"].append(str(creator.get("username", "")))
                rows["width"].append(int(ent.get("width", 0)))
                rows["height"].append(int(ent.get("height", 0)))
                u = ent.get("thumb_2048_url")
                if u:
                    _thumb_urls[int(ent["id"])] = u   # in-memory only, never persisted
    pq.write_table(pa.table(rows), out)
    print(f"[4] metadata for {len(rows['image_id'])}/{len(ids)} images -> {out}")


_thumb_urls: dict = {}


# --------------------------------------------------------------------------
# STAGE 5 — download
# --------------------------------------------------------------------------
def stage5_download(args):
    banner(5, "download")
    import pyarrow.parquet as pq
    meta = pq.read_table(os.path.join(MLY, "meta.parquet")).to_pydict()
    raw = os.path.join(MLY, "raw")
    os.makedirs(raw, exist_ok=True)
    missing = [i for i, iid in enumerate(meta["image_id"])
               if not os.path.exists(os.path.join(raw, f"{iid}.jpg"))]
    est = len(missing) * CONFIG["est_bytes_per_image"]
    print(f"[5] plan: {len(missing)} images to download, ~{est/1e6:.0f} MB "
          f"(total selected {len(meta['image_id'])})")
    if est > CONFIG["volume_sanity_gb"] * 1e9:
        sys.exit(f"[5] plan exceeds {CONFIG['volume_sanity_gb']} GB — filters look "
                 f"broken, refusing to download")
    if args.dry_run:
        print("dry-run: stopping at the plan")
        return
    if not missing:
        print("[5] nothing to do")
        return
    # signed CDN URLs are short-lived: fetch fresh ones for the missing set
    tok = token()
    need_ids = [meta["image_id"][i] for i in missing]
    urls = {}
    for iid in need_ids:
        if iid in _thumb_urls:
            urls[iid] = _thumb_urls[iid]
    todo = [i for i in need_ids if i not in urls]
    for b in range(0, len(todo), CONFIG["meta_batch"]):
        for ent in _fetch_meta(todo[b:b + CONFIG["meta_batch"]], tok):
            if ent.get("thumb_2048_url"):
                urls[int(ent["id"])] = ent["thumb_2048_url"]

    def dl(iid):
        path = os.path.join(raw, f"{iid}.jpg")
        u = urls.get(iid)
        if not u:
            reject(iid, 5, "no-thumb-url")
            return 0
        for attempt in range(4):
            try:
                with requests.get(u, stream=True, timeout=120) as r:
                    r.raise_for_status()
                    with open(path + ".part", "wb") as f:
                        for chunk in r.iter_content(1 << 18):
                            f.write(chunk)
                if os.path.getsize(path + ".part") > 20_000:
                    os.rename(path + ".part", path)
                    return 1
            except requests.RequestException:
                time.sleep(1.5 ** attempt)
        reject(iid, 5, "download-failed")
        return 0

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=CONFIG["workers"]) as ex:
        for ok in ex.map(dl, need_ids):
            done += ok
            if done % 50 == 0 and done:
                print(f"[5] {done}/{len(need_ids)}")
    print(f"[5] downloaded {done}/{len(need_ids)} in {time.time()-t0:.0f}s")


# --------------------------------------------------------------------------
# STAGE 6 — reproject
# --------------------------------------------------------------------------
def _rodrigues(r):
    th = math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2)
    if th < 1e-9:
        return np.eye(3)
    k = np.array(r) / th
    kk = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * kk + (1 - math.cos(th)) * (kk @ kk)


def stage6_reproject(args):
    banner(6, "reproject")
    from PIL import Image
    import pyarrow.parquet as pq
    m = pq.read_table(os.path.join(MLY, "matches.parquet")).to_pydict()
    meta = pq.read_table(os.path.join(MLY, "meta.parquet")).to_pydict()
    mi = {meta["image_id"][i]: i for i in range(len(meta["image_id"]))}
    os.makedirs(OUTDIR, exist_ok=True)
    n_rows = len(m["ref"])
    if args.dry_run:
        print(f"dry-run: would reproject {n_rows} facade crops")
        return

    S = CONFIG["out_size"]
    made = skipped = 0
    sheets = {}
    t0 = time.time()
    for i in range(n_rows):
        iid = m["image_id"][i]
        ref_short = m["ref"][i].split(".")[-1] or f"b{i}"
        out_png = os.path.join(OUTDIR, f"{ref_short}_{m['edge'][i]}_{iid}.png")
        key = (m["tile_x"][i], m["tile_y"][i])
        if os.path.exists(out_png) and not args.force:
            sheets.setdefault(key, []).append(out_png)
            continue
        if iid not in mi:
            skipped += 1
            continue
        raw = os.path.join(MLY, "raw", f"{iid}.jpg")
        if not os.path.exists(raw):
            skipped += 1
            continue
        j = mi[iid]
        img = np.asarray(Image.open(raw).convert("RGB"), dtype=np.float32)
        H, W = img.shape[:2]
        if W < 2 * H - 4 or W > 2 * H + 4:
            reject(iid, 6, f"not-equirect {W}x{H}")
            skipped += 1
            continue

        cam_e, cam_n = utm31(meta["cam_lon"][j], meta["cam_lat"][j])
        de, dn = m["m_e"][i] - cam_e, m["m_n"][i] - cam_n
        standoff = math.hypot(de, dn)
        bearing = math.atan2(de, dn)                     # 0 = north, cw
        floors = m["floors"][i] if m["floors"][i] > 0 else CONFIG["min_floors_default"]
        fh = floors * CONFIG["floor_height_m"]
        hfov = 2 * math.atan(m["facade_len"][i] * CONFIG["fov_margin"] / (2 * standoff))
        hfov = min(max(hfov, math.radians(CONFIG["min_hfov_deg"])),
                   math.radians(CONFIG["max_hfov_deg"]))

        # shift-lens projection: camera axis stays HORIZONTAL and the frame
        # shifts up — pitching the camera keystones the facade (verticals
        # converge), which is exactly wrong for texture crops
        fwd = np.array([math.sin(bearing), math.cos(bearing), 0.0])
        right = np.array([math.cos(bearing), -math.sin(bearing), 0.0])
        up = np.array([0.0, 0.0, 1.0])

        half = math.tan(hfov / 2)
        hc = CONFIG["camera_height_m"]
        v_lo = (-hc - 0.5) / standoff                    # just below street level
        v_hi = min((fh + 0.5 - hc) / standoff, 3.0)      # parapet, clamped
        out_h = int(np.clip(S * (v_hi - v_lo) / (2 * half), S // 2, int(2.6 * S)))
        u = np.linspace(-half, half, S, dtype=np.float32)
        v = np.linspace(v_hi, v_lo, out_h, dtype=np.float32)
        uu, vv = np.meshgrid(u, v)
        d_world = (fwd[None, None, :] + uu[..., None] * right[None, None, :]
                   + vv[..., None] * up[None, None, :])
        d_world /= np.linalg.norm(d_world, axis=2, keepdims=True)

        # world (E,N,U) -> pano camera frame via OpenSfM computed_rotation
        R = _rodrigues([meta["rot_x"][j], meta["rot_y"][j], meta["rot_z"][j]])
        # OpenSfM world is (E,N,U) with camera x right, y down, z forward
        d_cam = d_world @ R.T
        theta = np.arctan2(d_cam[..., 0], d_cam[..., 2])
        phi = np.arcsin(np.clip(d_cam[..., 1], -1.0, 1.0))
        px = (theta / (2 * math.pi) + 0.5) * W
        py = (phi / math.pi + 0.5) * H

        x0 = np.floor(px).astype(np.int32) % W
        x1 = (x0 + 1) % W
        y0 = np.clip(np.floor(py).astype(np.int32), 0, H - 1)
        y1 = np.clip(y0 + 1, 0, H - 1)
        fx = (px - np.floor(px))[..., None].astype(np.float32)
        fy = (py - np.floor(py))[..., None].astype(np.float32)
        outp = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
                + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)
        Image.fromarray(outp.astype(np.uint8)).save(out_png)
        sheets.setdefault(key, []).append(out_png)
        made += 1
        if made % 25 == 0:
            print(f"[6] {made} crops ({time.time()-t0:.0f}s)")

    # contact sheets per tile
    from PIL import Image as PImage
    thumb = CONFIG["contact_thumb"]
    cols = CONFIG["contact_sheet_cols"]
    for (tx, ty), files in sheets.items():
        files = sorted(set(files))
        rows_n = (len(files) + cols - 1) // cols
        sheet = PImage.new("RGB", (cols * thumb, max(rows_n, 1) * thumb), (12, 12, 14))
        for k, f in enumerate(files):
            try:
                im = PImage.open(f).resize((thumb, thumb))
            except OSError:
                continue
            sheet.paste(im, ((k % cols) * thumb, (k // cols) * thumb))
        sp = os.path.join(OUTDIR, f"contact_sheet_{CONFIG['tile_zoom']}_{tx}_{ty}.jpg")
        sheet.save(sp, quality=88)
        print(f"[6] {sp} ({len(files)} crops)")
    print(f"[6] made={made} skipped={skipped} in {time.time()-t0:.0f}s")


# --------------------------------------------------------------------------
# STAGE 7 — manifest + attribution
# --------------------------------------------------------------------------
def stage7_manifest(args):
    banner(7, "manifest + attribution")
    import pyarrow.parquet as pq
    if args.dry_run:
        print("dry-run: would write manifest.json and ATTRIBUTION.md")
        return
    m = pq.read_table(os.path.join(MLY, "matches.parquet")).to_pydict()
    meta = pq.read_table(os.path.join(MLY, "meta.parquet")).to_pydict()
    mi = {meta["image_id"][i]: i for i in range(len(meta["image_id"]))}
    records = []
    creators = {}
    for i in range(len(m["ref"])):
        iid = m["image_id"][i]
        if iid not in mi:
            continue
        j = mi[iid]
        ref_short = m["ref"][i].split(".")[-1] or f"b{i}"
        fn = f"{ref_short}_{m['edge'][i]}_{iid}.png"
        if not os.path.exists(os.path.join(OUTDIR, fn)):
            continue
        floors = m["floors"][i] if m["floors"][i] > 0 else CONFIG["min_floors_default"]
        records.append({
            "output": fn,
            "mapillary_image_id": iid,
            "creator": meta["creator"][j],
            "captured_at": meta["captured_at"][j],
            "cadastre_ref": m["ref"][i],
            "edge_index": m["edge"][i],
            "standoff_m": round(m["standoff"][i], 2),
            "incidence_deg": round(m["incidence_deg"][i], 1),
            "quality_score": None,
            "reprojection": {
                "floors": floors,
                "facade_len_m": round(m["facade_len"][i], 2),
                "fov_margin": CONFIG["fov_margin"],
                "out_size": CONFIG["out_size"],
                "camera_height_m": CONFIG["camera_height_m"],
                "floor_height_m": CONFIG["floor_height_m"],
            },
        })
        creators[meta["creator"][j]] = creators.get(meta["creator"][j], 0) + 1
    with open(os.path.join(OUTDIR, "manifest.json"), "w") as f:
        json.dump({"license": "CC BY-SA 4.0 (Mapillary contributors)",
                   "records": records}, f, indent=1)
    with open(os.path.join(OUTDIR, "ATTRIBUTION.md"), "w") as f:
        f.write("# Facade imagery attribution\n\n"
                "Source imagery from [Mapillary](https://www.mapillary.com), licensed "
                "[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) "
                "(share-alike). Contributing users:\n\n")
        for u, n in sorted(creators.items(), key=lambda kv: -kv[1]):
            f.write(f"- [{u}](https://www.mapillary.com/app/user/{u}) — {n} images\n")
    print(f"[7] {len(records)} records, {len(creators)} creators")


# --------------------------------------------------------------------------
STAGES = [stage0_footprints, stage1_discover, stage2_filter, stage3_match,
          stage4_metadata, stage5_download, stage6_reproject, stage7_manifest]


def main():
    ap = argparse.ArgumentParser(description="Mapillary facade harvester")
    ap.add_argument("--bbox", help="lonmin,latmin,lonmax,latmax")
    ap.add_argument("--tiles", help="X,Y — run exactly one z14 tile")
    ap.add_argument("--stage", type=int)
    ap.add_argument("--until", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-age", type=float,
                    help="override max_age_years (Barcelona panos are mostly 2016-2019)")
    args = ap.parse_args()
    if args.max_age:
        CONFIG["max_age_years"] = args.max_age
    os.makedirs(MLY, exist_ok=True)
    token()
    todo = [args.stage] if args.stage is not None else list(range(0, args.until + 1))
    t0 = time.time()
    for i in todo:
        STAGES[i](args)
    print(f"\nall done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
