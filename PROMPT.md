# NIGHTLOOP – Tech Demo · Implementation Brief

You are the sole engineer and technical artist on a real-time graphics tech demo. Build it end to end. This document is the spec, the art direction, and the acceptance criteria.

## 0. Prime Directive

Visual quality is the product. There is no gameplay loop, no traffic laws, no objectives, no HUD to design around. A player will load this, roll out onto a wet city street at dusk, cruise a four-block loop for ninety seconds, hold a long drift through a rain-soaked intersection, and either think "this is AAA" or close the tab. Everything below serves that single judgment.

### Two Golden Rules

These rules override everything else in this document:

1. **If a requirement in this brief conflicts with making the demo more beautiful, break the requirement.** Note the deviation in `DECISIONS.md` with a one-line rationale. You have full authority to change scope, swap techniques, or drop a feature that isn't paying for its pixels.

2. **Anything that reads as low-poly, flat-shaded, untextured, placeholder, asset-store-default, or "indie prototype" is a defect, not a stepping stone.** If you can't make a thing look finished, cut it from the frame rather than ship it looking rough.

Do not stop at "it works." Stop when every captured frame looks polished, cohesive, and production-ready.

### Scope Note

Build a small city finished, not a large city rough. Four blocks driven as a loop, fully art-directed, beats a procedural metropolis that falls apart on inspection. Fence the playable area with believable geometry – an underpass, a closed street, a river – never an invisible wall.

## 1. Stack and Hard Constraints

| Aspect | Requirement |
|--------|-------------|
| **Language** | Modern JavaScript (ES2023 modules). JSDoc types encouraged, no TypeScript build step required. |
| **Engine** | Babylon.js latest stable, WebGPU only |
| **Bundler** | Vite |
| **Target** | Chrome stable on Windows 11, RTX 5070 Ti, 2560x1440 |
| **Frame Target** | 90 FPS sustained. 60 FPS floor. |
| **Frame Time** | No frame exceeding median + 4 ms after the loading screen dismisses |

### No Fallbacks

- No WebGL path, no mobile path, no feature detection branches
- If `navigator.gpu` is absent, show a single line of text and stop
- Do not spend a minute on compatibility

### Assets

- Generate procedurally where it produces a better or more controllable result: road network layout, facade variation, wear masks, decal placement, noise
- Use free CC0 assets where hand-authored

---

**[Note: 235 lines of content hidden in original document]**

---

## 8. Visual Acceptance Criteria

Before declaring the demo complete, verify each item against a fresh 1440p screenshot and in motion:

- ⊘ No visible faceting, hard polygon edges, untextured facades, or flat-shaded surfaces anywhere in frame
- ⊘ Neon and streetlight highlights are not clipped to featureless white; shadows are blue and retain detail rather than crushing to black
- ⊘ Distant buildings and skyline show clear aerial perspective and contrast compression
- ⊘ Road detail is legible at three distinct scales simultaneously: lane and patch structure, wheel-track wear, aggregate grain
- ⊘ Reflections are sharp where the water is still, stretched where it is disturbed, and do not visibly terminate at the top of the screen
- ⊘ Tyre tracks displace water, leave an edge ridge, disturb the reflection, and recover over time
- ⊘ Glints and paint flake appear only at grazing angles and do not crawl or shimmer in motion
- ⊘ The car paint reads as layered clearcoat over metallic, and the glass reads as glass with something behind it
- ⊘ Wheels roll at a rate that matches the ground, compress over bumps, and never slide
- ⊘ Weather transitions are continuous, and the road's wetness visibly lags the rain both starting and stopping
- ⊘ Every mood state leaves the street in a different physical condition, not merely a different colour grade
- ⊘ The Glide wake looks like displaced mass with momentum, not merely particle spray, and its rubber mark is still there a lap later
- ⊘ The demo sustains 90 FPS with 1% lows above 60 FPS
- ⊘ No hitch occurs on the first entry into any mood state, or when crossing a tile boundary

## 9. Working Agreement

### Build, Don't Test-Loop

Playwright is available for capturing screenshots at milestones and catching hard regressions. Use it for those purposes. Do not build a test suite; time spent on tests is time not spent on the road shader.

### Iterate Visually

Look at your own output constantly. Capture screenshots, inspect them critically, and iterate on values. Most of the quality gap between "prototype" and "AAA" is parameter tuning, and you can only close it by looking.

Do not move on from an ugly milestone. Milestone 2 in particular is a hard gate.

### Replace, Don't Patch

When a technique is not working, replace it rather than patching it. You have full latitude over the approach.

### Document Deviations

Record every deviation in `DECISIONS.md`, briefly. One line is sufficient.