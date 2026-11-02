// Converte objetos do documento em grupos Three.js (procedural).
import * as THREE from 'three';
import { samplePath, computeFrames, offsetPoints, signedArea } from '../math/curve.js';
import { floorGeometry, slabGeometry, wallGeometry, boxBetween, ribbon, sharedGeometry } from '../render/geometry.js';
import { makeMesh } from '../render/materials.js';
import { buildWallLine } from './walls.js';
import { buildAssetParts, carParts } from './assets.js';
import { rng, lerp, smoothstep, shade } from '../util.js';

/** Contexto: elevação dos níveis. */
export function makeContext(doc) {
  const levels = new Map(doc.levels.map((l) => [l.id, l]));
  return {
    doc,
    levels,
    levelY: (id) => levels.get(id)?.elevation ?? 0,
  };
}

export function buildObject(obj, ctx) {
  let g;
  switch (obj.type) {
    case 'corridor': g = buildCorridor(obj, ctx); break;
    case 'wall': g = buildWall(obj, ctx); break;
    case 'area': g = buildArea(obj, ctx); break;
    case 'connector': g = buildConnector(obj, ctx); break;
    case 'asset': g = buildAsset(obj, ctx); break;
    case 'agent': g = buildAgent(obj, ctx); break;
    default: g = new THREE.Group();
  }
  g.userData.objId = obj.id;
  g.userData.levelId = obj.levelId;
  g.name = obj.name || obj.type;
  return g;
}

// ---------------------------------------------------------------- caminhos

/** Amostra o caminho e aplica o perfil de elevação (rampa ou degraus). */
export function corridorSamples(o, ctx) {
  const y0 = ctx.levelY(o.levelId);
  const y1 = o.endLevelId ? ctx.levelY(o.endLevelId) : y0;
  const stairs = o.rampStyle === 'stairs' && Math.abs(y1 - y0) > 1e-3;
  let s = samplePath(o.points, { closed: o.closed, smooth: o.smooth, spacing: o.proc?.segment || 1 });
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
    return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), s: sv, u: sv / L };
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

function buildCorridor(o, ctx) {
  const group = new THREE.Group();
  const { samples, stepped } = corridorSamples(o, ctx);
  if (samples.length < 2) return group;
  const closed = o.closed;
  const frames = computeFrames(samples, closed);
  const half = o.width / 2;
  const left = offsetPoints(samples, frames, half);
  const right = offsetPoints(samples, frames, -half);

  if (o.floor.enabled) {
    const fl = makeMesh(floorGeometry(left, right, o.floor.thickness, { closed }), o.floor.color, { threshold: 30 });
    fl.userData.floor = true;
    group.add(fl);
  }

  const W = o.walls;
  const sides = [];
  if (W.left) sides.push(1);
  if (W.right) sides.push(-1);
  // Em degraus, as paredes seguem o perfil linear (topo liso) e descem até o degrau.
  let wallSamples = samples, wallFrames = frames, extra = 0;
  if (stepped) {
    wallSamples = samplePath(o.points, { closed, smooth: o.smooth, spacing: o.proc?.segment || 1 });
    const L = wallSamples[wallSamples.length - 1].s || 1;
    for (const p of wallSamples) p.y = stepped.y0 + (stepped.rise * p.s) / L - stepped.step;
    wallFrames = computeFrames(wallSamples, closed);
    extra = stepped.step;
  }
  for (const side of sides) {
    const center = offsetPoints(wallSamples, wallFrames, side * (half + W.thickness / 2));
    group.add(buildWallLine(center, {
      height: W.height + extra, thickness: W.thickness, color: W.color, mode: W.mode, proc: o.proc, closed, seedOffset: side > 0 ? 1 : 2,
    }));
  }
  if (!closed) {
    const capW = (i) => {
      const a = offsetPoints([samples[i]], [frames[i]], half + W.thickness)[0];
      const b = offsetPoints([samples[i]], [frames[i]], -half - W.thickness)[0];
      return makeMesh(boxBetween(a, b, W.thickness, samples[i].y, W.height), W.color);
    };
    if (W.capStart) group.add(capW(0));
    if (W.capEnd) group.add(capW(samples.length - 1));
  }

  buildDecorations(group, samples, frames, o.deco, {
    half, closed, wallHeight: W.height, wallThickness: W.thickness, wallColor: W.color,
    sides: (o.deco.side === 'left' ? [1] : o.deco.side === 'right' ? [-1] : [1, -1]).map((side) => ({ side, edge: half, into: -1 })),
  });
  return group;
}

