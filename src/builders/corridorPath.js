// Caminho de um corredor: amostragem com elevação, largura por nó e junções
// (corredores que nascem de outro corredor abrem uma passagem/porta na parede).
import { samplePath, closestOnPolyline, computeFrames, offsetPoints, polylineCrossings, signedArea } from '../math/curve.js';
import { lerp, smoothstep } from '../util.js';

/** Meia-largura de um nó de controle (side 1 = esquerda, -1 = direita). */
export function nodeHalf(o, i, side) {
  const p = o.points[i];
  const v = side > 0 ? p?.wl : p?.wr;
  return typeof v === 'number' && v > 0 ? v : o.width / 2;
}

/** Meia-largura interpolada numa posição fracionária de ponto de controle. */
export function halfAt(o, ctrl, side) {
  const n = o.points.length;
  if (!n) return o.width / 2;
  const c = Math.max(0, ctrl ?? 0);
  const i = Math.floor(c);
  const f = c - i;
  const a = nodeHalf(o, o.closed ? i % n : Math.min(i, n - 1), side);
  const b = nodeHalf(o, o.closed ? (i + 1) % n : Math.min(i + 1, n - 1), side);
  return lerp(a, b, smoothstep(f));
}

/** Amostra o caminho e aplica o perfil de elevação (rampa ou degraus). */
export function corridorSamples(o, ctx) {
  const y0 = ctx.levelY(o.levelId);
  const y1 = o.endLevelId ? ctx.levelY(o.endLevelId) : y0;
  const stairs = o.rampStyle === 'stairs' && Math.abs(y1 - y0) > 1e-3;
  const s = samplePath(o.points, { closed: o.closed, smooth: o.smooth, spacing: o.proc?.segment || 1 });
  if (s.length < 2) return { samples: s, y0, y1 };
  const L = s[s.length - 1].s;
  // a subida só acontece fora das salas onde as pontas nascem/terminam (dentro
  // delas o piso fica plano, senão o primeiro degrau aparece alto na porta)
  const [sA, sB] = y1 === y0 ? [0, L] : climbRange(o, s, ctx, y0, y1);
  const span = Math.max(1e-6, sB - sA);
  if (!stairs) {
    for (const p of s) p.y = lerp(y0, y1, y1 === y0 ? 0 : smoothstep(Math.max(0, Math.min(1, (p.s - sA) / span))));
    return { samples: s, y0, y1 };
  }
  // Degraus: insere fronteiras exatas de cada degrau ao longo do arco
  const rise = y1 - y0;
  const N = Math.max(1, Math.round(Math.abs(rise) / Math.max(0.05, o.stepHeight || 0.25)));
  const tread = span / N;
  const stepY = (k) => y0 + (rise * k) / N;
  const out = [];
  const at = (sv) => {
    let j = 1;
    while (j < s.length - 1 && s[j].s < sv) j++;
    const a = s[j - 1], b = s[j];
    const f = b.s - a.s > 1e-6 ? (sv - a.s) / (b.s - a.s) : 0;
    return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), s: sv, u: sv / L, ctrl: lerp(a.ctrl, b.ctrl, f) };
  };
  const marks = new Set(s.map((p) => +p.s.toFixed(4)));
  for (let k = 1; k <= N; k++) marks.add(+(sA + k * tread).toFixed(4));
  const sorted = [...marks].sort((a, b) => a - b);
  for (const sv of sorted) {
    const k = Math.max(0, Math.min(N, Math.floor((sv - sA + 1e-4) / tread)));
    const p = at(Math.min(L, sv));
    const isBoundary = k > 0 && Math.abs(sv - sA - k * tread) < 2e-3;
    if (isBoundary) out.push({ ...p, y: stepY(k - 1) });
    out.push({ ...p, y: stepY(k) });
  }
  return { samples: out, y0, y1, stepped: { y0, rise, step: Math.abs(rise) / N, sA, sB, at: (sv) => y0 + rise * Math.max(0, Math.min(1, (sv - sA) / span)) } };
}

/**
 * Trecho [sA, sB] do corredor onde a rampa/escada sobe: começa depois de sair da
 * área do andar de partida em que a ponta inicial está e termina antes de entrar
 * na área do andar de chegada em que a ponta final está (com folga da parede).
 */
function climbRange(o, s, ctx, y0, y1) {
  const L = s[s.length - 1].s;
  const objs = ctx.doc?.objects;
  if (!objs || o.closed) return [0, L];
  const outlines = (y) => objs.filter((a) => a.type === 'area' && a.points?.length >= 3 && Math.abs(ctx.levelY(a.levelId) - y) < 1e-3)
    .map((a) => ({ pts: samplePath(a.points, { closed: true, smooth: a.smooth, spacing: 0.5 }), pad: (a.walls?.enabled ? a.walls.thickness : 0) / 2 + 0.3 }));
  const inside = (list, p) => list.some((a) => pointInPoly(a.pts, p) || (closestOnPolyline(a.pts, p, true)?.d ?? 9) < a.pad);
  const exitFrom = (list, fromStart) => {
    const hit = list.filter((a) => pointInPoly(a.pts, fromStart ? s[0] : s[s.length - 1]));
    if (!hit.length) return fromStart ? 0 : L;
    const idx = fromStart ? [...s.keys()] : [...s.keys()].reverse();
    for (const i of idx) if (!inside(hit, s[i])) return s[i].s;
    return fromStart ? 0 : L;
  };
  let sA = exitFrom(outlines(y0), true);
  let sB = exitFrom(outlines(y1), false);
  // nunca deixa a subida curta demais (fica íngreme): mínimo de 40% do corredor
  if (sB - sA < L * 0.4) { sA = 0; sB = L; }
  return [sA, sB];
}

function pointInPoly(pts, p) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}

export const JOIN_STYLES = { door: 'Porta (batente)', open: 'Abertura livre', none: 'Sem abertura' };

/** Linha deslocada da polilinha `sm` com meia-largura por amostra (side * (half + extra)). */
function sideLine(o, sm, frames, side, extra = 0) {
  return offsetPoints(sm, frames, (i) => side * (halfAt(o, sm[i].ctrl, side) + extra));
}

