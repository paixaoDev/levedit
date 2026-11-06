// Objetos que atravessam vários andares (prédios, torres, blocos) e
// plataformas entre andares. Funções puras, sem Three.js, para testar no node.

/** Lados onde uma plataforma pode ficar presa ao bloco. */
export const LEDGE_SIDES = {
  front: 'Frente',
  back: 'Trás',
  left: 'Esquerda',
  right: 'Direita',
  all: 'Volta toda',
};

export const LEDGE_DEFAULTS = { h: 2, side: 'front', depth: 1.2, width: 1, thickness: 0.2 };

/** Altura mínima de um asset que atravessa andares. */
const MIN_HEIGHT = 0.1;

/**
 * Base e topo (em Y do mundo) de um asset que vai até outro andar.
 * Retorna null quando o asset não tem andar de topo (usa a escala Y normal).
 */
export function assetSpan(o, levelY) {
  if (o?.type !== 'asset' || !o.topLevelId) return null;
  const base = levelY(o.levelId) + (o.y || 0);
  const top = Math.max(base + MIN_HEIGHT, levelY(o.topLevelId) + (o.topOffset || 0));
  return { base, top, height: top - base };
}

/** Altura total do asset (base até o topo), com a escala Y quando não atravessa andares. */
export function assetHeight(o, levelY, unitHeight = 1) {
  const span = assetSpan(o, levelY);
  return span ? span.height : unitHeight * (o.scale?.y ?? 1);
}

/**
 * Ids dos andares em que o objeto aparece: o próprio andar, o andar final de
 * um corredor/escada e, num asset que atravessa andares, todo andar entre a
 * base e o topo (o andar do topo inclusive, pois o teto vira chão dele).
 */
export function objectLevelIds(o, doc) {
  const ids = new Set([o.levelId]);
  if (o.type === 'corridor' && o.endLevelId) ids.add(o.endLevelId);
  if (o.type === 'connector') {
    if (o.fromLevelId) ids.add(o.fromLevelId);
    if (o.toLevelId) ids.add(o.toLevelId);
  }
  const levels = new Map(doc.levels.map((l) => [l.id, l.elevation]));
  const span = assetSpan(o, (id) => levels.get(id) ?? 0);
  if (span) {
    for (const l of doc.levels) {
      if (l.elevation >= span.base - 1e-3 && l.elevation <= span.top + 1e-3) ids.add(l.id);
    }
  }
  return ids;
}

/**
 * Encaixa uma altura de topo nos andares: perto de um andar (tol) vira esse
 * andar; longe de todos, arredonda no passo e fica preso ao andar logo abaixo
 * com um ajuste (topOffset). Retorna { y, levelId, offset }.
 */
export function snapTopToLevels(y, levels, { tol = 0.4, step = 0.25, free = false, minY = -Infinity } = {}) {
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  if (!sorted.length) return { y, levelId: null, offset: 0 };
  if (!free) {
    let best = null;
    for (const l of sorted) {
      const d = Math.abs(l.elevation - y);
      if (d <= tol && l.elevation > minY + 1e-3 && (!best || d < best.d)) best = { l, d };
    }
    if (best) return { y: best.l.elevation, levelId: best.l.id, offset: 0 };
    y = Math.round(y / step) * step;
  }
  y = Math.max(y, minY + MIN_HEIGHT);
  let below = sorted[0];
  for (const l of sorted) if (l.elevation <= y + 1e-6) below = l;
  return { y, levelId: below.id, offset: y - below.elevation };
}

/**
 * Altura sugerida (a partir da base) para uma plataforma nova: no meio do
 * primeiro vão entre andares que ainda não tem plataforma.
 */
export function suggestLedgeHeight(o, doc) {
  const levels = new Map(doc.levels.map((l) => [l.id, l.elevation]));
  const levelY = (id) => levels.get(id) ?? 0;
  const span = assetSpan(o, levelY);
  const base = levelY(o.levelId) + (o.y || 0);
  const top = span ? span.top : base + (o.scale?.y ?? 1);
  const marks = [base, ...doc.levels.map((l) => l.elevation).filter((e) => e > base + 1e-3 && e < top - 1e-3), top]
    .sort((a, b) => a - b);
  const used = new Set((o.ledges || []).map((l) => Math.round(l.h * 100)));
  for (let i = 0; i < marks.length - 1; i++) {
    const h = Math.round(((marks[i] + marks[i + 1]) / 2 - base) * 4) / 4;
    if (!used.has(Math.round(h * 100))) return h;
  }
  return Math.round(((top - base) / 2) * 4) / 4;
}
