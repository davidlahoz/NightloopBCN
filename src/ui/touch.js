/**
 * Touch controls (mobile only) — a translucent Game-Boy-style overlay:
 * D-pad on the left (throttle / brake / steer, diagonals work), A = Glide,
 * B = handbrake on the right, plus small CAM / TIME / MUTE keys.
 *
 * It drives the SAME Input state the keyboard does (down['KeyW'…], rmb,
 * toggleCamera, moodKey), so every physics/audio/vfx path is reused
 * untouched. Pointer events give one capture per finger — multi-touch
 * steering + buttons just work.
 */
export class TouchControls {
  /**
   * @param {import('../core/input.js').Input} input
   * @param {{ onMute?: () => void }} handlers
   */
  constructor(input, handlers = {}) {
    this.input = input;
    this._time = 3;   // matches the night boot state; TIME cycles 1→2→3

    document.body.classList.add('touch');
    const root = document.createElement('div');
    root.id = 'touch-ui';
    root.className = 'on';
    document.body.appendChild(root);

    // ---- D-pad ----
    const dpad = document.createElement('div');
    dpad.id = 'tc-dpad';
    dpad.className = 'tc';
    dpad.innerHTML = '<div class="bar-v"></div><div class="bar-h"></div><div class="nub"></div>';
    root.appendChild(dpad);
    const nub = dpad.querySelector('.nub');

    const clearDpad = () => {
      input.down['KeyW'] = false;
      input.down['KeyS'] = false;
      input.down['KeyA'] = false;
      input.down['KeyD'] = false;
      nub.style.transform = 'translate(-50%, -50%)';
      dpad.classList.remove('held');
    };
    const applyDpad = (cx, cy) => {
      const r = dpad.getBoundingClientRect();
      let dx = (cx - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (cy - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      input.down['KeyA'] = dx < -0.28;
      input.down['KeyD'] = dx > 0.28;
      input.down['KeyW'] = dy < -0.28;
      input.down['KeyS'] = dy > 0.28;
      nub.style.transform = `translate(calc(-50% + ${(dx * 26).toFixed(1)}px), calc(-50% + ${(dy * 26).toFixed(1)}px))`;
      dpad.classList.add('held');
    };
    let dpadPointer = -1;
    dpad.addEventListener('pointerdown', (e) => {
      dpadPointer = e.pointerId;
      try { dpad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      applyDpad(e.clientX, e.clientY);
      e.preventDefault();
    });
    dpad.addEventListener('pointermove', (e) => {
      if (e.pointerId === dpadPointer) applyDpad(e.clientX, e.clientY);
    });
    const dpadEnd = (e) => {
      if (e.pointerId === dpadPointer) { dpadPointer = -1; clearDpad(); }
    };
    dpad.addEventListener('pointerup', dpadEnd);
    dpad.addEventListener('pointercancel', dpadEnd);

    // ---- hold buttons: A = glide, B = handbrake ----
    const holdBtn = (id, label, cls, press, release) => {
      const el = document.createElement('div');
      el.id = id;
      el.className = 'tc tc-btn ' + cls;
      el.textContent = label;
      root.appendChild(el);
      el.addEventListener('pointerdown', (e) => {
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        el.classList.add('held');
        press();
        e.preventDefault();
      });
      const end = () => { el.classList.remove('held'); release(); };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      return el;
    };
    holdBtn('tc-a', 'A', '', () => { input.rmb = true; }, () => { input.rmb = false; });
    holdBtn('tc-b', 'B', '', () => { input.down['Space'] = true; }, () => { input.down['Space'] = false; });

    // ---- tap buttons: camera, time of day, mute ----
    const tapBtn = (id, label, fn) => {
      const el = document.createElement('div');
      el.id = id;
      el.className = 'tc tc-btn small';
      el.textContent = label;
      root.appendChild(el);
      el.addEventListener('pointerdown', (e) => {
        el.classList.add('held');
        fn();
        e.preventDefault();
      });
      const end = () => el.classList.remove('held');
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    };
    tapBtn('tc-cam', 'CAM', () => { input.toggleCamera = true; });
    tapBtn('tc-time', 'TIME', () => {
      this._time = (this._time % 3) + 1;
      input.moodKey = this._time;
    });
    tapBtn('tc-mute', 'MUTE', () => { if (handlers.onMute) handlers.onMute(); });
  }
}
