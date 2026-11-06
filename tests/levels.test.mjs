import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetSpan, objectLevelIds, snapTopToLevels, suggestLedgeHeight } from '../src/levels.js';

const doc = {
  levels: [
    { id: 'l0', elevation: 0 },
    { id: 'l1', elevation: 4 },
    { id: 'l2', elevation: 8 },
    { id: 'l3', elevation: 12 },
  ],
};
const levelY = (id) => doc.levels.find((l) => l.id === id)?.elevation ?? 0;
const tower = (props = {}) => ({ type: 'asset', levelId: 'l0', y: 0, scale: { x: 1, y: 1, z: 1 }, topLevelId: 'l2', topOffset: 0, ledges: [], ...props });

test('asset que vai até um andar tem a altura do andar', () => {
  assert.deepEqual(assetSpan(tower(), levelY), { base: 0, top: 8, height: 8 });
  assert.equal(assetSpan(tower({ topOffset: 1.5 }), levelY).height, 9.5);
  assert.equal(assetSpan(tower({ levelId: 'l1', y: 0.5 }), levelY).height, 3.5);
  assert.equal(assetSpan(tower({ topLevelId: null }), levelY), null);
});

test('topo abaixo da base não fica com altura negativa', () => {
  const s = assetSpan(tower({ levelId: 'l3', topLevelId: 'l1' }), levelY);
  assert.ok(s.height > 0);
});

test('asset aparece em todos os andares que atravessa', () => {
  assert.deepEqual([...objectLevelIds(tower(), doc)].sort(), ['l0', 'l1', 'l2']);
  assert.deepEqual([...objectLevelIds(tower({ topLevelId: null }), doc)], ['l0']);
  const cor = { type: 'corridor', levelId: 'l0', endLevelId: 'l1' };
  assert.deepEqual([...objectLevelIds(cor, doc)].sort(), ['l0', 'l1']);
});

test('extrusão encaixa no andar mais próximo', () => {
  assert.deepEqual(snapTopToLevels(7.7, doc.levels, { minY: 0 }), { y: 8, levelId: 'l2', offset: 0 });
  // longe de um andar: passo de 0,25 m preso ao andar de baixo
  const r = snapTopToLevels(5.9, doc.levels, { minY: 0 });
  assert.equal(r.levelId, 'l1');
  assert.equal(r.y, 6);
  assert.equal(r.offset, 2);
  // Alt: livre
  assert.equal(snapTopToLevels(7.7, doc.levels, { free: true, minY: 0 }).y, 7.7);
  // não encaixa no próprio chão da base
  assert.notEqual(snapTopToLevels(0.2, doc.levels, { minY: 0 }).y, 0);
});

test('plataforma nova vai para o meio do primeiro vão livre', () => {
  const o = tower();
  assert.equal(suggestLedgeHeight(o, doc), 2);
  o.ledges.push({ h: 2 });
  assert.equal(suggestLedgeHeight(o, doc), 6);
});
