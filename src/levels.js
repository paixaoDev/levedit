// Transformação vertical com encaixe nos andares (a "grade vertical"):
// objetos que vão até outro andar, objetos presos a outro objeto (pai/filho)
// e em quais andares cada objeto aparece. Funções puras, sem Three.js.

/** Altura mínima de algo que vai até outro andar. */
const MIN_HEIGHT = 0.1;

const levelMap = (doc) => new Map(doc.levels.map((l) => [l.id, l.elevation]));
const byId = (doc) => new Map(doc.objects.map((o) => [o.id, o]));

/** Tipos com paredes cuja altura pode encaixar num andar. */
export const WALL_TYPES = new Set(['wall', 'corridor', 'area']);

/** Altura das paredes de um caminho (parede, corredor, área). */
export function wallHeightOf(o) {
  return o.type === 'wall' ? o.height : o.walls?.height;
}

export function setWallHeight(o, h) {
  if (o.type === 'wall') o.height = h;
  else if (o.walls) o.walls.height = h;
}

/**
 * Posição no mundo de um asset, somando a do pai quando está preso a outro.
 * As coordenadas de um filho (x, z, y, rotY) são relativas ao pai, sem a escala dele.
 */
export function worldTransform(o, doc, levelY = (id) => levelMap(doc).get(id) ?? 0, depth = 0) {
  const parent = o.parentId && depth < 8 ? doc.objects.find((x) => x.id === o.parentId) : null;
  if (!parent) return { x: o.x, z: o.z, y: levelY(o.levelId) + (o.y || 0), rotY: o.rotY || 0 };
  const p = worldTransform(parent, doc, levelY, depth + 1);
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  return { x: p.x + o.x * c + o.z * s, z: p.z - o.x * s + o.z * c, y: p.y + (o.y || 0), rotY: p.rotY + (o.rotY || 0) };
}

/** Converte um ponto do mundo para as coordenadas locais do pai (x, z). */
export function toParentLocal(parentWorld, x, z) {
  const dx = x - parentWorld.x, dz = z - parentWorld.z;
  const c = Math.cos(parentWorld.rotY), s = Math.sin(parentWorld.rotY);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** Ids de um objeto e de tudo que está preso nele (filhos, netos...). */
export function withDescendants(doc, ids) {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of doc.objects) if (o.parentId && out.has(o.parentId) && !out.has(o.id)) { out.add(o.id); grew = true; }
  }
  return out;
}

/**
 * Base e topo (Y do mundo) de um asset que vai até outro andar.
 * Retorna null quando o asset não tem andar de topo (usa a escala Y normal).
 */
export function assetSpan(o, levelY, baseY = levelY(o.levelId) + (o.y || 0)) {
  if (o?.type !== 'asset' || !o.topLevelId) return null;
  const top = Math.max(baseY + MIN_HEIGHT, levelY(o.topLevelId) + (o.topOffset || 0));
  return { base: baseY, top, height: top - baseY };
}

/** Altura total do asset, com a escala Y quando não vai até outro andar. */
export function assetHeight(o, levelY, unitHeight = 1) {
  const span = assetSpan(o, levelY);
  return span ? span.height : unitHeight * (o.scale?.y ?? 1);
}

/** Altura que as paredes devem ter para chegar ao andar de topo (+ ajuste). */
export function spanWallHeight(o, levelY) {
  return Math.max(MIN_HEIGHT, levelY(o.topLevelId) + (o.topOffset || 0) - levelY(o.levelId));
}

/**
 * Roda a cada mutação: paredes que vão até um andar ganham a altura certa
 * (acompanham a elevação) e filhos ficam no andar do pai.
 */
