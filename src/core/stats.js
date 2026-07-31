/**
 * Frame-time statistics. Fixed-size ring buffer, zero allocation per frame.
 * Percentiles are computed on demand (throttled by the overlay) into a
 * pre-allocated scratch buffer.
 */
const N = 600; // ~6-8 seconds of history

export class FrameStats {
  constructor() {
    this.samples = new Float32Array(N);   // frame ms, ring
    this.head = 0;                        // next write index
    this.count = 0;
    this._scratch = new Float32Array(N);
    this.median = 0;
    this.p99 = 0;      // 1% high frame time (ms) -> "1% low fps"
    this.worst = 0;
    this.fps = 0;
    this._emaMs = 16.7;
  }

  /** @param {number} ms frame time in milliseconds */
  push(ms) {
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % N;
    if (this.count < N) this.count++;
    this._emaMs += (ms - this._emaMs) * 0.05;
    this.fps = 1000 / this._emaMs;
  }

  /** Recompute median/p99/worst. Called at overlay refresh rate only. */
  refresh() {
    const n = this.count;
    if (n === 0) return;
    const s = this._scratch;
    for (let i = 0; i < n; i++) s[i] = this.samples[i];
    s.subarray(0, n).sort();
    this.median = s[(n * 0.5) | 0];
    this.p99 = s[Math.min(n - 1, (n * 0.99) | 0)];
    this.worst = s[n - 1];
  }
}
