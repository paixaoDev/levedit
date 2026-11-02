// Matemática de curvas 2D (plano XZ): Catmull-Rom com tensão, amostragem por
// comprimento de arco, frames (tangente/normal) com miter e offsets paralelos.
// Sem dependência do Three.js para poder ser testado isoladamente.

const EPS = 1e-6;

function hermite(p0, p1, p2, p3, t, tension) {
  // Catmull-Rom cardinal: tangentes = tension * (p[i+1] - p[i-1])
  const m1x = tension * (p2.x - p0.x), m1z = tension * (p2.z - p0.z);
  const m2x = tension * (p3.x - p1.x), m2z = tension * (p3.z - p1.z);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return {
    x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
    z: h00 * p1.z + h10 * m1z + h01 * p2.z + h11 * m2z,
  };
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

/**
 * Amostra um caminho definido por pontos de controle.
 * @param {{x:number,z:number}[]} points
 * @param {{closed?:boolean, smooth?:number, spacing?:number}} opts
 *  smooth = 0 → polilinha com cantos vivos; >0 → Catmull-Rom com essa tensão.
 * @returns {{x:number,z:number,s:number,u:number,ctrl:number}[]} amostras com
 *  comprimento acumulado (s), fração (u) e índice do ponto de controle de origem.
 */
export function samplePath(points, { closed = false, smooth = 0, spacing = 1 } = {}) {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: points[0].x, z: points[0].z, s: 0, u: 0, ctrl: 0 }];
  const segCount = closed ? n : n - 1;
  const get = (i) => {
    if (closed) return points[((i % n) + n) % n];
    if (i < 0) return { x: 2 * points[0].x - points[1].x, z: 2 * points[0].z - points[1].z };
    if (i >= n) return { x: 2 * points[n - 1].x - points[n - 2].x, z: 2 * points[n - 1].z - points[n - 2].z };
    return points[i];
  };
  const out = [];
  let s = 0;
  let prev = null;
  for (let seg = 0; seg < segCount; seg++) {
    const p0 = get(seg - 1), p1 = get(seg), p2 = get(seg + 1), p3 = get(seg + 2);
    // Polilinha fina do segmento
    const fine = [];
    if (smooth <= 0) {
      fine.push({ x: p1.x, z: p1.z }, { x: p2.x, z: p2.z });
    } else {
      const steps = Math.max(8, Math.ceil(dist(p1, p2) * 4));
      for (let k = 0; k <= steps; k++) fine.push(hermite(p0, p1, p2, p3, k / steps, smooth));
    }
    // Comprimento acumulado do segmento fino
    const acc = [0];
    for (let k = 1; k < fine.length; k++) acc.push(acc[k - 1] + dist(fine[k - 1], fine[k]));
    const segLen = acc[acc.length - 1];
    const count = Math.max(1, Math.ceil(segLen / Math.max(0.05, spacing)));
    for (let k = seg === 0 ? 0 : 1; k <= count; k++) {
      const target = (k / count) * segLen;
      let j = 1;
      while (j < acc.length - 1 && acc[j] < target) j++;
      const a = fine[j - 1], b = fine[j];
      const span = acc[j] - acc[j - 1];
      const f = span > EPS ? (target - acc[j - 1]) / span : 0;
      const p = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
      if (prev) s += dist(prev, p);
      out.push({ x: p.x, z: p.z, s, u: 0, ctrl: k === 0 ? seg : k === count ? seg + 1 : seg + k / count });
      prev = p;
    }
  }
  const total = s || 1;
  for (const p of out) p.u = p.s / total;
  if (closed && out.length > 1) out.pop(); // último == primeiro
  return out;
}

export function pathLength(samples, closed = false) {
  let L = 0;
  for (let i = 1; i < samples.length; i++) L += dist(samples[i - 1], samples[i]);
  if (closed && samples.length > 2) L += dist(samples[samples.length - 1], samples[0]);
  return L;
}

/**
 * Calcula, para cada ponto, a tangente e a normal "esquerda" (no plano XZ) e
 * o fator de miter para que offsets paralelos mantenham largura constante.
 * Pontos repetidos (degraus) são tolerados.
 */
export function computeFrames(pts, closed = false) {
  const n = pts.length;
  const frames = new Array(n);
  const findDistinct = (i, step) => {
    let j = i + step;
    for (let guard = 0; guard < n; guard++, j += step) {
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) return -1;
      if (j === i) return -1;
      if (dist(pts[i], pts[j]) > EPS) return j;
    }
    return -1;
  };
  const leftOf = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    return { x: dz / L, z: -dx / L, tx: dx / L, tz: dz / L };
  };
  for (let i = 0; i < n; i++) {
    const ip = findDistinct(i, -1);
    const inx = findDistinct(i, 1);
    let nPrev = ip >= 0 ? leftOf(pts[ip], pts[i]) : null;
    let nNext = inx >= 0 ? leftOf(pts[i], pts[inx]) : null;
    if (!nPrev && !nNext) {
      frames[i] = { nx: 0, nz: -1, tx: 1, tz: 0, miter: 1 };
      continue;
    }
    if (!nPrev) nPrev = nNext;
    if (!nNext) nNext = nPrev;
    let mx = nPrev.x + nNext.x, mz = nPrev.z + nNext.z;
    let mL = Math.hypot(mx, mz);
    if (mL < EPS) { mx = nNext.x; mz = nNext.z; mL = 1; }
    mx /= mL; mz /= mL;
    const cos = mx * nNext.x + mz * nNext.z;
    const miter = 1 / Math.max(0.3, cos);
    let tx = nPrev.tx + nNext.tx, tz = nPrev.tz + nNext.tz;
    const tL = Math.hypot(tx, tz) || 1;
    frames[i] = { nx: mx, nz: mz, tx: tx / tL, tz: tz / tL, miter };
  }
  return frames;
}

/**
 * Desloca os pontos ao longo da normal esquerda (d > 0 = esquerda).
 * d pode ser um número ou uma função (índice) => distância (largura variável).
 */
export function offsetPoints(pts, frames, d) {
  const dist = typeof d === 'function' ? d : () => d;
  return pts.map((p, i) => {
    const f = frames[i];
    const di = dist(i);
    return { ...p, x: p.x + f.nx * f.miter * di, z: p.z + f.nz * f.miter * di };
  });
}

/**
 * Ponto mais próximo de p numa polilinha amostrada (com s acumulado).
 * Retorna {x, z, y, s, d, i, f, tx, tz} ou null.
 */
export function closestOnPolyline(samples, p, closed = false) {
  let best = null;
  const n = samples.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = samples[i], b = samples[(i + 1) % n];
    const c = closestOnSegment(p, a, b);
    if (!best || c.d < best.d) {
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const sb = i + 1 < n ? b.s : a.s + L;
      best = {
        x: c.x, z: c.z, d: c.d, i, f: c.t,
        s: a.s + (sb - a.s) * c.t,
        y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * c.t,
        tx: (b.x - a.x) / L, tz: (b.z - a.z) / L,
      };
    }
  }
  return best;
}

/** Ponto mais próximo num segmento AB (2D). Retorna {t, d}. */
export function closestOnSegment(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const L2 = abx * abx + abz * abz;
  let t = L2 > EPS ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + abx * t, z = a.z + abz * t;
  return { t, d: Math.hypot(p.x - x, p.z - z), x, z };
}

/** Área assinada de um polígono (XZ). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}
