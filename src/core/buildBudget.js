/**
 * Shared per-frame time budget for all world streamers (road chunks, curbs,
 * buildings, prop rebuilds). Keeps the SUM of incremental build work bounded
 * so several streamers can never stack their individual budgets into a hitch.
 *
 * Usage per streamer, once per frame:
 *   const deadline = buildBudget.deadline();
 *   if (performance.now() >= deadline) return;      // nothing left this frame
 *   ...slice work until performance.now() > deadline...
 *   buildBudget.report(spentMs);
 */
export const buildBudget = {
  limitMs: 3.0,
  _spent: 0,

  beginFrame() { this._spent = 0; },

  /** Absolute performance.now() timestamp this streamer must stop at. */
  deadline() {
    const remaining = this.limitMs - this._spent;
    return remaining <= 0 ? 0 : performance.now() + remaining;
  },

  report(ms) { this._spent += ms; },
};
