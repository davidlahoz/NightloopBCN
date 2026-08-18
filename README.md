# NIGHTLOOP BCN

A night driving game built in Godot 4, set in real Barcelona. You load in,
roll out onto Carrer de l'Hort de la Vila, and drive — real streets from
OpenStreetMap, real street names on marble plaques, ambient traffic that
stops at real traffic lights.

## Run

```sh
cd godot
godot          # or open the folder in the Godot editor and press Play
```

First run after cloning: let the editor import the ~2,270 city tiles once.

## Controls

| Input | Action |
|---|---|
| `W A S D` / arrows | throttle · steer · brake |
| hold `Shift` / RMB | Glide — sustained drift, the mouse carves the line |
| `Space` | handbrake |
| mouse / scroll | orbit camera / zoom |
| `C` | chase ↔ bumper camera |
| `1` `2` `3` | time of day: Day · Golden hour · Night |
| `T` | traffic lane-graph debug draw |
| `M` | mute engine |
| `Esc` | free the mouse |

## What's inside

- **The city**: ~2,270 streamed OSM-derived tiles (roads, buildings, bridges,
  tunnels) with collision, procedural facade windows, streetlight field, and
  street-name plaques from real OSM data.
- **Ambient traffic**: an offline SUMO-built lane graph (241k lanes, 2,376
  signal programs) driven by an IDM kinematic sim; the nearest cars promote
  to full vehicle physics.
- **The car**: arcade drift physics ported from the original NightLoop demo,
  with the classic muscle-car model.
- An endless procedural city mode survives as `--world=procedural`.

Tooling lives in `godot/tools/` (lane-graph builder, street-name baker).
`godot/PORT.md` tracks engineering history and the roadmap.

## Data & licenses

Map data **© OpenStreetMap contributors (ODbL)** — attribution is shown
in-game. All vendored assets and their licenses: [`ASSETS.md`](ASSETS.md).

The original NightLoop WebGL demo lives on in the
[NightLoop](https://github.com/davidlahoz/NightLoop) repository.
