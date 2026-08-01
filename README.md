# NIGHTLOOP

A real-time graphics tech fully AI coded demo. You load in, roll out onto a wet city street at night, and drive — the city never ends. Either it looks AAA or you close the tab.

## What This Is

- **Not a game.** No gameplay loop, no traffic laws, no objectives.
- **Pure visuals.** Every frame is art-directed. Every frame is the product.
- **Endless.** The city is a periodic procedural plan streamed around the car
  — roads, curbs, buildings, signage, lights are generated on the fly and
  discarded behind you. Streets sweep in gentle S-curves (the whole plan
  lives in a smoothly warped coordinate frame), and every 4th east-west road
  is a six-lane motorway with a barriered centre median. Drive any direction
  forever; revisited streets are always identical (everything is seeded from
  cell coordinates).

## The Stack

- **Babylon.js** (WebGPU only)
- **Modern JavaScript** (ES2023)
- **Vite** (bundler)
- **Target: 90 FPS sustained** on RTX 5070 Ti, 2560x1440

## What You're Looking At

- **Car paint** that reads as layered clearcoat over metallic
- **Road detail** legible at three scales: lanes, wear, grain
- **Water physics** — tire tracks displace, reflections stretch, wetness lags the rain
- **Neon and light** that doesn't clip to white, shadows that hold detail
- **Aerial perspective** on distant buildings
- **No placeholder, no rough edges.** If it doesn't look finished, it's cut.

## The Rule

Visual quality is the product. If a requirement conflicts with beauty, break the requirement and note it in `DECISIONS.md`. Do not ship rough.

## Run

```sh
npm install
npm run dev        # http://localhost:5174  (Chrome desktop, WebGPU required)
```

## Controls

| Input | Action |
|---|---|
| `W A S D` / arrows | throttle · steer · brake |
| **hold RMB** (or Shift) | **Glide** — sustained low-anger drift; the mouse carves the line |
| `Space` | handbrake — locks the rear for hard stops and slide entries |
| mouse | orbit camera (recentres while driving) |
| scroll | camera zoom |
| `C` | chase ↔ bumper camera |
| `M` | mute / unmute engine sound |
| `1–3` | time of day: Day · Afternoon · Night |
| `0` / `` ` `` / `F1` | settings + performance overlay |

Time-of-day transitions blend over ~4 s — the sun travels, the lights come
on, and the street's wetness lags physically (the night street stays damp
and dries in real time by day). Everything the tyres do is written into a
surface state buffer: tracks clear standing water and disturb the
reflections, drifts leave rubber arcs that persist for minutes. Curbs are
drivable bumps, not walls — the hard stops are building faces and the
motorway median barriers.

Quality presets (low / medium / high) live in the overlay; medium is the
default. `?q=high` / `?q=low` and `?state=N` work as URL parameters.

See `DECISIONS.md` for engineering choices, `PERF.md` for frame-budget
measurements, `ASSETS.md` for vendored assets. Milestone screenshots are
in `shots/`.

Engine sound: ["Car Engine Loop 96kHz 4s"](https://opengameart.org/content/car-engine-loop-96khz-4s)
by qubodup (Iwan Gabovitch), CC-BY 3.0 — revved in real time via playback rate.

Hero car: ["Classic Muscle car"](https://sketchfab.com/3d-models/classic-muscle-car-641efc889e5f4543bae51d0922e6f4b3)
by Lexyc16, CC Attribution — normalised, re-materialed and wheel-rigged at load.

---

*Built FULLY vibe-coded.*