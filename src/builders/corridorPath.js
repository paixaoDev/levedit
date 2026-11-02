// Caminho de um corredor: amostragem com elevação, largura por nó e junções
// (corredores que nascem de outro corredor abrem uma passagem/porta na parede).
import { samplePath, closestOnPolyline, computeFrames, offsetPoints, polylineCrossings } from '../math/curve.js';
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
  if (!stairs) {
    for (const p of s) p.y = lerp(y0, y1, y1 === y0 ? 0 : smoothstep(p.u));
    return { samples: s, y0, y1 };
  }
  // Degraus: insere fronteiras exatas de cada degrau ao longo do arco
  const L = s[s.length - 1].s;
  const rise = y1 - y0;
  const N = Math.max(1, Math.round(Math.abs(rise) / Math.max(0.05, o.stepHeight || 0.25)));
  const tread = L / N;
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
  for (let k = 1; k <= N; k++) marks.add(+(k * tread).toFixed(4));
  const sorted = [...marks].sort((a, b) => a - b);
  for (const sv of sorted) {
    const k = Math.min(N, Math.floor((sv + 1e-4) / tread));
    const p = at(Math.min(L, sv));
    const isBoundary = k > 0 && Math.abs(sv - k * tread) < 2e-3;
    if (isBoundary) out.push({ ...p, y: stepY(k - 1) });
    out.push({ ...p, y: stepY(k) });
  }
  return { samples: out, y0, y1, stepped: { y0, rise, step: Math.abs(rise) / N } };
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
      if (!best) continue;
      const { a, c, side, halfA } = best;
      const style = b.joins?.[end] || 'door';
      const sinA = Math.max(0.35, Math.abs(c.tx * dir.z - c.tz * dir.x));
      const hb = (nodeHalf(b, idx, 1) + nodeHalf(b, idx, -1)) / 2;
      const thA = a.walls.thickness, thB = b.walls.thickness;
      const sa = paths.get(a.id), fa = framesOf(a), fb = framesOf(b);
      const Lb = sb[sb.length - 1].s;
      const reach = (halfA + thA + 2) / sinA + hb + 2;
      const ext = (line) => (a.closed ? line : extendLine(line, 8));
      const aEdge = ext(sideLine(a, sa, fa, side, -0.02));
      const aInner = ext(sideLine(a, sa, fa, side, 0));
      const aCenter = ext(sideLine(a, sa, fa, side, thA / 2));
      const aOuter = ext(sideLine(a, sa, fa, side, thA));

      const trim = { floor: 0, walls: 0, style, sides: {} };
      const fallbackFloor = Math.max(0, (halfA - 0.02) / sinA);
      const fallbackWalls = (halfA + (style === 'none' ? 0 : thA / 2)) / sinA;
      const faces = [];
      for (const bs of [1, -1]) {
        const bEdge = nearEnd(sideLine(b, sb, fb, bs, 0), end, reach);
        const bWall = nearEnd(sideLine(b, sb, fb, bs, thB / 2), end, reach);
        const fl = crossNearEnd(bEdge, aEdge, end, Lb, a.closed);
        const wl = crossNearEnd(bWall, style === 'none' ? aInner : aCenter, end, Lb, a.closed);
        trim.sides[bs] = {
          floor: fl ? fl.dist : fallbackFloor, floorPt: fl ? { x: fl.x, z: fl.z } : null,
          walls: wl ? wl.dist : fallbackWalls, wallPt: wl ? { x: wl.x, z: wl.z } : null,
        };
        // face interna da parede de B cruzando a faixa da parede de A
        const fi = crossNearEnd(bEdge, aInner, end, Lb, a.closed);
        const fo = crossNearEnd(bEdge, aOuter, end, Lb, a.closed);
        if (fi || fo) faces.push([fi?.sQ ?? fo.sQ, fo?.sQ ?? fi.sQ]);
      }
      trim.floor = Math.max(trim.sides[1].floor, trim.sides[-1].floor);
      trim.walls = Math.max(trim.sides[1].walls, trim.sides[-1].walls);
      info.get(b.id).trims[end] = trim;

      if (style !== 'none') {
        let s0, s1;
        if (faces.length === 2) {
          const [p, q] = (faces[0][0] + faces[0][1]) / 2 <= (faces[1][0] + faces[1][1]) / 2 ? faces : [faces[1], faces[0]];
          // a parede de A vai até onde a face de B sai da faixa (sem fresta)
          s0 = Math.max(p[0], p[1]);
          s1 = Math.min(q[0], q[1]);
          if (s1 - s0 < 0.2) { const m = (s0 + s1) / 2; s0 = m - 0.1; s1 = m + 0.1; }
        } else {
          s0 = c.s - hb / sinA; s1 = c.s + hb / sinA;
        }
        info.get(a.id).cuts.push({
          side, s0, s1, s: (s0 + s1) / 2, half: (s1 - s0) / 2, style, from: b.id, y: c.y,
          wallH: a.walls.height, height: Math.min(b.walls.height, a.walls.height),
        });
      }
    }
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
