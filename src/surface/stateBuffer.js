/**
 * Surface state buffer — the core interactive system.
 *
 * A car-following RGBA16F render target (SIZE² texels over EXTENT metres,
 * ~4 cm/texel) holds water-cleared / ridge / damp / rubber deltas. Everything
 * writes here (tyres now, Glide wake in M5, weather decay every frame) and the
 * road shader reads it. One fused EffectRenderer pass per frame: scroll +
 * decay + rain coupling + up to MAX_SPLATS analytic splats. Zero allocations
 * per frame.
 */
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { EffectRenderer, EffectWrapper } from '@babylonjs/core/Materials/effectRenderer.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { defineParam, params } from '../core/params.js';
import { quality } from '../core/quality.js';
import stateFragment from '../shaders/surfaceState.fragment.wgsl?raw';

defineParam('stateEvaporation', 0.5, { label: 'evaporation', section: 'surface', min: 0, max: 2, step: 0.05 });
defineParam('stateRubberStrength', 1.0, { label: 'rubber strength', section: 'surface', min: 0, max: 3, step: 0.05 });

const SIZE = quality.stateSize;
const HALF_EXTENT = 40;         // buffer covers ±40 m around the car
const MAX_SPLATS = 8;

export class SurfaceState {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../city/roadMaterial.js').RoadMaterial} roadMat
   */
  constructor(scene, roadMat) {
    this.scene = scene;
    this.roadMat = roadMat;
    const engine = scene.getEngine();

    ShaderStore.ShadersStoreWGSL['nlSurfaceStateFragmentShader'] = stateFragment;

    const mkRT = (name) => {
      const rt = new RenderTargetTexture(name, { width: SIZE, height: SIZE }, scene, {
        generateMipMaps: false,
        type: Constants.TEXTURETYPE_HALF_FLOAT,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE,
        generateDepthBuffer: false,
      });
      rt.wrapU = Texture.CLAMP_ADDRESSMODE;
      rt.wrapV = Texture.CLAMP_ADDRESSMODE;
      return rt;
    };
    this.rtA = mkRT('surfaceStateA');
    this.rtB = mkRT('surfaceStateB');
    this.current = this.rtA;
    this.previous = this.rtB;

    this.renderer = new EffectRenderer(engine);
    this.wrapper = new EffectWrapper({
      engine,
      name: 'nlSurfaceState',
      fragmentShader: 'nlSurfaceState',
      useShaderStore: true,
      shaderLanguage: ShaderLanguage.WGSL,
      uniformNames: ['scrollUV', 'dt', 'rainRate', 'evaporation', 'splatCount', 'splats'],
      samplerNames: ['prevState'],
    });

    // world centre of the buffer, snapped to texel grid
    const texel = (HALF_EXTENT * 2) / SIZE;
    this._texel = texel;
    this.centerX = 0;
    this.centerZ = 0;
    this._splatData = new Float32Array(MAX_SPLATS * 12);
    this._splatCount = 0;
    this._dt = 1 / 90;
    this._rainRate = 0;
    this._scrollX = 0;
    this._scrollZ = 0;
    this._warm = 0;

    this.wrapper.onApplyObservable.add(() => {
      const e = this.wrapper.effect;
      e.setTexture('prevState', this.previous);
      e.setFloat2('scrollUV', this._scrollX, this._scrollZ);
      e.setFloat('dt', this._dt);
      e.setFloat('rainRate', this._rainRate);
      e.setFloat('evaporation', params.stateEvaporation);
      e.setFloat('splatCount', this._splatCount);
      e.setFloatArray4('splats', this._splatData);
    });
  }

  /**
   * Queue a splat for this frame. Positions in world metres.
   * @param {number} x @param {number} z world position
   * @param {number} dirX @param {number} dirZ motion direction (normalized)
   * @param {number} lenM gaussian sigma along motion (m)
   * @param {number} widthM gaussian sigma across (m)
   * @param {number} clear water-clear strength 0..1
   * @param {number} ridge ridge deposit strength
   * @param {number} damp damp film strength
   * @param {number} rubber rubber deposit strength
   * @param {number} avail water availability scale for the ridge
   */
  addSplat(x, z, dirX, dirZ, lenM, widthM, clear, ridge, damp, rubber, avail) {
    if (this._splatCount >= MAX_SPLATS) return;
    const o = this._splatCount * 12;
    const d = this._splatData;
    const span = HALF_EXTENT * 2;
    d[o] = (x - this.centerX) / span + 0.5;
    d[o + 1] = (z - this.centerZ) / span + 0.5;
    d[o + 2] = dirX;
    d[o + 3] = dirZ;
    d[o + 4] = lenM / span;
    d[o + 5] = widthM / span;
    d[o + 6] = clear;
    d[o + 7] = ridge; // unused since ridge visuals were removed; kept for layout
    d[o + 8] = damp;
    d[o + 9] = rubber * params.stateRubberStrength;
    d[o + 10] = avail;
    d[o + 11] = 0;
    this._splatCount++;
  }

  /**
   * Run the update pass. Call AFTER queuing splats for the frame.
   * @param {number} dt
   * @param {number} carX @param {number} carZ
   * @param {{rainRate:number}} weatherParams
   */
  update(dt, carX, carZ, weatherParams) {
    // snap the new centre to the texel grid so data never swims
    const tx = this._texel;
    const nx = Math.round(carX / tx) * tx;
    const nz = Math.round(carZ / tx) * tx;
    const span = HALF_EXTENT * 2;
    this._scrollX = (nx - this.centerX) / span;
    this._scrollZ = (nz - this.centerZ) / span;
    // splats were queued in OLD centre coords; shift them to the new centre
    if (this._scrollX !== 0 || this._scrollZ !== 0) {
      for (let i = 0; i < this._splatCount; i++) {
        this._splatData[i * 12] -= this._scrollX;
        this._splatData[i * 12 + 1] -= this._scrollZ;
      }
    }
    this.centerX = nx;
    this.centerZ = nz;
    this._dt = Math.min(dt, 0.05);
    this._rainRate = weatherParams.rainRate;

    // ping-pong
    const target = this.current === this.rtA ? this.rtB : this.rtA;
    this.previous = this.current;
    this.current = target;
    this.renderer.render(this.wrapper, target.renderTarget);
    this.renderer.restoreStates();

    // publish to the road material
    const rm = this.roadMat;
    rm.material.setTexture('stateTex', this.current);
    rm._stateCenter.x = this.centerX;
    rm._stateCenter.y = this.centerZ;
    rm._stateCenter.z = HALF_EXTENT;
    rm._stateCenter.w = 1;
    rm.material.setVector4('stateCenter', rm._stateCenter);

    this._splatCount = 0;
  }
}
