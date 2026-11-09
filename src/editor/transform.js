// Transformações do gizmo (mover, girar, escalar) aplicadas direto no documento.
// Sem Three.js: funções puras sobre o JSON do level, testáveis no Node.
import { snap } from '../util.js';
import { worldTransform, toParentLocal } from '../levels.js';
import { circleOf, circlePoints } from './polar.js';

export const PATH_TYPES = new Set(['corridor', 'wall', 'area']);
export const ROT_STEP = Math.PI / 12; // 15°

/**
 * O que o gizmo pode fazer com cada tipo de objeto.
 * move.y: sobe/desce (assets pela base, itens e luzes pela altura);
 * scale: eixos que esticam (assets e zonas nos eixos locais, curvas no mundo).
 */
export function transformCaps(o) {
  if (!o) return null;
  const t = o.type;
  const circle = !!circleOf(o);
  return {
    move: { x: true, z: true, y: t === 'asset' || t === 'item' || t === 'light' },
    rotate: t !== 'light' && !circle,
    scale: t === 'asset' ? { x: true, y: !o.topLevelId, z: true, uniform: true, yTop: true }
      : t === 'zone' ? { x: true, y: true, z: true, uniform: true }
      : PATH_TYPES.has(t) ? { x: !circle, y: false, z: !circle, uniform: true }
      : null,
    localAxes: t === 'asset' || t === 'zone', // escala segue o giro do objeto
  };
}

/** Só os "de cima": um objeto preso a outro que também está na lista já é levado por ele. */
export function rootsOf(doc, ids) {
  const set = new Set(ids);
  const out = [];
  for (const id of ids) {
    const o = doc.objects.find((x) => x.id === id);
    if (!o) continue;
    let p = o.parentId, carried = false, guard = 0;
    while (p && guard++ < 16) {
      if (set.has(p)) { carried = true; break; }
      p = doc.objects.find((x) => x.id === p)?.parentId;
    }
    if (!carried) out.push(o);
  }
  return out;
}

/** Centro do objeto no chão (x, z) e altura onde o gizmo fica. */
export function pivotOf(o, doc, levelY) {
  if (PATH_TYPES.has(o.type)) {
    const c = circleOf(o);
    if (c) return { x: c.cx, y: levelY(o.levelId), z: c.cz };
    // média dos nós: não muda quando a curva gira ou escala em volta dela
    const n = o.points.length || 1;
    return { x: o.points.reduce((a, p) => a + p.x, 0) / n, y: levelY(o.levelId), z: o.points.reduce((a, p) => a + p.z, 0) / n };
  }
  const w = o.type === 'asset' ? worldTransform(o, doc, levelY) : { x: o.x, z: o.z, y: levelY(o.levelId) + (o.type === 'item' || o.type === 'light' ? o.y || 0 : 0) };
  return { x: w.x, y: w.y, z: w.z };
}

/** Cópia do que a transformação mexe, para aplicar sempre a partir do início do arraste. */
export function captureOrig(o, doc, levelY) {
  return {
    id: o.id,
    points: o.points ? o.points.map((p) => ({ ...p })) : null,
    x: o.x, z: o.z, y: o.y, rotY: o.rotY || 0,
    scale: o.scale ? { ...o.scale } : null,
    w: o.w, d: o.d, h: o.h,
    world: o.parentId ? worldTransform(o, doc, levelY) : null,
  };
}

/** Grava x/z do mundo num objeto, convertendo para o pai quando está preso. */
function setWorldXZ(doc, o, x, z, levelY) {
  if (o.parentId) {
    const parent = doc.objects.find((p) => p.id === o.parentId);
    if (parent) {
      const loc = toParentLocal(worldTransform(parent, doc, levelY), x, z);
      o.x = loc.x; o.z = loc.z;
      return;
    }
  }
  o.x = x; o.z = z;
}

/**
 * Move objetos (dx, dz) no mundo a partir das cópias `origs`.
 * Ímã: um objeto sozinho encaixa a posição na grade; vários (ou curvas) encaixam o deslocamento,
 * para não desmontar o arranjo. Eixo travado (delta 0) não é encaixado.
 */