/** Prolonga uma linha aberta pelas pontas (reta tangente), para achar cruzamentos além do fim. */
function extendLine(line, len) {
  const n = line.length;
  if (n < 2) return line;
  const a = line[0], a1 = line[1], b = line[n - 1], b1 = line[n - 2];
  const da = Math.hypot(a.x - a1.x, a.z - a1.z) || 1, db = Math.hypot(b.x - b1.x, b.z - b1.z) || 1;
  return [
    { ...a, x: a.x + ((a.x - a1.x) / da) * len, z: a.z + ((a.z - a1.z) / da) * len, s: (a.s ?? 0) - len },
    ...line,
    { ...b, x: b.x + ((b.x - b1.x) / db) * len, z: b.z + ((b.z - b1.z) / db) * len, s: (b.s ?? 0) + len },
  ];
}

/** Pedaço da polilinha perto de uma ponta (até `len` metros), para cruzamentos baratos. */
function nearEnd(line, end, len) {
  const L = line[line.length - 1].s;
  return end === 'start' ? line.filter((p, i) => i === 0 || p.s <= len + 1) : line.filter((p, i) => i === line.length - 1 || p.s >= L - len - 1);
}

/** Cruzamento mais próximo da ponta `end` de uma linha da ramificação com uma linha do pai. */
function crossNearEnd(lineB, lineA, end, L, closedA) {
  let best = null;
  for (const c of polylineCrossings(lineB, lineA, closedA)) {
    const dist = end === 'start' ? c.sP : L - c.sP;
    if (dist < -1e-6) continue;
    if (!best || dist < best.dist) best = { ...c, dist };
  }
  return best;
}

/**
 * Contorno de uma área: amostras fechadas, frames e `at(d)` = linha deslocada d
 * metros para DENTRO (0 = contorno/face externa da parede).
 */
export function areaOutline(o, ctx) {
  const y = ctx.levelY(o.levelId);
  const sm = samplePath(o.points, { closed: true, smooth: o.smooth, spacing: o.proc?.segment || 1 });
  for (const p of sm) p.y = y;
  const fr = sm.length >= 3 ? computeFrames(sm, true) : [];
  const inside = signedArea(sm) > 0 ? -1 : 1;
  const n = sm.length;
  const total = n ? sm[n - 1].s + Math.hypot(sm[0].x - sm[n - 1].x, sm[0].z - sm[n - 1].z) : 0;
  return { samples: sm, frames: fr, inside, total, y, at: (d) => offsetPoints(sm, fr, inside * d) };
}

function insidePoly(pts, p) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}

/** Área (do mesmo nível) que contém E ou cuja borda está a menos de `margin` de E. */
function areaAt(areas, E, Ey, margin = 0.6) {
  let best = null;
  for (const ar of areas) {
    const { ol } = ar;
    if (ol.samples.length < 3 || Math.abs(ol.y - Ey) > 1) continue;
    const c = closestOnPolyline(ol.samples, E, true);
    if (!c) continue;
    const inside = insidePoly(ol.samples, E);
    if (!inside && c.d > margin) continue;
    const score = inside ? -1 / (1 + c.d) : c.d;
    if (!best || score < best.score) best = { ...ar, c, inside, score };
  }
  return best;
}

/** Normaliza um corte [s0, s1] numa linha fechada de comprimento `total` (pode virar dois). */
export function wrapCut(c, total) {
  if (!total) return [c];
  let { s0, s1 } = c;
  while (s0 < 0) { s0 += total; s1 += total; }
  while (s0 >= total) { s0 -= total; s1 -= total; }
  if (s1 <= total) return [{ ...c, s0, s1 }];
  return [{ ...c, s0, s1: total }, { ...c, s0: 0, s1: s1 - total }];
}

/** Ponto dentro do corredor o (até a linha a `extra` além da borda do piso), longe das pontas. */
function insideCorridor(o, sm, pt, extra) {
  const c = closestOnPolyline(sm, pt, o.closed);
  if (!c) return false;
  const L = sm[sm.length - 1].s;
  if (!o.closed && (c.s < 1e-3 || c.s > L - 1e-3)) return false;
  const ctrl = sm[c.i].ctrl + ((sm[(c.i + 1) % sm.length].ctrl ?? sm[c.i].ctrl) - sm[c.i].ctrl) * c.f;
  const side = (pt.x - c.x) * c.tz - (pt.z - c.z) * c.tx >= 0 ? 1 : -1; // normal esquerda = (tz, -tx)
  return c.d < halfAt(o, ctrl, side) + extra - 0.01;
}

/**
 * Liga a ponta `end` do corredor `b` a um "pai" P (corredor ou área), dado por
 * linhas paralelas à parede dele: edge (piso, levemente para dentro), inner
 * (face interna), center (centro da parede) e outer (face externa). Calcula os
 * recortes de B e a abertura na parede de P.
 */
