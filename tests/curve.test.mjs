import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePath, computeFrames, offsetPoints, pathLength, signedArea } from '../src/math/curve.js';

const L = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];

test('polilinha mantém cantos e comprimento', () => {
  const s = samplePath(L, { spacing: 1 });
  assert.equal(s[0].x, 0);
  assert.ok(s.some((p) => p.x === 10 && p.z === 0), 'canto presente');
  assert.ok(Math.abs(pathLength(s) - 20) < 1e-9);
  assert.equal(s.at(-1).u, 1);
});

test('offset com miter mantém distância constante nos trechos retos', () => {
  const s = samplePath(L, { spacing: 2 });
  const f = computeFrames(s);
  const o = offsetPoints(s, f, 1);
  // canto externo (miter) em (11,-1)
  const corner = o[s.findIndex((p) => p.x === 10 && p.z === 0)];
  assert.ok(Math.abs(corner.x - 11) < 1e-9 && Math.abs(corner.z + 1) < 1e-9);
  assert.ok(Math.abs(o[1].z + 1) < 1e-9);
});

test('curva suave passa pelos pontos de controle', () => {
  const s = samplePath(L, { spacing: 0.5, smooth: 0.5 });
  for (const c of L) assert.ok(s.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 1e-6));
});

test('caminho fechado não duplica o primeiro ponto', () => {
  const sq = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }];
  const s = samplePath(sq, { spacing: 1, closed: true });
  assert.ok(Math.hypot(s.at(-1).x - s[0].x, s.at(-1).z - s[0].z) > 0.5);
  assert.ok(Math.abs(Math.abs(signedArea(s)) - 16) < 1e-6);
});

test('pontos repetidos (degraus) não geram NaN nos frames', () => {
  const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
  for (const f of computeFrames(pts)) assert.ok(Number.isFinite(f.nx) && Number.isFinite(f.nz));
});
