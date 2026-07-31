/**
 * The car. Arcade planar dynamics with a kinematic-bicycle core, lateral slip
 * for Glide, and per-wheel visual state. Visuals start as a placeholder box +
 * cylinders (M1) and are replaced by the real model in M4 — the dynamics and
 * the public interface (position, yaw, speed, driftAmount, wheel contacts)
 * persist.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { defineParam, params } from '../core/params.js';

defineParam('carTopSpeed', 36, { label: 'top speed m/s', section: 'car', min: 10, max: 60, step: 1 });
defineParam('carAccel', 9.5, { label: 'accel m/s²', section: 'car', min: 3, max: 20, step: 0.5 });
defineParam('carBrake', 14, { label: 'brake m/s²', section: 'car', min: 5, max: 25, step: 0.5 });
defineParam('carGrip', 9.0, { label: 'grip', section: 'car', min: 2, max: 20, step: 0.5 });
defineParam('carGlideGrip', 1.7, { label: 'glide grip', section: 'car', min: 0.3, max: 6, step: 0.1 });
defineParam('carSteerMax', 0.52, { label: 'steer max rad', section: 'car', min: 0.2, max: 0.9, step: 0.01 });
defineParam('carGlideYawGain', 1.35, { label: 'glide yaw gain', section: 'car', min: 0.5, max: 3, step: 0.05 });

const WHEELBASE = 2.62;      // m
const TRACK = 1.52;          // m
const WHEEL_R = 0.325;       // m

const DAMP = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Car {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    this.scene = scene;
    // ---- dynamic state ----
    this.position = new Vector3(0, 0, 0);
    this.yaw = 0;
    this.vx = 0;             // local lateral velocity (m/s, +right)
    this.vz = 0;             // local forward velocity (m/s)
    this.yawRate = 0;
    this.steerAngle = 0;
    this.speed = 0;
    this.localAccelZ = 0;
    this.lateralG = 0;
    /** 0..1, how deep into Glide we are (eased) */
    this.driftAmount = 0;
    /** angle between heading and travel direction (rad, signed) */
    this.slipYawOffset = 0;
    /** body attitude (visual) */
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this._prevVz = 0;

    // ---- wheel state (FL, FR, RL, RR) ----
    this.wheelSpin = new Float32Array(4);
    this.wheelContactX = new Float32Array(4);
    this.wheelContactZ = new Float32Array(4);
    this.wheelLoad = new Float32Array(4);

    this._buildPlaceholder(scene);
  }

  _buildPlaceholder(scene) {
    this.root = new TransformNode('carRoot', scene);
    this.root.rotationQuaternion = Quaternion.Identity();
    this._q = Quaternion.Identity();

    this.bodyNode = new TransformNode('carBody', scene);
    this.bodyNode.parent = this.root;
    this.bodyNode.rotationQuaternion = Quaternion.Identity();
    this._bq = Quaternion.Identity();

    const paint = new StandardMaterial('carPaint', scene);
    paint.diffuseColor = new Color3(0.16, 0.24, 0.26);
    paint.specularColor = new Color3(0.6, 0.65, 0.7);
    paint.specularPower = 128;

    const dark = new StandardMaterial('carDark', scene);
    dark.diffuseColor = new Color3(0.04, 0.04, 0.045);
    dark.specularColor = new Color3(0.08, 0.08, 0.08);

    const body = MeshBuilder.CreateBox('carBox', { width: 1.78, height: 0.62, depth: 4.35 }, scene);
    body.material = paint;
    body.parent = this.bodyNode;
    body.position.y = 0.62;
    const cabin = MeshBuilder.CreateBox('carCabin', { width: 1.58, height: 0.5, depth: 2.0 }, scene);
    cabin.material = dark;
    cabin.parent = this.bodyNode;
    cabin.position.set(0, 1.12, -0.25);

    this.wheelMeshes = [];
    const wheelMat = dark;
    for (let i = 0; i < 4; i++) {
      const w = MeshBuilder.CreateCylinder(`wheel${i}`, { diameter: WHEEL_R * 2, height: 0.26, tessellation: 24 }, scene);
      w.rotation.z = Math.PI / 2;
      const pivot = new TransformNode(`wheelPivot${i}`, scene);
      pivot.parent = this.root;
      const fx = i < 2 ? 1 : -1;               // front/rear
      const sx = (i % 2 === 0 ? -1 : 1);       // left/right
      pivot.position.set(sx * TRACK * 0.5, WHEEL_R, fx * WHEELBASE * 0.5);
      w.parent = pivot;
      w.material = wheelMat;
      this.wheelMeshes.push({ pivot, mesh: w });
    }
  }

  /**
   * @param {number} dt
   * @param {import('../core/input.js').Input} input
   * @param {(x:number,z:number)=>number} groundHeight
   */
  update(dt, input, groundHeight) {
    // ---- steering ----
    const speedFade = 1 / (1 + Math.abs(this.vz) * 0.045);
    const steerTarget = input.steer * params.carSteerMax * speedFade;
    this.steerAngle += (steerTarget - this.steerAngle) * DAMP(8, dt);

    // ---- glide state eases in/out ----
    const glideTarget = input.rmb && Math.abs(this.vz) > 6 ? 1 : 0;
    this.driftAmount += (glideTarget - this.driftAmount) * DAMP(glideTarget ? 3.2 : 2.2, dt);

    // ---- longitudinal ----
    let az = 0;
    const topSpeed = params.carTopSpeed;
    if (input.throttle > 0) az += params.carAccel * (1 - Math.max(0, this.vz) / topSpeed);
    if (input.brake > 0) {
      if (this.vz > 0.5) az -= params.carBrake;
      else az -= params.carAccel * 0.55; // reverse
    }
    // rolling drag
    az -= this.vz * 0.045 + Math.sign(this.vz) * 0.35;
    this.vz += az * dt;
    if (Math.abs(this.vz) < 0.15 && input.throttle === 0 && input.brake === 0) this.vz = 0;

    // ---- yaw: kinematic bicycle blended with drift dynamics ----
    const kinYawRate = (this.vz / WHEELBASE) * Math.tan(this.steerAngle);
    const driftYawRate = kinYawRate * params.carGlideYawGain;
    const targetYawRate = kinYawRate + (driftYawRate - kinYawRate) * this.driftAmount;
    this.yawRate += (targetYawRate - this.yawRate) * DAMP(6 - this.driftAmount * 2.5, dt);
    this.yaw += this.yawRate * dt;

    // ---- lateral slip ----
    // yaw rotation transfers forward velocity into lateral (body frame rotates under the velocity vector)
    this.vx += -this.yawRate * this.vz * dt * (0.25 + this.driftAmount * 0.75);
    const grip = params.carGrip + (params.carGlideGrip - params.carGrip) * this.driftAmount;
    const vxDecay = this.vx * DAMP(grip, dt);
    this.vx -= vxDecay;
    this.lateralG = (vxDecay / dt || 0) / 9.81;
    if (this.lateralG > 3) this.lateralG = 3;
    if (this.lateralG < -3) this.lateralG = -3;

    // ---- integrate world position ----
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const wvx = this.vx * cy + this.vz * sy;
    const wvz = -this.vx * sy + this.vz * cy;
    this.position.x += wvx * dt;
    this.position.z += wvz * dt;
    this.position.y = groundHeight(this.position.x, this.position.z);

    this.speed = Math.hypot(this.vx, this.vz);
    this.slipYawOffset = this.speed > 2 ? Math.atan2(this.vx, Math.abs(this.vz)) : 0;
    this.localAccelZ = (this.vz - this._prevVz) / (dt || 1);
    this._prevVz = this.vz;

    // ---- body attitude (visual) ----
    const pitchT = -this.localAccelZ * 0.0055;
    const rollT = this.lateralG * 0.03 + this.vx * 0.006;
    this.bodyPitch += (pitchT - this.bodyPitch) * DAMP(5, dt);
    this.bodyRoll += (rollT - this.bodyRoll) * DAMP(5, dt);

    // ---- apply transforms ----
    this.root.position.copyFrom(this.position);
    Quaternion.RotationYawPitchRollToRef(this.yaw, 0, 0, this._q);
    this.root.rotationQuaternion.copyFrom(this._q);
    Quaternion.RotationYawPitchRollToRef(0, this.bodyPitch, this.bodyRoll, this._bq);
    this.bodyNode.rotationQuaternion.copyFrom(this._bq);

    // ---- wheels ----
    const spinRate = this.vz / WHEEL_R;
    for (let i = 0; i < 4; i++) {
      this.wheelSpin[i] += spinRate * dt;
      const wm = this.wheelMeshes[i];
      wm.mesh.rotation.x = this.wheelSpin[i];
      if (i < 2) wm.pivot.rotation.y = this.steerAngle;
      // world contact positions for the surface state system (M3)
      const lx = (i % 2 === 0 ? -1 : 1) * TRACK * 0.5;
      const lz = (i < 2 ? 1 : -1) * WHEELBASE * 0.5;
      this.wheelContactX[i] = this.position.x + lx * cy + lz * sy;
      this.wheelContactZ[i] = this.position.z - lx * sy + lz * cy;
      this.wheelLoad[i] = 0.25;
    }
  }
}