function connectEnd(info, b, end, ei, fb, P) {
  const { sb, idx } = ei;
  const style = b.joins?.[end] || 'door';
  const hb = (nodeHalf(b, idx, 1) + nodeHalf(b, idx, -1)) / 2;
  const thB = b.walls.thickness;
  const Lb = sb[sb.length - 1].s;
  const reach = (P.depth + P.th + 2) / P.sinA + hb + 2 + (P.area ? Lb : 0);
  const trim = { floor: 0, walls: 0, style, sides: {}, parent: P.id };
  const fallbackFloor = Math.max(0, (P.depth - 0.02) / P.sinA);
  const fallbackWalls = (P.depth + (style === 'none' ? 0 : P.th / 2)) / P.sinA;
  const faces = [];
  for (const bs of [1, -1]) {
    const bEdge = nearEnd(sideLine(b, sb, fb, bs, 0), end, reach);
    const bWall = nearEnd(sideLine(b, sb, fb, bs, thB / 2), end, reach);
    const fl = crossNearEnd(bEdge, P.edge, end, Lb, P.closed);
    const wl = crossNearEnd(bWall, style === 'none' ? P.inner : P.center, end, Lb, P.closed);
    trim.sides[bs] = {
      floor: fl ? fl.dist : fallbackFloor, floorPt: fl ? { x: fl.x, z: fl.z } : null,
      walls: wl ? wl.dist : fallbackWalls, wallPt: wl ? { x: wl.x, z: wl.z } : null,
    };
    // face interna da parede de B cruzando a faixa da parede de P
    const fi = crossNearEnd(bEdge, P.inner, end, Lb, P.closed);
    const fo = crossNearEnd(bEdge, P.outer, end, Lb, P.closed);
    if (fi || fo) faces.push([fi?.sQ ?? fo.sQ, fo?.sQ ?? fi.sQ]);
  }
  trim.floor = Math.max(trim.sides[1].floor, trim.sides[-1].floor);
  trim.walls = Math.max(trim.sides[1].walls, trim.sides[-1].walls);
  info.get(b.id).trims[end] = trim;
  if (style !== 'none') {
    let s0, s1;
    if (faces.length === 2) {
      let [p, q] = faces;
      if (P.closed && P.total) {
        // na linha fechada, aproxima q de p (pode ter dado a volta)
        const mp = (p[0] + p[1]) / 2;
        q = q.map((v) => v + Math.round((mp - v) / P.total) * P.total);
      }
      if ((p[0] + p[1]) / 2 > (q[0] + q[1]) / 2) [p, q] = [q, p];
      // a parede de P vai até onde a face de B sai da faixa (sem fresta)
      s0 = Math.max(p[0], p[1]);
      s1 = Math.min(q[0], q[1]);
      if (s1 - s0 < 0.2) { const m = (s0 + s1) / 2; s0 = m - 0.1; s1 = m + 0.1; }
    } else {
      s0 = P.s - hb / P.sinA; s1 = P.s + hb / P.sinA;
    }
    // altura do piso de B onde ele atravessa a parede de P (escada/rampa que
    // chega a uma sala ainda subindo: a porta precisa ser mais alta ali)
    const sAt = end === 'start' ? trim.walls : Lb - trim.walls;
    let floorY = null;
    for (let k = 1; k < sb.length; k++) {
      if (sb[k].s >= sAt || k === sb.length - 1) {
        const a0 = sb[k - 1], a1 = sb[k];
        const f = a1.s - a0.s > 1e-6 ? Math.max(0, Math.min(1, (sAt - a0.s) / (a1.s - a0.s))) : 0;
        if (a0.y != null && a1.y != null) floorY = a0.y + (a1.y - a0.y) * f;
        break;
      }
    }
    info.get(P.id).cuts.push({
      side: P.side, s0, s1, s: (s0 + s1) / 2, half: (s1 - s0) / 2, style, from: b.id, y: P.y,
      wallH: P.wallH, height: Math.min(b.walls.height, P.wallH), floorY,
    });
  }
}

/** Porta entre duas áreas cujas paredes correm juntas (encostadas). */
function sharedDoors(info, A, B) {
  const a = A.o, b = B.o;
  if (Math.abs(A.ol.y - B.ol.y) > 1) return;
  const style = a.joins?.areas || 'door';
  if (style === 'none' || (b.joins?.areas || 'door') === 'none') return;
  if (overlapping(A, B)) return; // sobrepostas se fundem (mergeCuts), sem porta
  if (!a.walls?.enabled || !b.walls?.enabled) return; // sem parede (plataforma): nada a abrir
  const tol = (a.walls.enabled ? a.walls.thickness : 0) + (b.walls.enabled ? b.walls.thickness : 0) + 0.3;
  const sa = A.ol.samples, n = sa.length;
  // amostra fina do contorno de A marcando o que corre junto ao contorno de B
  const step = 0.25;
  const marks = [];
  for (let k = 0; k < n; k++) {
    const p = sa[k], q = sa[(k + 1) % n];
    const s0 = p.s, len = Math.hypot(q.x - p.x, q.z - p.z);
    const tx = (q.x - p.x) / (len || 1), tz = (q.z - p.z) / (len || 1);
    for (let t = 0; t < len; t += step) {
      const P = { x: p.x + tx * t, z: p.z + tz * t };
      const c = closestOnPolyline(B.ol.samples, P, true);
      const par = c ? Math.abs(c.tx * tx + c.tz * tz) : 0;
      marks.push({ s: s0 + t, ok: !!c && c.d < tol && par > 0.9, P, c });
    }
  }
  if (!marks.length) return;
  // trechos contínuos (com volta no fim)
  let startIdx = marks.findIndex((m) => !m.ok);
  if (startIdx < 0) return; // B cobre A inteira: não é parede compartilhada
  const runs = [];
  let run = null;
  for (let i = 1; i <= marks.length; i++) {
    const m = marks[(startIdx + i) % marks.length];
    if (m.ok) { if (!run) run = []; run.push(m); } else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  const doorW = Math.max(0.8, a.doorWidth || 1.6);
  for (const r of runs) {
    const len = r.length * step;
    if (len < doorW + 0.6) continue;
    const mid = r[Math.floor(r.length / 2)];
    const w = Math.min(doorW, len - 0.6) / 2;
    const height = Math.min(a.walls.height, b.walls.height);
    const base = { style, y: A.ol.y, height, from: null, side: 0 };
    info.get(a.id).cuts.push({ ...base, s0: mid.s - w, s1: mid.s + w, s: mid.s, half: w, from: b.id, wallH: a.walls.height });
    // em B o mesmo vão, sem batente duplicado
    const sB = mid.c.s;
    info.get(b.id).cuts.push({ ...base, style: style === 'door' ? 'open' : style, s0: sB - w, s1: sB + w, s: sB, half: w, from: a.id, wallH: b.walls.height });
  }
}

/**
 * Áreas sobrepostas (mesmo nível) viram um espaço só: corta a parede de A nos
 * trechos em que a linha dela fica dentro de outra área, além da parede desta
 * (assim as duas paredes ainda se encontram no cruzamento, sem fresta).
 */
function mergeCuts(info, A, areas) {
  const a = A.o;
  if (!a.walls?.enabled || A.ol.samples.length < 3) return;
  const others = areas.filter((B) => B !== A && B.ol.samples.length >= 3 && Math.abs(B.ol.y - A.ol.y) < 1 && boxesTouch(A.ol.samples, B.ol.samples));
  if (!others.length) return;
  const thA = a.walls.thickness;
  const center = A.ol.at(thA / 2);
  const n = center.length, total = A.ol.total;
  const step = 0.2;
  const marks = [];
  for (let k = 0; k < n; k++) {
    const p = center[k], q = center[(k + 1) % n];
    const s0 = A.ol.samples[k].s, s1 = k + 1 < n ? A.ol.samples[k + 1].s : total;
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const m = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < m; j++) {
      const f = j / m;
      const P = { x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f };
      const inside = others.some((B) => {
        if (!insidePoly(B.ol.samples, P)) return false;
        const thB = B.o.walls?.enabled ? B.o.walls.thickness : 0;
        return (closestOnPolyline(B.ol.samples, P, true)?.d ?? 0) > thB;
      });
      marks.push({ s: s0 + (s1 - s0) * f, inside });
    }
  }
  if (!marks.some((m) => m.inside)) return;
  const cuts = info.get(a.id).cuts;
  const base = { style: 'merge', y: A.ol.y, height: a.walls.height, wallH: a.walls.height, side: 0, from: null };
  if (marks.every((m) => m.inside)) { cuts.push({ ...base, s0: 0, s1: total, s: total / 2, half: total / 2 }); return; }
  // trechos contínuos, começando num ponto de fora (assim um trecho pode passar do fim ao começo)
  const start = marks.findIndex((m) => !m.inside);
  let run = null;
  const flush = (endS) => {
    if (!run) return;
    let s1 = endS;
    if (s1 < run) s1 += total;
    cuts.push({ ...base, s0: run, s1, s: (run + s1) / 2, half: (s1 - run) / 2 });
    run = null;
  };
  for (let i = 1; i <= marks.length; i++) {
    const m = marks[(start + i) % marks.length];
    if (m.inside && run == null) run = m.s;
    else if (!m.inside && run != null) flush(m.s);
  }
}

