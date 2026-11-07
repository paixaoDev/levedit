// Paredes procedurais ao longo de uma linha: modo contínuo (faixa única com
// altura variável por ruído) ou blocos (segmentos individuais aleatórios),
// com vãos (gaps), variação de altura e deslocamento lateral (jitter).
import * as THREE from 'three';
import { computeFrames, offsetPoints } from '../math/curve.js';
import { wallGeometry, boxBetween } from '../render/geometry.js';
import { makeMesh } from '../render/materials.js';
import { rng, noise1D } from '../util.js';

/**
 * @param {{x,z,y,s}[]} center linha central da parede (com y da base e s)
 * @param {object} o { height, thickness, color, mode, proc, closed, seedOffset }
 * @returns {THREE.Group}
 */
export function buildWallLine(center, o) {
  const group = new THREE.Group();
  if (center.length < 2) return group;
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
      // trecho que fecha o anel (último ponto -> primeiro): o arco segue além do total
      const sa = a.s ?? k, sb = k + 1 < n ? (b.s ?? k + 1) : sa + Math.hypot(b.x - a.x, b.z - a.z);
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
