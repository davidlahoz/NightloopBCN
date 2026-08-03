/**
 * Minimap — top-right canvas overlay. North-up view of the street plan around
 * the car: normal streets as thin strokes, motorways accented and heavier,
 * the car as a heading arrow pinned at the centre. Streets are sampled
 * through gridToWorld so the map shows the same warped curves you drive.
 * Redraws at ~6 Hz; a full redraw is a few hundred gridToWorld calls.
 */
import {
  PERIOD_X, PERIOD_Z, rowFace, rowIsMotorway, gridToWorld,
  districtOf, DISTRICT_COUNTRYSIDE, nsSegPresent,
} from '../city/cityPlan.js';

const RANGE = 260;          // metres of world shown from centre to edge
const REDRAW_MS = 160;
const SAMPLE_STEP = 26;     // metres between polyline samples

const _gw = { x: 0, z: 0 };

export class Minimap {
  constructor() {
    const c = document.createElement('canvas');
    c.id = 'minimap';
    document.body.appendChild(c);
    this._canvas = c;
    this._ctx = c.getContext('2d');
    this._last = 0;
    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    this._size = 0;
  }

  _fit() {
    const cssSize = this._canvas.clientWidth;
    const px = Math.round(cssSize * this._dpr);
    if (px === this._size || px === 0) return;
    this._size = px;
    this._canvas.width = px;
    this._canvas.height = px;
  }

  update(nowMs, car) {
    if (nowMs - this._last < REDRAW_MS) return;
    this._last = nowMs;
    this._fit();
    const S = this._size;
    if (S === 0) return;
    const ctx = this._ctx;
    const half = S / 2;
    const scale = half / RANGE;
    const cx = car.position.x, cz = car.position.z;

    ctx.clearRect(0, 0, S, S);

    // panel + circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 12, 18, 0.55)';
    ctx.fill();
    ctx.clip();

    const px = (wx) => half + (wx - cx) * scale;
    const py = (wz) => half - (wz - cz) * scale;

    // countryside blocks: faint green fill so the fields read on the map
    const bi0 = Math.floor((cx - RANGE) / PERIOD_X), bi1 = Math.floor((cx + RANGE) / PERIOD_X);
    const bj0 = Math.floor((cz - RANGE) / PERIOD_Z), bj1 = Math.floor((cz + RANGE) / PERIOD_Z);
    ctx.fillStyle = 'rgba(96, 140, 72, 0.10)';
    for (let i = bi0; i <= bi1; i++) {
      for (let j = bj0; j <= bj1; j++) {
        if (districtOf(i, j) !== DISTRICT_COUNTRYSIDE) continue;
        ctx.fillRect(px(i * PERIOD_X), py((j + 1) * PERIOD_Z),
          PERIOD_X * scale, PERIOD_Z * scale);
      }
    }

    // street polylines through the warp (s0..s1 in grid space along the line)
    const stroke = (line, axis, mway, s0, s1) => {
      ctx.beginPath();
      const n = Math.max(2, Math.ceil((s1 - s0) / SAMPLE_STEP));
      for (let k = 0; k <= n; k++) {
        const s = s0 + (s1 - s0) * (k / n);
        gridToWorld(axis === 0 ? line * PERIOD_X : s, axis === 0 ? s : line * PERIOD_Z, _gw);
        const x = px(_gw.x), y = py(_gw.z);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (mway) {
        ctx.strokeStyle = 'rgba(242, 192, 120, 0.75)';
        ctx.lineWidth = Math.max(2.5, 2 * rowFace(line) * scale * 0.5);
      } else {
        ctx.strokeStyle = 'rgba(216, 222, 233, 0.38)';
        ctx.lineWidth = Math.max(1.2, 9 * scale);
      }
      ctx.stroke();
    };
    // N-S streets: draw per row-cell, skipping thinned-away segments
    const i0 = Math.round((cx - RANGE) / PERIOD_X), i1 = Math.round((cx + RANGE) / PERIOD_X);
    const jc0 = Math.floor((cz - RANGE) / PERIOD_Z), jc1 = Math.floor((cz + RANGE) / PERIOD_Z);
    for (let i = i0; i <= i1; i++) {
      for (let jc = jc0; jc <= jc1; jc++) {
        if (!nsSegPresent(i, jc)) continue;
        stroke(i, 0, false, jc * PERIOD_Z, (jc + 1) * PERIOD_Z);
      }
    }
    const j0 = Math.round((cz - RANGE) / PERIOD_Z), j1 = Math.round((cz + RANGE) / PERIOD_Z);
    for (let j = j0; j <= j1; j++) stroke(j, 1, rowIsMotorway(j), cx - RANGE, cx + RANGE);

    // car: heading arrow at centre (north-up map; forward = (sin yaw, cos yaw))
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(car.yaw);
    const a = Math.max(5, S * 0.028);
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.35);
    ctx.lineTo(a * 0.85, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a * 0.85, a);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 3;
    ctx.fill();
    ctx.restore();

    // N tick
    ctx.fillStyle = 'rgba(216, 222, 233, 0.6)';
    ctx.font = `${Math.max(9, S * 0.055)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('N', half, Math.max(12, S * 0.085));

    ctx.restore();

    // rim
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(216, 222, 233, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
