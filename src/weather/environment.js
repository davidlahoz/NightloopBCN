/**
 * Environment — owns the sun, ambient, fog, sky dome and shadow generator,
 * all driven by a single flat WeatherParams object. Mood states (M6) blend
 * WeatherParams and call apply(); nothing downstream ever blends "looks".
 *
 * Downstream modules (road material, facades, skyline, props) read from this
 * via applyEnvironment(env) on state change and update(env) per frame.
 */
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import skyVertex from '../shaders/sky.vertex.wgsl?raw';
import skyFragment from '../shaders/sky.fragment.wgsl?raw';

/**
 * The single interpolatable weather parameter set. Flat numbers + [r,g,b]
 * arrays only, so states can be lerped component-wise.
 */
export function makeWeatherParams() {
  return {
    // sun
    sunElevation: 7,          // degrees above horizon (can go negative)
    sunAzimuth: 205,          // degrees
    sunIntensity: 3.2,
    sunColor: [1.0, 0.62, 0.36],
    // sky dome
    zenithColor: [0.12, 0.19, 0.38],
    horizonColor: [0.86, 0.52, 0.30],
    horizonHaze: [0.48, 0.40, 0.44],
    starAmount: 0.0,
    cloudCover: 0.35,
    // ambient
    ambientSky: [0.30, 0.38, 0.58],
    ambientGround: [0.20, 0.17, 0.16],
    ambientIntensity: 0.85,
    // fog
    fogColor: [0.32, 0.32, 0.42],
    fogDensity: 0.0032,
    fogHeightFalloff: 0.045,
    // exposure & grade
    exposure: 1.0,
    // weather physical
    rainRate: 0.0,            // 0..1
    wetnessTarget: 0.55,      // what the street trends toward
    puddleLevel: 0.5,         // how full depressions are
    // lights
    streetlightIntensity: 1.0,
    neonIntensity: 1.0,
    windowLitFraction: 0.55,
  };
}

const _sunDir = new Vector3();

export class Environment {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.params = makeWeatherParams();

    this.sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
    // car-following ortho frustum, manually managed (see updateShadowFollow)
    this.sun.autoUpdateExtends = false;
    this.sun.autoCalcShadowZBounds = false;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 400;
    this.shadowHalf = 78;   // metres covered around the car
    this.sun.orthoLeft = -this.shadowHalf;
    this.sun.orthoRight = this.shadowHalf;
    this.sun.orthoBottom = -this.shadowHalf;
    this.sun.orthoTop = this.shadowHalf;

    this.hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);

    // FILTER_NONE float map: depth metric in R; the road shader does its own
    // 9-tap PCF via textureLoad, stock materials get hard-edge shadows (fine
    // at their footprint).
    this.shadow = new ShadowGenerator(4096, this.sun);
    this.shadow.bias = 0.0018;
    this.shadow.normalBias = 0.03;

    // sky dome — inverted sphere at infinite distance
    ShaderStore.ShadersStoreWGSL['nlSkyVertexShader'] = skyVertex;
    ShaderStore.ShadersStoreWGSL['nlSkyFragmentShader'] = skyFragment;
    this.skyMat = new ShaderMaterial('nlSky', scene, { vertex: 'nlSky', fragment: 'nlSky' }, {
      attributes: ['position'],
      uniformBuffers: ['Scene', 'Mesh'],
      shaderLanguage: ShaderLanguage.WGSL,
    });
    this.skyMat.backFaceCulling = false;
    this.skyMat.disableDepthWrite = true;
    this.sky = MeshBuilder.CreateSphere('sky', { diameter: 1, segments: 24, sideOrientation: 1 }, scene);
    this.sky.scaling.setAll(1500);
    this.sky.infiniteDistance = true;
    this.sky.material = this.skyMat;
    this.sky.isPickable = false;
    this.sky.alwaysSelectAsActiveMesh = true;

    // scratch colors reused in apply()
    this._c0 = new Color3(); this._c1 = new Color3(); this._c2 = new Color3();
    this.sunDir = new Vector3(0, -1, 0);
    this._time = 0;

    this.apply();
  }

  /** Push current params into engine objects. Call after any param change. */
  apply() {
    const p = this.params;
    const el = (p.sunElevation * Math.PI) / 180;
    const az = (p.sunAzimuth * Math.PI) / 180;
    // direction the light travels (from sun toward scene)
    _sunDir.set(-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az));
    this.sunDir.copyFrom(_sunDir);
    this.sun.direction.copyFrom(_sunDir);
    const sunUp = Math.max(0, Math.sin(el) * 8); // fade sun as it sets
    this.sun.intensity = p.sunIntensity * Math.min(1, sunUp);
    this.sun.diffuse.copyFromFloats(p.sunColor[0], p.sunColor[1], p.sunColor[2]);
    this.sun.specular.copyFromFloats(p.sunColor[0], p.sunColor[1], p.sunColor[2]);

    this.hemi.intensity = p.ambientIntensity;
    this.hemi.diffuse.copyFromFloats(p.ambientSky[0], p.ambientSky[1], p.ambientSky[2]);
    this.hemi.groundColor.copyFromFloats(p.ambientGround[0], p.ambientGround[1], p.ambientGround[2]);
    this.hemi.specular.copyFromFloats(0, 0, 0);

    const m = this.skyMat;
    m.setVector3('sunDir', this.sunDir);
    m.setFloat('sunIntensity', p.sunIntensity);
    m.setFloat('starAmount', p.starAmount);
    m.setFloat('cloudCover', p.cloudCover);
    m.setFloat('exposure', p.exposure);
    setC3(m, 'sunColor', p.sunColor);
    setC3(m, 'zenithColor', p.zenithColor);
    setC3(m, 'horizonColor', p.horizonColor);
    setC3(m, 'horizonHaze', p.horizonHaze);
    setC3(m, 'fogColor', p.fogColor);
  }

  /** @param {number} dt */
  update(dt) {
    this._time += dt;
    this.skyMat.setFloat('time', this._time);
  }

  /**
   * Re-anchor the sun's ortho shadow frustum on the car, snapped to shadow-map
   * texels in light space so the shadow edge never swims as the car moves.
   */
  updateShadowFollow(x, z) {
    const d = this.sunDir;
    // light-space basis (right/up perpendicular to sun direction)
    _rx.set(d.z, 0, -d.x);
    const rl = _rx.length();
    if (rl < 1e-4) _rx.set(1, 0, 0); else _rx.scaleInPlace(1 / rl);
    Vector3.CrossToRef(d, _rx, _uy);
    // anchor slightly ahead of the car is unnecessary — centre on car
    const texel = (this.shadowHalf * 2) / 4096;
    _anchor.set(x, 0, z);
    let px = Vector3.Dot(_anchor, _rx);
    let py = Vector3.Dot(_anchor, _uy);
    px = Math.round(px / texel) * texel;
    py = Math.round(py / texel) * texel;
    // reconstruct snapped anchor
    _snap.copyFrom(_rx).scaleInPlace(px);
    _snap.addInPlace(_uy2.copyFrom(_uy).scaleInPlace(py));
    // keep the world-Y component of the anchor consistent with plane y≈0
    this.sun.position.copyFrom(_snap).subtractInPlace(_sd.copyFrom(d).scaleInPlace(180));
  }
}

const _rx = new Vector3();
const _uy = new Vector3();
const _uy2 = new Vector3();
const _anchor = new Vector3();
const _snap = new Vector3();
const _sd = new Vector3();

function setC3(mat, name, arr) {
  mat.setColor3(name, _tmpC.copyFromFloats(arr[0], arr[1], arr[2]));
}
const _tmpC = new Color3();
