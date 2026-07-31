/**
 * Hero car materials — layered clearcoat paint with flake + orange peel,
 * tinted glass, black trim, tyres, gunmetal rims, emissive lights.
 * The scene's HDR environment (loaded here once) feeds all PBR reflections.
 */
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { defineParam, params, onParam } from '../core/params.js';
import { hash2, valueNoise } from '../city/noise.js';

defineParam('carPaintHue', 0, { label: 'paint variant', section: 'car', min: 0, max: 3, step: 1 });
defineParam('carEnvIntensity', 0.55, { label: 'env reflections', section: 'car', min: 0, max: 2, step: 0.05 });

/** flake sparkle + orange peel, packed into one clearcoat normal map */
function makeFlakeBump(scene) {
  const S = 256;
  const tex = new DynamicTexture('nlCarFlake', { width: S, height: S }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // orange peel: smooth low-frequency wobble (~10 px wavelength)
      const opX = (valueNoise(x * 0.11, y * 0.11) - 0.5) * 14;
      const opY = (valueNoise(x * 0.11 + 37.2, y * 0.11 + 11.9) - 0.5) * 14;
      // metallic flake: per-pixel random micro-normal
      const flX = (hash2(x + S * 3, y) - 0.5) * 26;
      const flY = (hash2(x, y + S * 5) - 0.5) * 26;
      const i = (y * S + x) * 4;
      d[i] = Math.max(0, Math.min(255, 128 + opX + flX));
      d[i + 1] = Math.max(0, Math.min(255, 128 + opY + flY));
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

const PAINTS = [
  { name: 'petrol', albedo: [0.030, 0.085, 0.095], metallic: 0.92, rough: 0.40 },
  { name: 'graphite', albedo: [0.052, 0.055, 0.060], metallic: 0.95, rough: 0.38 },
  { name: 'oxide red', albedo: [0.120, 0.038, 0.028], metallic: 0.88, rough: 0.44 },
  { name: 'champagne', albedo: [0.130, 0.110, 0.080], metallic: 0.93, rough: 0.36 },
];

export class CarMaterials {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // scene-wide HDR environment (PBR reflections for car + props)
    if (!scene.environmentTexture) {
      scene.environmentTexture = new HDRCubeTexture('/assets/env/urban.hdr', scene, 128, false, true, false, true);
      scene.environmentIntensity = params.carEnvIntensity;
      onParam('carEnvIntensity', (v) => { scene.environmentIntensity = v; });
    }

    const flake = makeFlakeBump(scene);

    // ---- paint: metallic base + clearcoat with flake/orange peel ----
    const paint = new PBRMaterial('nlCarPaint', scene);
    const pv = PAINTS[params.carPaintHue | 0] ?? PAINTS[0];
    paint.albedoColor = new Color3(...pv.albedo);
    paint.metallic = pv.metallic;
    paint.roughness = pv.rough;
    paint.clearCoat.isEnabled = true;
    paint.clearCoat.intensity = 0.9;
    paint.clearCoat.roughness = 0.06;
    paint.clearCoat.bumpTexture = flake;
    paint.clearCoat.bumpTexture.level = 0.35;
    paint.clearCoat.bumpTexture.uScale = 24;
    paint.clearCoat.bumpTexture.vScale = 24;
    this.paint = paint;
    onParam('carPaintHue', (v) => {
      const p = PAINTS[v | 0] ?? PAINTS[0];
      paint.albedoColor.copyFromFloats(p.albedo[0], p.albedo[1], p.albedo[2]);
      paint.metallic = p.metallic;
      paint.roughness = p.rough;
    });

    // ---- glass: dark tint, sharp reflections, no modelled interior ----
    const glass = new PBRMaterial('nlCarGlass', scene);
    glass.albedoColor = new Color3(0.006, 0.008, 0.010);
    glass.metallic = 0.0;
    glass.roughness = 0.055;
    glass.environmentIntensity = 1.2;
    this.glass = glass;

    // ---- black trim / plastics ----
    const trim = new PBRMaterial('nlCarTrim', scene);
    trim.albedoColor = new Color3(0.018, 0.018, 0.020);
    trim.metallic = 0.1;
    trim.roughness = 0.5;
    this.trim = trim;

    // ---- arch liners: light-eating dark ----
    const liner = new PBRMaterial('nlCarLiner', scene);
    liner.albedoColor = new Color3(0.008, 0.008, 0.009);
    liner.metallic = 0;
    liner.roughness = 1;
    this.liner = liner;

    // ---- tyre: unlit near-black (tyres at dusk are voids with a whisper of sheen;
    // the PBR path made the sidewall read pale under the sky dome) ----
    const tire = new StandardMaterial('nlCarTire', scene);
    tire.diffuseColor = new Color3(0, 0, 0);
    tire.specularColor = new Color3(0.02, 0.02, 0.022);
    tire.emissiveColor = new Color3(0.012, 0.012, 0.013);
    tire.specularPower = 24;
    this.tire = tire;

    // ---- rim: dark gunmetal (kept dim — silver rims blow out at dusk) ----
    const rim = new PBRMaterial('nlCarRim', scene);
    rim.albedoColor = new Color3(0.045, 0.047, 0.052);
    rim.metallic = 0.92;
    rim.roughness = 0.38;
    rim.environmentIntensity = 0.55;
    this.rim = rim;

    // ---- brake: dark steel disc + caliper ----
    const brake = new PBRMaterial('nlCarBrake', scene);
    brake.albedoColor = new Color3(0.035, 0.026, 0.024);
    brake.metallic = 0.7;
    brake.roughness = 0.45;
    brake.environmentIntensity = 0.4;
    this.brake = brake;

    // ---- lights ----
    const rear = new PBRMaterial('nlCarRearLight', scene);
    rear.albedoColor = new Color3(0.05, 0.005, 0.006);
    rear.metallic = 0;
    rear.roughness = 0.2;
    rear.emissiveColor = new Color3(1.0, 0.05, 0.06);
    rear.emissiveIntensity = 1.6;
    this.rearLight = rear;

    const front = new PBRMaterial('nlCarFrontLight', scene);
    front.albedoColor = new Color3(0.04, 0.04, 0.045);
    front.metallic = 0;
    front.roughness = 0.15;
    front.emissiveColor = new Color3(1.0, 0.95, 0.85);
    front.emissiveIntensity = 1.1;
    this.frontLight = front;
  }

  /** brake lights flare when braking; headlights scale with weather */
  setBrake(on) {
    this.rearLight.emissiveIntensity = on ? 5.5 : 1.6;
  }

  setHeadlights(intensity) {
    this.frontLight.emissiveIntensity = 0.25 + intensity * 2.2;
  }
}
