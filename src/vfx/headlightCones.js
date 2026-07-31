/**
 * Volumetric headlight cones — visible only when the air itself is thick
 * (rain or fog). Two additive open cones parented to the car body; alpha from
 * a fresnel-edge × longitudinal falloff in the shader. Restrained by design.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import coneVertex from '../shaders/lightcone.vertex.wgsl?raw';
import coneFragment from '../shaders/lightcone.fragment.wgsl?raw';

const CONE_LEN = 9;

export class HeadlightCones {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../vehicle/car.js').Car} car
   */
  constructor(scene, car) {
    ShaderStore.ShadersStoreWGSL['nlLightConeVertexShader'] = coneVertex;
    ShaderStore.ShadersStoreWGSL['nlLightConeFragmentShader'] = coneFragment;

    const mat = new ShaderMaterial('nlLightCone', scene, { vertex: 'nlLightCone', fragment: 'nlLightCone' }, {
      attributes: ['position', 'normal'],
      uniformBuffers: ['Scene', 'Mesh'],
      shaderLanguage: ShaderLanguage.WGSL,
      needAlphaBlending: true,
    });
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.setFloat('density', 0);
    mat.setVector3('tint', new Vector3(1.0, 0.9, 0.72));
    this.material = mat;

    this.cones = [];
    for (let i = 0; i < 2; i++) {
      const cone = MeshBuilder.CreateCylinder(`nlHeadCone${i}`, {
        diameterTop: 4.6, diameterBottom: 0.16, height: CONE_LEN,
        tessellation: 24, cap: 0,
      }, scene);
      // cylinder axis is Y; rotate so it points +Z with base at origin
      cone.rotation.x = Math.PI / 2;
      cone.position.z = CONE_LEN / 2;
      cone.bakeCurrentTransformIntoVertices();
      cone.material = mat;
      cone.parent = car.bodyNode;
      cone.position.set(i === 0 ? -0.62 : 0.62, 0.62, 2.0);
      cone.rotation.x = 0.055; // slight downward throw
      cone.isPickable = false;
      cone.metadata = { nlNoShadow: true, nlNoMirror: true };
      this.cones.push(cone);
    }
    this._density = 0;
  }

  /** @param {import('../weather/environment.js').Environment} env @param {number} headlights */
  applyEnvironment(env, headlights) {
    const p = env.params;
    // cones appear only when the air scatters: rain or fog
    const thick = Math.min(1, p.rainRate * 0.8 + Math.max(0, p.fogDensity - 0.004) * 55);
    this._density = thick * headlights;
    this.material.setFloat('density', this._density);
    const on = this._density > 0.02;
    for (const c of this.cones) if (c.isEnabled() !== on) c.setEnabled(on);
  }

  update() { /* parented to the car; nothing per-frame */ }
}
