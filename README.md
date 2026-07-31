# NIGHTLOOP

A real-time graphics tech fully AI coded demo. You load in, roll out onto a wet city street at dusk, drift through a four-block loop for ninety seconds. Either it looks AAA or you close the tab.

## What This Is

- **Not a game.** No gameplay loop, no traffic laws, no objectives.
- **Pure visuals.** Every frame is art-directed. Every frame is the product.
- **Hyper-focused.** One small city, fully finished. Four blocks, ninety seconds, one long drift through rain-soaked streets.

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
| mouse | orbit camera (recentres while driving) |
| scroll | camera zoom |
| `C` | chase ↔ bumper camera |
| `1–5` | mood states: Golden · Blue hour · Downpour · Afterglow · Fogbank |
| `` ` `` / `F1` | settings + performance overlay |

Weather states transition physically over ~11 s — the sun travels, fog
thickens, rain fills the street, and the asphalt dries in real time after the
rain stops. Everything the tyres do is written into a surface state buffer:
water is displaced with a visible ridge, tracks disturb the reflections,
drifts leave rubber arcs that persist for minutes.

Quality presets (low / medium / high) live in the overlay; medium is the
default. `?q=high` / `?q=low` and `?state=N` work as URL parameters.

See `DECISIONS.md` for engineering choices, `PERF.md` for frame-budget
measurements, `ASSETS.md` for vendored CC0 assets. Milestone screenshots are
in `shots/`.

---

*Built FULLY vibe-coded.*