/** Uma área entra na outra (além da parede)? */
function overlapping(A, B) {
  if (!boxesTouch(A.ol.samples, B.ol.samples)) return false;
  const deep = (X, Y) => {
    const th = Y.o.walls?.enabled ? Y.o.walls.thickness : 0;
    return X.ol.samples.some((p) => insidePoly(Y.ol.samples, p) && (closestOnPolyline(Y.ol.samples, p, true)?.d ?? 0) > th + 0.1);
  };
  return deep(A, B) || deep(B, A);
}

function boxesTouch(P, Q) {
  const bb = (pts) => pts.reduce((b, p) => [Math.min(b[0], p.x), Math.min(b[1], p.z), Math.max(b[2], p.x), Math.max(b[3], p.z)], [Infinity, Infinity, -Infinity, -Infinity]);
  const a = bb(P), b = bb(Q);
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Detecta junções entre corredores.
 * - Ramificação: ponta de B sobre o eixo de A. A parede de A abre exatamente entre
 *   as faces internas das paredes de B; paredes e piso de B terminam exatamente nas
 *   linhas de A (cada lado no seu cruzamento), sem frestas.
 * - Emenda: ponta com ponta. As duas pontas usam a mesma normal (bissetriz) e a
 *   mesma largura, então piso e paredes fecham juntos.
 * Retorna Map id -> { cuts, trims: { start, end }, joints: { start, end } }.
 */
export function computeJunctions(ctx) {
  const corridors = ctx.doc.objects.filter((o) => o.type === 'corridor' && o.points.length >= 2);
  const info = new Map(corridors.map((o) => [o.id, { cuts: [], trims: {}, joints: {} }]));
  const areas = ctx.doc.objects.filter((o) => o.type === 'area' && o.points.length >= 3).map((o) => {
    info.set(o.id, { cuts: [] });
    return { o, ol: areaOutline(o, ctx) };
  });
  const paths = new Map(corridors.map((o) => [o.id, corridorSamples(o, ctx).samples]));
  const frameCache = new Map();
  const framesOf = (o) => {
    if (!frameCache.has(o.id)) frameCache.set(o.id, computeFrames(paths.get(o.id), o.closed));
    return frameCache.get(o.id);
  };
  const endInfo = (b, end) => {
    const sb = paths.get(b.id);
    const idx = end === 'start' ? 0 : b.points.length - 1;
    const E = sb[end === 'start' ? 0 : sb.length - 1];
    const q = end === 'start' ? sb[Math.min(1, sb.length - 1)] : sb[Math.max(0, sb.length - 2)];
    const dx = q.x - E.x, dz = q.z - E.z;
    const dl = Math.hypot(dx, dz) || 1;
    return { sb, idx, E, dir: { x: dx / dl, z: dz / dl } }; // dir: de E para dentro de B
  };

  // ---- emendas (ponta com ponta)
  const used = new Set();
  const opens = corridors.filter((o) => !o.closed && paths.get(o.id).length >= 2);
  for (let i = 0; i < opens.length; i++) {
    for (const endA of ['start', 'end']) {
      const A = opens[i];
      const keyA = A.id + endA;
      if (used.has(keyA)) continue;
      const ea = endInfo(A, endA);
      for (let k = i + 1; k < opens.length; k++) {
        const B = opens[k];
        for (const endB of ['start', 'end']) {
          const keyB = B.id + endB;
          if (used.has(keyB) || used.has(keyA)) continue;
          const eb = endInfo(B, endB);
          if (Math.hypot(ea.E.x - eb.E.x, ea.E.z - eb.E.z) > 0.05 || Math.abs((ea.E.y ?? 0) - (eb.E.y ?? 0)) > 0.5) continue;
          // T: direção de A atravessando a emenda para dentro de B
          let tx = eb.dir.x - ea.dir.x, tz = eb.dir.z - ea.dir.z;
          const tl = Math.hypot(tx, tz);
          if (tl < 0.2) continue; // dobram sobre si mesmos
          tx /= tl; tz /= tl;
          // larguras no referencial de T (esquerda = normal (tz, -tx))
          // tangente própria de cada corredor na ponta, no sentido dos seus pontos
          const tA = endA === 'end' ? { x: tx, z: tz } : { x: -tx, z: -tz };
          const tB = endB === 'start' ? { x: tx, z: tz } : { x: -tx, z: -tz };
          const same = (t) => t.x * tx + t.z * tz > 0;
          const hW = (o, idx, t, worldSide) => nodeHalf(o, idx, same(t) ? worldSide : -worldSide);
          const wl = (hW(A, ea.idx, tA, 1) + hW(B, eb.idx, tB, 1)) / 2;
          const wr = (hW(A, ea.idx, tA, -1) + hW(B, eb.idx, tB, -1)) / 2;
          for (const [o, end, t] of [[A, endA, tA], [B, endB, tB]]) {
            info.get(o.id).joints[end] = {
              tx: t.x, tz: t.z, nx: t.z, nz: -t.x,
              hl: same(t) ? wl : wr, hr: same(t) ? wr : wl,
            };
          }
          used.add(keyA); used.add(keyB);
        }
      }
    }
  }

  // ---- ramificações
  for (const b of corridors) {
    if (b.closed) continue;
    for (const end of ['start', 'end']) {
      if (used.has(b.id + end)) continue;
      const { sb, idx, E, dir } = endInfo(b, end);
      const Ey = end === 'start' ? ctx.levelY(b.levelId) : ctx.levelY(b.endLevelId || b.levelId);
      let best = null;
      const link = b.links?.[end];
      for (const a of corridors) {
        if (a.id === b.id || (link && a.id !== link.id)) continue;
        const sa = paths.get(a.id);
        const c = closestOnPolyline(sa, E, a.closed);
        if (!c || (!link && Math.abs(c.y - Ey) > 1)) continue;
        const ctrl = sa[c.i].ctrl + ((sa[(c.i + 1) % sa.length].ctrl ?? sa[c.i].ctrl) - sa[c.i].ctrl) * c.f;
        const nx = c.tz, nz = -c.tx; // normal esquerda de A
        const side = dir.x * nx + dir.z * nz >= 0 ? 1 : -1;
        const halfA = halfAt(a, ctrl, side);
        if (!link && c.d > halfA + 0.35) continue;
        const L = sa[sa.length - 1].s;
        // ponta com ponta (continuação): não corta
        if (!link && !a.closed && (c.s < 0.6 || c.s > L - 0.6)) continue;
        if (!best || c.d < best.c.d) best = { a, c, side, halfA, ctrl };
      }
      if (best) {
        const { a, c, side, halfA } = best;
        const sa = paths.get(a.id), fa = framesOf(a);
        const ext = (line) => (a.closed ? line : extendLine(line, 8));
        const thA = a.walls.thickness;
        connectEnd(info, b, end, endInfo(b, end), framesOf(b), {
          id: a.id, closed: a.closed, th: thA, wallH: a.walls.height, y: c.y, side, s: c.s,
          sinA: Math.max(0.35, Math.abs(c.tx * dir.z - c.tz * dir.x)), depth: halfA,
          edge: ext(sideLine(a, sa, fa, side, -0.02)),
          inner: ext(sideLine(a, sa, fa, side, 0)),
          center: ext(sideLine(a, sa, fa, side, thA / 2)),
          outer: ext(sideLine(a, sa, fa, side, thA)),
        });
        continue;
      }
      // ---- ponta dentro (ou na borda) de uma área: porta na parede da área
      if (link) continue;
      const ar = areaAt(areas, E, Ey);
      if (!ar) continue;
      const { o: A, ol, c } = ar;
      const thA = A.walls.enabled ? A.walls.thickness : 0;
      connectEnd(info, b, end, endInfo(b, end), framesOf(b), {
        id: A.id, closed: true, th: thA, wallH: A.walls.height, y: ol.y, side: 0, s: c.s,
        sinA: Math.max(0.35, Math.abs(c.tx * dir.z - c.tz * dir.x)), depth: 0, area: true, total: ol.total,
        edge: ol.at(0.02), inner: ol.at(thA), center: ol.at(thA / 2), outer: ol.at(0),
      });
    }
  }

  // ---- áreas encostadas: porta no meio de cada trecho de parede compartilhado
  for (let i = 0; i < areas.length; i++) {
    for (let k = i + 1; k < areas.length; k++) sharedDoors(info, areas[i], areas[k]);
  }

  // ---- áreas sobrepostas se fundem: a parede que entra em outra área some ali
  for (const A of areas) mergeCuts(info, A, areas);

  // ---- quem invade encosta: cada corredor não entra nos corredores mais antigos
  // (e no pai, longe da porta) nem em áreas que não são o destino dele. A meia-largura
  // de cada amostra é limitada para a face externa da parede parar rente à do outro.
  // quem foi editado por último é quem encosta (sem marca: ordem no documento)
  const order = new Map(ctx.doc.objects.map((o, i) => [o.id, (o.edited ?? -1) * 1e6 + i]));
  for (const X of corridors) {
    const obst = [];
    const ends = X.closed ? [] : [X.points[0], X.points[X.points.length - 1]];
    const xLinks = Object.values(X.links || {}).filter(Boolean).map((l) => l.id);
    const y0 = ctx.levelY(X.levelId), y1 = ctx.levelY(X.endLevelId || X.levelId);
    const sameLevel = (a, b) => Math.min(Math.abs(a - y0), Math.abs(a - y1), Math.abs(b - y0), Math.abs(b - y1)) < 1;
    const trimsX = info.get(X.id).trims;
    for (const Y of corridors) {
      if (Y.id === X.id) continue;
      if (!sameLevel(ctx.levelY(Y.levelId), ctx.levelY(Y.endLevelId || Y.levelId))) continue;
      if (Object.values(Y.links || {}).some((l) => l?.id === X.id)) continue; // filho de X
      const isParent = xLinks.includes(Y.id) || Object.entries(trimsX).some(([, t]) => t?.parent === Y.id);
      if (!isParent && order.get(Y.id) > order.get(X.id)) continue; // o editado por último é quem encosta
      if (!Y.closed && ends.some((p) => [Y.points[0], Y.points[Y.points.length - 1]].some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.05))) continue; // emenda
      const sm = paths.get(Y.id), fr = framesOf(Y);
      obst.push({
        id: Y.id, parent: isParent,
        lines: [1, -1].map((sd) => ({ pts: sideLine(Y, sm, fr, sd, (sd > 0 ? Y.walls.left : Y.walls.right) ? Y.walls.thickness : 0), closed: Y.closed })),
        inside: (pt) => insideCorridor(Y, sm, pt, Y.walls.thickness),
      });
    }
    for (const { o: A, ol } of areas) {
      if (!sameLevel(ol.y, ol.y)) continue;
      if (Object.values(trimsX).some((t) => t?.parent === A.id)) continue; // X abre porta nesta área
      const poly = ol.samples;
      obst.push({ id: A.id, lines: [{ pts: poly, closed: true }], inside: (pt) => insidePoly(poly, pt) });
    }
    if (!obst.length) continue;
    const L = paths.get(X.id).at(-1).s;
    info.get(X.id).clamp = (p, f, side) => {
      const th = (side > 0 ? X.walls.left : X.walls.right) ? X.walls.thickness : 0;
      let best = Infinity;
      for (const ob of obst) {
        if (ob.parent) {
          // perto da porta para o pai a parede já termina certinho: não mexe
          const near = Object.entries(trimsX).some(([end, t]) => t?.parent === ob.id
            && (end === 'start' ? p.s : L - p.s) < (t.sides?.[side]?.walls ?? t.walls) + 1.5);
          if (near) continue;
        }
        if (ob.inside(p)) continue; // o eixo já está dentro do outro: não dá para encostar
        const t = rayHit(p, { x: f.nx * side, z: f.nz * side }, ob.lines, 0.01);
        if (Number.isFinite(t)) best = Math.min(best, t / (f.miter || 1) - th - 0.02);
      }
      return Math.max(0.3, best);
    };
  }
  return info;
}

