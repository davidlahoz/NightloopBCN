#!/usr/bin/env python3
"""Bake per-tile ground classification masks for the Barcelona tiles.

The road tiles are ONE flat mesh with one material, so carriageway /
sidewalk / park / bike lane must be classified by world position. This
bakes a 512x512 RGB PNG per 500 m tile (~1 m/px):

  R = carriageway asphalt   (SUMO edges at full carriageway width, CENTRED
                             on the OSM way line the tiles drew the road
                             from, plus the junction shape polygons)
  G = park / green space    (OSM leisure/landuse/natural polygons)
  B = bike lane             (OSM highway=cycleway, drawn 2.4 m wide)

Anything unmasked is sidewalk paving. The shader gives priority
bike > asphalt > grass > paving, so bike lanes never read as sidewalk.

NOTE on the asphalt source: painting individual SUMO lanes was wrong for
one-way streets — netconvert puts lanes to the RIGHT of the OSM line
while the tiles draw the road centred on it, so the asphalt hugged one
side of every one-way street. Edges (centred, offset half-width for the
two-way pairs) + junction polygons match the drawn roads.

Inputs : work/barcelona.net.xml, work/parks.geojson, work/cycle.geojson,
         barcelona/manifest.json
Outputs: barcelona/masks/tile_X_Z.png (+ .gdignore so Godot won't import)

Run from godot/:  python3 tools/bake_ground_masks.py
"""
import json
import math
import os
import sys
from collections import defaultdict

from lxml import etree
from PIL import Image, ImageDraw
from shapely.geometry import shape
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(__file__))
from bake_street_names import utm31                      # noqa: E402

TILE = 500.0
RES = 512
PX = RES / TILE
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

    # --- carriageway segments + junction polygons from the SUMO net ------
    # net -> godot: orig = net - netOffset; godot = (E - ORIGIN_E, -(N - ORIGIN_N))
    ctx = etree.iterparse("work/barcelona.net.xml",
                          tag=("location", "edge", "junction"))
    n_ox = n_oy = 0.0
    edges = []          # (polyline [(x,z)...], width_m, from, to)
    pairs = set()       # (from,to) node pairs, to spot two-way streets
    junction_polys = []
    for _, el in ctx:
        if el.tag == "location":
            n_ox, n_oy = (float(v) for v in el.get("netOffset").split(","))
        elif el.tag == "edge" and el.get("function") != "internal":
            lanes = el.findall("lane")
            drivable = [ln for ln in lanes
                        if "passenger" not in (ln.get("disallow") or "")]
            if drivable:
                shp = el.get("shape") or drivable[0].get("shape")
                pl = []
                for p in shp.split():
                    nx, ny = (float(v) for v in p.split(","))
                    pl.append((nx - n_ox - ORIGIN_E, -(ny - n_oy - ORIGIN_N)))
                lw = sum(float(ln.get("width", 3.2)) for ln in drivable)
                # generous dilation: the mask must cover the whole drawn
                # carriageway polygon; spill onto the sidewalk strips is
                # overridden by the shader's UV-ribbon test
                edges.append((pl, lw + 6.0, el.get("from"), el.get("to")))
                pairs.add((el.get("from"), el.get("to")))
        elif el.tag == "junction" and el.get("type") != "internal":
            shp = el.get("shape")
            if shp and shp.count(" ") >= 2:
                poly = []
                for p in shp.split():
                    nx, ny = (float(v) for v in p.split(","))
                    poly.append((nx - n_ox - ORIGIN_E, -(ny - n_oy - ORIGIN_N)))
                junction_polys.append(poly)
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]

    lane_segs = defaultdict(list)      # (tx,tz) -> [(x0,z0,x1,z1,width)]
    for pl, w, nfrom, nto in edges:
        # two-way pair: this edge covers only its half — shift right w/2.
        # One-way: the tiles draw the road centred on the way line.
        two_way = (nto, nfrom) in pairs
        for (x0, z0), (x1, z1) in zip(pl, pl[1:]):
            if two_way:
                dx, dz = x1 - x0, z1 - z0
                dl = math.hypot(dx, dz)
                if dl < 1e-6:
                    continue
                rx, rz = -dz / dl * w * 0.5, dx / dl * w * 0.5
                x0 += rx; z0 += rz; x1 += rx; z1 += rz
            for t in {tile_of(min(x0, x1) - w, min(z0, z1) - w),
                      tile_of(max(x0, x1) + w, min(z0, z1) - w),
                      tile_of(min(x0, x1) - w, max(z0, z1) + w),
                      tile_of(max(x0, x1) + w, max(z0, z1) + w)}:
                lane_segs[t].append((x0, z0, x1, z1, w))
    jpoly_by_tile = defaultdict(list)
    for poly in junction_polys:
        xs = [p[0] for p in poly]
        zs = [p[1] for p in poly]
        for t in {tile_of(min(xs), min(zs)), tile_of(max(xs), min(zs)),
                  tile_of(min(xs), max(zs)), tile_of(max(xs), max(zs))}:
            jpoly_by_tile[t].append(poly)
    print(f"[masks] {len(edges)} edges, {len(junction_polys)} junction polys "
          f"over {len(lane_segs)} tiles")

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
        for x0, z0, x1, z1, wm in lane_segs.get((tx, tz), ()):
            w = max(2, round(wm * PX))
            d.line([px(x0, z0), px(x1, z1)], fill=255, width=w)
            for ex, ez in ((x0, z0), (x1, z1)):
                exp, ezp = px(ex, ez)
                d.ellipse([exp - w / 2, ezp - w / 2, exp + w / 2, ezp + w / 2],
                          fill=255)
        for poly in jpoly_by_tile.get((tx, tz), ()):
            d.polygon([px(x, z) for x, z in poly], fill=255)

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
