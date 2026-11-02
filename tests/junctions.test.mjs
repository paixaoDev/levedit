import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeJunctions, halfAt, nodeHalf } from '../src/builders/corridorPath.js';

const base = { type: 'corridor', levelId: 'l0', endLevelId: null, closed: false, smooth: 0, width: 4, proc: { segment: 1 }, walls: { height: 3, thickness: 0.3 } };
const ctxFor = (objects) => ({ doc: { objects }, levelY: () => 0 });

test('corredor que nasce no meio de outro abre porta no lado certo', () => {
  const a = { ...base, id: 'a', points: [{ x: -10, z: 0 }, { x: 10, z: 0 }] };
  const b = { ...base, id: 'b', width: 2, joins: { start: 'door', end: 'door' }, points: [{ x: 0, z: 0 }, { x: 0, z: -10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  const cut = j.get('a').cuts[0];
  assert.ok(cut, 'A recebe abertura');
  // A vai em +x; a normal esquerda é -z; B sai para -z => lado esquerdo (+1)
  assert.equal(cut.side, 1);
  assert.ok(Math.abs(cut.s - 10) < 1e-6);
  assert.ok(Math.abs(cut.half - 1) < 1e-6);
  assert.ok(j.get('b').trims.start.walls > 2);
  assert.equal(j.get('a').trims.start, undefined);
});

test('ponta com ponta não corta parede', () => {
  const a = { ...base, id: 'a', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] };
  const b = { ...base, id: 'b', points: [{ x: 10, z: 0 }, { x: 10, z: 10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  assert.equal(j.get('a').cuts.length, 0);
  assert.equal(j.get('b').cuts.length, 0);
});

test('estilo "none" não abre a parede', () => {
  const a = { ...base, id: 'a', points: [{ x: -10, z: 0 }, { x: 10, z: 0 }] };
  const b = { ...base, id: 'b', joins: { start: 'none' }, points: [{ x: 0, z: 0 }, { x: 0, z: 10 }] };
  assert.equal(computeJunctions(ctxFor([a, b])).get('a').cuts.length, 0);
});

test('largura por nó interpola entre nós', () => {
  const o = { ...base, points: [{ x: 0, z: 0, wl: 1 }, { x: 10, z: 0, wl: 3 }] };
  assert.equal(nodeHalf(o, 0, 1), 1);
  assert.equal(nodeHalf(o, 0, -1), 2);
  assert.equal(halfAt(o, 0.5, 1), 2);
});
