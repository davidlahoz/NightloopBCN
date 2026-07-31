# DECISIONS

Deviations from the brief and notable technical choices, one line each.

- **Dev port 5174** — 5173 was occupied by an unrelated dev server on this machine.
- **M1 placeholder wheels are smooth cylinders** — rolling is not visually verifiable until real rims land in M4; spin math is in place.
- **Axis-aligned street grid instead of free splines** — exact analytic road-space mapping per-pixel in the shader (wear, lanes, gutters are procedural and resolution-independent); visual richness comes from profile/wear/materials, not plan curvature.
- **Road material = PBRMaterial + WGSL MaterialPluginBase rather than raw ShaderMaterial** — inherits CSM shadows, IBL, fog and the light loop for free; all custom terms (wetness, puddles, glints, retroreflection, state buffer) injected via plugin. Falls back to full custom shader only if the plugin API blocks a required term.
- **Street lighting = per-chunk Babylon light lists for diffuse pools + custom light buffer in the road plugin for wet specular streaks/retro/glints** — forward light-list rather than true clustered; identical visual result at this light count.
