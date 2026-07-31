/**
 * Spring-arm chase camera with velocity-aware behaviour, free mouse orbit,
 * eased scroll zoom, speed-driven FOV, drift banking, and an alternate
 * bumper view (toggled with C). Zero allocations per frame.
 */
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera.js';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { defineParam, params } from '../core/params.js';

defineParam('camDist', 5.6, { label: 'distance', section: 'camera', min: 3, max: 12, step: 0.1 });
defineParam('camHeight', 1.85, { label: 'height', section: 'camera', min: 0.5, max: 5, step: 0.05 });
defineParam('camFov', 52, { label: 'fov base °', section: 'camera', min: 35, max: 80, step: 1 });
defineParam('camFovSpeed', 14, { label: 'fov speed gain °', section: 'camera', min: 0, max: 25, step: 1 });
defineParam('camLag', 0.09, { label: 'accel lag', section: 'camera', min: 0, max: 0.3, step: 0.005 });
defineParam('camBank', 2.6, { label: 'drift bank °', section: 'camera', min: 0, max: 8, step: 0.1 });
defineParam('camStiff', 7.5, { label: 'stiffness', section: 'camera', min: 2, max: 20, step: 0.5 });
defineParam('camSideOffset', 0.42, { label: 'side offset', section: 'camera', min: -1, max: 1, step: 0.02 });
defineParam('camShake', 1.0, { label: 'shake amount', section: 'camera', min: 0, max: 2, step: 0.05 });

const _desired = new Vector3();
const _target = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3(0, 1, 0);
const _view = new Vector3();
const _rotM = new Matrix();

const DAMP = (rate, dt) => 1 - Math.exp(-rate * dt);

export class ChaseCamera {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    this.cam = new TargetCamera('chase', new Vector3(0, 3, -8), scene);
    this.cam.minZ = 0.3;
    this.cam.maxZ = 2000;
    this.cam.fov = (params.camFov * Math.PI) / 180;
    scene.activeCamera = this.cam;