// ------------------------------------------------------------------ ligações
// Uma ramificação fica presa a um NÓ do corredor pai: o nó tem um id (jid) e a
// ponta do corredor filho guarda { id do pai, jid }. Mover o nó move a ponta.

let _jid = 0;
const newJid = () => `j${Date.now().toString(36)}${(++_jid).toString(36)}`;

/** Distância (m) para reaproveitar um nó existente em vez de criar outro. */
export const NODE_REUSE = 1.2;
/** Folga além da meia-largura em que uma ponta ainda conecta num corredor. */
export const ATTACH_MARGIN = 1.0;

/**
 * Onde uma ponta em E (altura Ey) se conectaria: o corredor mais próximo cujo
 * eixo passe por ali. Retorna null ou
 * { a, x, z, ctrl, node (índice de nó existente ou -1), continuation }.
 * continuation = a ponta cai numa ponta do outro corredor (emenda, não ramifica).
 */
export function findAttachTarget(doc, ctx, E, Ey, excludeId) {
  let best = null;
  for (const a of doc.objects) {
    if (a.type !== 'corridor' || a.id === excludeId || a.points.length < 2) continue;
    const sa = corridorSamples(a, ctx).samples;
    const c = closestOnPolyline(sa, E, a.closed);
    if (!c || Math.abs(c.y - Ey) > 1) continue;
    const ctrl = sa[c.i].ctrl + ((sa[(c.i + 1) % sa.length].ctrl ?? sa[c.i].ctrl) - sa[c.i].ctrl) * c.f;
    const half = Math.max(halfAt(a, ctrl, 1), halfAt(a, ctrl, -1));
    if (c.d > half + ATTACH_MARGIN) continue;
    if (!best || c.d < best.c.d) best = { a, c, ctrl };
  }
  if (!best) return null;
  const { a, c, ctrl } = best;
  const n = a.points.length;
  let node = -1, nd = NODE_REUSE;
  a.points.forEach((p, i) => {
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d < nd) { nd = d; node = i; }
  });
  const continuation = node >= 0 && !a.closed && (node === 0 || node === n - 1);
  const at = node >= 0 ? a.points[node] : c;
  return { a, x: at.x, z: at.z, y: c.y, ctrl, node, continuation };
}

