import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePath, segmentArc, bulgeFor, expandArcs } from '../src/math/curve.js';
import { circlePoints, circleOf, polarSnap, withArcs, refitArcs, ringsOf } from '../src/editor/polar.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('círculo de 4 nós em arco amostra um círculo de verdade', () => {
  const pts = circlePoints(3, -2, 5);
  const s = samplePath(pts, { closed: true, spacing: 0.5 });
  for (const p of s) assert.ok(near(Math.hypot(p.x - 3, p.z + 2), 5, 1e-9));
  const L = s.at(-1).s + Math.hypot(s[0].x - s.at(-1).x, s[0].z - s.at(-1).z);
  assert.ok(near(L, 2 * Math.PI * 5, 0.05), `perímetro ${L}`);
  // ctrl continua apontando para os nós originais
  assert.equal(s[0].ctrl, 0);
  assert.ok(s.at(-1).ctrl > 3 && s.at(-1).ctrl < 4);
  const c = circleOf({ shape: 'circle', points: pts });
  assert.ok(near(c.cx, 3) && near(c.cz, -2) && near(c.r, 5));
});

test('bulge ida e volta: bulgeFor ↔ segmentArc', () => {
  const C = { x: 1, z: 1 }, A = { x: 5, z: 1 }, B = { x: 1, z: -3 };
  for (const dir of [0, 1, -1]) {
    const b = bulgeFor(C, A, B, dir);
    const arc = segmentArc(A, B, b);
    assert.ok(near(arc.cx, 1) && near(arc.cz, 1) && near(arc.r, 4), `dir ${dir}`);
    if (dir) assert.equal(Math.sign(arc.sweep), dir);
  }
  // o mais curto: 90° horário
  assert.ok(near(segmentArc(A, B, bulgeFor(C, A, B)).sweep, -Math.PI / 2));
});

test('segmento reto sem bulge não é expandido', () => {
  const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }];
  assert.equal(expandArcs(pts).length, 2);
});

const SRC = [{ id: 'sala', cx: 0, cz: 0, R: 10, ring0: 9.85 }];

test('grade polar encaixa em anel × raio e no centro', () => {
  const opt = { step: 2, divisions: 24 };
  assert.deepEqual(ringsOf(SRC[0], 2).map((r) => +r.toFixed(2)), [9.85, 7.85, 5.85, 3.85, 1.85]);
  const p = polarSnap({ x: 7.6, z: 0.4 }, SRC, opt);
  assert.equal(p.pol.ring, 1);
  assert.ok(near(p.x, 7.85) && near(p.z, 0));
  const c = polarSnap({ x: 0.3, z: -0.2 }, SRC, opt);
  assert.equal(c.pol.ring, -1);
  assert.ok(near(c.x, 0) && near(c.z, 0));
  assert.equal(polarSnap({ x: 30, z: 0 }, SRC, opt), null, 'fora da sala não encaixa');
});

test('dois pontos no mesmo anel viram arco; radial fica reta', () => {
  const opt = { step: 2, divisions: 24 };
  const a = polarSnap({ x: 7.8, z: 0 }, SRC, opt);
  const b = polarSnap({ x: 0, z: 7.8 }, SRC, opt);
  const c = polarSnap({ x: 0, z: 3.9 }, SRC, opt);
  const pts = withArcs([a, b, c]);
  assert.ok(pts[0].b > 0, 'arco anti-horário de 90°');
  assert.equal(pts[1].b, undefined, 'radial é reta');
  assert.ok(!('pol' in pts[0]));
  const s = samplePath(pts, { spacing: 0.5 });
  const onArc = s.filter((p) => p.ctrl <= 1);
  for (const p of onArc) assert.ok(near(Math.hypot(p.x, p.z), 7.85, 1e-6));
});

test('mover a ponta de um arco ao longo do anel mantém o arco no anel', () => {
  const o = { type: 'wall', points: [{ x: 7.85, z: 0, b: bulgeFor({ x: 0, z: 0 }, { x: 7.85, z: 0 }, { x: 0, z: 7.85 }) }, { x: 0, z: 7.85 }] };
  o.points[1] = { x: -7.85, z: 0 }; // 180°: mantém o sentido anti-horário
  refitArcs(o, 1, SRC);
  const arc = segmentArc(o.points[0], o.points[1], o.points[0].b);
  assert.ok(near(arc.cx, 0) && near(arc.cz, 0) && arc.sweep > 0);
});