    this.mode = 0;               // 0 = chase, 1 = bumper
    this.orbitYaw = 0;           // mouse orbit offsets (rad)
    this.orbitPitch = 0;
    this._orbitIdle = 0;         // seconds since last mouse move
    this.zoom = 0.45;            // 0..1 across zoom range
    this._zoomTarget = 0.45;
    this._smoothFov = this.cam.fov;
    this._roll = 0;
    this._armStretch = 0;
    this._pos = new Vector3(0, 3, -8);
    this._look = new Vector3();
    this._shakeT = 0;
    this._followYaw = 0;
    /** external systems can add shake energy (0..1) */
    this.shakeEnergy = 0;
  }

  /**
   * @param {number} dt
   * @param {import('../vehicle/car.js').Car} car
   * @param {import('../core/input.js').Input} input
   * @param {(x:number,z:number)=>number} groundHeight clearance query
   */
  update(dt, car, input, groundHeight) {
    if (input.toggleCamera) this.mode = this.mode ^ 1;

    // ---- zoom (scroll) ----
    if (input.wheel !== 0) {
      this._zoomTarget += input.wheel * 0.0008;
      this._zoomTarget = this._zoomTarget < 0 ? 0 : this._zoomTarget > 1 ? 1 : this._zoomTarget;
    }
    this.zoom += (this._zoomTarget - this.zoom) * DAMP(6, dt);

    // ---- mouse orbit (the mouse carves the car's line during Glide) ----
    if (!input.rmb && (input.mouseDX !== 0 || input.mouseDY !== 0)) {
      this.orbitYaw += input.mouseDX * 0.0032;
      this.orbitPitch += input.mouseDY * 0.0022;
      const pLim = 0.55;
      if (this.orbitPitch > pLim) this.orbitPitch = pLim;
      if (this.orbitPitch < -0.35) this.orbitPitch = -0.35;
      this._orbitIdle = 0;
    } else {
      this._orbitIdle += dt;
    }
    // recentre while driving after a moment of mouse inactivity
    const speed = car.speed;
    if (this._orbitIdle > 1.2 && speed > 3) {
      const rc = DAMP(1.8, dt);
      this.orbitYaw -= this.orbitYaw * rc;
      this.orbitPitch -= this.orbitPitch * rc;
    }

    // ---- follow yaw: car yaw blended toward travel direction in drift ----
    let targetYaw = car.yaw + car.driftAmount * car.slipYawOffset * 0.55;
    // shortest-arc blend of followYaw toward targetYaw
    let dy = targetYaw - this._followYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this._followYaw += dy * DAMP(params.camStiff, dt);

    if (this.mode === 1) {
      this._updateBumper(dt, car);
      return;
    }

    // ---- desired position ----
    const dist = (params.camDist + this.zoom * 5.5) * (1 + this._armStretch);
    const height = params.camHeight + this.zoom * 1.3;

    // arm stretch from longitudinal acceleration (lag behind on throttle)
    const stretchTarget = car.localAccelZ * params.camLag * 0.1;
    this._armStretch += (stretchTarget - this._armStretch) * DAMP(3.5, dt);

    const yaw = this._followYaw + this.orbitYaw;
    const pitch = 0.16 + this.orbitPitch + this.zoom * 0.1;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    // behind the car (car forward is +Z in local space at yaw)
    _fwd.set(sy, 0, cy);
    _right.set(cy, 0, -sy);
    _desired.copyFrom(car.position);
    _desired.x -= _fwd.x * dist * cp;
    _desired.z -= _fwd.z * dist * cp;
    _desired.y += height + dist * sp * 0.55;
    _desired.x += _right.x * params.camSideOffset;
    _desired.z += _right.z * params.camSideOffset;

    // never below ground
    const gy = groundHeight(_desired.x, _desired.z) + 0.35;
    if (_desired.y < gy) _desired.y = gy;

    // ---- smooth position ----
    const k = DAMP(params.camStiff * 1.4, dt);
    this._pos.x += (_desired.x - this._pos.x) * k;
    this._pos.y += (_desired.y - this._pos.y) * (k * 0.8);
    this._pos.z += (_desired.z - this._pos.z) * k;

    // ---- look target: ahead of the car ----
    _target.copyFrom(car.position);
    _target.x += _fwd.x * 3.0;
    _target.z += _fwd.z * 3.0;
    _target.y += 0.9;
    const lk = DAMP(params.camStiff * 1.8, dt);
    this._look.x += (_target.x - this._look.x) * lk;
    this._look.y += (_target.y - this._look.y) * lk;
    this._look.z += (_target.z - this._look.z) * lk;

    // ---- shake ----
    this._shakeT += dt * (8 + speed * 0.6);
    const shakeAmp = this.shakeEnergy * params.camShake * 0.02;
    const shx = Math.sin(this._shakeT * 2.17) * shakeAmp;
    const shy = Math.sin(this._shakeT * 3.31 + 1.3) * shakeAmp * 0.7;

    this.cam.position.set(this._pos.x + shx, this._pos.y + shy, this._pos.z);
    this.cam.setTarget(this._look);

    // ---- roll (bank into drift) ----
    const rollTarget = (-car.lateralG * params.camBank * Math.PI) / 180;
    this._roll += (rollTarget - this._roll) * DAMP(3, dt);
    this._applyRoll();

    // ---- fov ----
    const speedT = speed / 38;
    const fovT = (params.camFov + params.camFovSpeed * (speedT > 1 ? 1 : speedT) * speedT + car.driftAmount * 5.5) * (Math.PI / 180);
    this._smoothFov += (fovT - this._smoothFov) * DAMP(2.5, dt);
    this.cam.fov = this._smoothFov;

    // decay externally-fed shake
    this.shakeEnergy -= this.shakeEnergy * DAMP(4, dt);
  }

  _updateBumper(dt, car) {
    // low, fixed to the body, flatters the road shader
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    _desired.copyFrom(car.position);
    _desired.x += sy * 1.9;
    _desired.z += cy * 1.9;
    _desired.y += 0.55;
    const k = DAMP(30, dt);
    this._pos.x += (_desired.x - this._pos.x) * k;
    this._pos.y += (_desired.y - this._pos.y) * k;
    this._pos.z += (_desired.z - this._pos.z) * k;
    this.cam.position.copyFrom(this._pos);
    _target.copyFrom(this._pos);
    _target.x += sy * 10;
    _target.z += cy * 10;
    _target.y += 0.12;
    this.cam.setTarget(_target);
    const fovT = (params.camFov + 8) * (Math.PI / 180);
    this._smoothFov += (fovT - this._smoothFov) * DAMP(4, dt);
    this.cam.fov = this._smoothFov;
    this._roll += (0 - this._roll) * DAMP(3, dt);
    this._applyRoll();
  }

  _applyRoll() {
    if (Math.abs(this._roll) < 1e-4) {
      this.cam.upVector.set(0, 1, 0);
      return;
    }
    // rotate up vector around the view direction
    _view.copyFrom(this._look).subtractInPlace(this.cam.position).normalize();
    Matrix.RotationAxisToRef(_view, this._roll, _rotM);
    Vector3.TransformNormalToRef(_up, _rotM, this.cam.upVector);
  }
}
