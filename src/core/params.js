/**
 * Central tunable-parameter registry.
 *
 * Every art/tuning value that might need live adjustment is defined here once.
 * The settings overlay auto-builds its controls from these definitions.
 * Hot code reads `params.<key>` directly (plain property reads, no getters).
 */

/** @type {Array<{key:string,label:string,section:string,min?:number,max?:number,step?:number,type:string,options?:string[]}>} */
export const paramDefs = [];

/** Live values — read directly in hot paths. @type {Record<string, any>} */
export const params = Object.create(null);

/** @type {Map<string, Array<(v:any)=>void>>} */
const listeners = new Map();

/**
 * @param {string} key
 * @param {any} value initial value
 * @param {{label?:string, section?:string, min?:number, max?:number, step?:number, options?:string[]}} [spec]
 */
export function defineParam(key, value, spec = {}) {
  const type = typeof value === 'boolean' ? 'bool' : spec.options ? 'enum' : 'number';
  paramDefs.push({
    key,
    label: spec.label ?? key,
    section: spec.section ?? 'misc',
    min: spec.min ?? 0,
    max: spec.max ?? 1,
    step: spec.step ?? 0.01,
    options: spec.options,
    type,
  });
  params[key] = value;
  return params;
}

/** Set a param and notify listeners (used by the overlay and by code-driven changes). */
export function setParam(key, v) {
  params[key] = v;
  const ls = listeners.get(key);
  if (ls) for (let i = 0; i < ls.length; i++) ls[i](v);
}

/** Subscribe to changes of one param. */
export function onParam(key, fn) {
  let ls = listeners.get(key);
  if (!ls) { ls = []; listeners.set(key, ls); }
  ls.push(fn);
}
