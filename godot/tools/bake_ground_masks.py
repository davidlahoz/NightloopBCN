#!/usr/bin/env python3
"""Bake per-tile ground classification masks for the Barcelona tiles.

The road tiles are ONE flat mesh with one material, so carriageway /
sidewalk / park / bike lane must be classified by world position. This
bakes a 512x512 RGB PNG per 500 m tile (~1 m/px):

  R = carriageway asphalt   (traffic lane graph, all lanes incl. junction
                             internals, drawn at lane width)
  G = park / green space    (OSM leisure/landuse/natural polygons)
  B = bike lane             (OSM highway=cycleway, drawn 2.4 m wide)

Anything unmasked is sidewalk paving. The shader gives priority
bike > asphalt > grass > paving, so bike lanes never read as sidewalk.

Inputs : out/lane_graph.bin, work/parks.geojson, work/cycle.geojson,
         barcelona/manifest.json
Outputs: barcelona/masks/tile_X_Z.png (+ .gdignore so Godot won't import)

Run from godot/:  python3 tools/bake_ground_masks.py
"""
import json
import math
import os
import sys
from collections import defaultdict

from PIL import Image, ImageDraw
from shapely.geometry import shape
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(__file__))
from check_lane_graph import load_bin                    # noqa: E402
from bake_street_names import utm31                      # noqa: E402

TILE = 500.0
RES = 512
PX = RES / TILE
LANE_W = 3.4        # drawn width per lane, m (3.2 SUMO + join margin)
BIKE_W = 2.4
ORIGIN_E = 426857.48212297366
ORIGIN_N = 4583531.762974968


def to_godot(lon, lat):
    e, n = utm31(lon, lat)
    return e - ORIGIN_E, -(n - ORIGIN_N)


def tile_of(x, z):
    return int(math.floor(x / TILE)), int(math.floor(z / TILE))


def main():
    man = json.load(open("barcelona/manifest.json"))
    tiles = {(t["tile_x"], t["tile_z"]) for t in man["tiles"]}
    print(f"[masks] {len(tiles)} tiles")

    # --- bucket lane segments by tile -----------------------------------
    g = load_bin("out/lane_graph.bin")
    lane_segs = defaultdict(list)      # (tx,tz) -> [(x0,z0,x1,z1), ...]
    pts = g["points"]
    for lane in range(g["L"]):
        a, b = g["lane_point_start"][lane], g["lane_point_start"][lane + 1]
        for i in range(a, b - 1):
            x0, z0 = pts[i * 4], pts[i * 4 + 2]
            x1, z1 = pts[(i + 1) * 4], pts[(i + 1) * 4 + 2]
            # dilate by the paint width so border lanes spill into the
            # neighbouring tile's mask (no asphalt cuts at tile seams)
            for t in {tile_of(min(x0, x1) - LANE_W, min(z0, z1) - LANE_W),
                      tile_of(max(x0, x1) + LANE_W, min(z0, z1) - LANE_W),
                      tile_of(min(x0, x1) - LANE_W, max(z0, z1) + LANE_W),
                      tile_of(max(x0, x1) + LANE_W, max(z0, z1) + LANE_W)}:
                lane_segs[t].append((x0, z0, x1, z1))
    print(f"[masks] lane segments bucketed over {len(lane_segs)} tiles")

    # --- bike segments ---------------------------------------------------
    bike_segs = defaultdict(list)
    for feat in json.load(open("work/cycle.geojson"))["features"]:
        geom = feat["geometry"]
        if geom["type"] != "LineString":
            continue
        pl = [to_godot(lon, lat) for lon, lat in geom["coordinates"]]
        for (x0, z0), (x1, z1) in zip(pl, pl[1:]):
            for t in {tile_of(min(x0, x1) - BIKE_W, min(z0, z1) - BIKE_W),
                      tile_of(max(x0, x1) + BIKE_W, min(z0, z1) - BIKE_W),
                      tile_of(min(x0, x1) - BIKE_W, max(z0, z1) + BIKE_W),
                      tile_of(max(x0, x1) + BIKE_W, max(z0, z1) + BIKE_W)}:
                bike_segs[t].append((x0, z0, x1, z1))
    print(f"[masks] bike segments over {len(bike_segs)} tiles")

    # --- park polygons (shapely, godot coords) with a spatial index ------
    parks = []
    for feat in json.load(open("work/parks.geojson"))["features"]:
        gm = feat["geometry"]
        if gm["type"] not in ("Polygon", "MultiPolygon"):
            continue
        if gm["type"] == "Polygon":
            polys = [gm["coordinates"]]
        else:
            polys = gm["coordinates"]
        for rings in polys:
            conv = [[to_godot(lon, lat) for lon, lat in ring] for ring in rings]
            try:
                p = shape({"type": "Polygon",
                           "coordinates": [[list(c) for c in r] for r in conv]})
                if p.is_valid and p.area > 150.0:
                    parks.append(p)
            except Exception:
                pass
    tree = STRtree(parks)
    print(f"[masks] {len(parks)} park polygons")

    os.makedirs("barcelona/masks", exist_ok=True)
    open("barcelona/masks/.gdignore", "w").close()

    from shapely.geometry import box as sbox
    written = 0
    for (tx, tz) in sorted(tiles):
        ox, oz = tx * TILE, tz * TILE
        r_img = Image.new("L", (RES, RES), 0)
        g_img = Image.new("L", (RES, RES), 0)
        b_img = Image.new("L", (RES, RES), 0)

        def px(x, z):
            return ((x - ox) * PX, (z - oz) * PX)

        d = ImageDraw.Draw(r_img)
        w = max(2, round(LANE_W * PX))
        for x0, z0, x1, z1 in lane_segs.get((tx, tz), ()):
            d.line([px(x0, z0), px(x1, z1)], fill=255, width=w)
            d.ellipse([px(x0, z0)[0] - w / 2, px(x0, z0)[1] - w / 2,
                       px(x0, z0)[0] + w / 2, px(x0, z0)[1] + w / 2], fill=255)

        d = ImageDraw.Draw(b_img)
        w = max(2, round(BIKE_W * PX))
        for x0, z0, x1, z1 in bike_segs.get((tx, tz), ()):
            d.line([px(x0, z0), px(x1, z1)], fill=255, width=w)

        d = ImageDraw.Draw(g_img)
        tb = sbox(ox, oz, ox + TILE, oz + TILE)
        for pi in tree.query(tb):
            poly = parks[pi]
            inter = poly.intersection(tb)
            if inter.is_empty:
                continue
            geoms = inter.geoms if hasattr(inter, "geoms") else [inter]
            for gpoly in geoms:
                if gpoly.geom_type != "Polygon":
                    continue
                d.polygon([px(x, z) for x, z in gpoly.exterior.coords], fill=255)
                for hole in gpoly.interiors:
                    d.polygon([px(x, z) for x, z in hole.coords], fill=0)

        if r_img.getbbox() is None and g_img.getbbox() is None \
                and b_img.getbbox() is None:
            continue
        Image.merge("RGB", (r_img, g_img, b_img)).save(
            f"barcelona/masks/tile_{tx}_{tz}.png", optimize=True)
        written += 1
    print(f"[masks] wrote {written} masks")


if __name__ == "__main__":
    main()
