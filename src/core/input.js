/**
 * Keyboard + mouse state. One instance, updated by DOM events, consumed once
 * per frame by the simulation. No allocations after construction.
 */
export class Input {
  constructor(canvas) {
    /** @type {Record<string, boolean>} */
    this.down = Object.create(null);
    // Mouse deltas accumulated between frames, consumed in beginFrame().
    this._accDX = 0;
    this._accDY = 0;
    this._accWheel = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.rmb = false;
    this.lmb = false;
    /** Last pressed mood key 1..5, or 0. Consumed by weather system. */
    this.moodKey = 0;
    /** One-shot flags, consumed each frame. */
    this.toggleCamera = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down[e.code] = true;
      if (e.code.startsWith('Digit')) {
        const n = e.code.charCodeAt(5) - 48;
        if (n >= 1 && n <= 5) this.moodKey = n;
      }
      if (e.code === 'KeyC') this.toggleCamera = true;
    });
    window.addEventListener('keyup', (e) => { this.down[e.code] = false; });
    window.addEventListener('blur', () => {
      for (const k in this.down) this.down[k] = false;
      this.rmb = false; this.lmb = false;
    });

    this._lastCX = NaN;
    this._lastCY = NaN;
    window.addEventListener('mousemove', (e) => {
      // synthetic/test events may carry movementX = 0 — fall back to client deltas
      let dx = e.movementX, dy = e.movementY;
      if (!dx && !dy && Number.isFinite(this._lastCX)) {
        dx = e.clientX - this._lastCX;
        dy = e.clientY - this._lastCY;
      }
      this._lastCX = e.clientX;
      this._lastCY = e.clientY;
      this._accDX += dx || 0;
      this._accDY += dy || 0;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.rmb = true;
      if (e.button === 0) this.lmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0) this.lmb = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      this._accWheel += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  /** Latch accumulated deltas for this frame. */
  beginFrame() {
    this.mouseDX = this._accDX; this._accDX = 0;
    this.mouseDY = this._accDY; this._accDY = 0;
    this.wheel = this._accWheel; this._accWheel = 0;
  }

  /** Consume one-shot state at end of frame. */
  endFrame() {
    this.moodKey = 0;
    this.toggleCamera = false;
  }

  /** +1 if pos key down, -1 if neg key down, 0 otherwise. */
  axis(posCode, negCode) {
    return (this.down[posCode] ? 1 : 0) - (this.down[negCode] ? 1 : 0);
  }

  /** Glide is RMB or Shift (trackpad-friendly alternative). */
  get gliding() { return this.rmb || !!this.down['ShiftLeft'] || !!this.down['ShiftRight']; }

  get throttle() { return this.down['KeyW'] || this.down['ArrowUp'] ? 1 : 0; }
  get brake() { return this.down['KeyS'] || this.down['ArrowDown'] ? 1 : 0; }
  get steer() {
    return ((this.down['KeyA'] || this.down['ArrowLeft']) ? -1 : 0) +
           ((this.down['KeyD'] || this.down['ArrowRight']) ? 1 : 0);
  }
}
