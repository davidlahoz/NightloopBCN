/**
 * Litter and leaves skating along the gutters. A single thin-instanced master
 * quad; 48 pieces live near the car, recycled ahead when left behind. CPU
 * updates one preallocated matrix buffer per frame (48 groundHeight calls —
 * negligible), giving correct ground contact and gusty stop-start motion.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { STREETS_X, STREETS_Z, ROAD_HALF, EXTENT_X, EXTENT_Z } from '../city/cityPlan.js';
import { groundHeight } from '../city/roadProfile.js';
import { valueNoise, hash2 } from '../city/noise.js';

const N = 48;
const GUTTER_T = 3.9; // ride the lane edge / gutter line

export class Litter {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    const master = MeshBuilder.CreatePlane('nlLitter', { width: 0.13, height: 0.10 }, scene);
    const mat = new PBRMaterial('nlLitterMat', scene);
    mat.albedoColor = new Color3(0.28, 0.25, 0.20);
    mat.metallic = 0;
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    master.material = mat;
    master.isPickable = false;
    master.alwaysSelectAsActiveMesh = true;
    master.metadata = { nlNoShadow: true, nlNoMirror: true };
    this.mesh = master;

    this._m = new Float32Array(N * 16);
    // per piece: axis(0 NS/1 EW), streetIdx, side(±1), s, speed, tumble, phase
    this._axis = new Uint8Array(N);
    this._street = new Uint8Array(N);
    this._side = new Float32Array(N);
    this._s = new Float32Array(N);
    this._tumble = new Float32Array(N);
    this._phase = new Float32Array(N);
    for (let i = 0; i < N; i++) this._recycle(i, 0, 0, true);
    master.thinInstanceSetBuffer('matrix', this._m, 16, false);
    this._time = 0;
    this.wind = 0.6;
  }

  _recycle(i, carX, carZ, anywhere) {
    const r = hash2(i * 7 + ((this._time * 13) | 0), 3);
    this._axis[i] = r > 0.5 ? 1 : 0;
    this._street[i] = (hash2(i, 11) * 3) | 0;
    this._side[i] = hash2(i, 13) > 0.5 ? 1 : -1;
    const along = anywhere ? (hash2(i, 17) - 0.5) * 180 : (hash2(i, 17) - 0.30) * 90;
    if (this._axis[i] === 0) {
      this._s[i] = clampAbs(carZ + along, EXTENT_Z - 4);
    } else {
      this._s[i] = clampAbs(carX + along, EXTENT_X - 4);
    }
    this._tumble[i] = hash2(i, 19) * Math.PI * 2;
    this._phase[i] = hash2(i, 23) * 100;
  }

  /** @param {number} dt @param {number} carX @param {number} carZ */
  update(dt, carX, carZ) {
    this._time += dt;
    const t = this._time;
    const m = this._m;
    for (let i = 0; i < N; i++) {
      // gusty advance: mostly parked, occasional skitter
      const gust = Math.max(0, valueNoise(t * 0.25 + this._phase[i], i * 3.7) - 0.55) * 4.5;
      const v = gust * this.wind * (1.5 + hash2(i, 29) * 2.5);
      this._s[i] += v * dt * (this._side[i] > 0 ? 1 : -1) * 0.6;
      this._tumble[i] += v * dt * 9;

      let x, z;
      if (this._axis[i] === 0) {
        x = STREETS_X[this._street[i]] + this._side[i] * GUTTER_T;
        z = this._s[i];
      } else {
        x = this._s[i];
        z = STREETS_Z[this._street[i]] + this._side[i] * GUTTER_T;
      }
      const dx = x - carX, dz = z - carZ;
      if (dx * dx + dz * dz > 4900) {
        this._recycle(i, carX, carZ, false);
        continue;
      }
      const y = groundHeight(x, z) + 0.012 + Math.max(0, valueNoise(t * 0.7 + this._phase[i], i * 1.3) - 0.75) * 0.5;
      // matrix: tumble around a diagonal axis, lying mostly flat
      const ca = Math.cos(this._tumble[i]), sa = Math.sin(this._tumble[i]);
      const o = i * 16;
      // lie flat (rotX -90°) then spin around local Z (world Y)
      m[o] = ca; m[o + 1] = 0.12 * sa; m[o + 2] = sa * 0.99; m[o + 3] = 0;
      m[o + 4] = -sa; m[o + 5] = 0.12 * ca; m[o + 6] = ca * 0.99; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = -0.99; m[o + 10] = 0.12; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    }
    this.mesh.thinInstanceBufferUpdated('matrix');
  }

  applyEnvironment(env) {
    // stronger wind in rain, dead still in fog
    const p = env.params;
    this.wind = 0.45 + p.rainRate * 0.9 + p.cloudCover * 0.3 - (p.fogDensity > 0.015 ? 0.5 : 0);
    if (this.wind < 0.05) this.wind = 0.05;
  }
}

function clampAbs(v, lim) {
  return v > lim ? lim : v < -lim ? -lim : v;
}