/**
 * Prende a ponta `end` ('start' | 'end') do corredor `b` ao corredor mais
 * próximo cujo eixo passe por ela: reaproveita um nó perto ou insere um nó novo
 * no pai exatamente ali. Retorna true se ligou.
 */
export function attachEnd(doc, ctx, b, end) {
  if (b.closed || b.points.length < 2) return false;
  const idx = end === 'start' ? 0 : b.points.length - 1;
  const E = b.points[idx];
  const Ey = end === 'start' ? ctx.levelY(b.levelId) : ctx.levelY(b.endLevelId || b.levelId);
  const t = findAttachTarget(doc, ctx, E, Ey, b.id);
  if (!t) return false;
  const { a, ctrl } = t;
  const n = a.points.length;
  if (t.continuation) {
    b.points[idx] = { ...E, x: t.x, z: t.z };
    return false;
  }
  let k = t.node;
  if (k < 0) {
    const seg = Math.min(a.closed ? n - 1 : n - 2, Math.floor(ctrl));
    const j = (seg + 1) % n;
    const np = { x: t.x, z: t.z };
    const pa = a.points[seg], pb = a.points[j];
    if (pa.wl || pb.wl) np.wl = (nodeHalf(a, seg, 1) + nodeHalf(a, j, 1)) / 2;
    if (pa.wr || pb.wr) np.wr = (nodeHalf(a, seg, -1) + nodeHalf(a, j, -1)) / 2;
    a.points.splice(seg + 1, 0, np);
    k = seg + 1;
  }
  const node = a.points[k];
  if (!node.jid) node.jid = newJid();
  b.points[idx] = { ...E, x: node.x, z: node.z };
  b.links = { ...(b.links || {}), [end]: { id: a.id, jid: node.jid } };
  return true;
}

