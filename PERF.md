# PERF

Frame budget at 90 FPS: **11.1 ms** total. Target hardware was revised down
mid-project ("hardware demands should be lower"): the default **medium**
preset targets mid-range GPUs; **high** restores the original RTX-class
settings; **low** runs on integrated GPUs (see `src/core/quality.js`).

## Measured (dev machine: Apple Silicon, 2560×1440, medium preset, headless capture)

Steady state, all five mood states: **median 8.3 ms** (vsync-capped 120 Hz),
**p99 10.1–10.3 ms**, worst ≤ 11 ms. Identical medians across states — the
state system is uniform-driven, no per-state pipeline cost.

| Scenario | median | p99 | worst (app-attributable) |
|---|---|---|---|
| Idle, any state | 8.3 ms | 10.2 ms | 10.4 ms |
| Driving straight (streaming LOD0) | 8.3 ms | 10.3 ms | ≤ 11 ms |
| Full drift w/ spray + wake (downpour) | 8.3 ms | 10.2–10.3 ms | ≤ 11 ms |

In-callback attribution at worst: sim ≤ 4.0 ms, render encode ≤ 3.9 ms,
chunk-build slice ≤ 4.6 ms (budget 2.6 ms + one slice overrun allowance).
Residual isolated 30–50 ms frame gaps observed in some headless captures occur
**outside the rAF callback** (harness/compositor); they do not reproduce at
idle and are not app work.

## Hitches hunted and killed

1. **First-entry pipeline compiles** — all weather states, rain, steam, glow
   halos, headlight cones and both particle systems now render at least once
   behind the loading screen (`main.js` warm-up block).
2. **Intersection patch finalisation** (~49k verts assembled in one frame,
   80–110 ms) — chunk building refactored into a 5-phase row-sliced state
   machine, and the 9 intersection patches build **permanent LOD0 at load**.
3. **LOD0 rebuild/dispose GC churn** — LOD0 street meshes are deterministic,
   so they are built once and cached forever; ring transitions only toggle
   `setEnabled`.

## Notable budget decisions

- Planar mirror at 0.35× ratio (medium) instead of SSR: one extra scene pass
  over ~60 draws, ~1 ms; solves offscreen-reflection correctness outright.
- Single 2048² follow shadow map (medium) replaces 3-cascade CSM.
- No SSAO / TAA / DoF (see DECISIONS.md) — night scene priorities.
- Surface state buffer: one fused 2048² half-float pass per frame (~0.2 ms).
- Draw calls ~65–75 in-frustum typical; active tris ~1.7 M.

## Remaining known costs / risks

- Weather transitions push material uniforms at 15 Hz for 11 s — measured
  negligible, worst case a few tenths of a ms.
- `applyToMesh` on first visit of a street chunk uploads ~600 KB; bounded,
  once per chunk per session.
- Headless captures include a benign one-frame "Destroyed texture used in a
  submit" warning at boot (swapchain teardown race in headless present); not
  observed to affect steady state.

## Endless city streaming (post-rework)

Measured on the dev machine (M-series, medium preset, 2560×1440 headless):

- 45 s full-throttle drive (~1.2 km): worst sim frame 5.3 ms, worst render
  11.6 ms, worst incremental build slice 4.8 ms. 35 s motorway drive
  (~0.9 km): worst sim 5.8 ms, worst build 3.6 ms. No hitches, holes or
  pop-in observed at 100 km/h.
- All streamers (road chunks, curb bands, building blocks) share ONE
  ~3 ms/frame build budget (`src/core/buildBudget.js`); road chunks slice by
  grid rows, curbs by path rows (generator), buildings by whole building
  (generator). Rescan/rebuild cadences are deliberately staggered
  (22/24/26/44/52 m) so region rebuilds never stack in one frame.
- Working set stays bounded while driving: ~260–280 road chunks, ~380–410
  scene meshes, ~190 streetlight instances; far cells are disposed
  (roads > 470 m, buildings > 384 m, curbs > 340 m). Memory is flat over
  distance.
- The road light storage buffer holds the 72–96 nearest emitters (sorted per
  region rebuild); halo geometry rebuilds on the same event, a few kB.
