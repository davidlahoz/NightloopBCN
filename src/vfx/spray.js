/**
 * Tyre spray + drift smoke. Pooled Babylon particle systems (zero allocation
 * after construction): spray droplets streak from the rear tyres scaled by
 * speed × water on the road; smoke replaces spray when drifting on dry
 * asphalt; a damp drift blends both. Spray velocity follows the wheel's
 * world motion so the wake trails correctly.
 */
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color4 } from '@babylonjs/core/Maths/math.color.js';

function makeDotTexture(scene, soft) {
  const S = 64;
  const tex = new DynamicTexture(soft ? 'nlPuff' : 'nlDrop', { width: S, height: S }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = soft
        ? Math.max(0, 1 - r) ** 2 * 200
        : Math.max(0, 1 - r * r) ** 1.5 * 255;
      const i = (y * S + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.min(255, a | 0);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

export class TyreFX {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    const drop = makeDotTexture(scene, false);
    const puff = makeDotTexture(scene, true);

    /** @type {ParticleSystem[]} */
    this.spray = [];
    /** @type {Vector3[]} */
    this._emitters = [];
    this._dir1 = [];
    this._dir2 = [];

    for (let i = 0; i < 2; i++) {
      const ps = new ParticleSystem(`nlSpray${i}`, 900, scene);
      ps.particleTexture = drop;
      const emitter = new Vector3(0, -10, 0);
      ps.emitter = emitter;
      ps.minLifeTime = 0.28;
      ps.maxLifeTime = 0.6;
      ps.minSize = 0.05;
      ps.maxSize = 0.17;
      ps.emitRate = 0;
      ps.gravity = new Vector3(0, -11, 0);
      ps.color1 = new Color4(0.62, 0.68, 0.80, 0.42);
      ps.color2 = new Color4(0.45, 0.50, 0.62, 0.30);
      ps.colorDead = new Color4(0.4, 0.45, 0.55, 0);
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      ps.minEmitPower = 1;
      ps.maxEmitPower = 1;
      ps.updateSpeed = 1 / 90;
      const d1 = new Vector3(0, 1, 0), d2 = new Vector3(0, 2, 0);
      ps.direction1 = d1;
      ps.direction2 = d2;
      ps.minEmitBox = new Vector3(-0.14, -0.05, -0.2);
      ps.maxEmitBox = new Vector3(0.14, 0.05, 0.2);
      ps.isBillboardBased = true;
      ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      ps.start();
      this.spray.push(ps);
      this._emitters.push(emitter);
      this._dir1.push(d1);
      this._dir2.push(d2);
    }

    // drift smoke — one shared system at the rear axle midpoint
    const smoke = new ParticleSystem('nlSmoke', 300, scene);
    smoke.particleTexture = puff;
    this._smokeEmitter = new Vector3(0, -10, 0);
    smoke.emitter = this._smokeEmitter;
    smoke.minLifeTime = 0.9;
    smoke.maxLifeTime = 1.8;
    smoke.minSize = 0.5;
    smoke.maxSize = 1.1;
    smoke.emitRate = 0;
    smoke.gravity = new Vector3(0, 0.6, 0);
    smoke.color1 = new Color4(0.30, 0.30, 0.33, 0.14);
    smoke.color2 = new Color4(0.38, 0.38, 0.41, 0.10);
    smoke.colorDead = new Color4(0.35, 0.35, 0.38, 0);
    smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    smoke.minEmitPower = 0.4;
    smoke.maxEmitPower = 1.4;
    smoke.updateSpeed = 1 / 90;
    this._smokeDir1 = new Vector3(0, 0.6, 0);
    this._smokeDir2 = new Vector3(0, 1.4, 0);
    smoke.direction1 = this._smokeDir1;
    smoke.direction2 = this._smokeDir2;
    smoke.minEmitBox = new Vector3(-0.7, 0, -0.5);
    smoke.maxEmitBox = new Vector3(0.7, 0.15, 0.5);
    smoke.start();
    this.smoke = smoke;
  }

  /**
   * @param {number} dt
   * @param {import('../vehicle/car.js').Car} car
   * @param {number} wetness effective road water at the car (0..1)
   */
  update(dt, car, wetness) {
    const sp = car.speed;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const wvx = car.vx * cy + car.vz * sy;
    const wvz = -car.vx * sy + car.vz * cy;

    // rear wheels are indices 2 (RL) and 3 (RR)
    for (let i = 0; i < 2; i++) {
      const wi = 2 + i;
      const ps = this.spray[i];
      const e = this._emitters[i];
      e.x = car.wheelContactX[wi];
      e.y = car.wheelGroundY[wi] + 0.06;
      e.z = car.wheelContactZ[wi];
      const wake = 0.5 + car.driftAmount * 1.6;
      const rate = sp > 5 && wetness > 0.18 ? sp * 26 * wetness * wake : 0;
      ps.emitRate = rate;
      // droplets: thrown back along travel + up + outward kick in drift
      const outSign = i === 0 ? -1 : 1;
      this._dir1[i].set(-wvx * 0.28 + cy * outSign * 0.4, 1.2 + sp * 0.05, -wvz * 0.28 - sy * outSign * 0.4);
      this._dir2[i].set(-wvx * 0.45 + cy * outSign * (1.0 + car.driftAmount * 1.6), 2.4 + sp * 0.09, -wvz * 0.45 - sy * outSign * (1.0 + car.driftAmount * 1.6));
      ps.direction1 = this._dir1[i];
      ps.direction2 = this._dir2[i];
    }

    // smoke: dry-ish drift only
    const se = this._smokeEmitter;
    se.x = car.position.x - sy * 1.31;
    se.y = car.position.y + 0.15;
    se.z = car.position.z - cy * 1.31;
    const dry = 1 - Math.min(1, wetness * 1.6);
    this.smoke.emitRate = car.driftAmount > 0.25 && sp > 8 ? car.driftAmount * dry * sp * 6 : 0;
  }
}
