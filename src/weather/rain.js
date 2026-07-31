/**
 * Rain — one static mesh of streak quads; falling, wrapping, wind drift and
 * fade all run in the vertex shader. Zero CPU work per frame beyond four
 * uniform sets. Hidden entirely when dry.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { hash2 } from '../city/noise.js';
import rainVertex from '../shaders/rain.vertex.wgsl?raw';
import rainFragment from '../shaders/rain.fragment.wgsl?raw';

const N = 1400;

export class Rain {
  /** @param {import('@babylonjs/core').Scene} scene @param {import('./environment.js').Environment} env */
  constructor(scene, env) {
    ShaderStore.ShadersStoreWGSL['nlRainVertexShader'] = rainVertex;
    ShaderStore.ShadersStoreWGSL['nlRainFragmentShader'] = rainFragment;

    const mat = new ShaderMaterial('nlRain', scene, { vertex: 'nlRain', fragment: 'nlRain' }, {
      attributes: ['position', 'seed'],
      uniformBuffers: ['Scene'],
      shaderLanguage: ShaderLanguage.WGSL,
      needAlphaBlending: true,
    });
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    this.material = mat;

    // N quads: position = (corner ±0.5, corner 0..1, perStreakRandom), seed = home pos
    const pos = new Float32Array(N * 4 * 3);
    const seed = new Float32Array(N * 4 * 3);
    const idx = new Uint32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const r = hash2(i, 17);
      const sx = hash2(i, 31), sy = hash2(i, 47), sz = hash2(i, 63);
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 3;
        pos[o] = c === 0 || c === 3 ? -0.5 : 0.5;
        pos[o + 1] = c < 2 ? 0 : 1;
        pos[o + 2] = r;
        seed[o] = sx; seed[o + 1] = sy; seed[o + 2] = sz;
      }
      const b = i * 4, j = i * 6;
      idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
      idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
    }
    const mesh = new Mesh('nlRain', scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh);
    mesh.setVerticesData('seed', seed, false, 3);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;  // bounds are meaningless (GPU-positioned)
    mesh.metadata = { nlNoShadow: true, nlNoMirror: true };
    this.mesh = mesh;

    this._camPos = new Vector3();
    this._wind = new Vector2(1.4, 0.6);
    this._time = 0;
    mat.setVector3('camPos', this._camPos);
    mat.setFloat('time', 0);
    mat.setFloat('rainRate', 0);
    mat.setVector2('wind', this._wind);
    mat.setVector3('tint', new Vector3(0.55, 0.60, 0.72));
    mesh.setEnabled(false);
  }

  /** @param {number} dt @param {import('@babylonjs/core').Camera} cam @param {number} rainRate */
  update(dt, cam, rainRate) {
    const on = rainRate > 0.01;
    if (this.mesh.isEnabled() !== on) this.mesh.setEnabled(on);
    if (!on) return;
    this._time += dt;
    this._camPos.copyFrom(cam.globalPosition);
    const m = this.material;
    m.setVector3('camPos', this._camPos);
    m.setFloat('time', this._time);
    m.setFloat('rainRate', rainRate);
  }
}
