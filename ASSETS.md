# ASSETS

Every third-party asset vendored into this repository, with source and licence.

Texture sets follow the module convention (`docs/MODULE_NOTES.md`): each set
directory contains `color.jpg`, `normal.jpg` (OpenGL-convention, from
ambientCG `NormalGL`), `roughness.jpg` and `ao.jpg`, all 2048x2048 JPEG.

| Asset | Path | Source URL | Asset ID | Licence |
|---|---|---|---|---|
| Asphalt 033 (fine granular dark tarmac) | `assets/textures/asphalt/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Asphalt033 (download `https://ambientcg.com/get?file=Asphalt033_2K-JPG.zip`) | Asphalt033 | CC0 1.0 |
| Concrete 036 (smooth weathered grey concrete) | `assets/textures/concrete/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Concrete036 (download `https://ambientcg.com/get?file=Concrete036_2K-JPG.zip`) | Concrete036 | CC0 1.0 |
| Paving Stones 112 (grey square sidewalk slabs, dirty joints) | `assets/textures/paving/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/PavingStones112 (download `https://ambientcg.com/get?file=PavingStones112_2K-JPG.zip`) | PavingStones112 | CC0 1.0 |
| Metal 063 (aged dark oxidised steel) | `assets/textures/metal/{color,normal,roughness,ao}.jpg` | https://ambientcg.com/a/Metal063 (download `https://ambientcg.com/get?file=Metal063_2K-JPG.zip`) | Metal063 | CC0 1.0 |
| Modern Evening Street 2k HDRI (blue-hour city street, by Grzegorz Wronkowski) | `assets/env/urban.hdr` | https://polyhaven.com/a/modern_evening_street (download `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/modern_evening_street_2k.hdr`) | modern_evening_street | CC0 1.0 |

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
- No CC0 car model is vendored: nothing meeting the quality bar exists on
  the approved hosts (see module notes / integration notes).
