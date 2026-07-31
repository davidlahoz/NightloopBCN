/**
 * Light halos — additive billboards at every streetlight head and neon sign.
 * They swell with fog density (fogbank turns lamps into haloed spheres) and
 * vanish in clear air. One static mesh, billboarding in the vertex shader.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import glowVertex from '../shaders/glow.vertex.wgsl?raw';
import glowFragment from '../shaders/glow.fragment.wgsl?raw';

export class Glow {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {Array<{x:number,y:number,z:number,r:number,g:number,b:number,intensity:number}>} streetHeads
   * @param {Array<{x:number,y:number,z:number,r:number,g:number,b:number,intensity:number}>} neons
   */
  constructor(scene, streetHeads, neons) {
    ShaderStore.ShadersStoreWGSL['nlGlowVertexShader'] = glowVertex;
    ShaderStore.ShadersStoreWGSL['nlGlowFragmentShader'] = glowFragment;

    const mat = new ShaderMaterial('nlGlow', scene, { vertex: 'nlGlow', fragment: 'nlGlow' }, {
      attributes: ['position', 'center', 'tint', 'misc'],
      uniformBuffers: ['Scene'],
      shaderLanguage: ShaderLanguage.WGSL,
      needAlphaBlending: true,
    });
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.alphaMode = Constants.ALPHA_ADD;
    this.material = mat;

    const mesh = new Mesh('nlGlow', scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.metadata = { nlNoShadow: true, nlNoMirror: true };
    this.mesh = mesh;
    this.rebuild(streetHeads, neons);

    mat.setFloat('fogDensity', 0.003);
    mat.setFloat('streetlight', 1);
    mat.setFloat('neon', 1);
    mat.setFloat('time', 0);
  }

  /**
   * Regenerate all halo quads. Called whenever the streamed light sets change
   * (a few times per block of driving — full re-upload is a few kB).
   */
  rebuild(streetHeads, neons) {
    const items = [];
    for (const h of streetHeads) items.push({ ...h, size: 1.35, neon: 0 });
    for (const n of neons) items.push({ ...n, size: 1.0, neon: 1 });

    const nQ = items.length;
    if (nQ === 0) { this.mesh.setEnabled(false); return; }
    const pos = new Float32Array(nQ * 4 * 3);
    const center = new Float32Array(nQ * 4 * 3);
    const tint = new Float32Array(nQ * 4 * 4);
    const misc = new Float32Array(nQ * 4 * 4);
    const idx = new Uint32Array(nQ * 6);
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let i = 0; i < nQ; i++) {
      const it = items[i];
      for (let c = 0; c < 4; c++) {
        const o3 = (i * 4 + c) * 3, o4 = (i * 4 + c) * 4;
        pos[o3] = corners[c][0]; pos[o3 + 1] = corners[c][1]; pos[o3 + 2] = it.size;
        center[o3] = it.x; center[o3 + 1] = it.y; center[o3 + 2] = it.z;
        tint[o4] = it.r; tint[o4 + 1] = it.g; tint[o4 + 2] = it.b; tint[o4 + 3] = 1;
        misc[o4] = 0.8 * (it.intensity || 1); misc[o4 + 1] = it.neon; misc[o4 + 2] = (i % 7) / 7; misc[o4 + 3] = 0;
      }
      const b = i * 4, j = i * 6;
      idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
      idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(this.mesh);
    this.mesh.setVerticesData('center', center, false, 3);
    this.mesh.setVerticesData('tint', tint, false, 4);
    this.mesh.setVerticesData('misc', misc, false, 4);
    this.mesh.setEnabled(true);
  }

  applyEnvironment(env) {
    const p = env.params;
    this.material.setFloat('fogDensity', p.fogDensity);
    this.material.setFloat('streetlight', p.streetlightIntensity);
    this.material.setFloat('neon', p.neonIntensity);
  }

  update() { /* static */ }
}
