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

import { attachEnd, syncLinks } from '../src/builders/corridorPath.js';

test('ramificação vira nó compartilhado do pai e acompanha o nó', () => {
  const a = { ...base, id: 'a', points: [{ x: -10, z: 0 }, { x: 10, z: 0 }] };
  // ponta perto da parede (fora do eixo): deve ser puxada para o eixo
  const b = { ...base, id: 'b', width: 2, points: [{ x: 3.3, z: -2.6 }, { x: 3, z: -12 }] };
  const doc = { objects: [a, b] };
  const ctx = ctxFor(doc.objects);
  assert.equal(attachEnd(doc, ctx, b, 'start'), true);
  assert.equal(a.points.length, 3, 'nó inserido no pai');
  const node = a.points[1];
  assert.ok(node.jid);
  assert.ok(Math.abs(node.z) < 1e-6 && Math.abs(b.points[0].z) < 1e-6);
  assert.deepEqual(b.links.start, { id: 'a', jid: node.jid });
  // mover o nó do pai move a ponta da ramificação
  a.points[1] = { ...node, x: 5, z: 1 };
  syncLinks(doc);
  assert.equal(b.points[0].x, 5);
  assert.equal(b.points[0].z, 1);
  // a junção é detectada e abre a parede do pai
  const j = computeJunctions(ctxFor(doc.objects));
  assert.equal(j.get('a').cuts.length, 1);
  // apagar o nó desfaz a ligação
  a.points.splice(1, 1);
  syncLinks(doc);
  assert.equal(b.links.start, null);
});

import { computeFrames, offsetPoints, untangle } from '../src/math/curve.js';

test('emenda ponta com ponta: mesma normal e mesma largura nos dois lados', () => {
  const a = { ...base, id: 'a', width: 4, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] };
  const b = { ...base, id: 'b', width: 6, points: [{ x: 10, z: 0 }, { x: 10, z: 10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  const ja = j.get('a').joints.end, jb = j.get('b').joints.start;
  assert.ok(ja && jb);
  // mesma tangente (bissetriz) e mesma normal
  assert.ok(Math.abs(ja.nx - jb.nx) < 1e-9 && Math.abs(ja.nz - jb.nz) < 1e-9);
  // largura média (2 e 3 -> 2.5) dos dois lados
  assert.equal(ja.hl, 2.5); assert.equal(jb.hl, 2.5);
  // bordas coincidem no ponto da emenda
  const P = { x: 10, z: 0 };
  const la = { x: P.x + ja.nx * ja.hl, z: P.z + ja.nz * ja.hl };
  const lb = { x: P.x + jb.nx * jb.hl, z: P.z + jb.nz * jb.hl };
  assert.ok(Math.hypot(la.x - lb.x, la.z - lb.z) < 1e-9);
});

test('emenda fim com fim troca os lados', () => {
  const a = { ...base, id: 'a', points: [{ x: 0, z: 0, wl: 1, wr: 3 }, { x: 10, z: 0, wl: 1, wr: 3 }] };
  const b = { ...base, id: 'b', points: [{ x: 20, z: 0, wl: 1, wr: 3 }, { x: 10, z: 0, wl: 1, wr: 3 }] };
  const j = computeJunctions(ctxFor([a, b]));
  const ja = j.get('a').joints.end, jb = j.get('b').joints.end;
  // esquerda de A = direita de B no mundo: média (1+3)/2 = 2 nos dois
  assert.equal(ja.hl, 2); assert.equal(ja.hr, 2);
  assert.ok(Math.abs(ja.nx + jb.nx) < 1e-9 && Math.abs(ja.nz + jb.nz) < 1e-9);
});

test('ramificação oblíqua: cada parede termina exatamente na linha do pai', () => {
  const a = { ...base, id: 'a', points: [{ x: -20, z: 0 }, { x: 20, z: 0 }] };
  const b = { ...base, id: 'b', width: 2, points: [{ x: 0, z: 0 }, { x: 10, z: -10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  const t = j.get('b').trims.start;
  // eixo de A em z=0; meia-largura 2; parede de A com centro em |z| = 2.15
  for (const side of [1, -1]) {
    assert.ok(Math.abs(Math.abs(t.sides[side].wallPt.z) - 2.15) < 1e-6, 'parede de B encosta no centro da parede de A');
    assert.ok(Math.abs(Math.abs(t.sides[side].floorPt.z) - 1.98) < 1e-6, 'piso de B encosta na borda do piso de A');
  }
  assert.notEqual(t.sides[1].walls.toFixed(3), t.sides[-1].walls.toFixed(3), 'lados diferentes em ângulo');
  const cut = j.get('a').cuts[0];
  assert.ok(cut.s1 - cut.s0 > 2 * Math.SQRT2 * 1 - 0.5);
});

test('lado de dentro de curva fechada não dobra', () => {
  const pts = [{ x: 0, z: 0, s: 0 }, { x: 5, z: 0, s: 5 }, { x: 5.5, z: 0.5, s: 5.7 }, { x: 5.5, z: 5, s: 10 }];
  const fr = computeFrames(pts);
  // offset maior que o raio do lado de dentro (esquerda = -z... dentro da curva = +z => lado direito)
  const inner = offsetPoints(pts, fr, -3);
  const u = untangle(inner, { ref: pts, keepLength: true });
  for (let i = 0; i < u.length - 1; i++) {
    const ox = u[i + 1].x - u[i].x, oz = u[i + 1].z - u[i].z;
    const cx = pts[i + 1].x - pts[i].x, cz = pts[i + 1].z - pts[i].z;
    assert.ok(ox * cx + oz * cz >= -1e-9, `segmento ${i} não anda para trás`);
  }
});
