/**
 * The road material — owns the hero WGSL shader, the planar mirror reflection,
 * the city-light storage buffer, and the per-frame uniform pushes.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { MirrorTexture } from '@babylonjs/core/Materials/Textures/mirrorTexture.js';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer.js';
import { Plane } from '@babylonjs/core/Maths/math.plane.js';
import { Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { defineParam, params } from '../core/params.js';
import { quality } from '../core/quality.js';
import roadVertex from '../shaders/road.vertex.wgsl?raw';
import roadFragment from '../shaders/road.fragment.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';

defineParam('roadWetness', 0.55, { label: 'wetness', section: 'road', min: 0, max: 1, step: 0.01 });
defineParam('roadPuddles', 0.55, { label: 'puddle level', section: 'road', min: 0, max: 1, step: 0.01 });
defineParam('roadGlints', quality.glintDefault, { label: 'glint intensity', section: 'road', min: 0, max: 2, step: 0.05 });
defineParam('roadRefl', 0.85, { label: 'reflection', section: 'road', min: 0, max: 2, step: 0.05 });
defineParam('roadMarkWear', 0.55, { label: 'marking wear', section: 'road', min: 0, max: 1, step: 0.01 });

const MAX_LIGHTS = 96;

export class RoadMaterial {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    this.scene = scene;
    const engine = scene.getEngine();

    ShaderStore.IncludesShadersStoreWGSL['nlCommon'] = commonWgsl;
    ShaderStore.ShadersStoreWGSL['nlRoadVertexShader'] = roadVertex;
    ShaderStore.ShadersStoreWGSL['nlRoadFragmentShader'] = roadFragment;

    const mat = new ShaderMaterial('nlRoad', scene, { vertex: 'nlRoad', fragment: 'nlRoad' }, {
      attributes: ['position', 'normal'],
      uniformBuffers: ['Scene'],
      storageBuffers: ['roadLights'],
      shaderLanguage: ShaderLanguage.WGSL,
    });
    this.material = mat;
    mat.backFaceCulling = true;

    // ---- textures ----
    const tex = (p) => {
      const t = new Texture(p, scene, false, false); // no mipmaps? -> yes mipmaps: invertY false
      t.anisotropicFilteringLevel = 8;
      t.wrapU = Texture.WRAP_ADDRESSMODE;
      t.wrapV = Texture.WRAP_ADDRESSMODE;
      return t;
    };
    this.texAlbedo = tex('/assets/textures/asphalt/color.jpg');
    this.texNormal = tex('/assets/textures/asphalt/normal.jpg');
    this.texRough = tex('/assets/textures/asphalt/roughness.jpg');
    mat.setTexture('asphaltAlbedo', this.texAlbedo);
    mat.setTexture('asphaltNormal', this.texNormal);
    mat.setTexture('asphaltRough', this.texRough);

    // ---- surface state placeholder (M3 replaces) ----
    this.stateTex = RawTexture.CreateRGBATexture(
      new Uint8Array([0, 0, 0, 0]), 1, 1, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    mat.setTexture('stateTex', this.stateTex);
    this._stateCenter = new Vector4(0, 0, 50, 0);
    mat.setVector4('stateCenter', this._stateCenter);

    // ---- planar mirror ----
    // HDR half-float mirror with trilinear mips (roughness-blurred sampling)
    this.mirror = new MirrorTexture('roadMirror', { ratio: quality.mirrorRatio }, scene, true,
      Constants.TEXTURETYPE_HALF_FLOAT, Texture.TRILINEAR_SAMPLINGMODE);
    this.mirror.mirrorPlane = new Plane(0, -1, 0, 0);
    this.mirror.level = 1;
    this.mirror.anisotropicFilteringLevel = 4;
    // ShaderMaterial-bound RTTs are not auto-rendered — register explicitly
    scene.customRenderTargets.push(this.mirror);
    mat.setTexture('mirrorTex', this.mirror);

    // ---- lights storage buffer ----
    this.lightBuffer = new StorageBuffer(engine, MAX_LIGHTS * 32);
    this.lightData = new Float32Array(MAX_LIGHTS * 8);
    this.lightCount = 0;
    mat.setStorageBuffer('roadLights', this.lightBuffer);
    mat.setFloat('lightCount', 0);

    // ---- static-ish uniforms ----
    mat.setFloat('time', 0);
    mat.setFloat('shadowMapSize', quality.shadowSize);
    // sun ortho near/far — used to reconstruct the light-view depth metric
    this._shadowDV = new Vector2(env.sun.shadowMinZ, env.sun.shadowMaxZ);
    mat.setVector2('shadowDV', this._shadowDV);
    this._hl0 = new Vector4(0, 0, 0, 0);
    this._hl1 = new Vector4(0, 0, 0, 0);
    this._ht0 = new Vector4(0, 0, 0, 0);
    this._ht1 = new Vector4(0, 0, 0, 0);
    mat.setVector4('headlight0', this._hl0);
    mat.setVector4('headlight1', this._hl1);
    mat.setVector4('headlightTip0', this._ht0);
    mat.setVector4('headlightTip1', this._ht1);

    // sun shadow map (depth texture, comparison-sampled in the shader)
    mat.setTexture('sunShadowMap', env.shadow.getShadowMap());

    this._time = 0;
    this._sunColor = new Vector3();
    this._cSky = new Vector3();
    this._cGround = new Vector3();
    this._cFog = new Vector3();
    this.applyEnvironment(env);
  }

  /**
   * Rebuild the city light list. Accepts [{x,y,z,r,g,b,radius,intensity}].
   * Called at integration and after applyEnvironment of light-owning modules.
   */
  setLights(lists) {
    let n = 0;
    const cap = Math.min(MAX_LIGHTS, quality.maxLights);
    const d = this.lightData;
    for (let li = 0; li < lists.length; li++) {
      const arr = lists[li];
      for (let i = 0; i < arr.length && n < cap; i++) {
        const L = arr[i];
        const o = n * 8;
        d[o] = L.x; d[o + 1] = L.y; d[o + 2] = L.z; d[o + 3] = L.radius;
        d[o + 4] = L.r; d[o + 5] = L.g; d[o + 6] = L.b; d[o + 7] = L.intensity;
        n++;
      }
    }
    this.lightCount = n;
    this.lightBuffer.update(this.lightData);
    this.material.setFloat('lightCount', n);
  }

  /** @param {import('../weather/environment.js').Environment} env */
  applyEnvironment(env) {
    const p = env.params;
    const m = this.material;
    m.setVector3('sunDir', env.sunDir);
    const si = env.sun.intensity;
    m.setVector3('sunColor', this._sunColor.set(p.sunColor[0] * si, p.sunColor[1] * si, p.sunColor[2] * si));
    m.setVector3('ambientSky', this._cSky.set(p.ambientSky[0] * p.ambientIntensity, p.ambientSky[1] * p.ambientIntensity, p.ambientSky[2] * p.ambientIntensity));
    m.setVector3('ambientGround', this._cGround.set(p.ambientGround[0] * p.ambientIntensity, p.ambientGround[1] * p.ambientIntensity, p.ambientGround[2] * p.ambientIntensity));
    m.setVector3('fogColor', this._cFog.set(p.fogColor[0], p.fogColor[1], p.fogColor[2]));
    m.setFloat('fogDensity', p.fogDensity);
    m.setFloat('fogHeightFalloff', p.fogHeightFalloff);
    m.setFloat('rainRate', p.rainRate);
    m.setFloat('wetness', params.roadWetness);
    m.setFloat('puddleLevel', params.roadPuddles);
    m.setFloat('glintIntensity', params.roadGlints);
    m.setFloat('reflStrength', params.roadRefl);
    m.setFloat('markingWear', params.roadMarkWear);
  }

  /**
   * Per-frame: time, mirror plane follow, sun shadow matrix.
   * @param {number} dt
   * @param {import('../weather/environment.js').Environment} env
   * @param {number} carX @param {number} carZ @param {number} roadY
   */
  update(dt, env, carX, carZ, roadY) {
    this._time += dt;
    const m = this.material;
    m.setFloat('time', this._time);
    // live-tunable params (cheap sets; ShaderMaterial caches values)
    m.setFloat('wetness', params.roadWetness);
    m.setFloat('puddleLevel', params.roadPuddles);
    m.setFloat('glintIntensity', params.roadGlints);
    m.setFloat('reflStrength', params.roadRefl);
    m.setFloat('markingWear', params.roadMarkWear);
    this.mirror.mirrorPlane.d = roadY + 0.01;
    if (env.shadow) {
      m.setMatrix('sunShadowMatrix', env.shadow.getTransformMatrix());
    }
  }
}
