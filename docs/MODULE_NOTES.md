# NIGHTLOOP module conventions

Read this before writing any city/vfx module. The demo is Babylon.js 8 on
**WebGPU only**, ES2023 modules, Vite, all shaders **WGSL**.

## Hard rules

- **Zero allocations per frame.** No `new`, no array literals, no closures, no
  `map/filter/reduce`, no string building inside `update()`. Pre-allocate
  scratch `Vector3`/`Matrix`/typed arrays at module scope.
- Static meshes: `mesh.freezeWorldMatrix()`, `mesh.isPickable = false`,
  `mesh.doNotSyncBoundingInfo = true` where safe. Materials: `material.freeze()`
  after uniforms are first set (unfreeze/refreeze on env changes — or leave
  unfrozen if uniforms change every apply).
- Repeated geometry uses **thin instances** (`thinInstanceSetBuffer('matrix', f32, 16)`).
- Merge static geometry aggressively: one mesh per material per region.
  Target < 15 draw calls per module.
- **No runtime CDN fetches.** Local assets only (under `/assets`, vendored).
- Nothing may look untextured/flat/low-poly at the distance the player sees it.
  If a thing can't be made to look finished, keep it out of the frame instead.

## Imports

Use granular Babylon imports, e.g.
`import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'`.
`main.js` imports the full package once, so all side effects are registered.

## WGSL materials

Pattern (see `src/weather/environment.js` + `src/shaders/sky.*.wgsl` for a
working example):

```js
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import vsrc from '../shaders/foo.vertex.wgsl?raw';
import fsrc from '../shaders/foo.fragment.wgsl?raw';
ShaderStore.ShadersStoreWGSL['nlFooVertexShader'] = vsrc;
ShaderStore.ShadersStoreWGSL['nlFooFragmentShader'] = fsrc;
const mat = new ShaderMaterial('nlFoo', scene, { vertex: 'nlFoo', fragment: 'nlFoo' }, {
  attributes: ['position', 'normal', 'uv'],
  uniformBuffers: ['Scene', 'Mesh'],
  shaderLanguage: ShaderLanguage.WGSL,
});
```

- WGSL conventions: `attribute pos : vec3f;` read as `vertexInputs.pos`;
  `varying v : vec3f;` written as `vertexOutputs.v`, read as
  `fragmentInputs.v`; `uniform u : f32;` read as `uniforms.u`; outputs:
  `vertexOutputs.position`, `fragmentOutputs.color`.
- `#include<sceneUboDeclaration>` gives `scene.viewProjection`,
  `scene.vEyePosition`; `#include<meshUboDeclaration>` gives `mesh.world`.
- Shared helpers: `#include<nlCommon>` (registered from
  `src/shaders/common.wgsl`): `nlHash2`, `nlHash2v`, `nlValueNoise`, `nlFbm3`,
  `nlFogFactor(camPos, worldPos, density, heightFalloff)`, `nlLuma`.
  main.js registers it before any module constructor runs.
- Custom ShaderMaterials do NOT receive scene lights/shadows automatically —
  fake lighting inside the shader (facades are mostly emissive + ambient) and
  ALWAYS apply `nlFogFactor` toward `fogColor` or the object will float.

## Layout / queries

`src/city/cityPlan.js` is the single source of truth for streets/blocks/zones
(read its doc comment). `src/city/roadProfile.js` provides
`groundHeight(x, z)` and `groundNormal(x, z, eps, out)` — place everything on
the ground with these, never assume y=0. Curb top ≈ 0.13 m, sidewalk tilts up
away from the road, block interior ≈ 0.20 m.

## Module contract

Each module exports one class:

```js
export class Foo {
  constructor(scene, env) { /* build everything, register shaders */ }
  applyEnvironment(env)   { /* push env.params into uniforms (state change) */ }
  update(dt, camX, camZ)  { /* per-frame, allocation-free, usually tiny */ }
  warmup()                { /* optional: touch every pipeline variant once */ }
}
```

`env` is `src/weather/environment.js` — read `env.params` (flat weather
parameter set: fog, ambient, intensities…) and `env.sunDir` (Vector3).
`applyEnvironment` is called at least once after construction and on every
weather change; it must be cheap-ish and allocation-light.

## Texture assets

Vendored under `/assets/textures/<set>/` with fixed names:
`color.jpg`, `normal.jpg`, `roughness.jpg`, `ao.jpg` (2K, ambientCG naming
already normalised). Sets available: `asphalt/`, `concrete/`, `paving/`,
`metal/`. If a texture is missing at runtime, fail visibly (magenta), don't
silently fall back.
