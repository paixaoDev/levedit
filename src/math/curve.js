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
export function samplePath(points, opts = {}) {
  if (!hasArcs(points)) return samplePlain(points, opts);
  // Segmentos em arco (bulge `b` no ponto inicial): expande em pontos densos
  // sobre o arco e amostra como polilinha; ctrl volta a apontar para os nós originais.
  const closed = !!opts.closed;
  const dense = expandArcs(points, closed);
  const out = samplePlain(dense, { ...opts, smooth: 0 });
  for (const p of out) {
    const i = Math.floor(p.ctrl), f = p.ctrl - i;
    const a = dense[Math.min(i, dense.length - 1)]._c;
    const b = i + 1 < dense.length ? dense[i + 1]._c : closed ? points.length : a;
    p.ctrl = f > 0 ? a + (b - a) * f : a;
  }
  return out;
}

/** Algum segmento tem arco? */
export function hasArcs(points) {
  return points.some((p) => p.b);
}

/**
 * Arco do segmento A→B com bulge b = tan(varredura/4) (b>0: anti-horário no
 * plano x/z, isto é, ângulo de atan2(z, x) crescente). Retorna
 * { cx, cz, r, a0, sweep } ou null se for reto.
 */
export function segmentArc(A, B, b) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const c = Math.hypot(dx, dz);
  if (!b || c < EPS) return null;
  const sweep = 4 * Math.atan(b);
  const h = c / 2 / Math.tan(sweep / 2);
  const cx = (A.x + B.x) / 2 - (dz / c) * h, cz = (A.z + B.z) / 2 + (dx / c) * h;
  return { cx, cz, r: Math.hypot(A.x - cx, A.z - cz), a0: Math.atan2(A.z - cz, A.x - cx), sweep };
}

/** Ponto do arco na fração t (0..1). */
export function arcPoint(arc, t) {
  const a = arc.a0 + arc.sweep * t;
  return { x: arc.cx + Math.cos(a) * arc.r, z: arc.cz + Math.sin(a) * arc.r };
}

/**
 * Bulge do arco de centro C que vai de A até B. dir: +1 anti-horário, -1
 * horário, 0 = o arco mais curto.
 */
export function bulgeFor(C, A, B, dir = 0) {
  const a0 = Math.atan2(A.z - C.z, A.x - C.x), a1 = Math.atan2(B.z - C.z, B.x - C.x);
  let sw = a1 - a0;
  while (sw <= -Math.PI) sw += 2 * Math.PI;
  while (sw > Math.PI) sw -= 2 * Math.PI;
  if (dir > 0 && sw < 0) sw += 2 * Math.PI;
  if (dir < 0 && sw > 0) sw -= 2 * Math.PI;
  if (Math.abs(sw) < 1e-4) return 0;
  return Math.tan(sw / 4);
}

/** Pontos densos sobre os arcos; cada um guarda _c = índice (fracionário) do nó original. */
export function expandArcs(points, closed = false) {
  const n = points.length;
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const A = points[i];
    out.push({ x: A.x, z: A.z, _c: i });
    if (i >= segs) continue;
    const arc = segmentArc(A, points[(i + 1) % n], A.b);
    if (!arc) continue;
    const len = Math.abs(arc.sweep) * arc.r;
    const k = Math.max(4, Math.ceil(Math.max(len / 0.3, Math.abs(arc.sweep) / (Math.PI / 36))));
    for (let j = 1; j < k; j++) out.push({ ...arcPoint(arc, j / k), _c: i + j / k });
  }
  return out;
}

