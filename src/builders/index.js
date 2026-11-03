// Converte objetos do documento em grupos Three.js (procedural).
import * as THREE from 'three';
import { samplePath, computeFrames, offsetPoints, signedArea, untangle } from '../math/curve.js';
import { floorGeometry, slabGeometry, wallGeometry, boxBetween, ribbon, sharedGeometry } from '../render/geometry.js';
import { makeMesh, makeRoofMesh } from '../render/materials.js';
import { makePointLight } from '../render/lighting.js';
import { buildWallLine } from './walls.js';
import { buildAssetParts, carParts } from './assets.js';
import { corridorSamples, computeJunctions, halfAt, areaOutline, wrapCut } from './corridorPath.js';

export { corridorSamples };
import { rng, lerp, smoothstep, shade } from '../util.js';

/** Contexto: elevação dos níveis. */
export function makeContext(doc) {
  const levels = new Map(doc.levels.map((l) => [l.id, l]));
  const ctx = {
    doc,
    levels,
    levelY: (id) => levels.get(id)?.elevation ?? 0,
    _junctions: null,
    junctions() {
      if (!this._junctions) this._junctions = computeJunctions(this);
      return this._junctions;
    },
  };
  return ctx;
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
    case 'light': g = buildLight(obj, ctx); break;
    default: g = new THREE.Group();
  }
  g.userData.objId = obj.id;
  g.userData.levelId = obj.levelId;
  g.name = obj.name || obj.type;
  return g;
}

// ---------------------------------------------------------------- caminhos

/** Recorta amostras no intervalo de arco [s0, s1], interpolando as bordas. */
function trimRange(samples, s0, s1) {
  if (s0 <= 1e-4 && s1 >= samples[samples.length - 1].s - 1e-4) return samples;
  const lerpP = (a, b, sv) => {
    const f = b.s - a.s > 1e-6 ? (sv - a.s) / (b.s - a.s) : 0;
    return {
      ...a, x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), y: lerp(a.y ?? 0, b.y ?? 0, f), s: sv,
      u: lerp(a.u ?? 0, b.u ?? 0, f), ctrl: lerp(a.ctrl ?? 0, b.ctrl ?? 0, f),
    };
  };
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const prev = samples[i - 1];
    if (prev && prev.s < s0 && p.s > s0) out.push(lerpP(prev, p, s0));
    if (p.s >= s0 && p.s <= s1) out.push(p);
    if (prev && prev.s < s1 && p.s > s1) out.push(lerpP(prev, p, s1));
  }
  return out;
}

/** Ponto interpolado por arco numa linha (para batentes de porta). */
function pointAtS(line, sv) {
  let j = 1;
  while (j < line.length - 1 && line[j].s < sv) j++;
  const a = line[j - 1], b = line[j];
  const f = b.s - a.s > 1e-6 ? Math.max(0, Math.min(1, (sv - a.s) / (b.s - a.s))) : 0;
  return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), y: lerp(a.y ?? 0, b.y ?? 0, f), s: sv };
}

/** Batente (montantes + verga + parede acima) de uma porta entre s0 e s1 de uma linha de parede. */
function buildDoorFrame(group, center, s0, s1, c, W, extra = 0) {
  const a = pointAtS(center, s0), b = pointAtS(center, s1);
  const y = Math.min(a.y, b.y);
  const H = W.height + extra;
  const doorH = Math.min(2.5, c.height - 0.2, H - 0.25);
  const postW = 0.18;
  const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
  const ux = dx / dl, uz = dz / dl;
  const frameColor = shade(W.color, -0.18);
  const post = (p, dir) => makeMesh(boxBetween(
    { x: p.x, z: p.z }, { x: p.x + ux * dir * postW, z: p.z + uz * dir * postW },
    W.thickness + 0.12, y, doorH,
  ), frameColor);
  group.add(post(a, 1), post(b, -1));
  if (H - doorH > 0.05) group.add(makeMesh(boxBetween(a, b, W.thickness, y + doorH, H - doorH), W.color));
  group.add(makeMesh(boxBetween(a, b, W.thickness + 0.12, y + doorH - 0.12, 0.12), frameColor));
}

