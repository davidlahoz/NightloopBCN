# DECISIONS

Deviations from the brief and notable technical choices, one line each.

- **Dev port 5174** — 5173 was occupied by an unrelated dev server on this machine.
- **M1 placeholder wheels are smooth cylinders** — rolling is not visually verifiable until real rims land in M4; spin math is in place.
- **Axis-aligned street grid instead of free splines** — exact analytic road-space mapping per-pixel in the shader (wear, lanes, gutters are procedural and resolution-independent); visual richness comes from profile/wear/materials, not plan curvature.
- **Road material = full custom WGSL ShaderMaterial, not a PBR plugin** — Babylon 8.56's WGSL PBR lacks a pre-lighting roughness hook, which blocks the wetness→roughness collapse; a custom shader also owns the layered water BRDF, anisotropic streak speculars, retroreflection and glints outright.
- **Planar reflection (MirrorTexture) instead of SSR for the road** — the street is locally planar; a mirrored render captures offscreen neon above the frame, structurally eliminating the "reflection ends at top of screen" defect. SSR dropped entirely.
- **Car-following single ortho shadow map (4096, PCF) instead of CSM** — the world is four blocks; one tight follow frustum gives crisper texels than 3 cascades, one code path for both the custom road shader (manual PCF) and stock materials.
- **Street lighting = custom light array in the road shader (diffuse pools + anisotropic wet streaks) + emissive geometry** — no Babylon per-mesh light lists needed; the road is where light response matters.
- **Hero car is built procedurally (lofted cross-sections)** — exhaustive search found no CC0 car meeting the quality bar (Poly Haven has none; Khronos CarConcept is CC-BY + logos + supercar); a parametric coupe we control beats a compromised asset.
- **Quality presets low/medium/high, default medium** — per direction to lower hardware demands; high restores the original RTX-class targets. Preset switch reloads (pipelines are built per preset).
- **HDR shader outputs clamped ≤120** — anything above half-float max poisons the bloom chain with NaN tiles (this bug shipped as a "black box in the sky" for an afternoon).
- **Motion blur is screen-space (camera) not per-object** — in a chase-cam driving demo the camera IS the motion; per-object adds a geometry velocity buffer for marginal gain. Revisit only if wheel blur is missed.
- **Weather wetness/puddles integrate with first-order lag, never blended** — rain fills fast (τ≈7s), drying is slow (τ≈45–70s×evaporation), so the street stays soaked after rain stops and dries in real time.
