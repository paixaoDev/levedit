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

import { widthLimit } from '../src/builders/corridorPath.js';

test('engordar um corredor para na parede do vizinho', () => {
  const walls = { left: true, right: true, height: 3, thickness: 0.3 };
  const a = { ...base, id: 'a', walls, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }] };
  // vizinho paralelo a 10 m (lado esquerdo de A = -z)
  const b = { ...base, id: 'b', walls, points: [{ x: 0, z: -10 }, { x: 20, z: -10 }] };
  const doc = { objects: [a, b] };
  const lim = widthLimit(doc, ctxFor(doc.objects), a, 1, 1);
  // face externa de B em z = -10 + 2 + 0.3 = -7.7; A precisa da própria parede (0.3) e folga
  assert.ok(Math.abs(lim - (7.7 - 0.3 - 0.02)) < 0.05, `limite ${lim}`);
  assert.equal(widthLimit(doc, ctxFor(doc.objects), a, 1, -1), Infinity, 'lado livre');
  // ramificação ligada não bloqueia
  const c = { ...base, id: 'c', walls, links: { start: { id: 'a', jid: 'x' } }, points: [{ x: 10, z: 0 }, { x: 10, z: 8 }] };
  const doc2 = { objects: [a, c] };
  assert.equal(widthLimit(doc2, ctxFor(doc2.objects), a, 1, -1), Infinity);
});

const areaBase = { type: 'area', levelId: 'l0', smooth: 0, closed: true, proc: { segment: 1 }, walls: { enabled: true, height: 3, thickness: 0.3 }, joins: { areas: 'door' }, doorWidth: 1.6 };

test('corredor que termina dentro de uma área abre porta na parede dela', () => {
  const room = { ...areaBase, id: 'r', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] };
  const c = { ...base, id: 'c', width: 2, points: [{ x: 5, z: -10 }, { x: 5, z: 1 }] };
  const j = computeJunctions(ctxFor([room, c]));
  const cut = j.get('r').cuts[0];
  assert.ok(cut, 'área recebe abertura');
  assert.ok(cut.s1 - cut.s0 > 1.9 && cut.s1 - cut.s0 < 2.3, `vão ${cut.s1 - cut.s0}`);
  const t = j.get('c').trims.end;
  // piso do corredor vai até a borda da área (z ~ 0.02), parede até o centro da parede da área
  assert.ok(Math.abs(t.sides[1].floorPt.z - 0.02) < 1e-6);
  assert.ok(Math.abs(t.sides[1].wallPt.z - 0.15) < 1e-6);
});

test('corredor longe da área não abre nada', () => {
  const room = { ...areaBase, id: 'r', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] };
  const c = { ...base, id: 'c', points: [{ x: 5, z: -10 }, { x: 5, z: -3 }] };
  assert.equal(computeJunctions(ctxFor([room, c])).get('r').cuts.length, 0);
});

test('áreas encostadas ganham uma porta na parede em comum', () => {
  const a = { ...areaBase, id: 'a', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] };
  const b = { ...areaBase, id: 'b', points: [{ x: 10, z: 2 }, { x: 18, z: 2 }, { x: 18, z: 8 }, { x: 10, z: 8 }] };
  const j = computeJunctions(ctxFor([a, b]));
  assert.equal(j.get('a').cuts.length, 1);
  assert.equal(j.get('b').cuts.length, 1);
  const ca = j.get('a').cuts[0];
  assert.ok(Math.abs(ca.s1 - ca.s0 - 1.6) < 1e-6);
  assert.equal(j.get('b').cuts[0].style, 'open', 'sem batente duplicado');
  // estilo "none" desliga
  a.joins = { areas: 'none' };
  assert.equal(computeJunctions(ctxFor([a, b])).get('a').cuts.length, 0);
});