export function detachEnd(b, end) {
  if (b.links?.[end]) {
    b.links = { ...b.links, [end]: null };
  }
}

/** Mantém as pontas ligadas grudadas nos nós dos pais; remove ligações órfãs. */
export function syncLinks(doc) {
  const byId = new Map(doc.objects.map((o) => [o.id, o]));
  for (const b of doc.objects) {
    if (b.type !== 'corridor' || !b.links) continue;
    for (const end of ['start', 'end']) {
      const L = b.links[end];
      if (!L) continue;
      const a = byId.get(L.id);
      const node = a?.points.find((p) => p.jid === L.jid);
      if (!node || b.closed) { b.links[end] = null; continue; }
      const idx = end === 'start' ? 0 : b.points.length - 1;
      const p = b.points[idx];
      if (p.x !== node.x || p.z !== node.z) b.points[idx] = { ...p, x: node.x, z: node.z };
    }
  }
}

/** Marca `o` como o objeto editado por último (ele é quem se ajusta numa sobreposição). */
export function markEdited(doc, o) {
  if (!o) return;
  const top = Math.max(0, ...doc.objects.map((x) => x.edited ?? 0));
  if (o.edited !== top || doc.objects.some((x) => x !== o && x.edited === top)) o.edited = top + 1;
}

// ------------------------------------------------------------------ limite de largura
/** Linhas que um corredor não deve atravessar ao engordar (outros corredores, paredes, áreas). */
function obstacleLines(doc, ctx, o) {
  const y0 = ctx.levelY(o.levelId), y1 = ctx.levelY(o.endLevelId || o.levelId);
  const near = (x) => {
    const a = ctx.levelY(x.levelId), b = ctx.levelY(x.endLevelId || x.levelId);
    return Math.min(Math.abs(a - y0), Math.abs(a - y1), Math.abs(b - y0), Math.abs(b - y1)) < 1;
  };
  // corredores ligados a este (ramificação, pai ou emenda) não contam
  const ends = o.closed ? [] : [o.points[0], o.points[o.points.length - 1]];
  const related = (x) => {
    if (Object.values(o.links || {}).some((l) => l?.id === x.id)) return true;
    if (Object.values(x.links || {}).some((l) => l?.id === o.id)) return true;
    if (x.closed || !ends.length) return false;
    const xe = [x.points[0], x.points[x.points.length - 1]];
    return ends.some((p) => xe.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.05));
  };
  const lines = [];
  for (const x of doc.objects) {
    if (x.id === o.id || !x.points || x.points.length < 2 || !near(x)) continue;
    if (x.type === 'corridor') {
      if (related(x)) continue;
      const sm = corridorSamples(x, ctx).samples;
      if (sm.length < 2) continue;
      const fr = computeFrames(sm, x.closed);
      const inside = (pt) => insideCorridor(x, sm, pt, x.walls.thickness);
      for (const side of [1, -1]) {
        const on = side > 0 ? x.walls.left : x.walls.right;
        lines.push({ id: x.id, type: x.type, pts: sideLine(x, sm, fr, side, on ? x.walls.thickness : 0), closed: x.closed, inside });
      }
    } else if (x.type === 'wall' || x.type === 'area') {
      const closed = x.type === 'area' || x.closed;
      const sm = samplePath(x.points, { closed, smooth: x.smooth, spacing: x.proc?.segment || 1 });
      lines.push({ id: x.id, type: x.type, pts: sm, closed, inside: x.type === 'area' ? (pt) => insidePoly(sm, pt) : null });
    }
  }
  return lines;
}

/** Distância de um raio (P + t·d) até a primeira linha, ignorando o que está antes de `tMin`. */
function rayHit(P, d, lines, tMin) {
  return rayHitLine(P, d, lines, tMin).t;
}

/** Como rayHit, mas diz também qual linha foi atingida: { t, line }. */
function rayHitLine(P, d, lines, tMin) {
  let best = Infinity, hitLine = null;
  for (const line of lines) {
    const { pts, closed } = line;
    const n = pts.length;
    const segs = closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const ex = b.x - a.x, ez = b.z - a.z;
      const den = d.x * ez - d.z * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = a.x - P.x, wz = a.z - P.z;
      const t = (wx * ez - wz * ex) / den;
      const u = (wx * d.z - wz * d.x) / den;
      if (u >= 0 && u <= 1 && t > tMin && t < best) { best = t; hitLine = line; }
    }
  }
  return { t: best, line: hitLine };
}

/**
 * Maior meia-largura que o nó `index` pode ter no lado `side` sem que o
 * corredor (com a espessura da parede) entre em outro objeto. Infinity = livre.
 * Obstáculos que já estavam dentro do corredor antes são ignorados.
 */
export function widthLimit(doc, ctx, o, index, side, obstacles = null) {
  const lines = obstacles || obstacleLines(doc, ctx, o);
  if (!lines.length) return Infinity;
  const sm = corridorSamples(o, ctx).samples;
  if (sm.length < 2) return Infinity;
  const fr = computeFrames(sm, o.closed);
  const n = o.points.length;
  const th = (side > 0 ? o.walls.left : o.walls.right) ? o.walls.thickness : 0;
  let limit = Infinity;
  for (let i = 0; i < sm.length; i++) {
    let dc = sm[i].ctrl - index;
    if (o.closed) dc = ((dc + n / 2) % n + n) % n - n / 2;
    if (Math.abs(dc) >= 1) continue;
    const w = dc >= 0 ? 1 - smoothstep(dc) : smoothstep(1 + dc); // peso deste nó na amostra
    if (w < 0.25) continue;
    const f = fr[i];
    const dir = { x: f.nx * side, z: f.nz * side };
    const cur = halfAt(o, sm[i].ctrl, side) * f.miter;
    const t = rayHit(sm[i], dir, lines, cur + th + 0.01);
    if (!Number.isFinite(t)) continue;
    const allowed = t / f.miter - th - 0.02; // meia-largura máxima nesta amostra
    // halfAt = outro·(1-w) + este·w  =>  este ≤ (allowed - outro·(1-w)) / w
    const other = (halfAt(o, sm[i].ctrl, side) - nodeHalf(o, index, side) * w) / (1 - w || 1);
    const lim = w > 0.999 ? allowed : (allowed - other * (1 - w)) / w;
    limit = Math.min(limit, lim);
  }
  return limit;
}
export { obstacleLines };

