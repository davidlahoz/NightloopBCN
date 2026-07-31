/**
 * Speedometer — km/h bottom right. DOM updates are throttled to 10 Hz and
 * only touch the node when the rounded value actually changes, so the render
 * loop stays allocation-quiet.
 */
export class Speedo {
  constructor() {
    this._el = document.getElementById('speedo-value');
    this._last = -1;
    this._nextAt = 0;
  }

  /** @param {number} nowMs @param {number} speedMs speed in m/s */
  update(nowMs, speedMs) {
    if (!this._el || nowMs < this._nextAt) return;
    this._nextAt = nowMs + 100;
    const kmh = Math.round(speedMs * 3.6);
    if (kmh !== this._last) {
      this._last = kmh;
      this._el.textContent = String(kmh);
    }
  }
}