function buildWall(o, ctx) {
  const group = new THREE.Group();
  const y = ctx.levelY(o.levelId);
  const s = samplePath(o.points, { closed: o.closed, smooth: o.smooth, spacing: o.proc?.segment || 1 });
  if (s.length < 2) return group;
  for (const p of s) p.y = y;
  group.add(buildWallLine(s, { height: o.height, thickness: o.thickness, color: o.color, mode: o.mode, proc: o.proc, closed: o.closed }));
  return group;
}

function buildArea(o, ctx) {
  const group = new THREE.Group();
  const y = ctx.levelY(o.levelId);
  const s = samplePath(o.points, { closed: true, smooth: o.smooth, spacing: o.proc?.segment || 1 });
  if (s.length < 3) return group;
  for (const p of s) p.y = y;
  if (o.floor.enabled) {
    const fl = makeMesh(slabGeometry(s, y, o.floor.thickness), o.floor.color, { threshold: 30 });
    fl.userData.floor = true;
    group.add(fl);
  }
  const frames = computeFrames(s, true);
  // Sinal "para dentro" no referencial da normal esquerda
  const inside = signedArea(s) > 0 ? -1 : 1;
  if (o.walls.enabled) {
    const center = offsetPoints(s, frames, inside * (o.walls.thickness / 2));
    group.add(buildWallLine(center, { ...o.walls, proc: o.proc, closed: true }));
  }
  const side = o.deco.side;
  const th = o.walls.enabled ? o.walls.thickness : 0;
  const inner = { side: inside, edge: th, into: 1 };
  const outer = { side: -inside, edge: 0, into: 1 };
  buildDecorations(group, s, frames, o.deco, {
    closed: true, wallHeight: o.walls.height, wallThickness: th, wallColor: o.walls.color,
    sides: side === 'outside' ? [outer] : side === 'both' ? [inner, outer] : [inner],
  });
  return group;
}

// ---------------------------------------------------------------- decoração

const FLOWER_COLORS = ['#d9a441', '#b56b7a', '#ffffff', '#c0632f', '#e9c6d0'];

function interp(samples, frames, sv, closed) {
  let j = 1;
  while (j < samples.length - 1 && samples[j].s < sv) j++;
  const a = samples[j - 1], b = samples[j];
  const f = b.s - a.s > 1e-6 ? Math.max(0, Math.min(1, (sv - a.s) / (b.s - a.s))) : 0;
  const fa = frames[j - 1], fb = frames[j];
  return {
    x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), y: lerp(a.y ?? 0, b.y ?? 0, f),
    nx: lerp(fa.nx, fb.nx, f), nz: lerp(fa.nz, fb.nz, f), tx: lerp(fa.tx, fb.tx, f), tz: lerp(fa.tz, fb.tz, f),
  };
}

function buildDecorations(group, samples, frames, deco, opt) {
  if (!deco || deco.type === 'none') return;
  const rnd = rng((deco.seed || 1) * 7919);
  const L = samples[samples.length - 1].s;
  const totalL = opt.closed ? L + Math.hypot(samples[0].x - samples.at(-1).x, samples[0].z - samples.at(-1).z) : L;
  const color = deco.color;
  const inset = deco.inset;

  // Faixas contínuas: calçada / cerca viva
  if (deco.type === 'sidewalk' || deco.type === 'hedge') {
    for (const { side, edge, into } of opt.sides) {
      if (deco.type === 'sidewalk') {
        const a = side * edge, b = side * (edge + into * inset * 2);
        const outer = offsetPoints(samples, frames, a);
        const inner = offsetPoints(samples, frames, b);
        const L2 = a > b ? outer : inner, R2 = a > b ? inner : outer;
        const yb = samples.map((p) => (p.y ?? 0) - 0.02);
        const yt = samples.map((p) => (p.y ?? 0) + 0.18);
        const m = makeMesh(ribbon(L2, R2, yb, yt, { closed: opt.closed }), color, { threshold: 30 });
        m.userData.floor = true;
        group.add(m);
      } else {
        const c = offsetPoints(samples, frames, side * (edge + into * inset));
        group.add(makeMesh(wallGeometry(c, 1.1, 0.7, { closed: opt.closed, caps: !opt.closed }), color, { threshold: 30 }));
      }
    }
    return;
  }

  const spacing = lerp(6, 1.1, Math.max(0, Math.min(1, deco.density)));
  for (const { side, edge, into } of opt.sides) {
    for (let sv = spacing * 0.5 + rnd() * spacing * 0.3; sv < (opt.closed ? L : totalL); sv += spacing * (0.75 + rnd() * 0.5)) {
      const p = interp(samples, frames, sv, opt.closed);
      const rot = Math.atan2(p.tx, p.tz);
      const off = deco.type === 'pillars' ? edge : edge + into * (inset + rnd() * inset * 0.3);
      const x = p.x + p.nx * side * off, z = p.z + p.nz * side * off;
      const item = decoItem(deco.type, color, rnd, opt);
      item.position.set(x, p.y, z);
      item.rotation.y = rot;
      group.add(item);
    }
  }
}

