// Caminho de um corredor: amostragem com elevação, largura por nó e junções
// (corredores que nascem de outro corredor abrem uma passagem/porta na parede).
import { samplePath, closestOnPolyline } from '../math/curve.js';
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

/**
 * Detecta junções: extremidade de um corredor B sobre o eixo de outro corredor A.
 * Retorna Map id -> { cuts: [...] (aberturas nas paredes deste corredor),
 *                     trims: { start, end } (recuo das paredes/piso nesta ponta) }
 */
export function computeJunctions(ctx) {
  const corridors = ctx.doc.objects.filter((o) => o.type === 'corridor' && o.points.length >= 2);
  const info = new Map(corridors.map((o) => [o.id, { cuts: [], trims: {} }]));
  const paths = new Map(corridors.map((o) => [o.id, corridorSamples(o, ctx).samples]));
  for (const b of corridors) {
    if (b.closed) continue;
    for (const end of ['start', 'end']) {
      const idx = end === 'start' ? 0 : b.points.length - 1;
      const inner = end === 'start' ? 1 : b.points.length - 2;
      const E = b.points[idx];
      const Ey = end === 'start' ? ctx.levelY(b.levelId) : ctx.levelY(b.endLevelId || b.levelId);
      const dx = b.points[inner].x - E.x, dz = b.points[inner].z - E.z;
      const dl = Math.hypot(dx, dz) || 1;
      const dir = { x: dx / dl, z: dz / dl }; // de E para dentro de B
      let best = null;
      for (const a of corridors) {
        if (a.id === b.id) continue;
        const sa = paths.get(a.id);
        const c = closestOnPolyline(sa, E, a.closed);
        if (!c || Math.abs(c.y - Ey) > 1) continue;
        const ctrl = sa[c.i].ctrl + ((sa[(c.i + 1) % sa.length].ctrl ?? sa[c.i].ctrl) - sa[c.i].ctrl) * c.f;
        const nx = c.tz, nz = -c.tx; // normal esquerda de A
        const side = dir.x * nx + dir.z * nz >= 0 ? 1 : -1;
        const halfA = halfAt(a, ctrl, side);
        if (c.d > halfA + 0.35) continue;
        const L = sa[sa.length - 1].s;
        // ponta com ponta (continuação): não corta
        if (!a.closed && (c.s < 0.6 || c.s > L - 0.6)) continue;
        if (!best || c.d < best.c.d) best = { a, c, side, halfA, ctrl };
      }
      if (!best) continue;
      const { a, c, side, halfA } = best;
      const style = b.joins?.[end] || 'door';
      const sinA = Math.max(0.35, Math.abs(c.tx * dir.z - c.tz * dir.x));
      const hb = (nodeHalf(b, idx, 1) + nodeHalf(b, idx, -1)) / 2;
      const thA = a.walls.thickness;
      if (style !== 'none') {
        info.get(a.id).cuts.push({
          side, s: c.s, half: hb / sinA, style, from: b.id, y: c.y,
          wallH: a.walls.height, height: Math.min(b.walls.height, a.walls.height),
        });
      }
      // recua as paredes e o piso de B até a borda de A
      info.get(b.id).trims[end] = {
        floor: Math.max(0, (halfA - 0.02) / sinA),
        walls: (halfA + (style === 'none' ? 0 : thA)) / sinA,
        style,
      };
    }
  }
  return info;
}
