// Paredes procedurais ao longo de uma linha: modo contínuo (faixa única com
// altura variável por ruído) ou blocos (segmentos individuais aleatórios),
// com vãos (gaps), variação de altura e deslocamento lateral (jitter).
import * as THREE from 'three';
import { computeFrames, offsetPoints } from '../math/curve.js';
import { wallGeometry, boxBetween } from '../render/geometry.js';
import { makeMesh } from '../render/materials.js';
import { rng, noise1D } from '../util.js';
import { Batch, rock, tree, bush, slab, NATURAL, TRUNK_COLOR } from './nature.js';

// Colisor das paredes estilizadas: invisível, mas o jogo e o clique enxergam.
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

/**
 * @param {{x,z,y,s}[]} center linha central da parede (com y da base e s)
 * @param {object} o { height, thickness, color, mode, proc, closed, seedOffset }
 * @returns {THREE.Group}
 */
export function buildWallLine(center, o) {
  const group = new THREE.Group();
  if (center.length < 2) return group;
  if (o.style && o.style !== 'smooth') return buildStyledWall(center, o);
  const proc = o.proc || {};
  const seed = (proc.seed || 1) * 131 + (o.seedOffset || 0);
  const rnd = rng(seed);
  const hNoise = noise1D(seed + 11, 0.18);
  const jNoise = noise1D(seed + 23, 0.12);
  const closed = !!o.closed;
  // Pontos exatos nas bordas das aberturas (a parede termina rente à outra)
  const cutList = o.cuts || [];
  if (cutList.length) center = splitAt(center, cutList.flatMap((c) => [c.s0, c.s1]), closed);
  const n2 = center.length;
  // Pontas e bordas de aberturas ficam fixas (sem jitter / sem folga entre blocos)
  const sOf = (p, i) => p.s ?? i;
  const L0 = sOf(center[0], 0), L1 = sOf(center[n2 - 1], n2 - 1);
  const pins = cutList.flatMap((c) => [c.s0, c.s1]);
  if (!closed) pins.push(L0, L1);
  const pinDist = (sv) => pins.reduce((m, q) => Math.min(m, Math.abs(sv - q)), Infinity);

  // Jitter lateral (curvas "orgânicas"), some perto das pontas e aberturas
  let pts = center;
  if (proc.jitter > 0) {
    const fr = computeFrames(center, closed);
    pts = center.map((p, i) => {
      const d = jNoise(sOf(p, i)) * proc.jitter * Math.min(1, pinDist(sOf(p, i)) / 1.2);
      return { ...p, x: p.x + fr[i].nx * d, z: p.z + fr[i].nz * d };
    });
  }

  const n = pts.length;
  // Vãos: marca segmentos removidos
  const segs = closed ? n : n - 1;
  const gap = new Array(segs).fill(false);
  if (proc.gapChance > 0) {
    for (let k = 0; k < segs; k++) {
      if (!gap[k] && rnd() < proc.gapChance) {
        const len = Math.max(1, Math.round(proc.gapLength || 1));
        for (let j = 0; j < len && k + j < segs; j++) gap[k + j] = true;
        k += len;
      }
    }
  }
  // Aberturas fixas (junções com outros corredores): intervalos de arco [s0, s1]
  if (o.cuts?.length) {
    for (let k = 0; k < segs; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const sa = a.s ?? k, sb = b.s ?? k + 1;
      if (o.cuts.some((c) => sb > c.s0 + 1e-3 && sa < c.s1 - 1e-3)) gap[k] = true;
    }
  }
  const anyGap = gap.some(Boolean);

  if (o.mode === 'blocks') {
    for (let k = 0; k < segs; k++) {
      if (gap[k]) continue;
      const a = pts[k], b = pts[(k + 1) % n];
      const h = o.height * Math.max(0.15, 1 + (proc.heightVar || 0) * (rnd() * 2 - 1));
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      if (L < 1e-4) continue;
      // folga entre blocos, exceto nas pontas e nas bordas de aberturas
      const shA = pinDist(sOf(a, k)) < 1e-3 ? 0 : Math.min(0.04, L / 4);
      const shB = pinDist(sOf(b, k + 1)) < 1e-3 ? 0 : Math.min(0.04, L / 4);
      const ux = dx / L, uz = dz / L;
      const a2 = { x: a.x + ux * shA, z: a.z + uz * shA };
      const b2 = { x: b.x - ux * shB, z: b.z - uz * shB };
      const yb = Math.min(a.y ?? 0, b.y ?? 0);
      const extra = Math.abs((a.y ?? 0) - (b.y ?? 0));
      const g = boxBetween(a2, b2, o.thickness * (1 + (proc.jitter || 0) * rnd()), yb, h + extra);
      group.add(makeMesh(g, o.color));
    }
    return group;
  }

  const heightAt = (p, i) => o.height * Math.max(0.15, 1 + (proc.heightVar || 0) * hNoise(p.s ?? i));
  if (!anyGap) {
    const heights = pts.map(heightAt);
    group.add(makeMesh(wallGeometry(pts, heights, o.thickness, { closed, caps: !closed }), o.color));
    return group;
  }
  // Constrói trechos contínuos entre os vãos
  const frames = computeFrames(pts, closed);
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const c = run.map((i) => pts[i]);
      const f = run.map((i) => frames[i]);
      group.add(makeMesh(wallGeometry(c, c.map((p, j) => heightAt(p, run[j])), o.thickness, { frames: f }), o.color));
    }
    run = [];
  };
  for (let k = 0; k < segs; k++) {
    if (gap[k]) { flush(); continue; }
    if (!run.length) run.push(k);
    run.push((k + 1) % n);
  }
  flush();
  return group;
}