function decoItem(type, color, rnd, opt) {
  const g = new THREE.Group();
  const box = (w, h, d) => sharedGeometry(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
  switch (type) {
    case 'flowers': {
      const planter = makeMesh(box(1.4, 0.45, 0.9), '#d8cbb3');
      planter.position.y = 0.225;
      g.add(planter);
      const leaf = sharedGeometry('ico0.22', () => new THREE.IcosahedronGeometry(0.22, 0));
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const isFlower = rnd() < 0.5;
        const m = makeMesh(leaf, isFlower ? FLOWER_COLORS[Math.floor(rnd() * FLOWER_COLORS.length)] : color, { threshold: 50, collider: false });
        m.position.set((rnd() - 0.5) * 1.0, 0.55 + rnd() * 0.15, (rnd() - 0.5) * 0.5);
        m.scale.setScalar(isFlower ? 0.7 : 1.1);
        g.add(m);
      }
      break;
    }
    case 'rocks': {
      const geo = sharedGeometry('dod0.5', () => new THREE.DodecahedronGeometry(0.5, 0));
      const m = makeMesh(geo, color, { threshold: 30 });
      const s = 0.4 + rnd() * 1.0;
      m.scale.set(s, s * (0.5 + rnd() * 0.4), s * (0.7 + rnd() * 0.5));
      m.rotation.set(rnd(), rnd() * 6, rnd());
      m.position.y = 0.15 * s;
      g.add(m);
      break;
    }
    case 'pillars': {
      const h = opt.wallHeight + 0.3;
      const m = makeMesh(box(0.7, 1, 0.7), opt.wallColor);
      m.scale.y = h;
      m.position.y = h / 2;
      g.add(m);
      break;
    }
    case 'crates': {
      const stack = 1 + (rnd() < 0.3 ? 1 : 0);
      for (let i = 0; i < stack; i++) {
        const m = makeMesh(box(0.9, 0.9, 0.9), i ? shade(color, 0.15) : color);
        m.position.y = 0.45 + i * 0.9;
        m.rotation.y = (rnd() - 0.5) * 0.6;
        g.add(m);
      }
      break;
    }
    case 'lamps': {
      const pole = makeMesh(sharedGeometry('lamp-pole', () => new THREE.CylinderGeometry(0.07, 0.1, 3.4, 8)), '#5b5144');
      pole.position.y = 1.7;
      const head = makeMesh(sharedGeometry('lamp-head', () => new THREE.IcosahedronGeometry(0.28, 1)), color, { threshold: 40 });
      head.position.y = 3.5;
      g.add(pole, head);
      break;
    }
    default: break;
  }
  return g;
}

// ---------------------------------------------------------------- conectores

export function connectorDims(o, ctx) {
  const yf = ctx.levelY(o.fromLevelId ?? o.levelId);
  const yt = ctx.levelY(o.toLevelId ?? o.levelId);
  const base = Math.min(yf, yt);
  const rise = Math.max(0.01, Math.abs(yt - yf));
  const run = rise * (o.style === 'ramp' ? Math.max(o.slope, 2.5) : o.slope);
  return { base, rise, run };
}

function buildConnector(o, ctx) {
  const group = new THREE.Group();
  const { base, rise, run } = connectorDims(o, ctx);
  const w = o.width;
  if (o.style === 'ramp') {
    const L = [{ x: w / 2, z: 0, y: 0 }, { x: w / 2, z: run, y: rise }];
    const R = [{ x: -w / 2, z: 0, y: 0 }, { x: -w / 2, z: run, y: rise }];
    const m = makeMesh(floorGeometry(L, R, 0.3), o.color);
    m.userData.floor = true;
    group.add(m);
  } else {
    const N = Math.max(1, Math.round(rise / Math.max(0.05, o.stepHeight)));
    const tread = run / N;
    for (let i = 0; i < N; i++) {
      const h = (rise * (i + 1)) / N;
      const m = makeMesh(boxBetween({ x: 0, z: i * tread }, { x: 0, z: (i + 1) * tread }, w, 0, h), o.color);
      m.userData.floor = true;
      group.add(m);
    }
  }
  if (o.rails) {
    for (const sx of [w / 2 + 0.05, -w / 2 - 0.05]) {
      const c = [{ x: sx, z: 0, y: 0 }, { x: sx, z: run, y: rise }];
      group.add(makeMesh(wallGeometry(c, 1.0, 0.1), shade(o.color, -0.25)));
    }
  }
  group.position.set(o.x, base, o.z);
  group.rotation.y = o.rotY;
  return group;
}