export function moveObjects(doc, origs, dx, dz, { grid = 0, levelY } = {}) {
  const single = origs.length === 1;
  const half = grid / 2;
  let sdx = dx, sdz = dz;
  if (!single || PATH_TYPES.has(doc.objects.find((x) => x.id === origs[0].id)?.type)) {
    if (dx) sdx = snap(dx, half);
    if (dz) sdz = snap(dz, half);
  }
  for (const og of origs) {
    const o = doc.objects.find((x) => x.id === og.id);
    if (!o) continue;
    if (og.points) {
      o.points = og.points.map(({ att, ...p }) => ({ ...p, x: p.x + sdx, z: p.z + sdz })); // mover solta as pontas presas
      continue;
    }
    const bx = og.world ? og.world.x : og.x, bz = og.world ? og.world.z : og.z;
    let x = bx + sdx, z = bz + sdz;
    if (single) {
      const step = o.parentId ? grid / 4 : half;
      if (dx) x = snap(bx + dx, step);
      if (dz) z = snap(bz + dz, step);
    }
    setWorldXZ(doc, o, x, z, levelY);
  }
  return { dx: sdx, dz: sdz };
}

/**
 * Gira objetos em volta de `pivot` (ângulo no sentido do rotY do Three.js).
 * Sozinho com ímã: o rotY final encaixa de 15 em 15°; vários: o giro encaixa.
 */
export function rotateObjects(doc, origs, pivot, angle, { snapOn = false, levelY } = {}) {
  const single = origs.length === 1;
  let a = angle;
  if (snapOn && (!single || origs[0].points)) a = snap(angle, ROT_STEP);
  const c = Math.cos(a), s = Math.sin(a);
  const turn = (x, z) => {
    const rx = x - pivot.x, rz = z - pivot.z;
    return { x: pivot.x + rx * c + rz * s, z: pivot.z - rx * s + rz * c };
  };
  for (const og of origs) {
    const o = doc.objects.find((x) => x.id === og.id);
    if (!o) continue;
    if (og.points) {
      o.points = og.points.map(({ att, ...p }) => ({ ...p, ...turn(p.x, p.z) }));
      continue;
    }
    let rot = og.rotY + a;
    if (snapOn && single) {
      // o rotY do mundo encaixa (filho: o do pai entra na conta)
      const parentRot = og.world ? og.world.rotY - og.rotY : 0;
      rot = snap(parentRot + rot, ROT_STEP) - parentRot;
      a = rot - og.rotY;
    }
    o.rotY = +rot.toFixed(6);
    if (!single) {
      const w = og.world || og;
      const p = turn(w.x, w.z);
      setWorldXZ(doc, o, p.x, p.z, levelY);
    }
  }
  return a;
}

/**
 * Escala um objeto pelos fatores (fx, fy, fz) a partir da cópia.
 * Assets: escala X/Y/Z; zonas: largura/altura/fundo; curvas: os nós em volta de `pivot`
 * (salas circulares só no raio). Ímã: assets de 0,1 em 0,1, zonas e curvas de meio em meio metro.
 */
export function scaleObject(doc, og, pivot, fx, fy, fz, { snapOn = false } = {}) {
  const o = doc.objects.find((x) => x.id === og.id);
  if (!o) return null;
  const pos = (v) => Math.max(0.05, v);
  if (o.type === 'asset') {
    const st = (v) => +(snapOn ? Math.max(0.1, snap(v, 0.1)) : pos(v)).toFixed(3);
    o.scale = { ...o.scale, x: st(og.scale.x * fx), z: st(og.scale.z * fz) };
    if (!o.topLevelId) o.scale.y = st(og.scale.y * fy);
    return o.scale;
  }
  if (o.type === 'zone') {
    const st = (v) => +(snapOn ? Math.max(0.5, snap(v, 0.5)) : Math.max(0.3, v)).toFixed(3);
    o.w = st(og.w * fx); o.h = st(og.h * fy); o.d = st(og.d * fz);
    return { x: o.w, y: o.h, z: o.d };
  }
  if (og.points) {
    const c = circleOf({ ...o, points: og.points });
    if (c) {
      let r = c.r * fx;
      r = snapOn ? Math.max(0.5, snap(r, 0.5)) : Math.max(0.5, r);
      o.points = circlePoints(c.cx, c.cz, r);
      return { r };
    }
    o.points = og.points.map(({ att, ...p }) => ({ ...p, x: pivot.x + (p.x - pivot.x) * fx, z: pivot.z + (p.z - pivot.z) * fz }));
    return { x: fx, z: fz };
  }
  return null;
}
