#!/usr/bin/env python3
"""Curate harvested facade crops into a game-ready atlas (demo pass).

Reads out/facades/ (from facade_harvester.py) and its manifest, auto-scores
crops (sky fraction, detail, incidence, standoff), extracts a consistently
scaled 15 m x 21 m street-level patch from each winner (the shift-lens crops
are LINEAR in metres, so this is a plain sub-rectangle), and writes:

  assets/textures/facade_atlas/{NN}.png   512x768 patches, uniform scale
  assets/textures/facade_atlas/meta.json  patch size + provenance

The runtime stacks these into a Texture2DArray. CC BY-SA provenance is
carried through from the harvester manifest.
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image

SRC = os.path.join("out", "facades")
DST = os.path.join("assets", "textures", "facade_atlas")
PATCH_W_M = 15.0
PATCH_H_M = 21.0
OUT_W, OUT_H = 512, 768
LAYERS = 32
CAM_H = 2.2
FOV_MARGIN = 1.10
MAX_HFOV = math.radians(90.0)
MIN_HFOV = math.radians(22.0)


def score_crop(img: np.ndarray, rec: dict) -> float:
    h, w = img.shape[:2]
    top = img[: h // 5]
    r, g, b = top[..., 0].astype(int), top[..., 1].astype(int), top[..., 2].astype(int)
    sky = float(np.mean((b > r + 10) & (b > g + 5) | (top.mean(axis=2) > 225)))
    gray = img.mean(axis=2)
    detail = float(gray.std())
    if sky > 0.35 or detail < 26:
        return -1.0
    inc = rec["incidence_deg"]
    d = rec["standoff_m"]
    s = (1.0 - sky) * 2.0
    s += max(0.0, 1.0 - inc / 45.0) * 2.0
    s += math.exp(-((d - 18.0) / 8.0) ** 2)
    s += min(detail / 60.0, 1.0)
    fl = rec["reprojection"]["facade_len_m"]
    if 8.0 <= fl <= 30.0:
        s += 1.0
    return s


def main():
    man = json.load(open(os.path.join(SRC, "manifest.json")))
    scored = []
    for rec in man["records"]:
        p = os.path.join(SRC, rec["output"])
        if not os.path.exists(p):
            continue
        img = np.asarray(Image.open(p).convert("RGB"))
        s = score_crop(img, rec)
        if s > 0:
            scored.append((s, rec, p))
    scored.sort(key=lambda t: -t[0])
    os.makedirs(DST, exist_ok=True)
    meta = {"patch_w_m": PATCH_W_M, "patch_h_m": PATCH_H_M,
            "license": "CC BY-SA 4.0 (Mapillary contributors)", "layers": []}
    seen = set()
    li = 0
    for s, rec, p in scored:
        if li >= LAYERS:
            break
        # one patch per building so the atlas doesn't repeat one block
        if rec["cadastre_ref"] in seen:
            continue
        patch = build_patch(rec, p)
        if patch is None:
            continue
        seen.add(rec["cadastre_ref"])
        out = os.path.join(DST, f"{li:02d}.png")
        patch.save(out)
        meta["layers"].append({
            "file": f"{li:02d}.png", "score": round(s, 2),
            "mapillary_image_id": rec["mapillary_image_id"],
            "creator": rec["creator"], "cadastre_ref": rec["cadastre_ref"],
        })
        print(f"[{li:02d}] score {s:4.1f}  {rec['output']}")
        li += 1
    if li < 8:
        sys.exit(f"only {li} usable patches — harvest more first")
    json.dump(meta, open(os.path.join(DST, "meta.json"), "w"), indent=1)
    print(f"\nwrote {li} layers -> {DST}")


def build_patch(rec, p):
    """Extract the 15x21 m street-level patch, or None when unusable."""
    img = Image.open(p).convert("RGB")
    W, H = img.size
    rp = rec["reprojection"]
    d = rec["standoff_m"]
    fh = rp["floors"] * rp["floor_height_m"]
    # vertical mapping: rows are linear in facade height (shift-lens)
    v_hi = min((fh + 0.5 - CAM_H) / d, 3.0)
    h_hi = v_hi * d + CAM_H
    h_lo = -0.5
    covered_h = min(PATCH_H_M, h_hi)
    if covered_h < 13.0:
        return None   # low building: too much mirror padding, skip
    # horizontal: actual covered width from the clamped hfov
    hfov = 2 * math.atan(rp["facade_len_m"] * FOV_MARGIN / (2 * d))
    hfov = min(max(hfov, MIN_HFOV), MAX_HFOV)
    width_m = 2 * d * math.tan(hfov / 2)
    if width_m < 9.0:
        return None   # too zoomed: single-storefront closeups read as noise

    def y_of(hm):   # metres -> pixel row
        return int(round((h_hi - hm) / (h_hi - h_lo) * (H - 1)))

    y_top = max(y_of(covered_h), 0)
    y_bot = min(y_of(0.0), H - 1)
    if y_bot - y_top < 64:
        return None
    frac_w = min(PATCH_W_M / width_m, 1.0)
    x0 = int((1 - frac_w) / 2 * W)
    x1 = W - x0
    patch = img.crop((x0, y_top, x1, y_bot))
    # mirror-pad upward when the building is slightly shorter than the patch
    if covered_h < PATCH_H_M - 0.5:
        scale_h = int(OUT_H * covered_h / PATCH_H_M)
        base = patch.resize((OUT_W, max(scale_h, 8)))
        canvas = Image.new("RGB", (OUT_W, OUT_H))
        canvas.paste(base, (0, OUT_H - base.height))
        band = base.crop((0, 0, OUT_W, min(base.height, OUT_H - base.height)))
        if band.height > 0:
            canvas.paste(band.transpose(Image.FLIP_TOP_BOTTOM),
                         (0, OUT_H - base.height - band.height))
        patch = canvas
    else:
        patch = patch.resize((OUT_W, OUT_H))
    # final-patch quality gates: black gaps, sky, flatness, blown highlights,
    # and overall exposure sanity (harsh-sun photos ship clipped whites that
    # no shader gain can recover — reject them at the source)
    arr = np.asarray(patch)
    lum = arr.mean(axis=2)
    if float(np.mean(lum < 12)) > 0.04:
        return None
    r, g, b = arr[..., 0].astype(int), arr[..., 1].astype(int), arr[..., 2].astype(int)
    if float(np.mean((b > r + 12) & (b > g + 6) & (lum > 120))) > 0.18:
        return None
    if float(lum.std()) < 26 or float(lum.std()) > 78:
        return None
    if float(np.mean(lum > 225)) > 0.10:
        return None   # blown whites
    m = float(lum.mean())
    if m < 70 or m > 185:
        return None
    # reject big featureless slabs (marble walls, dark glass storefronts):
    # they render as blank rectangles in-game
    med = float(np.median(lum))
    if float(np.mean(np.abs(lum - med) < 14)) > 0.42:
        return None
    # windows/balconies produce edges — demand a minimum edge density
    gx = np.abs(np.diff(lum, axis=1)).mean()
    gy = np.abs(np.diff(lum, axis=0)).mean()
    if gx + gy < 9.0:
        return None
    return patch


if __name__ == "__main__":
    main()
