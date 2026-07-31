/** Thin controller for the DOM loading screen defined in index.html. */
export const loadingScreen = {
  _bar: document.getElementById('loader-bar'),
  _status: document.getElementById('loader-status'),
  _root: document.getElementById('loader'),

  /** @param {number} t 0..1 @param {string} [label] */
  set(t, label) {
    this._bar.style.width = `${Math.round(t * 100)}%`;
    if (label) this._status.textContent = label;
  },

  hide() {
    this.set(1, 'ready');
    this._root.classList.add('hidden');
    // remove from DOM after fade completes so it costs nothing,
    // then reveal the persistent in-game controls hint
    setTimeout(() => {
      this._root.remove();
      const hint = document.getElementById('controls-hint');
      if (hint) hint.classList.add('visible');
    }, 1600);
  },

  showNoWebGPU() {
    this._root.style.display = 'none';
    document.getElementById('nogpu').style.display = 'flex';
  },
};
