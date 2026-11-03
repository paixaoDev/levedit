import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc, makeObject, emptyDoc, LIGHTING_DEFAULTS } from '../src/model.js';

test('documento antigo ganha iluminação padrão e tetos desligados', () => {
  const old = emptyDoc();
  delete old.settings.lighting;
  old.objects.push({ id: 'c1', type: 'corridor', levelId: old.levels[0].id, points: [] });
  old.objects.push({ id: 'a1', type: 'area', levelId: old.levels[0].id, points: [] });
  const d = normalizeDoc(old);
  assert.deepEqual(d.settings.lighting, LIGHTING_DEFAULTS);
  assert.equal(d.objects[0].roof.enabled, false);
  assert.equal(d.objects[1].roof.enabled, false);
});

test('luz pontual tem posição, cor, alcance e sombra', () => {
  const l = makeObject('light', { x: 3, z: 4 });
  assert.equal(l.type, 'light');
  assert.equal(l.x, 3);
  assert.ok(l.range > 0 && l.intensity > 0 && l.y > 0);
  assert.equal(l.shadows, true);
});
