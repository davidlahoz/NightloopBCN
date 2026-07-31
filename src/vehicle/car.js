/**
 * The car. Arcade planar dynamics + per-wheel visual suspension.
 *
 * Dynamics: kinematic-bicycle core with lateral slip (Glide eases rear grip).
 * Suspension: each wheel follows the road heightfield; the sprung body reacts
 * with a damped spring in heave/pitch/roll, plus acceleration lean. Wheels
 * roll from ground speed and steer with Ackermann geometry.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { defineParam, params } from '../core/params.js';
import { sampleRoadSpace } from '../city/cityPlan.js';
import { buildCarBody } from './carBody.js';
import { buildWheel } from './carWheels.js';
import { CarMaterials } from './carMaterials.js';

defineParam('carTopSpeed', 36, { label: 'top speed m/s', section: 'car', min: 10, max: 60, step: 1 });
defineParam('carAccel', 9.5, { label: 'accel m/s²', section: 'car', min: 3, max: 20, step: 0.5 });
defineParam('carBrake', 14, { label: 'brake m/s²', section: 'car', min: 5, max: 25, step: 0.5 });
defineParam('carGrip', 9.0, { label: 'grip', section: 'car', min: 2, max: 20, step: 0.5 });
defineParam('carGlideGrip', 1.7, { label: 'glide grip', section: 'car', min: 0.3, max: 6, step: 0.1 });
defineParam('carSteerMax', 0.52, { label: 'steer max rad', section: 'car', min: 0.2, max: 0.9, step: 0.01 });
defineParam('carGlideYawGain', 1.35, { label: 'glide yaw gain', section: 'car', min: 0.5, max: 3, step: 0.05 });

const WHEELBASE = 2.62;
const TRACK = 1.56;   // slightly wider than spec: plants the tyres flush with the fenders
const WHEEL_R = 0.325;

const DAMP = (rate, dt) => 1 - Math.exp(-rate * dt);
const CURB_MARGIN = 0.92;   // keep the body this far inside the curb face
const _crs = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };
const _crs2 = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };

export class Car {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    this.scene = scene;
    // ---- dynamic state ----
    this.position = new Vector3(0, 0, 0);
    this.yaw = 0;
    this.vx = 0;
    this.vz = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.speed = 0;
    this.localAccelZ = 0;
    this.lateralG = 0;
    this.driftAmount = 0;
    this.slipYawOffset = 0;
    this.braking = false;
    /** mouse-carved steering bias while gliding (rad) */
    this.carve = 0;

    // sprung body spring state (heave m, pitch rad, roll rad)
    this._heave = 0; this._heaveV = 0;
    this._pitch = 0; this._pitchV = 0;
    this._roll = 0; this._rollV = 0;
    this._prevVz = 0;
    this._prevVx = 0;

    // ---- wheel state (FL, FR, RL, RR) ----
    this.wheelSpin = new Float32Array(4);
    this.wheelContactX = new Float32Array(4);
    this.wheelContactZ = new Float32Array(4);
    this.wheelGroundY = new Float32Array(4);
    this.wheelLoad = new Float32Array(4);
    this.wheelSteer = new Float32Array(2); // FL, FR (Ackermann)

    this.materials = new CarMaterials(scene);
    this._build(scene);
  }

  _build(scene) {
    this.root = new TransformNode('carRoot', scene);
    this.root.rotationQuaternion = Quaternion.Identity();
    this._q = Quaternion.Identity();

    this.bodyNode = new TransformNode('carBody', scene);
    this.bodyNode.parent = this.root;
    this.bodyNode.rotationQuaternion = Quaternion.Identity();
    this._bq = Quaternion.Identity();

    const m = this.materials;
    const parts = buildCarBody(scene);
    this.dims = parts.dims;
    parts.body.material = m.paint;
    parts.mirrors.material = m.paint;
    parts.glass.material = m.glass;
    parts.trim.material = m.trim;
    parts.liners.material = m.liner;
    parts.lightsFront.material = m.frontLight;
    parts.lightsRear.material = m.rearLight;
    for (const key of ['body', 'glass', 'trim', 'liners', 'lightsFront', 'lightsRear', 'mirrors']) {
      const mesh = parts[key];
      mesh.parent = this.bodyNode;
      mesh.isPickable = false;
    }
    this.bodyMeshes = parts;

    // soft contact-shadow blob — cheap AO that keeps the car grounded even
    // when the whole street is in building shadow
    {
      const S = 128;
      const tex = new DynamicTexture('nlCarAO', { width: S, height: S }, scene, true);
      const ctx = tex.getContext();
      const img = ctx.createImageData(S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
          // rounded-rect falloff matching the car footprint
          const rx = Math.max(0, Math.abs(dx) - 0.60) / 0.40;
          const ry = Math.max(0, Math.abs(dy) - 0.52) / 0.48;
          const d = Math.sqrt(rx * rx + ry * ry);
          const a = Math.max(0, 1 - d) ** 2 * 195;
          const i = (y * S + x) * 4;
          img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = a | 0;
        }
      }
      ctx.putImageData(img, 0, 0);
      tex.update(false);
      tex.hasAlpha = true;
      const blobMat = new StandardMaterial('nlCarAOMat', scene);
      blobMat.diffuseTexture = tex;
      blobMat.diffuseColor = new Color3(0, 0, 0);
      blobMat.emissiveColor = new Color3(0, 0, 0);
      blobMat.specularColor = new Color3(0, 0, 0);
      blobMat.opacityTexture = tex;
      blobMat.disableLighting = true;
      const blob = MeshBuilder.CreateGround('carAOBlob', { width: 4.9, height: 2.35 }, scene);
      blob.rotation.y = Math.PI / 2;
      blob.bakeCurrentTransformIntoVertices();
      blob.material = blobMat;
      blob.parent = this.root;
      blob.position.y = 0.03;
      blob.isPickable = false;
      blob.metadata = { nlNoShadow: true, nlNoMirror: true };
    }

    // ---- wheels ----
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0;
      const w = buildWheel(scene, left ? 1 : -1);
      const pivot = new TransformNode(`wheelPivot${i}`, scene);
      pivot.parent = this.root;
      const wx = (left ? -1 : 1) * (TRACK * 0.5);
      const wz = (i < 2 ? 1 : -1) * (WHEELBASE * 0.5);
      pivot.position.set(wx, WHEEL_R, wz);
      // spin node rotates around the axle; brake stays fixed to the pivot
      const spin = new TransformNode(`wheelSpin${i}`, scene);
      spin.parent = pivot;
      w.tire.parent = spin;
      w.rim.parent = spin;
      w.brake.parent = pivot;
      if (!left) {
        // right side: face outward
        w.root.rotation.y = Math.PI;
        spin.rotation.y = Math.PI;
        w.brake.rotation.y = Math.PI;
      }
      w.tire.material = this.materials.tire;
      w.rim.material = this.materials.rim;
      w.brake.material = this.materials.brake;
      w.tire.isPickable = w.rim.isPickable = w.brake.isPickable = false;
      w.root.dispose ? null : null;
      this.wheels.push({ pivot, spin });
    }
  }

  /**
   * @param {number} dt
   * @param {import('../core/input.js').Input} input
   * @param {(x:number,z:number)=>number} groundHeight
   */
  update(dt, input, groundHeight) {
    // ---- steering (mouse carves the line while gliding) ----
    if (input.gliding) this.carve += input.mouseDX * 0.0011;
    this.carve -= this.carve * DAMP(input.gliding ? 1.1 : 6.0, dt);
    if (this.carve > 0.55) this.carve = 0.55;
    if (this.carve < -0.55) this.carve = -0.55;
    const speedFade = 1 / (1 + Math.abs(this.vz) * 0.045);
    // gliding softens keyboard lock into a wide, committed arc
    const kbScale = 1 - this.driftAmount * 0.55;
    const steerTarget = (input.steer * params.carSteerMax * kbScale + this.carve) * speedFade;
    this.steerAngle += (steerTarget - this.steerAngle) * DAMP(8, dt);

    // ---- glide state eases in/out ----
    const glideTarget = input.gliding && Math.abs(this.vz) > 6 ? 1 : 0;
    this.driftAmount += (glideTarget - this.driftAmount) * DAMP(glideTarget ? 3.2 : 2.2, dt);

    // ---- longitudinal ----
    let az = 0;
    const topSpeed = params.carTopSpeed;
    this.braking = false;
    if (input.throttle > 0) az += params.carAccel * (1 - Math.max(0, this.vz) / topSpeed);
    if (input.brake > 0) {
      if (this.vz > 0.5) { az -= params.carBrake; this.braking = true; }
      else az -= params.carAccel * 0.55;
    }
    az -= this.vz * 0.045 + Math.sign(this.vz) * 0.35;
    // drift scrub: sliding sideways bleeds speed (weighty, not floaty)
    az -= Math.abs(this.vx) * 0.15 * this.driftAmount;
    this.vz += az * dt;
    if (Math.abs(this.vz) < 0.15 && input.throttle === 0 && input.brake === 0) this.vz = 0;

    // ---- yaw ----
    const kinYawRate = (this.vz / WHEELBASE) * Math.tan(this.steerAngle);
    const driftYawRate = kinYawRate * params.carGlideYawGain;
    const targetYawRate = kinYawRate + (driftYawRate - kinYawRate) * this.driftAmount;
    this.yawRate += (targetYawRate - this.yawRate) * DAMP(6 - this.driftAmount * 2.5, dt);
    this.yaw += this.yawRate * dt;

    // ---- lateral slip ----
    // slip source fades as the angle builds (the rear can only step out so far)
    const slipNow = this.speed > 2 ? Math.atan2(Math.abs(this.vx), Math.abs(this.vz) + 0.5) : 0;
    const sourceFade = Math.max(0, 1 - slipNow / 0.82);
    this.vx += -this.yawRate * this.vz * dt * (0.25 + this.driftAmount * 0.75) * sourceFade;
    // tyres saturate: past ~26° of slip the grip climbs steeply back
    const satBoost = 1 + Math.max(0, slipNow - 0.45) * 7.0;
    const grip = (params.carGrip + (params.carGlideGrip - params.carGrip) * this.driftAmount) * satBoost;
    const vxDecay = this.vx * DAMP(grip, dt);
    this.vx -= vxDecay;
    this.lateralG = (vxDecay / dt || 0) / 9.81;
    if (this.lateralG > 3) this.lateralG = 3;
    if (this.lateralG < -3) this.lateralG = -3;

    // ---- integrate world position ----
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    let wvx = this.vx * cy + this.vz * sy;
    let wvz = -this.vx * sy + this.vz * cy;
    this.position.x += wvx * dt;
    this.position.z += wvz * dt;

    // ---- curb containment: the street is fenced by real curbs ----
    this.curbBump = 0;
    sampleRoadSpace(this.position.x, this.position.z, _crs);
    if (_crs.d > -CURB_MARGIN) {
      const e = 0.06;
      sampleRoadSpace(this.position.x + e, this.position.z, _crs2); const dx1 = _crs2.d;
      sampleRoadSpace(this.position.x - e, this.position.z, _crs2); const dx0 = _crs2.d;
      sampleRoadSpace(this.position.x, this.position.z + e, _crs2); const dz1 = _crs2.d;
      sampleRoadSpace(this.position.x, this.position.z - e, _crs2); const dz0 = _crs2.d;
      let gx = (dx1 - dx0) / (2 * e), gz = (dz1 - dz0) / (2 * e);
      const gl = Math.hypot(gx, gz);
      if (gl > 1e-4) {
        gx /= gl; gz /= gl;
        const pen = _crs.d + CURB_MARGIN;
        this.position.x -= gx * pen;
        this.position.z -= gz * pen;
        const outward = wvx * gx + wvz * gz;
        if (outward > 0) {
          // kill outward velocity with a slightly springy rebound + scrub
          wvx -= outward * 1.35 * gx;
          wvz -= outward * 1.35 * gz;
          this.vx = wvx * cy - wvz * sy;
          this.vz = wvx * sy + wvz * cy;
          this.vz *= 0.985;
          this.curbBump = Math.min(1, outward * 0.18);
        }
      }
    }

    this.speed = Math.hypot(this.vx, this.vz);
    this.slipYawOffset = this.speed > 2 ? Math.atan2(this.vx, Math.abs(this.vz)) : 0;
    // forgiving: past ~30° of slip the rear catches — no surprise spins
    if (this.driftAmount > 0.2) {
      const overshoot = Math.abs(this.slipYawOffset) - 0.52;
      if (overshoot > 0) this.yawRate -= Math.sign(this.slipYawOffset) * overshoot * 3.0 * dt * this.driftAmount * 10;
    }
    this.localAccelZ = (this.vz - this._prevVz) / (dt || 1);
    const latAccel = (this.vx - this._prevVx) / (dt || 1);
    this._prevVz = this.vz;
    this._prevVx = this.vx;

    // ---- wheel contacts + Ackermann ----
    // Ackermann: inner wheel steers tighter
    if (Math.abs(this.steerAngle) > 1e-4) {
      const R = WHEELBASE / Math.tan(Math.abs(this.steerAngle));
      const inner = Math.atan(WHEELBASE / (R - TRACK * 0.5));
      const outer = Math.atan(WHEELBASE / (R + TRACK * 0.5));
      if (this.steerAngle > 0) { // steering right; FR inner
        this.wheelSteer[0] = outer; this.wheelSteer[1] = inner;
      } else {
        this.wheelSteer[0] = -inner; this.wheelSteer[1] = -outer;
      }
    } else {
      this.wheelSteer[0] = this.wheelSteer[1] = 0;
    }

    let gSum = 0;
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0;
      const lx = (left ? -1 : 1) * TRACK * 0.5;
      const lz = (i < 2 ? 1 : -1) * WHEELBASE * 0.5;
      const wx = this.position.x + lx * cy + lz * sy;
      const wz = this.position.z - lx * sy + lz * cy;
      this.wheelContactX[i] = wx;
      this.wheelContactZ[i] = wz;
      const gy = groundHeight(wx, wz);
      this.wheelGroundY[i] = gy;
      gSum += gy;
      this.wheelLoad[i] = 0.25;
    }
    const gAvg = gSum * 0.25;
    this.position.y = gAvg;

    // ---- sprung body: heave/pitch/roll springs ----
    const frontAvg = (this.wheelGroundY[0] + this.wheelGroundY[1]) * 0.5;
    const rearAvg = (this.wheelGroundY[2] + this.wheelGroundY[3]) * 0.5;
    const leftAvg = (this.wheelGroundY[0] + this.wheelGroundY[2]) * 0.5;
    const rightAvg = (this.wheelGroundY[1] + this.wheelGroundY[3]) * 0.5;
    // terrain-driven targets + acceleration lean
    const pitchT = Math.atan2(rearAvg - frontAvg, WHEELBASE) + this.localAccelZ * 0.006;
    const rollT = Math.atan2(rightAvg - leftAvg, TRACK) * -1 + (this.lateralG * 0.030 + this.vx * 0.006);
    const heaveT = 0;
    const K = 55, C = 9.5;
    this._heaveV += ((heaveT - this._heave) * K - this._heaveV * C) * dt;
    this._heave += this._heaveV * dt;
    this._pitchV += ((pitchT - this._pitch) * K - this._pitchV * C) * dt;
    this._pitch += this._pitchV * dt;
    this._rollV += ((rollT - this._roll) * K - this._rollV * C) * dt;
    this._roll += this._rollV * dt;

    // ---- apply transforms ----
    this.root.position.copyFrom(this.position);
    Quaternion.RotationYawPitchRollToRef(this.yaw, 0, 0, this._q);
    this.root.rotationQuaternion.copyFrom(this._q);
    this.bodyNode.position.y = this._heave;
    Quaternion.RotationYawPitchRollToRef(0, this._pitch, this._roll, this._bq);
    this.bodyNode.rotationQuaternion.copyFrom(this._bq);

    // ---- wheels: plant on ground, spin, steer ----
    const spinRate = this.vz / WHEEL_R;
    this.materials.setBrake(this.braking);
    for (let i = 0; i < 4; i++) {
      this.wheelSpin[i] += spinRate * dt;
      const w = this.wheels[i];
      // wheel centre follows its own contact height relative to the root
      w.pivot.position.y = (this.wheelGroundY[i] - gAvg) + WHEEL_R;
      if (i < 2) w.pivot.rotation.y = this.wheelSteer[i];
      const left = i % 2 === 0;
      w.spin.rotation.x = left ? this.wheelSpin[i] : -this.wheelSpin[i];
    }
  }
}