export function syncVertical(doc) {
  const lv = levelMap(doc);
  const levelY = (id) => lv.get(id) ?? 0;
  const ids = byId(doc);
  for (const o of doc.objects) {
    if (o.topLevelId && !lv.has(o.topLevelId)) { o.topLevelId = null; o.topOffset = 0; }
    if (o.topLevelId && WALL_TYPES.has(o.type)) setWallHeight(o, +spanWallHeight(o, levelY).toFixed(3));
    if (o.parentId) {
      const p = ids.get(o.parentId);
      if (!p) o.parentId = null;
      else o.levelId = p.levelId;
    }
  }
}

/**
 * Ids dos andares em que o objeto aparece: o próprio andar, o andar final de
 * um corredor/escada, o andar de topo e todo andar que ele atravessa.
 */
export function objectLevelIds(o, doc) {
  const ids = new Set([o.levelId]);
  if (o.type === 'corridor' && o.endLevelId) ids.add(o.endLevelId);
  if (o.type === 'connector') {
    if (o.fromLevelId) ids.add(o.fromLevelId);
    if (o.toLevelId) ids.add(o.toLevelId);
  }
  const lv = levelMap(doc);
  const levelY = (id) => lv.get(id) ?? 0;
  let base = null, top = null;
  if (o.type === 'asset') {
    base = worldTransform(o, doc, levelY).y;
    const span = assetSpan(o, levelY, base);
    if (span) top = span.top;
  } else if (WALL_TYPES.has(o.type) && o.topLevelId) {
    base = levelY(o.levelId);
    top = base + (wallHeightOf(o) ?? 0);
  }
  if (o.topLevelId && lv.has(o.topLevelId)) ids.add(o.topLevelId);
  if (base != null) {
    // filho que fica acima de outro andar aparece nele também
    let below = null;
    for (const l of doc.levels) if (l.elevation <= base + 1e-3 && (!below || l.elevation > below.elevation)) below = l;
    if (below) ids.add(below.id);
    if (top != null) for (const l of doc.levels) if (l.elevation > base + 1e-3 && l.elevation < top - 1e-3) ids.add(l.id);
  }
  return ids;
}

/**
 * Encaixa uma altura de topo nos andares: perto de um andar (tol) vira esse
 * andar; longe de todos, arredonda no passo e fica preso ao andar logo abaixo
 * com um ajuste (offset). Retorna { y, levelId, offset }.
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
 * Encaixe vertical genérico: perto de uma marca (andares, topo do pai...) vira
 * a marca; senão arredonda no passo. Retorna { y, mark } (mark = índice ou -1).
 */
export function snapVertical(y, marks, { tol = 0.3, step = 0.25, free = false } = {}) {
  if (free) return { y, mark: -1 };
  let best = -1, bd = tol;
  marks.forEach((m, i) => { const d = Math.abs(m - y); if (d <= bd) { bd = d; best = i; } });
  if (best >= 0) return { y: marks[best], mark: best };
  return { y: Math.round(y / step) * step, mark: -1 };
}

/**
 * Altura (a partir da base do pai) para um objeto novo preso a ele: no meio
 * do primeiro vão entre andares que ainda não tem nada preso.
 */
export function suggestChildHeight(parent, doc) {
  const lv = levelMap(doc);
  const levelY = (id) => lv.get(id) ?? 0;
  const base = worldTransform(parent, doc, levelY).y;
  const span = assetSpan(parent, levelY, base);
  const top = span ? span.top : base + (parent.scale?.y ?? 1);
  const marks = [base, ...doc.levels.map((l) => l.elevation).filter((e) => e > base + 1e-3 && e < top - 1e-3), top]
    .sort((a, b) => a - b);
  const used = doc.objects.filter((o) => o.parentId === parent.id).map((o) => o.y || 0);
  for (let i = 0; i < marks.length - 1; i++) {
    const h = Math.round(((marks[i] + marks[i + 1]) / 2 - base) * 4) / 4;
    if (!used.some((y) => Math.abs(y - h) < 0.6)) return h;
  }
  return Math.round(((top - base) / 2) * 4) / 4;
}
