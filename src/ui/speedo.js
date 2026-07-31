/**
 * Speedometer — analog dial + digital km/h, bottom right.
 *
 * The dial (ticks, labels, redline, needle) is built once as SVG at
 * construction. Per frame the needle eases toward the true speed with a
 * damped spring and only writes its transform when it actually moves;
 * the digital readout updates at 10 Hz when the rounded value changes.
 */
const MAX_KMH = 200;
const ANGLE_MIN = -120;          // needle angle at 0 km/h (deg, 0 = up)
const ANGLE_MAX = 120;           // needle angle at MAX_KMH
const REDLINE_KMH = 150;
const CX = 60, CY = 64, R_OUT = 54, R_IN = 47, R_LABEL = 38;

const NS = 'http://www.w3.org/2000/svg';

function angleFor(kmh) {
  const t = Math.min(1, Math.max(0, kmh / MAX_KMH));
  return ANGLE_MIN + (ANGLE_MAX - ANGLE_MIN) * t;
}

export class Speedo {
  constructor() {
    const host = document.getElementById('speedo');
    if (!host) { this._el = null; return; }

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');

    // tick marks: minor every 10 km/h, major every 50; warm past the redline
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const major = v % 50 === 0;
      const a = (angleFor(v) - 90) * (Math.PI / 180);
      const rIn = major ? R_IN - 3.5 : R_IN;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', (CX + Math.cos(a) * rIn).toFixed(2));
      line.setAttribute('y1', (CY + Math.sin(a) * rIn).toFixed(2));
      line.setAttribute('x2', (CX + Math.cos(a) * R_OUT).toFixed(2));
      line.setAttribute('y2', (CY + Math.sin(a) * R_OUT).toFixed(2));
      const hot = v > REDLINE_KMH;
      line.setAttribute('stroke', hot ? 'rgba(242,140,110,0.55)' : 'rgba(216,222,233,0.38)');
      line.setAttribute('stroke-width', major ? '2' : '0.8');
      svg.appendChild(line);
    }

    // major labels
    for (let v = 0; v <= MAX_KMH; v += 50) {
      const a = (angleFor(v) - 90) * (Math.PI / 180);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', (CX + Math.cos(a) * R_LABEL).toFixed(2));
      label.setAttribute('y', (CY + Math.sin(a) * R_LABEL + 2.4).toFixed(2));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '7');
      label.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
      label.setAttribute('fill', v > REDLINE_KMH ? 'rgba(242,140,110,0.5)' : 'rgba(216,222,233,0.42)');
      label.textContent = String(v);
      svg.appendChild(label);
    }

    // needle: warm, slim, with a short tail and hub
    const needle = document.createElementNS(NS, 'g');
    const blade = document.createElementNS(NS, 'path');
    blade.setAttribute('d', `M ${CX - 1.4} ${CY + 8} L ${CX} ${CY - R_IN + 4} L ${CX + 1.4} ${CY + 8} Z`);
    blade.setAttribute('fill', 'rgba(242,192,120,0.9)');
    needle.appendChild(blade);
    const hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('cx', CX); hub.setAttribute('cy', CY); hub.setAttribute('r', '3.2');
    hub.setAttribute('fill', 'rgba(216,222,233,0.65)');
    needle.appendChild(hub);
    svg.appendChild(needle);
    host.appendChild(svg);

    const kmhEl = document.createElement('div');
    kmhEl.className = 'kmh';
    kmhEl.textContent = '0';
    host.appendChild(kmhEl);
    const unitEl = document.createElement('div');
    unitEl.className = 'unit';
    unitEl.textContent = 'km/h';
    host.appendChild(unitEl);

    this._el = kmhEl;
    this._needle = needle;
    this._last = -1;
    this._nextAt = 0;
    this._angle = ANGLE_MIN;
    this._angleShown = 999;
    this._lastNow = 0;
    needle.setAttribute('transform', `rotate(${ANGLE_MIN} ${CX} ${CY})`);
  }

  /** @param {number} nowMs @param {number} speedMs speed in m/s */
  update(nowMs, speedMs) {
    if (!this._el) return;
    const dt = this._lastNow ? Math.min(0.1, (nowMs - this._lastNow) / 1000) : 0.016;
    this._lastNow = nowMs;
    const kmh = speedMs * 3.6;

    // damped needle: quick to rise, settles without wobble
    const target = angleFor(kmh);
    this._angle += (target - this._angle) * (1 - Math.exp(-9 * dt));
    if (Math.abs(this._angle - this._angleShown) > 0.08) {
      this._angleShown = this._angle;
      this._needle.setAttribute('transform', `rotate(${this._angle.toFixed(2)} ${CX} ${CY})`);
    }

    // digital readout at 10 Hz
    if (nowMs >= this._nextAt) {
      this._nextAt = nowMs + 100;
      const v = Math.round(kmh);
      if (v !== this._last) {
        this._last = v;
        this._el.textContent = String(v);
      }
    }
  }
}
