/**
 * Post-processing chain. M2: HDR pipeline with ACES tonemapping, light bloom,
 * FXAA (TAA replaces it in M7), subtle vignette. Every effect individually
 * toggleable from the overlay. All materials output linear HDR; this chain is
 * the only place tone mapping happens.
 */
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { defineParam, params, onParam } from '../core/params.js';
import { quality } from '../core/quality.js';

defineParam('ppExposure', 1.35, { label: 'exposure', section: 'post', min: 0.2, max: 3, step: 0.05 });
defineParam('ppBloom', true, { label: 'bloom', section: 'post' });
defineParam('ppBloomWeight', 0.25, { label: 'bloom weight', section: 'post', min: 0, max: 1.5, step: 0.05 });
defineParam('ppFxaa', true, { label: 'fxaa', section: 'post' });
defineParam('ppVignette', 0.28, { label: 'vignette', section: 'post', min: 0, max: 1, step: 0.02 });
defineParam('ppContrast', 1.08, { label: 'contrast', section: 'post', min: 0.5, max: 2, step: 0.02 });
defineParam('ppMotionBlur', 0.55, { label: 'motion blur', section: 'post', min: 0, max: 2, step: 0.05 });

export class PostChain {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('@babylonjs/core').Camera} camera
   */
  constructor(scene, camera) {
    // camera/screen motion blur — runs before the tonemapping pipeline
    this.motionBlur = new MotionBlurPostProcess('nlMB', scene, 1.0, camera);
    this.motionBlur.isObjectBased = false;
    this.motionBlur.motionStrength = 0;
    this.motionBlur.motionBlurSamples = 14;
    this._mbSpeed = 0;

    const pp = new DefaultRenderingPipeline('nlPost', true, scene, [camera]);
    this.pipeline = pp;

    pp.fxaaEnabled = params.ppFxaa;
    pp.bloomEnabled = params.ppBloom;
    pp.bloomThreshold = 0.9;
    pp.bloomWeight = params.ppBloomWeight;
    pp.bloomKernel = quality.bloomKernel;
    pp.bloomScale = 0.5;

    const ip = pp.imageProcessing;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = params.ppExposure;
    ip.contrast = params.ppContrast;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = params.ppVignette * 4;
    ip.vignetteCameraFov = 0.9;

    onParam('ppExposure', (v) => { ip.exposure = v; });
    onParam('ppContrast', (v) => { ip.contrast = v; });
    onParam('ppBloom', (v) => { pp.bloomEnabled = v; });
    onParam('ppBloomWeight', (v) => { pp.bloomWeight = v; });
    onParam('ppFxaa', (v) => { pp.fxaaEnabled = v; });
    onParam('ppVignette', (v) => { ip.vignetteWeight = v * 4; ip.vignetteEnabled = v > 0.001; });
  }

  /** Weather states drive exposure through this. */
  setExposure(v) {
    this.pipeline.imageProcessing.exposure = v * params.ppExposure;
  }

  /** Speed-scaled motion blur (called per frame from the main loop). */
  setSpeed(speed) {
    const t = Math.min(1, speed / 32);
    this.motionBlur.motionStrength = params.ppMotionBlur * t * t * 1.2;
  }
}