function buildCorridor(o, ctx) {
  const group = new THREE.Group();
  const { samples: raw, stepped } = corridorSamples(o, ctx);
  if (raw.length < 2) return group;
  const closed = o.closed;
  const J = ctx.junctions?.().get(o.id) || { cuts: [], trims: {}, joints: {} };
  const joints = closed ? {} : (J.joints || {});
  const L = raw[raw.length - 1].s;
  const trim = (end, key) => J.trims[end]?.[key] || 0;
  // Emendas: perto da ponta a largura converge para a largura comum da emenda
  const D = Math.min(3, L * 0.45);
  const halfS = (p, side, f) => {
    let h = halfAt(o, p.ctrl, side);
    const js = joints.start, je = joints.end;
    if (js) h = lerp(h, side > 0 ? js.hl : js.hr, smoothstep(Math.max(0, 1 - p.s / D)));
    if (je) h = lerp(h, side > 0 ? je.hl : je.hr, smoothstep(Math.max(0, 1 - (L - p.s) / D)));
    // encosta no vizinho em vez de entrar nele
    if (J.clamp && f) h = Math.min(h, J.clamp(p, f, side));
    return h;
  };
  // ... e a normal na ponta é a mesma dos dois corredores (bissetriz)
  const jointFrames = (sm, fr) => {
    if (joints.start && sm[0].s < 1e-4) fr[0] = { ...joints.start, miter: 1 };
    if (joints.end && sm[sm.length - 1].s > L - 1e-4) fr[fr.length - 1] = { ...joints.end, miter: 1 };
    return fr;
  };
  // Ramificação: cada lado termina exatamente no seu cruzamento com o pai
  const pinEnds = (line, side, key) => {
    for (const end of ['start', 'end']) {
      const pt = J.trims[end]?.sides?.[side]?.[key];
      if (!pt) continue;
      const k = end === 'start' ? 0 : line.length - 1;
      line[k] = { ...line[k], x: pt.x, z: pt.z };
    }
    return line;
  };
  const samples = closed ? raw : trimRange(raw, trim('start', 'floor'), L - trim('end', 'floor'));
  if (samples.length < 2) return group;
  const frames = jointFrames(samples, computeFrames(samples, closed));
  const hl = (i) => halfS(samples[i], 1, frames[i]);
  const hr = (i) => halfS(samples[i], -1, frames[i]);
  // curvas mais fechadas que a largura: o lado de dentro não pode dobrar sobre si
  const left = pinEnds(untangle(offsetPoints(samples, frames, hl), { keepLength: true, ref: samples }), 1, 'floorPt');
  const right = pinEnds(untangle(offsetPoints(samples, frames, (i) => -hr(i)), { keepLength: true, ref: samples }), -1, 'floorPt');

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
  let wallBase = raw, extra = 0;
  if (stepped) {
    wallBase = samplePath(o.points, { closed, smooth: o.smooth, spacing: o.proc?.segment || 1 });
    const LL = wallBase[wallBase.length - 1].s || 1;
    for (const p of wallBase) p.y = stepped.y0 + (stepped.rise * p.s) / LL - stepped.step;
    extra = stepped.step;
  }
  const wallSamples = closed ? wallBase : trimRange(wallBase, trim('start', 'walls'), L - trim('end', 'walls'));
  const wallFrames = wallSamples.length >= 2 ? jointFrames(wallSamples, computeFrames(wallSamples, closed)) : [];
  // corredores não têm vãos aleatórios: aberturas só onde outro corredor sai
  const proc = { ...o.proc, gapChance: 0 };
  for (const side of sides) {
    if (wallSamples.length < 2) break;
    const center = untangle(pinEnds(offsetPoints(wallSamples, wallFrames, (i) => side * (halfS(wallSamples[i], side, wallFrames[i]) + W.thickness / 2)), side, 'wallPt'), { ref: wallSamples });
    const cuts = J.cuts.filter((c) => c.side === side).map((c) => ({ s0: c.s0 ?? c.s - c.half, s1: c.s1 ?? c.s + c.half, c }));
    group.add(buildWallLine(center, {
      height: W.height + extra, thickness: W.thickness, color: W.color, mode: W.mode, proc, closed, seedOffset: side > 0 ? 1 : 2, cuts,
    }));
    for (const { s0, s1, c } of cuts) if (c.style === 'door') buildDoorFrame(group, center, s0, s1, c, W, extra);
  }
  if (!closed) {
    const capW = (i) => {
      const a = offsetPoints([samples[i]], [frames[i]], hl(i) + W.thickness)[0];
      const b = offsetPoints([samples[i]], [frames[i]], -hr(i) - W.thickness)[0];
      return makeMesh(boxBetween(a, b, W.thickness, samples[i].y, W.height), W.color);
    };
    if (W.capStart && !J.trims.start && !joints.start) group.add(capW(0));
    if (W.capEnd && !J.trims.end && !joints.end) group.add(capW(samples.length - 1));
  }

  if (o.roof?.enabled) {
    // teto apoiado no topo das paredes, cobrindo até a face externa delas
    const R = o.roof;
    const topY = (p) => (stepped ? stepped.y0 + (stepped.rise * p.s) / (L || 1) : p.y ?? 0) + W.height + R.thickness;
    const out = (side) => untangle(offsetPoints(samples, frames, (i) => side * (halfS(samples[i], side, frames[i]) + W.thickness)), { keepLength: true, ref: samples })
      .map((p, i) => ({ ...p, y: topY(samples[i]) }));
    group.add(makeRoofMesh(floorGeometry(out(1), out(-1), R.thickness, { closed }), R.color));
  }

  const decoSides = o.deco.side === 'left' ? [1] : o.deco.side === 'right' ? [-1] : [1, -1];
  buildDecorations(group, samples, frames, o.deco, {
    closed, wallHeight: W.height, wallThickness: W.thickness, wallColor: W.color,
    sides: decoSides.map((side) => ({
      side, into: -1, edge: (ctrl) => halfAt(o, ctrl, side),
      cuts: J.cuts.filter((c) => c.side === side).map((c) => [c.s - c.half - 0.8, c.s + c.half + 0.8]),
    })),
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
  const ol = areaOutline(o, ctx);
  const s = ol.samples;
  if (s.length < 3) return group;
  if (o.floor.enabled) {
    const fl = makeMesh(slabGeometry(s, y, o.floor.thickness), o.floor.color, { threshold: 30 });
    fl.userData.floor = true;
    group.add(fl);
  }
  const frames = ol.frames;
  // Sinal "para dentro" no referencial da normal esquerda
  const inside = ol.inside;
  // aberturas só onde chega um corredor ou encosta outra área (sem vãos aleatórios)
  const J = ctx.junctions?.().get(o.id) || { cuts: [] };
  const cuts = J.cuts.flatMap((c) => wrapCut(c, ol.total).map((w) => ({ s0: w.s0, s1: w.s1, c })));
  if (o.walls.enabled) {
    const center = offsetPoints(s, frames, inside * (o.walls.thickness / 2));
    group.add(buildWallLine(center, { ...o.walls, proc: { ...o.proc, gapChance: 0 }, closed: true, cuts }));
    // batentes: linha "desenrolada" duas vezes para portas que passam do ponto inicial
    const ring = [...center, ...center.map((p) => ({ ...p, s: p.s + ol.total })), { ...center[0], s: 2 * ol.total }];
    for (const c of J.cuts) {
      if (c.style !== 'door') continue;
      const [w] = wrapCut({ s0: c.s0, s1: c.s0 + (c.s1 - c.s0) }, ol.total);
      buildDoorFrame(group, ring, w.s0, w.s0 + (c.s1 - c.s0), c, o.walls);
    }
  }
  if (o.roof?.enabled) {
    const R = o.roof;
    group.add(makeRoofMesh(slabGeometry(s, y + o.walls.height + R.thickness, R.thickness), R.color));
  }
  const side = o.deco.side;
  const th = o.walls.enabled ? o.walls.thickness : 0;
  const decoCuts = cuts.map(({ s0, s1 }) => [s0 - 0.8, s1 + 0.8]);
  const inner = { side: inside, edge: th, into: 1, cuts: decoCuts };
  const outer = { side: -inside, edge: 0, into: 1, cuts: decoCuts };
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
    ctrl: lerp(a.ctrl ?? 0, b.ctrl ?? 0, f),
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
    for (const { side, edge: e0, into } of opt.sides) {
      const edge = typeof e0 === 'function' ? (i) => e0(samples[i].ctrl) : () => e0;
      if (deco.type === 'sidewalk') {
        const a = side * edge(0), b = side * (edge(0) + into * inset * 2);
        const outer = offsetPoints(samples, frames, (i) => side * edge(i));
        const inner = offsetPoints(samples, frames, (i) => side * (edge(i) + into * inset * 2));
        const L2 = a > b ? outer : inner, R2 = a > b ? inner : outer;
        const yb = samples.map((p) => (p.y ?? 0) - 0.02);
        const yt = samples.map((p) => (p.y ?? 0) + 0.18);
        const m = makeMesh(ribbon(L2, R2, yb, yt, { closed: opt.closed }), color, { threshold: 30 });
        m.userData.floor = true;
        group.add(m);
      } else {
        const c = offsetPoints(samples, frames, (i) => side * (edge(i) + into * inset));
        group.add(makeMesh(wallGeometry(c, 1.1, 0.7, { closed: opt.closed, caps: !opt.closed }), color, { threshold: 30 }));
      }
    }
    return;
  }

  const spacing = lerp(6, 1.1, Math.max(0, Math.min(1, deco.density)));
  for (const { side, edge: e0, into, cuts } of opt.sides) {
    const s0 = samples[0].s;
    for (let sv = s0 + spacing * 0.5 + rnd() * spacing * 0.3; sv < (opt.closed ? L : totalL); sv += spacing * (0.75 + rnd() * 0.5)) {
      if (cuts?.some(([a, b]) => sv > a && sv < b)) continue;
      const p = interp(samples, frames, sv, opt.closed);
      const edge = typeof e0 === 'function' ? e0(p.ctrl) : e0;
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

// ---------------------------------------------------------------- luzes

function buildLight(o, ctx) {
  const group = new THREE.Group();
  const y0 = ctx.levelY(o.levelId);
  const h = Math.max(0.2, o.y ?? 2.4);
  const light = makePointLight(o);
  light.position.y = h;
  group.add(light);
  // lâmpada (visível no jogo também), sem sombra para não tapar a própria luz
  const bulb = new THREE.Mesh(
    sharedGeometry('light-bulb', () => new THREE.IcosahedronGeometry(0.22, 1)),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(o.color).lerp(new THREE.Color('#ffffff'), 0.35) }),
  );
  bulb.position.y = h;
  bulb.userData.collider = false;
  bulb.userData.lightBulb = true;
  group.add(bulb);
  // marcadores do editor: haste até o chão e alcance tracejado
  const helperMat = new THREE.LineDashedMaterial({ color: o.color, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.9 });
  const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(0, h, 0)]), helperMat);
  stem.computeLineDistances();
  const ring = [];
  const r = Math.min(o.range, 40) * 0.5;
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * r, 0.03, Math.sin(a) * r)); }
  const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), helperMat);
  circle.computeLineDistances();
  for (const l of [stem, circle]) { l.userData.editorOnly = true; l.raycast = () => {}; group.add(l); }
  const base = makeMesh(sharedGeometry('light-base', () => new THREE.CylinderGeometry(0.28, 0.32, 0.06, 16)), '#5b5144', { collider: false, shadow: false });
  base.position.y = 0.03;
  base.userData.editorOnly = true;
  group.add(base);
  group.position.set(o.x, y0, o.z);
  group.traverse((m) => { m.userData.collider = false; });
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
  ring.castShadow = arrow.castShadow = false;
  group.add(ring, arrow);
  group.position.set(o.x, ctx.levelY(o.levelId), o.z);
  group.rotation.y = o.rotY;
  group.traverse((m) => { m.userData.collider = false; });
  return group;
}
