import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformCaps, rootsOf, pivotOf, captureOrig, moveObjects, rotateObjects, scaleObject } from '../src/editor/transform.js';

const levelY = () => 0;
const asset = (p = {}) => ({ id: 'a', type: 'asset', levelId: 'l0', x: 0, z: 0, y: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, topLevelId: null, parentId: null, ...p });
const docOf = (...objects) => ({ levels: [{ id: 'l0', elevation: 0 }], objects });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('o que cada tipo aceita', () => {
  assert.equal(transformCaps(asset()).move.y, true);
  assert.equal(transformCaps({ type: 'light' }).rotate, false);
  assert.equal(transformCaps({ type: 'agent' }).scale, null);
  assert.equal(transformCaps(asset({ topLevelId: 'l1' })).scale.y, false);
  const circle = { type: 'area', shape: 'circle', points: [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }] };
  assert.equal(transformCaps(circle).scale.x, false);
  assert.equal(transformCaps(circle).scale.uniform, true);
});

test('filho de um selecionado não conta duas vezes', () => {
  const doc = docOf(asset(), asset({ id: 'b', parentId: 'a' }), asset({ id: 'c' }));
  assert.deepEqual(rootsOf(doc, ['a', 'b', 'c']).map((o) => o.id), ['a', 'c']);
});

test('mover um eixo não encaixa o outro', () => {
  const doc = docOf(asset({ x: 0.3, z: 0.3 }));
  const og = [captureOrig(doc.objects[0], doc, levelY)];
  moveObjects(doc, og, 1.2, 0, { grid: 1, levelY });
  assert.equal(doc.objects[0].x, 1.5);
  assert.equal(doc.objects[0].z, 0.3);
});

test('curva move junto e solta pontas presas', () => {
  const w = { id: 'w', type: 'wall', levelId: 'l0', points: [{ x: 0, z: 0, att: { id: 'x' } }, { x: 4, z: 0 }] };
  const doc = docOf(w);
  moveObjects(doc, [captureOrig(w, doc, levelY)], 2, 1, { levelY });
  assert.deepEqual(doc.objects[0].points, [{ x: 2, z: 1 }, { x: 6, z: 1 }]);
});

test('girar vários em volta do centro', () => {
  const doc = docOf(asset({ x: 2, z: 0 }), asset({ id: 'b', x: -2, z: 0 }));
  const og = doc.objects.map((o) => captureOrig(o, doc, levelY));
  rotateObjects(doc, og, { x: 0, z: 0 }, Math.PI / 2, { levelY });
  near(doc.objects[0].x, 0); near(doc.objects[0].z, -2);
  near(doc.objects[1].z, 2);
  near(doc.objects[0].rotY, Math.PI / 2);
});

test('girar um sozinho encaixa de 15 em 15°', () => {
  const doc = docOf(asset({ rotY: 0.1 }));
  rotateObjects(doc, [captureOrig(doc.objects[0], doc, levelY)], { x: 0, z: 0 }, 0.1, { snapOn: true, levelY });
  near(doc.objects[0].rotY, Math.PI / 12);
});

test('escala de asset, zona e sala circular', () => {
  const doc = docOf(asset(), { id: 'z', type: 'zone', w: 4, d: 4, h: 3 },
    { id: 'c', type: 'area', shape: 'circle', points: [{ x: 3, z: 0 }, { x: 0, z: 3 }, { x: -3, z: 0 }, { x: 0, z: -3 }] });
  scaleObject(doc, captureOrig(doc.objects[0], doc, levelY), { x: 0, z: 0 }, 2, 1, 1.5, { snapOn: true });
  assert.deepEqual(doc.objects[0].scale, { x: 2, y: 1, z: 1.5 });
  scaleObject(doc, captureOrig(doc.objects[1], doc, levelY), { x: 0, z: 0 }, 1.5, 1, 1, { snapOn: true });
  assert.equal(doc.objects[1].w, 6);
  const r = scaleObject(doc, captureOrig(doc.objects[2], doc, levelY), pivotOf(doc.objects[2], doc, levelY), 2, 2, 2, {});
  near(r.r, 6);
});
