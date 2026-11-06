import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetSpan, objectLevelIds, snapTopToLevels, snapVertical, suggestChildHeight,
  worldTransform, toParentLocal, withDescendants, syncVertical,
} from '../src/levels.js';

const levels = [
  { id: 'l0', elevation: 0 },
  { id: 'l1', elevation: 4 },
  { id: 'l2', elevation: 8 },
  { id: 'l3', elevation: 12 },
];
const levelY = (id) => levels.find((l) => l.id === id)?.elevation ?? 0;
const tower = (props = {}) => ({ id: 't', type: 'asset', levelId: 'l0', x: 0, z: 0, y: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, topLevelId: 'l2', topOffset: 0, parentId: null, ...props });
const docOf = (...objects) => ({ levels, objects });

test('asset que vai até um andar tem a altura do andar', () => {
  assert.deepEqual(assetSpan(tower(), levelY), { base: 0, top: 8, height: 8 });
  assert.equal(assetSpan(tower({ topOffset: 1.5 }), levelY).height, 9.5);
  assert.equal(assetSpan(tower({ levelId: 'l1', y: 0.5 }), levelY).height, 3.5);
  assert.equal(assetSpan(tower({ topLevelId: null }), levelY), null);
  assert.ok(assetSpan(tower({ levelId: 'l3', topLevelId: 'l1' }), levelY).height > 0);
});

test('asset aparece em todos os andares que atravessa', () => {
  assert.deepEqual([...objectLevelIds(tower(), docOf())].sort(), ['l0', 'l1', 'l2']);
  assert.deepEqual([...objectLevelIds(tower({ topLevelId: null }), docOf())], ['l0']);
  const cor = { type: 'corridor', levelId: 'l0', endLevelId: 'l1' };
  assert.deepEqual([...objectLevelIds(cor, docOf())].sort(), ['l0', 'l1']);
});

test('parede presa a um andar ganha a altura dele e acompanha a elevação', () => {
  const wall = { id: 'w', type: 'wall', levelId: 'l0', height: 3, topLevelId: 'l1', topOffset: 0, points: [] };
  const area = { id: 'a', type: 'area', levelId: 'l1', walls: { height: 3 }, topLevelId: 'l3', topOffset: -0.5, points: [] };
  const lv = levels.map((l) => ({ ...l }));
  const doc = { levels: lv, objects: [wall, area] };
  syncVertical(doc);
  assert.equal(wall.height, 4);
  assert.equal(area.walls.height, 7.5);
  lv[1].elevation = 5;
  syncVertical(doc);
  assert.equal(wall.height, 5);
  assert.deepEqual([...objectLevelIds(area, doc)].sort(), ['l1', 'l2', 'l3']);
  // andar excluído: solta
  doc.levels = lv.filter((l) => l.id !== 'l3');
  syncVertical(doc);
  assert.equal(area.topLevelId, null);
});

test('filho preso anda e gira com o pai', () => {
  const parent = tower({ x: 10, z: 5, rotY: Math.PI / 2 });
  const kid = { id: 'k', type: 'asset', levelId: 'l0', parentId: 't', x: 2, z: 0, y: 6, rotY: 0 };
  const doc = docOf(parent, kid);
  const w = worldTransform(kid, doc, levelY);
  // rotY 90°: x local vira -z no mundo
  assert.ok(Math.abs(w.x - 10) < 1e-9 && Math.abs(w.z - 3) < 1e-9);
  assert.equal(w.y, 6);
  assert.equal(w.rotY, Math.PI / 2);
  const back = toParentLocal(worldTransform(parent, doc, levelY), w.x, w.z);
  assert.ok(Math.abs(back.x - 2) < 1e-9 && Math.abs(back.z) < 1e-9);
  // filho a 6 m aparece no andar de 4 m
  assert.ok(objectLevelIds(kid, doc).has('l1'));
  assert.deepEqual([...withDescendants(doc, ['t'])].sort(), ['k', 't']);
  // filho fica no andar do pai
  parent.levelId = 'l1';
  syncVertical(doc);
  assert.equal(kid.levelId, 'l1');
});

test('extrusão encaixa no andar mais próximo', () => {
  assert.deepEqual(snapTopToLevels(7.7, levels, { minY: 0 }), { y: 8, levelId: 'l2', offset: 0 });
  const r = snapTopToLevels(5.9, levels, { minY: 0 });
  assert.equal(r.levelId, 'l1');
  assert.equal(r.y, 6);
  assert.equal(r.offset, 2);
  assert.equal(snapTopToLevels(7.7, levels, { free: true, minY: 0 }).y, 7.7);
  assert.notEqual(snapTopToLevels(0.2, levels, { minY: 0 }).y, 0);
});

test('subir pela base encaixa em andares e marcas', () => {
  assert.deepEqual(snapVertical(3.85, [0, 4, 8]), { y: 4, mark: 1 });
  assert.deepEqual(snapVertical(2.1, [0, 4, 8]), { y: 2, mark: -1 });
  assert.equal(snapVertical(2.1, [0, 4], { free: true }).y, 2.1);
});

test('plataforma presa nova vai para o meio do primeiro vão livre', () => {
  const p = tower();
  const doc = docOf(p);
  assert.equal(suggestChildHeight(p, doc), 2);
  doc.objects.push({ id: 'k', type: 'asset', parentId: 't', y: 1.8 });
  assert.equal(suggestChildHeight(p, doc), 6);
});
