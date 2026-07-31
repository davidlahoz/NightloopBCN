# PERF

Frame budget at 90 FPS: **11.1 ms** total.

Planned allocation (revised with measurements as systems land):

| System | Budget | Measured |
|---|---|---|
| City geometry (road chunks, curbs, buildings, skyline) | 2.0 ms | — |
| Road shading (hero material, light loop) | 2.0 ms | — |
| Shadows (CSM) | 1.2 ms | — |
| SSR + reflections | 1.5 ms | — |
| Surface state buffer (splats, diffusion, evaporation) | 0.6 ms | — |
| Weather VFX (rain, spray, steam) | 1.0 ms | — |
| Vehicle (suspension, materials) | 0.4 ms | — |
| Post chain (TAA, SSAO, MB, DoF, bloom, tonemap, grain) | 2.0 ms | — |
| Headroom / driver | 0.4 ms | — |

Measurements below are taken on the dev machine (Apple Silicon) and sanity-checked
against the target (RTX 5070 Ti @ 2560×1440) budget proportionally.

## Log

- M1 foundation: median 8.3 ms in 2560×1440 headless capture, 16 draws / 518 tris (placeholder world). Note: headless capture is not vsync-locked; useful for relative regressions only.
