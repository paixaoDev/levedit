// Utilitários gerais: ids, RNG com seed, ruído 1D e helpers de objeto.

let _uidCounter = 0;
export function uid(prefix = 'o') {
  _uidCounter = (_uidCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${_uidCounter.toString(36)}`;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/** RNG determinístico (mulberry32). */
export function rng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

/** Ruído de valor 1D suave em [-1, 1], com seed. */
export function noise1D(seed = 1, frequency = 0.25) {
  const cache = new Map();
  const r = (i) => {
    if (!cache.has(i)) cache.set(i, rng((seed * 9301 + i * 49297) ^ 0x5bd1e995)() * 2 - 1);
    return cache.get(i);
  };
  return (x) => {
    const xf = x * frequency;
    const i = Math.floor(xf);
    const f = xf - i;
    return lerp(r(i), r(i + 1), smoothstep(f));
  };
}

export function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setByPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

export const deepClone = (o) => JSON.parse(JSON.stringify(o));

/** Mescla defaults em obj (sem sobrescrever o que já existe). */
export function withDefaults(obj, defaults) {
  for (const k of Object.keys(defaults)) {
    const d = defaults[k];
    if (obj[k] === undefined) obj[k] = deepClone(d);
    else if (d && typeof d === 'object' && !Array.isArray(d) && typeof obj[k] === 'object') withDefaults(obj[k], d);
  }
  return obj;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function snap(v, step) {
  return step > 0 ? Math.round(v / step) * step : v;
}

/** Ajusta a cor (hex string) para mais clara/escura. amount em [-1, 1]. */
export function shade(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  r = f(r); g = f(g); b = f(b);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
