#!/usr/bin/env python3
"""Bake the full-city map texture for the M map overlay.

Draws every street from barcelona/street_names.json plus the park masks'
green areas into one 4096px PNG covering the street AABB. The overlay pans/
zooms this texture; street-name labels are drawn live by the overlay.

Run from godot/:  python3 tools/bake_city_map.py
Writes godot/assets/textures/city_map.png and prints the world rect that
must match CityMap.WORLD_RECT in scripts/city_map.gd.
"""
import json

from PIL import Image, ImageDraw

RES = 4096

streets = json.load(open("barcelona/street_names.json"))["streets"]
minx = minz = 1e18
maxx = maxz = -1e18
for _, pts in streets:
    for i in range(0, len(pts), 2):
        minx = min(minx, pts[i]); maxx = max(maxx, pts[i])
        minz = min(minz, pts[i + 1]); maxz = max(maxz, pts[i + 1])
pad = 200.0
minx -= pad; minz -= pad; maxx += pad; maxz += pad
side = max(maxx - minx, maxz - minz)
scale = RES / side
print(f"world rect: x[{minx:.0f}] z[{minz:.0f}] side {side:.0f} "
      f"({side/RES:.1f} m/px)")

img = Image.new("RGB", (RES, RES), (10, 12, 20))
d = ImageDraw.Draw(img)

# park green underlay from the baked ground masks (already classified)
import glob
for f in glob.glob("barcelona/masks/tile_*.png"):
    tx, tz = (int(v) for v in f.split("tile_")[1][:-4].split("_"))
    m = Image.open(f).split()[1]                     # G channel = parks
    if m.getbbox() is None:
        continue
    px = int((tx * 500.0 - minx) * scale)
    pz = int((tz * 500.0 - minz) * scale)
    w = max(1, int(500.0 * scale))
    green = Image.new("RGB", (w, w), (24, 52, 30))
    img.paste(green, (px, pz), m.resize((w, w)))

for _, pts in streets:
    line = [((pts[i] - minx) * scale, (pts[i + 1] - minz) * scale)
            for i in range(0, len(pts), 2)]
    if len(line) > 1:
        d.line(line, fill=(70, 86, 110), width=1)

img.save("assets/textures/city_map.png", optimize=True)
print("wrote assets/textures/city_map.png")
