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
  const n = center.length;
  if (n < 2) return group;
  const proc = o.proc || {};
  const seed = (proc.seed || 1) * 131 + (o.seedOffset || 0);
  const rnd = rng(seed);
  const hNoise = noise1D(seed + 11, 0.18);
  const jNoise = noise1D(seed + 23, 0.12);
  const closed = !!o.closed;

  // Jitter lateral (curvas "orgânicas")
  let pts = center;
  if (proc.jitter > 0) {
    const fr = computeFrames(center, closed);
    pts = center.map((p, i) => {
      const d = jNoise(p.s ?? i) * proc.jitter;
      return { ...p, x: p.x + fr[i].nx * d, z: p.z + fr[i].nz * d };
    });
  }

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
      if (o.cuts.some((c) => sb > c.s0 && sa < c.s1)) gap[k] = true;
    }
  }
  const anyGap = gap.some(Boolean);

  if (o.mode === 'blocks') {
    for (let k = 0; k < segs; k++) {
      if (gap[k]) continue;
      const a = pts[k], b = pts[(k + 1) % n];
      const h = o.height * Math.max(0.15, 1 + (proc.heightVar || 0) * (rnd() * 2 - 1));
      const shrink = 0.04;
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      if (L < 1e-4) continue;
      const ux = dx / L, uz = dz / L;
      const a2 = { x: a.x + ux * shrink, z: a.z + uz * shrink };
      const b2 = { x: b.x - ux * shrink, z: b.z - uz * shrink };
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