/**
 * Onde o corredor `o` (já com a mudança aplicada) entra em outro objeto perto do
 * nó `index`. Retorna Map id -> { id, type, overflow, x, z, dx, dz, inside }, com a
 * pior amostra de cada objeto: o ponto atingido, a direção (normal de `o`) e
 * quanto falta para a parede de `o` parar rente. `minHalf(p, side)` = meia-largura
 * de antes (ao engordar, o que já estava dentro dela é ignorado). inside = o eixo
 * de `o` já está dentro do outro (não dá para resolver empurrando).
 */
export function nodeCollisions(doc, ctx, o, index, { sides = [1, -1], obstacles = null, minHalf = null } = {}) {
  const out = new Map();
  const lines = obstacles || obstacleLines(doc, ctx, o);
  if (!lines.length) return out;
  const sm = corridorSamples(o, ctx).samples;
  if (sm.length < 2) return out;
  const fr = computeFrames(sm, o.closed);
  const n = o.points.length;
  const put = (hit) => {
    const prev = out.get(hit.id);
    if (!prev || (hit.inside && !prev.inside) || (hit.inside === prev.inside && hit.overflow > prev.overflow)) out.set(hit.id, hit);
  };
  for (let i = 0; i < sm.length; i++) {
    let dc = sm[i].ctrl - index;
    if (o.closed) dc = ((dc + n / 2) % n + n) % n - n / 2;
    if (Math.abs(dc) >= 1) continue;
    const p = sm[i], f = fr[i];
    if (!minHalf) {
      for (const L of lines) {
        if (L.inside?.(p)) put({ id: L.id, type: L.type, overflow: Infinity, x: p.x, z: p.z, dx: 0, dz: 0, inside: true });
      }
    }
    for (const side of sides) {
      const th = (side > 0 ? o.walls.left : o.walls.right) ? o.walls.thickness : 0;
      const dir = { x: f.nx * side, z: f.nz * side };
      const t0 = minHalf ? minHalf(p, side) * f.miter + th + 0.01 : 0.01;
      const { t, line } = rayHitLine(p, dir, lines, t0);
      if (!line) continue;
      const over = halfAt(o, p.ctrl, side) - (t / f.miter - th - 0.02);
      if (over <= 0) continue;
      put({ id: line.id, type: line.type, overflow: over, x: p.x + dir.x * t, z: p.z + dir.z * t, dx: dir.x, dz: dir.z, inside: false });
    }
  }
  return out;
}

/** Há agentes em cima do corredor Y (mesmo nível) ou patrulhando por ele? */
export function hasAgents(doc, ctx, Y) {
  const sm = corridorSamples(Y, ctx).samples;
  if (sm.length < 2) return false;
  const ys = [ctx.levelY(Y.levelId), ctx.levelY(Y.endLevelId || Y.levelId)];
  return doc.objects.some((a) => a.type === 'agent' && (a.pathId === Y.id
    || (ys.some((y) => Math.abs(ctx.levelY(a.levelId) - y) < 1) && insideCorridor(Y, sm, a, Y.walls.thickness + 0.5))));
}

/**
 * Empurra os nós do corredor Y mais próximos do ponto atingido `hit` (de
 * nodeCollisions) por `amount` metros na direção do empurrão. Pontas ligadas a
 * um pai ou emendadas em outro corredor ficam presas. Retorna se moveu algo.
 */
export function pushCorridor(doc, ctx, Y, hit, amount) {
  const sm = corridorSamples(Y, ctx).samples;
  if (sm.length < 2) return false;
  const c = closestOnPolyline(sm, hit, Y.closed);
  if (!c) return false;
  const n = Y.points.length;
  const a = sm[c.i], b = sm[(c.i + 1) % sm.length];
  const ctrl = a.ctrl + ((b.ctrl ?? a.ctrl) - a.ctrl) * c.f;
  const wrap = (i) => (Y.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const ends = doc.objects.filter((x) => x.type === 'corridor' && x.id !== Y.id && !x.closed && x.points.length >= 2)
    .flatMap((x) => [x.points[0], x.points[x.points.length - 1]]);
  const locked = (i) => {
    if (Y.closed || (i !== 0 && i !== n - 1)) return false;
    if (Y.links?.[i === 0 ? 'start' : 'end']) return true;
    const p = Y.points[i];
    return ends.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.05);
  };
  const idx = [...new Set([wrap(Math.floor(ctrl)), wrap(Math.ceil(ctrl))])].filter((i) => !locked(i));
  if (!idx.length) return false;
  for (const i of idx) {
    const p = Y.points[i];
    Y.points[i] = { ...p, x: p.x + hit.dx * amount, z: p.z + hit.dz * amount };
  }
  return true;
}

/**
 * Área onde uma ponta de corredor em p abriria porta. Retorna null ou
 * { area, x, z (ponto ajustado logo dentro da parede, se perto da borda),
 *   bx, bz (ponto na borda), snap (perto da borda) }.
 */
export function findAreaTarget(doc, ctx, p, y, excludeId) {
  const areas = doc.objects.filter((o) => o.type === 'area' && o.id !== excludeId && o.points.length >= 3)
    .map((o) => ({ o, ol: areaOutline(o, ctx) }));
  const ar = areaAt(areas, p, y, 1.0);
  if (!ar) return null;
  const { o, ol, c } = ar;
  const f = ol.frames[c.i] || { nx: 0, nz: 0 };
  const th = o.walls.enabled ? o.walls.thickness : 0;
  const snap = c.d < 1.0;
  const din = th + 0.5;
  const x = snap ? c.x + f.nx * ol.inside * din : p.x;
  const z = snap ? c.z + f.nz * ol.inside * din : p.z;
  return { area: o, x, z, bx: c.x, bz: c.z, y: ol.y, snap };
}
