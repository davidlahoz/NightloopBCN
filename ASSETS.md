# ASSETS

Every third-party asset vendored into this repository, with source and licence.

Texture sets follow the module convention (`docs/MODULE_NOTES.md`): each set
directory contains `color.jpg`, `normal.jpg` (OpenGL-convention, from
ambientCG `NormalGL`), `roughness.jpg` and `ao.jpg`. Originally vendored at
2048², later downscaled to their on-screen footprint to cut web traffic
(71 MB → 13 MB total assets): asphalt 1400² (hero surface), concrete and
paving 1024², metal 512². Re-download from the source URLs below if full
resolution is ever needed.

| Asset | Path | Source URL | Asset ID | Licence |
|---|---|---|---|---|
| Asphalt 033 (fine granular dark tarmac) | `assets/textures/asphalt/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Asphalt033 (download `https://ambientcg.com/get?file=Asphalt033_2K-JPG.zip`) | Asphalt033 | CC0 1.0 |
| Concrete 036 (smooth weathered grey concrete) | `assets/textures/concrete/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Concrete036 (download `https://ambientcg.com/get?file=Concrete036_2K-JPG.zip`) | Concrete036 | CC0 1.0 |
| Paving Stones 112 (grey square sidewalk slabs, dirty joints) | `assets/textures/paving/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/PavingStones112 (download `https://ambientcg.com/get?file=PavingStones112_2K-JPG.zip`) | PavingStones112 | CC0 1.0 |
| Metal 063 (aged dark oxidised steel) | `assets/textures/metal/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Metal063 (download `https://ambientcg.com/get?file=Metal063_2K-JPG.zip`) | Metal063 | CC0 1.0 |
| Modern Evening Street 2k HDRI (blue-hour city street, by Grzegorz Wronkowski) | `assets/env/urban.hdr` | https://polyhaven.com/a/modern_evening_street (download `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/modern_evening_street_2k.hdr`) | modern_evening_street | CC0 1.0 |
| Car Engine Loop 96kHz 4s (seamless recorded 4-cyl engine loop, normalized 44.1 kHz version), **by qubodup (Iwan Gabovitch)** — attribution required | `assets/audio/engine-loop.wav` | https://opengameart.org/content/car-engine-loop-96khz-4s (download `https://opengameart.org/sites/default/files/engine-loop.7z`) | engine-loop | CC-BY 3.0 |
| Classic Muscle car (low-poly game-ready car, 5.6k tris), **by Lexyc16** — attribution required; tagged NoAI by the author | `assets/car/classic-muscle-car.glb` | https://sketchfab.com/3d-models/classic-muscle-car-641efc889e5f4543bae51d0922e6f4b3 (GLB converted download via Sketchfab) | 641efc88 | CC Attribution (CC-BY 4.0) |

Notes:

- `assets/textures/concrete/ao.jpg` and `assets/textures/metal/ao.jpg` are
  **synthesised neutral maps** (solid 128,128,128, 256x256) — the ambientCG
  2K-JPG bundles for Concrete036 and Metal063 do not ship an
  AmbientOcclusion map. Treat them as "no AO"; safe to sample and multiply.
- Metal063 additionally ships a `Metalness` map upstream (not vendored;
  manhole material can hardcode metalness ~1.0). Re-download the zip above
  if it is ever needed.
- `assets/env/urban.hdr` verified against the Poly Haven API md5
  (`f16d9ee891148a1504cc6e2048516f90`), Radiance RGBE, 2048x1024.
- The muscle car's glTF materials are NOT used at runtime: the loader's
  material instances corrupt other WebGPU pipelines in Babylon 8.56 (see
  DECISIONS.md), so `src/vehicle/carModel.js` rebuilds equivalent plain
  PBRMaterials (same colours read from the source file) and disposes the
  imported ones. The vendored GLB itself is unmodified.
- The procedural fallback car remains in the codebase and is used if the
  GLB fails to load.

## Godot / Barcelona edition

- **Marble007** (`godot/assets/textures/marble007.jpg`) — [ambientCG](https://ambientcg.com/view?id=Marble007), CC0. Used by the street-name plaque HUD.
- **Barcelona street names** (`godot/barcelona/street_names.json`) — baked from OpenStreetMap via `godot/tools/bake_street_names.py`. **© OpenStreetMap contributors, ODbL** — same license and attribution as the tile data.
