# NIGHTLOOP — Godot port

The Babylon.js/WebGPU demo rebuilt as a Godot 4.7 project (Forward+), grown
into the Barcelona game. The original web demo lives in the NightLoop
repository; everything here is Godot.

## Worlds

Two drivable worlds share the same car/camera/time-of-day systems:

- **Barcelona** (`--world=barcelona`, default when the data is present) —
  real OSM-derived city tiles streamed from `godot/barcelona/`
  (`scripts/barcelona_streamer.gd`). ~2,270 tiles of 500 m, world-space
  vertices instantiated at identity, collision baked into the glbs via the
  `-col` mesh suffix. The car's ground/wall queries switch to physics
  raycasts against the tile meshes (bridges +6 m and tunnels −6 m work by
  following the car's own level). Placeholder materials are swapped in
  `_apply_material_overrides` — replace them with real textured materials
  there. **Map data © OpenStreetMap contributors (ODbL)** — the attribution
  is shown in the in-game HUD and must stay there.
  The tile data (~758 MB) is NOT committed; drop it at `godot/barcelona/`
  (manifest.json + tiles/) and run a Godot import once.
- **Procedural** (`--world=procedural`) — the endless seeded NightLoop city
  described below.

## Run

```sh
cd godot
godot          # or open the folder in the Godot editor and press Play
```

Same controls as the demo: WASD/arrows drive, Shift/RMB glide, Space
handbrake, mouse orbit, scroll zoom, `C` chase/bumper camera, `M` mute,
`1–3` time of day, `6–9` district jump, Esc releases the mouse.

Capture tooling (used by the port's own validation):

```sh
godot -- --seed=12345 --state=3 --drive=300 --shot-frame=300 --screenshot=/tmp/shot.png
```

`--seed=N` pins a city (the equivalent of the demo's `?seed=N`; the current
seed is printed on boot). `--drive/--steer/--jump` script inputs for
repeatable captures.

## What is a 1:1 port

| Web module | Godot file | Notes |
|---|---|---|
| `city/cityPlan.js` | `scripts/city_plan.gd` | Warped periodic grid, districts, street thinning, seeded u32 hashing — bit-exact semantics (`mul32` emulates `Math.imul`) |
| `city/roadProfile.js` | `scripts/road_profile.gd` | Crown/gutter/curb/sidewalk/median heightfield; settle noise moved to FastNoiseLite (see below) |
| `vehicle/car.js` | `scripts/car.gd` | Arcade dynamics ported verbatim: glide/drift, handbrake, curb bumps, building-line + median colliders, Ackermann, sprung body |
| `camera/chaseCamera.js` | `scripts/chase_camera.gd` | Spring-arm chase + bumper view, orbit, zoom, speed FOV, drift bank |
| `weather/states.js` + `environment.js` | `scripts/environment_ctrl.gd` | 3 time-of-day states, 4 s eased transitions, physical wet/dry lag |
| `vehicle/carModel.js` | `scripts/car_model.gd` | GLB normalisation + wheel-group carving into steer/spin pivots, material replacement |
| `core/input.js` | `scripts/input_state.gd` | Via Godot InputMap |
| `main.js` | `scripts/main.gd` | Boot, frame loop, district jump, HUD, capture args |

## What was redesigned for Godot

- **Ground**: the web demo meshed carriageway/curb/sidewalk in three modules
  and colored the road in a 700-line WGSL shader fed a 96-light buffer. Here
  the whole ground is ONE streamed heightfield (`scripts/ground_chunks.gd`,
  three LOD tile layers baked on `WorkerThreadPool` threads; coarser layers
  sit a few cm lower so seams can't crack) and `shaders/ground.gdshader`
  colors zones/lane paint/districts/wetness analytically per pixel. The
  shader mirrors the plan math (warp, cell_seed, thinning) bit-exactly in
  uint arithmetic — change `city_plan.gd` and the shader together or not at all.
- **Lighting**: real nodes instead of a shader light buffer — `SpotLight3D`
  headlights, pooled `OmniLight3D` streetlights (`scripts/street_lights.gd`),
  emissive facade windows (`shaders/facade.gdshader`), Godot glow/SSR/ACES
  via `WorldEnvironment`.
- **Buildings** (`scripts/buildings.gd`): streamed perimeter-parcel prisms,
  district-driven heights, procedural windows. A deliberate simplification of
  the 885-line facade system — same plan, much less dressing (for now).
- **Terrain noise**: the JS pcg2d value-noise fbm existed so CPU and WGSL
  agreed bit-exactly. Nothing on the Godot GPU re-derives heights, so
  settle/wobble run on FastNoiseLite (C++, ~20× faster than GDScript
  hashing) with the demo's frequencies/amplitudes. Physics and baked meshes
  share `ground_height`, so they always agree. Deliberately not
  world-seeded, matching the demo.

**Handedness**: Babylon renders left-handed, Godot right-handed. Physics math
is ported verbatim; `input_state.gd` negates steering/mouse-X so screen
left/right stay true, and `car.gd` negates the visual roll once. Documented
at each site.

## Not yet ported (roadmap)

- Rain particles + headlight cones (weather states currently stop at "damp")
- Surface state buffer: tyre tracks clearing water, rubber arcs (the demo's
  signature) — plan: a viewport-based splat buffer feeding ground.gdshader
- Spray/steam/litter VFX, glow halos on lights
- Minimap, speedo dial, settings overlay, touch controls
- Facade dressing: fire escapes, neon signs, storefront variety; skyline
  impostor ring beyond the streamed radius
- Traffic lights (junction phase logic exists in the demo's props module)
- Quality presets; mobile/low tiers
- Game-direction work (it's a *game* branch now): objectives, traffic, audio
  design beyond the engine loop

## Known issues / tuning debt

- Downtown curtain-wall windows overexpose at night (lit fraction × glow)
- No skyline beyond the 430 m ground radius at day (night hides it; the demo
  used an impostor skyline ring)
- Sidewalk expansion joints are grid-aligned in warped space but the two
  axes' joints cross mid-block (cosmetic)
- Boot prewarm ~1.3 s on an M4 (threaded streaming hides the rest)