// ---------------------------------------------------------------- assets

function buildAsset(o, ctx) {
  const group = new THREE.Group();
  for (const p of buildAssetParts(o)) {
    if (!o.collider) p.traverse((m) => { if (m.isMesh) m.userData.collider = false; });
    group.add(p);
  }
  group.position.set(o.x, ctx.levelY(o.levelId) + (o.y || 0), o.z);
  group.rotation.y = o.rotY;
  group.scale.set(o.scale.x, o.scale.y, o.scale.z);
  return group;
}

// ---------------------------------------------------------------- agentes

/** Corpo visual de um agente (usado no editor e no modo jogo). */
export function buildAgentBody(o) {
  const g = new THREE.Group();
  const c = o.color;
  const cap = (r, l) => sharedGeometry(`cap${r},${l}`, () => new THREE.CapsuleGeometry(r, l, 3, 10));
  const box = (w, h, d) => sharedGeometry(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
  const add = (m, x, y, z) => { m.position.set(x, y, z); m.userData.collider = false; m.traverse((k) => { k.userData.collider = false; }); g.add(m); return m; };
  const kind = o.role === 'player' ? o.mode : `enemy-${o.mode}`;
  switch (kind) {
    case 'fps':
      add(makeMesh(cap(0.4, 1.0), c, { threshold: 40 }), 0, 0.9, 0);
      add(makeMesh(box(0.5, 0.18, 0.2), shade(c, -0.4)), 0, 1.5, 0.3);
      break;
    case 'platform':
      add(makeMesh(cap(0.45, 0.5), c, { threshold: 40 }), 0, 0.7, 0);
      add(makeMesh(sharedGeometry('ico0.3,1', () => new THREE.IcosahedronGeometry(0.3, 1)), shade(c, 0.3), { threshold: 40 }), 0, 1.45, 0);
      add(makeMesh(box(0.3, 0.12, 0.15), shade(c, -0.4)), 0, 1.45, 0.25);
      break;
    case 'car':
    case 'enemy-car':
      for (const p of carParts(c)) add(p, p.position.x, p.position.y, p.position.z);
      break;
    case 'enemy-shooter':
      add(makeMesh(cap(0.42, 1.0), c, { threshold: 40 }), 0, 0.92, 0);
      add(makeMesh(box(0.14, 0.14, 0.8), shade(c, -0.5)), 0.35, 1.2, 0.4);
      add(makeMesh(box(0.55, 0.15, 0.2), shade(c, 0.4)), 0, 1.5, 0.32);
      break;
    case 'enemy-arcade':
      add(makeMesh(sharedGeometry('ico0.6,0', () => new THREE.IcosahedronGeometry(0.6, 0)), c), 0, 0.65, 0);
      add(makeMesh(box(0.18, 0.18, 0.1), '#ffffff'), -0.2, 0.8, 0.5);
      add(makeMesh(box(0.18, 0.18, 0.1), '#ffffff'), 0.2, 0.8, 0.5);
      break;
    default:
      add(makeMesh(cap(0.4, 1), c), 0, 0.9, 0);
  }
  return g;
}

function buildAgent(o, ctx) {
  const group = new THREE.Group();
  const body = buildAgentBody(o);
  group.add(body);
  // Marcador de editor: anel + seta de direção
  const ringGeo = sharedGeometry('agent-ring', () => new THREE.RingGeometry(0.85, 1.0, 32).rotateX(-Math.PI / 2));
  const ring = makeMesh(ringGeo, o.role === 'player' ? '#4a6a8f' : '#c0632f', { edges: false, collider: false });
  ring.position.y = 0.03;
  ring.userData.editorOnly = true;
  const arrowGeo = sharedGeometry('agent-arrow', () => {
    const s = new THREE.Shape([new THREE.Vector2(-0.35, 0), new THREE.Vector2(0.35, 0), new THREE.Vector2(0, 0.7)]);
    return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2).rotateY(Math.PI);
  });
  const arrow = makeMesh(arrowGeo, o.role === 'player' ? '#4a6a8f' : '#c0632f', { collider: false });
  arrow.position.set(0, 0.04, 1.1);
  arrow.userData.editorOnly = true;
  group.add(ring, arrow);
  group.position.set(o.x, ctx.levelY(o.levelId), o.z);
  group.rotation.y = o.rotY;
  group.traverse((m) => { m.userData.collider = false; });
  return group;
}
