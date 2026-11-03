// Salas circulares e grade polar: círculo como área de 4 nós com arcos (bulge),
// anéis concêntricos + raios a partir do centro de cada sala circular para
// encaixar paredes, e linhas de parede existentes para "extrudar" paredes novas.
// Sem Three.js, para poder ser testado no Node.
import { samplePath, closestOnPolyline, bulgeFor, segmentArc } from '../math/curve.js';
import { areaOutline } from '../builders/corridorPath.js';

const QUARTER = Math.tan(Math.PI / 8); // bulge de 90°

/** 4 nós sobre o círculo, cada segmento um arco de 90° (anti-horário). */
export function circlePoints(cx, cz, r) {
  return [0, 1, 2, 3].map((k) => ({ x: cx + r * Math.cos((k * Math.PI) / 2), z: cz + r * Math.sin((k * Math.PI) / 2), b: QUARTER }));
}

/** Centro e raio de uma área circular (ou null). */
export function circleOf(o) {
  if (o?.shape !== 'circle' || o.points?.length !== 4) return null;
  const cx = o.points.reduce((a, p) => a + p.x, 0) / 4;
  const cz = o.points.reduce((a, p) => a + p.z, 0) / 4;
  return { cx, cz, r: Math.hypot(o.points[0].x - cx, o.points[0].z - cz) };
}

/** Salas circulares do nível y: centro, raio externo e anel da linha da parede. */
export function polarSources(doc, ctx, y, excludeId = null) {
  const out = [];
  for (const o of doc.objects) {
    if (o.type !== 'area' || o.id === excludeId) continue;
    const c = circleOf(o);
    if (!c || Math.abs(ctx.levelY(o.levelId) - y) > 1) continue;
    const th = o.walls?.enabled ? o.walls.thickness : 0;
    out.push({ id: o.id, cx: c.cx, cz: c.cz, R: c.r, ring0: Math.max(0.1, c.r - th / 2) });
  }
  return out;
}

/** Raios dos anéis de uma sala: a linha da parede e, para dentro, um a cada `step`. */
export function ringsOf(src, step) {
  const rings = [src.ring0];
  for (let r = src.ring0 - step; r > step * 0.45; r -= step) rings.push(r);
  return rings;
}

/** Sala circular cuja grade vale em p: a menor que contém p (com folga de meio passo). */
export function sourceAt(p, sources, step) {
  let best = null;
  for (const s of sources) {
    const d = Math.hypot(p.x - s.cx, p.z - s.cz);
    if (d <= s.R + step * 0.5 && (!best || s.R < best.R)) best = s;
  }
  return best;
}

/**
 * Encaixa p na grade polar: anel mais próximo × raio (divisões da volta).
 * Retorna { x, z, pol: { sid, cx, cz, r, ring, ang } } ou null fora das salas.
 */
export function polarSnap(p, sources, { step = 2, divisions = 24 } = {}) {
  const src = sourceAt(p, sources, step);
  if (!src) return null;
  const dx = p.x - src.cx, dz = p.z - src.cz;
  const d = Math.hypot(dx, dz);
  const rings = ringsOf(src, step);
  // centro conta como "anel 0" (plataformas concêntricas, paredes radiais até o meio)
  let ring = -1, r = 0, bd = d;
  rings.forEach((rv, i) => { if (Math.abs(d - rv) < bd) { bd = Math.abs(d - rv); ring = i; r = rv; } });
  const da = (2 * Math.PI) / Math.max(3, divisions);
  const ang = Math.round(Math.atan2(dz, dx) / da) * da;
  const pol = { sid: src.id, cx: src.cx, cz: src.cz, r, ring, ang };
  if (ring < 0) return { x: src.cx, z: src.cz, pol };
  return { x: src.cx + Math.cos(ang) * r, z: src.cz + Math.sin(ang) * r, pol };
}

/** Os dois pontos estão no mesmo anel da mesma sala (dá para ligar por arco)? */
export function sameRing(a, b) {
  return !!(a?.pol && b?.pol && a.pol.sid === b.pol.sid && a.pol.ring >= 0 && a.pol.ring === b.pol.ring
    && Math.hypot(a.x - b.x, a.z - b.z) > 1e-3);
}

/**
 * Pontos de rascunho com os arcos resolvidos: dois pontos seguidos no mesmo
 * anel viram arco (o caminho mais curto). Remove os dados de encaixe.
 */
export function withArcs(points, closed = false) {
  const n = points.length;
  return points.map((p, i) => {
    const q = { x: p.x, z: p.z };
    const nx = i + 1 < n ? points[i + 1] : closed && n > 2 ? points[0] : null;
    if (nx && sameRing(p, nx)) {
      const b = bulgeFor({ x: p.pol.cx, z: p.pol.cz }, p, nx);
      if (b) q.b = b;
    }
    return q;
  });
}

/**
 * Depois de mover o nó `i`, os arcos vizinhos continuam no anel quando as duas
 * pontas ficaram à mesma distância do centro de alguma sala (mantém o sentido).
 */
export function refitArcs(o, i, sources) {
  const n = o.points.length;
  const closed = o.type === 'area' || o.closed;
  for (const j of [i - 1, i]) {
    const a = closed ? ((j % n) + n) % n : j;
    if (a < 0 || (!closed && a >= n - 1)) continue;
    const A = o.points[a], B = o.points[(a + 1) % n];
    if (!A.b) continue;
    const old = segmentArc(A, B, A.b);
    for (const s of sources) {
      const C = { x: s.cx, z: s.cz };
      const ra = Math.hypot(A.x - C.x, A.z - C.z), rb = Math.hypot(B.x - C.x, B.z - C.z);
      if (Math.abs(ra - rb) > 0.05 || ra < 0.05) continue;
      const b = bulgeFor(C, A, B, old ? Math.sign(old.sweep) : 0);
      o.points[a] = { ...A, b: b || undefined };
      if (!b) delete o.points[a].b;
      break;
    }
  }
}

/**
 * Linhas centrais das paredes do nível y (paredes soltas e paredes de áreas),
 * para mostrar a guia e extrudar uma parede nova a partir delas.
 */
export function wallLines(doc, ctx, y, excludeId = null) {
  const out = [];
  for (const o of doc.objects) {
    if (o.id === excludeId || !o.points || Math.abs(ctx.levelY(o.levelId) - y) > 1) continue;
    if (o.type === 'wall' && o.points.length >= 2) {
      out.push({ id: o.id, closed: !!o.closed, pts: samplePath(o.points, { closed: o.closed, smooth: o.smooth, spacing: 0.5 }) });
    } else if (o.type === 'area' && o.points.length >= 3 && o.walls?.enabled) {
      const ol = areaOutline(o, ctx);
      if (ol.samples.length < 3) continue;
      const pts = ol.at(o.walls.thickness / 2);
      let s = 0;
      pts.forEach((p, k) => { if (k) s += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z); p.s = s; });
      out.push({ id: o.id, closed: true, pts });
    }
  }
  return out;
}

/** Linha de parede mais próxima de p (até maxD). Retorna { line, x, z, d } ou null. */
export function nearestWall(p, lines, maxD = 0.6) {
  let best = null;
  for (const line of lines) {
    const c = closestOnPolyline(line.pts, p, line.closed);
    if (c && c.d < maxD && (!best || c.d < best.d)) best = { line, x: c.x, z: c.z, d: c.d };
  }
  return best;
}

/** p está sobre a linha (a menos de tol)? */
export function onLine(p, line, tol = 0.05) {
  const c = closestOnPolyline(line.pts, p, line.closed);
  return !!c && c.d < tol;
}