function samplePlain(points, { closed = false, smooth = 0, spacing = 1 } = {}) {
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

/**
 * Cruzamentos entre duas polilinhas P e Q (XZ). Cada resultado traz o ponto e
 * o arco interpolado nas duas (sP, sQ), usando o campo `s` dos pontos.
 */
export function polylineCrossings(P, Q, closedQ = false) {
  const out = [];
  const m = Q.length;
  const qsegs = closedQ ? m : m - 1;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const rx = b.x - a.x, rz = b.z - a.z;
    for (let j = 0; j < qsegs; j++) {
      const c = Q[j], d = Q[(j + 1) % m];
      const qx = d.x - c.x, qz = d.z - c.z;
      const den = rx * qz - rz * qx;
      if (Math.abs(den) < 1e-12) continue;
      const wx = c.x - a.x, wz = c.z - a.z;
      const t = (wx * qz - wz * qx) / den;
      const u = (wx * rz - wz * rx) / den;
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
      const sd = j + 1 < m ? d.s : (c.s ?? 0) + Math.hypot(qx, qz);
      out.push({
        x: a.x + rx * t, z: a.z + rz * t, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t,
        sP: (a.s ?? i) + ((b.s ?? i + 1) - (a.s ?? i)) * t,
        sQ: (c.s ?? j) + (sd - (c.s ?? j)) * u,
      });
    }
  }
  return out;
}

/**
 * Remove os laços que um offset forma no lado de dentro de curvas fechadas
 * (largura maior que o raio): os pontos do laço colapsam no cruzamento.
 * keepLength = true mantém a quantidade de pontos (para faixas pareadas).
 */
export function untangle(line, { keepLength = false, window = 60, ref = null } = {}) {
  const out = line.map((p) => ({ ...p }));
  const n = out.length;
  // 1) trechos invertidos (o offset anda para trás em relação ao eixo `ref`):
  //    colapsam no encontro das retas vizinhas
  if (ref && ref.length === n) {
    const rev = (k) => {
      const ox = out[k + 1].x - out[k].x, oz = out[k + 1].z - out[k].z;
      const cx = ref[k + 1].x - ref[k].x, cz = ref[k + 1].z - ref[k].z;
      return ox * cx + oz * cz < 0;
    };
    for (let k = 0; k < n - 1; k++) {
      if (!rev(k)) continue;
      let e = k;
      while (e + 1 < n - 1 && rev(e + 1)) e++;
      // trecho invertido: pontos k..e+1; vizinhos bons: (k-1,k) e (e+1,e+2)
      const a0 = out[Math.max(0, k - 1)], a1 = out[k];
      const b0 = out[e + 1], b1 = out[Math.min(n - 1, e + 2)];
      let X = null;
      const rx = a1.x - a0.x, rz = a1.z - a0.z, qx = b1.x - b0.x, qz = b1.z - b0.z;
      const den = rx * qz - rz * qx;
      if (Math.abs(den) > 1e-9) {
        const t = ((b0.x - a0.x) * qz - (b0.z - a0.z) * qx) / den;
        X = { x: a0.x + rx * t, z: a0.z + rz * t };
        const span = Math.hypot(b0.x - a1.x, b0.z - a1.z) + Math.hypot(rx, rz) + Math.hypot(qx, qz);
        if (Math.hypot(X.x - (a1.x + b0.x) / 2, X.z - (a1.z + b0.z) / 2) > span * 2) X = null;
      }
      if (!X) X = { x: (a1.x + b0.x) / 2, z: (a1.z + b0.z) / 2 };
      for (let m = k; m <= e + 1; m++) out[m] = { ...out[m], x: X.x, z: X.z };
      k = e + 1;
    }
  }
  // 2) laços (o offset cruza a si mesmo)
  for (let i = 0; i < n - 3; i++) {
    const a = out[i], b = out[i + 1];
    const rx = b.x - a.x, rz = b.z - a.z;
    let hit = null;
    for (let j = Math.min(n - 2, i + window); j >= i + 2; j--) {
      const c = out[j], d = out[j + 1];
      const qx = d.x - c.x, qz = d.z - c.z;
      const den = rx * qz - rz * qx;
      if (Math.abs(den) < 1e-12) continue;
      const wx = c.x - a.x, wz = c.z - a.z;
      const t = (wx * qz - wz * qx) / den;
      const u = (wx * rz - wz * rx) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) { hit = { j, t }; break; }
    }
    if (!hit) continue;
    const X = { x: a.x + rx * hit.t, z: a.z + rz * hit.t };
    for (let k = i + 1; k <= hit.j; k++) out[k] = { ...out[k], x: X.x, z: X.z };
    i = hit.j - 1;
  }
  if (keepLength) return out;
  return out.filter((p, k) => k === 0 || Math.hypot(p.x - out[k - 1].x, p.z - out[k - 1].z) > 1e-6);
}