/** Insere pontos interpolados nos arcos `marks` (campo s) de uma linha. */
function splitAt(line, marks, closed) {
  const ms = marks.filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  if (!ms.length) return line;
  const out = [];
  const n = line.length;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = line[k], b = line[(k + 1) % n];
    out.push(a);
    const sa = a.s ?? k, sb = k + 1 < n ? (b.s ?? k + 1) : sa + Math.hypot(b.x - a.x, b.z - a.z);
    for (const m of ms) {
      if (m > sa + 1e-3 && m < sb - 1e-3) {
        const f = (m - sa) / (sb - sa);
        out.push({ ...a, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * f, s: m });
      }
    }
  }
  if (!closed) out.push(line[n - 1]);
  return out;
}

/**
 * Parede estilizada (pedras, árvores, arbustos, rochedo): um colisor liso e
 * invisível com a mesma espessura/altura/aberturas, coberto por peças
 * procedurais que preenchem a espessura da parede.
 */
function buildStyledWall(center, o) {
  const group = new THREE.Group();
  const solid = buildWallLine(center, { ...o, style: 'smooth', mode: 'continuous', proc: { ...o.proc, gapChance: 0, jitter: 0, heightVar: 0 } });
  solid.traverse((m) => {
    if (!m.isMesh) return;
    m.material = HIDDEN;
    delete m.userData.baseColor;
    m.castShadow = m.receiveShadow = false;
    for (const c of [...m.children]) m.remove(c);
  });
  group.add(solid);

  const T = Math.max(0.05, o.thickness), H = Math.max(0.2, o.height);
  const closed = !!o.closed;
  const rnd = rng(((o.proc?.seed || 1) * 977 + (o.seedOffset || 0) * 31) >>> 0);
  const color = (o.color || '#ffffff').toLowerCase() === '#ffffff' ? (NATURAL[o.style] || o.color) : o.color;
  const cuts = (o.cuts || []).map((c) => [c.s0, c.s1]);
  const b = new Batch();
  const step = {
    rocks: Math.max(0.3, Math.min(T, H) * 0.7),
    cliff: Math.max(0.35, T * 0.45),
    trees: Math.max(0.9, Math.min(2.4, T * 0.7)),
    bushes: Math.max(0.5, Math.min(1.6, T * 0.6)),
  }[o.style] || 1;
  // fileiras ao longo da espessura (paredes grossas ficam com várias)
  const rows = o.style === 'cliff' ? 1 : Math.max(1, Math.min(5, Math.round(T / (o.style === 'trees' ? 1.8 : o.style === 'rocks' ? Math.max(0.5, Math.min(T, H)) : 1.2))));
  walkLine(center, closed, step, (p, k) => {
    if (cuts.some(([a, c]) => p.s > a - step * 0.35 && p.s < c + step * 0.35)) return;
    const yaw = Math.atan2(p.tx, p.tz);
    for (let r = 0; r < rows; r++) {
      const lat = rows === 1 ? 0 : (r / (rows - 1) - 0.5) * T * 0.7;
      const stagger = rows > 1 && r % 2 ? step * 0.5 : 0;
      const jl = (rnd() - 0.5) * Math.min(T, step) * 0.25;
      const x = p.x + p.nx * (lat + jl) + p.tx * stagger * (k > 0 ? 1 : 0);
      const z = p.z + p.nz * (lat + jl) + p.tz * stagger * (k > 0 ? 1 : 0);
      const y = p.y;
      const cell = Math.max(T / rows, step);
      switch (o.style) {
        case 'rocks': {
          // pilha de pedras até a altura da parede
          const size = Math.min(cell, H) * 0.62;
          const layers = Math.max(1, Math.round(H / (size * 1.5)));
          const lh = H / layers;
          for (let l = 0; l < layers; l++) {
            const top = l === layers - 1;
            rock(b, rnd, color, x + (rnd() - 0.5) * size * 0.3, y + l * lh - lh * 0.1, z, size * (0.95 + rnd() * 0.3), lh * (top ? 1.15 + rnd() * 0.25 : 1.3), yaw);
          }
          break;
        }
        case 'cliff': {
          const h = H * (0.85 + rnd() * 0.35);
          slab(b, rnd, color, x, y, z, step * 1.35, T * (0.85 + rnd() * 0.3), h, yaw);
          if (rnd() < 0.35) slab(b, rnd, color, x + p.nx * T * 0.2, y, z + p.nz * T * 0.2, step * 0.9, T * 0.6, h * (1.1 + rnd() * 0.2), yaw);
          break;
        }
        case 'trees': {
          const h = Math.max(H, 2) * (0.95 + rnd() * 0.45);
          const rad = Math.max(step * 0.75, Math.min(cell * 0.75, h * 0.35));
          tree(b, rnd, { leaf: color, trunk: TRUNK_COLOR }, x, y, z, h, rad);
          break;
        }
        case 'bushes': {
          const rad = Math.max(step * 0.7, cell * 0.6);
          const layers = Math.max(1, Math.round(H / (rad * 1.6)));
          const lh = H / layers;
          for (let l = 0; l < layers; l++) bush(b, rnd, color, x, y + l * lh * 0.85, z, rad * (1 - l * 0.12), lh * 1.25);
          break;
        }
        default: break;
      }
    }
  });
  for (const m of b.build({ threshold: o.style === 'cliff' ? 25 : 32 })) group.add(m);
  return group;
}

/** Percorre a linha em passos de comprimento real; s/y são interpolados. */
function walkLine(line, closed, step, fn) {
  const n = line.length;
  const segs = closed ? n : n - 1;
  let carry = step * 0.5, k = 0;
  for (let i = 0; i < segs; i++) {
    const a = line[i], b = line[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const tx = dx / L, tz = dz / L;
    const sa = a.s ?? i, sb = closed && i === n - 1 ? sa + L : (b.s ?? i + 1);
    let t = carry;
    while (t <= L) {
      const f = t / L;
      fn({ x: a.x + dx * f, z: a.z + dz * f, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * f, s: sa + (sb - sa) * f, tx, tz, nx: -tz, nz: tx }, k++);
      t += step;
    }
    carry = t - L;
  }
}
