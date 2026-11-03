import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Footprint } from '../src/builders/footprint.js';
import { normalizeDoc, emptyDoc, makeObject, applyWallDefaults } from '../src/model.js';

test('pegada mede a distância até o chão do level e bloqueia a saída', () => {
  // quadrado 10x10 em dois triângulos
  const sq = new Float32Array([0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10]);
  const fp = Footprint.fromTriangles([sq], { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, { pad: 20 });
  assert.ok(fp.distAt(5, 5) < 0.01);
  assert.ok(Math.abs(fp.distAt(15, 5) - 5) < 1);
  assert.ok(fp.distAt(5, 40) > 25, 'fora do raster continua crescendo');
  assert.equal(fp.blocked(5, 5), false);
  assert.equal(fp.blocked(14, 5), true);
});

test('paredes seguem a espessura/estilo global, exceto as personalizadas', () => {
  const d = emptyDoc();
  d.settings.walls = { thickness: 2, style: 'rocks' };
  const a = makeObject('corridor', { levelId: d.levels[0].id });
  const b = makeObject('wall', { levelId: d.levels[0].id, custom: true, thickness: 0.5 });
  d.objects.push(a, b);
  const n = normalizeDoc(d);
  assert.equal(n.objects[0].walls.thickness, 2);
  assert.equal(n.objects[0].walls.style, 'rocks');
  assert.equal(n.objects[1].thickness, 0.5);
  assert.equal(n.objects[1].style, 'smooth');
  assert.equal(applyWallDefaults(n.objects[0], n.settings), false);
});

test('documento antigo: espessura diferente da padrão vira personalizada', () => {
  const old = emptyDoc();
  delete old.settings.walls;
  delete old.settings.backdrop;
  old.objects.push({ id: 'c', type: 'corridor', levelId: old.levels[0].id, points: [], walls: { left: true, right: true, height: 3, thickness: 0.8 } });
  const n = normalizeDoc(old);
  assert.equal(n.objects[0].walls.custom, true);
  assert.equal(n.objects[0].walls.thickness, 0.8);
  assert.equal(n.settings.backdrop.enabled, false);
});