test('corredor mais novo engordado encosta no mais antigo sem entrar', () => {
  const walls = { left: true, right: true, height: 3, thickness: 0.3 };
  const a = { ...base, id: 'a', walls, points: [{ x: 0, z: -10 }, { x: 0, z: 10 }] };
  // b (mais novo) a 8 m de a, com o lado direito (-x, indo em +z) engordado para 12
  const b = { ...base, id: 'b', walls, points: [{ x: 8, z: -10 }, { x: 8, z: 0, wr: 12 }, { x: 8, z: 10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  const clamp = j.get('b').clamp;
  assert.ok(clamp, 'b recebe limite');
  const f = { nx: 1, nz: 0, miter: 1 }; // normal esquerda de +z é +x; lado direito = -x
  const h = clamp({ x: 8, z: 0, s: 10 }, f, -1);
  // face externa de a em x = 2.3; b precisa da própria parede (0.3) e folga 0.02
  assert.ok(Math.abs(h - (8 - 2.3 - 0.3 - 0.02)) < 1e-6, `meia-largura ${h}`);
  // o mais antigo não muda
  assert.equal(j.get('a').clamp, undefined);
});

import { nodeCollisions, pushCorridor, hasAgents, halfAt as halfAt2 } from '../src/builders/corridorPath.js';

test('engordar empurra o corredor vizinho; com agente ele só bloqueia', () => {
  const walls = { left: true, right: true, height: 3, thickness: 0.3 };
  const a = { ...base, id: 'a', walls, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }] };
  const b = { ...base, id: 'b', walls, points: [{ x: 0, z: -10 }, { x: 10, z: -10 }, { x: 20, z: -10 }] };
  const doc = { objects: [a, b] };
  const ctx = ctxFor(doc.objects);
  const before = { ...a, points: a.points.map((p) => ({ ...p })) };
  a.points[1] = { ...a.points[1], wl: 9 };
  const hits = nodeCollisions(doc, ctx, a, 1, { sides: [1], minHalf: (p, s) => halfAt2(before, p.ctrl, s) });
  const h = hits.get('b');
  assert.ok(h && !h.inside, 'colide com B');
  assert.ok(Math.abs(h.overflow - (9 - 7.38)) < 0.05, `sobra ${h.overflow}`);
  assert.ok(Math.abs(h.dz + 1) < 1e-6, 'empurra para -z');
  assert.equal(hasAgents(doc, ctx, b), false);
  assert.ok(pushCorridor(doc, ctx, b, h, h.overflow + 0.05));
  assert.ok(b.points[1].z < -11.5, `nó do meio de B foi empurrado (${b.points[1].z})`);
  assert.equal(nodeCollisions(doc, ctx, a, 1, { sides: [1], minHalf: (p, s) => halfAt2(before, p.ctrl, s) }).size, 0, 'resolvido');
  // agente em cima de B: não pode empurrar
  doc.objects.push({ type: 'agent', id: 'g', levelId: 'l0', x: 10, z: -11 });
  assert.equal(hasAgents(doc, ctx, b), true);
});

test('mover um nó para dentro de outro corredor é detectado; ponta ligada não é empurrada', () => {
  const walls = { left: true, right: true, height: 3, thickness: 0.3 };
  const a = { ...base, id: 'a', walls, points: [{ x: 0, z: 0 }, { x: 10, z: -9 }, { x: 20, z: 0 }] };
  const b = { ...base, id: 'b', walls, links: { start: { id: 'x', jid: 'j' } }, points: [{ x: 10, z: -10 }, { x: 30, z: -10 }] };
  const doc = { objects: [a, b] };
  const ctx = ctxFor(doc.objects);
  const h = nodeCollisions(doc, ctx, a, 1).get('b');
  assert.ok(h, 'nó de A dentro de B');
  // B só tem a ponta ligada (presa) e a outra ponta; a ponta presa não se mexe
  const z0 = b.points[0].z;
  pushCorridor(doc, ctx, b, { ...h, dx: 0, dz: -1 }, 2);
  assert.equal(b.points[0].z, z0);
});

test('quem foi editado por último é quem encosta, não o mais novo', () => {
  const walls = { left: true, right: true, height: 3, thickness: 0.3 };
  // b é mais novo no documento, mas a foi editado depois
  const a = { ...base, id: 'a', walls, edited: 5, points: [{ x: 0, z: -10 }, { x: 0, z: 0, wl: 12 }, { x: 0, z: 10 }] };
  const b = { ...base, id: 'b', walls, edited: 2, points: [{ x: -8, z: -10 }, { x: -8, z: 10 }] };
  const j = computeJunctions(ctxFor([a, b]));
  assert.equal(j.get('b').clamp, undefined, 'b fica como está');
  assert.ok(j.get('a').clamp, 'a se ajusta');
  // a vai em +z: normal (+x) com lado -1 aponta para b, em x = -8
  const fl = { nx: 1, nz: 0, miter: 1 };
  const h = j.get('a').clamp({ x: 0, z: 0, s: 10 }, fl, -1);
  assert.ok(Math.abs(h - (8 - 2.3 - 0.3 - 0.02)) < 1e-6, `meia-largura ${h}`);
});

test('salas sobrepostas se fundem: a parede some só dentro da outra sala', async () => {
  const { circlePoints } = await import('../src/editor/polar.js');
  const area = (id, cx, r) => ({ id, type: 'area', levelId: 'l0', closed: true, smooth: 0, shape: 'circle', points: circlePoints(cx, 0, r), proc: { segment: 1 }, walls: { enabled: true, height: 3, thickness: 0.3 }, joins: { areas: 'door' }, doorWidth: 1.6 });
  const A = area('A', 0, 10), B = area('B', 14, 8), C = area('C', 40, 5);
  const j = computeJunctions(ctxFor([A, B, C]));
  const ca = j.get('A').cuts.filter((c) => c.style === 'merge');
  const cb = j.get('B').cuts.filter((c) => c.style === 'merge');
  assert.equal(ca.length, 1, 'A abre um trecho');
  assert.equal(cb.length, 1, 'B abre um trecho');
  assert.equal(j.get('C').cuts.length, 0, 'C não encosta em ninguém');
  // o trecho de A fica do lado de B (perto de x=10, ângulo 0 → s≈0, passando do fim ao começo)
  const total = 2 * Math.PI * 10;
  const mid = ((ca[0].s % total) + total) % total;
  assert.ok(mid < 4 || mid > total - 4, `meio do corte em s=${mid}`);
  assert.ok(ca[0].s1 - ca[0].s0 > 2 && ca[0].s1 - ca[0].s0 < 15);
});
