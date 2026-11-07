import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicRuntime, compare } from '../src/logic/runtime.js';
import { makeRule, describeRule, rulesUsing } from '../src/logic/schema.js';
import { buildSource } from '../src/logic/script.js';

const hostFor = (extra = {}) => {
  const acts = [];
  return { acts, act: (a) => acts.push(a), isEnemyDead: () => false, enemiesLeft: () => 1, totalItems: () => 2, playerHealth: () => 100, ...extra };
};

test('pegar a chave abre a porta só uma vez', () => {
  const r = makeRule({ when: { type: 'pickup', target: 'key' }, do: [{ type: 'open', target: 'door' }, { type: 'message', text: 'Abriu' }] });
  const h = hostFor();
  const rt = new LogicRuntime({ goal: { type: 'rules' }, rules: [r] }, h);
  rt.start();
  rt.addItem('coin');
  assert.equal(h.acts.length, 0);
  rt.addItem('key');
  assert.deepEqual(h.acts.map((a) => a.type), ['open', 'message']);
  rt.addItem('key');
  assert.equal(h.acts.length, 2, 'regra só uma vez');
});

test('condição de item e contador com esperar', () => {
  const rules = [
    makeRule({ id: 'a', once: false, when: { type: 'kill', target: null }, do: [{ type: 'addVar', target: 'mortes', value: 1 }] }),
    makeRule({ id: 'b', when: { type: 'varChange', target: 'mortes' }, if: [{ type: 'var', target: 'mortes', op: '>=', value: 2 }, { type: 'hasItem', target: 'key' }], do: [{ type: 'wait', value: 1 }, { type: 'spawn', target: 'boss' }] }),
  ];
  const h = hostFor();
  const rt = new LogicRuntime({ goal: { type: 'rules' }, rules }, h);
  rt.start();
  rt.emit('kill', 'e1');
  rt.emit('kill', 'e2');
  assert.equal(rt.getVar('mortes'), 2);
  assert.equal(h.acts.length, 0, 'sem a chave não dispara');
  rt.addItem('key', 1, false);
  rt.emit('kill', 'e3');
  assert.equal(h.acts.length, 0, 'espera antes de agir');
  rt.update(1.1);
  assert.deepEqual(h.acts.map((a) => a.type), ['spawn']);
});

test('objetivos: zona, tempo limite e coletar tudo', () => {
  let h = hostFor();
  let rt = new LogicRuntime({ goal: { type: 'reachZone', zoneId: 'z' }, rules: [] }, h);
  rt.start();
  rt.emit('enter', 'outra');
  assert.equal(rt.ended, null);
  rt.emit('enter', 'z');
  assert.equal(rt.ended.win, true);

  h = hostFor();
  rt = new LogicRuntime({ goal: { type: 'killAll' }, timeLimit: 5, rules: [] }, h);
  rt.start();
  rt.update(5.01);
  assert.equal(rt.ended.win, false);

  h = hostFor();
  rt = new LogicRuntime({ goal: { type: 'collectAll' }, rules: [] }, h);
  rt.start();
  rt.addItem('a'); rt.addItem('a');
  assert.equal(rt.ended, null, 'pegar o mesmo item duas vezes não conta');
  rt.addItem('b');
  assert.equal(rt.ended.win, true);
});

test('matar todos só vence sem inimigos dormindo', () => {
  let left = 1;
  const h = hostFor({ enemiesLeft: (d) => (d ? left : 0) });
  const rt = new LogicRuntime({ goal: { type: 'killAll' }, rules: [] }, h);
  rt.start();
  rt.emit('allKilled');
  assert.equal(rt.ended, null);
  left = 0;
  rt.emit('allKilled');
  assert.equal(rt.ended.win, true);
});

test('regra a cada N segundos, desligar e laço protegido', () => {
  const rules = [
    makeRule({ id: 'w', once: false, when: { type: 'every', value: 2 }, do: [{ type: 'spawn', target: 'x' }] }),
    makeRule({ id: 'loop', once: false, when: { type: 'varChange', target: 'n' }, do: [{ type: 'addVar', target: 'n', value: 1 }] }),
  ];
  const h = hostFor();
  const rt = new LogicRuntime({ goal: { type: 'rules' }, rules }, h);
  rt.start();
  rt.update(2.05); rt.update(2);
  assert.equal(h.acts.length, 2);
  rt.exec({ type: 'disableRule', target: 'w' });
  rt.update(2);
  assert.equal(h.acts.length, 2);
  rt.setVar('n', 1); // não pode travar
  assert.ok(rt.getVar('n') < 40);
});

test('compare, descrição e regras que usam um objeto', () => {
  assert.ok(compare(3, '>=', 3) && !compare(3, '<', 3) && compare(1, '!=', 2));
  const r = makeRule({ when: { type: 'pickup', target: 'k' }, do: [{ type: 'open', target: 'd' }] });
  assert.equal(describeRule(r, (id) => ({ k: 'Chave', d: 'Porta' }[id])), 'Pegar um item Chave → Abrir (porta/objeto) Porta');
  assert.equal(rulesUsing({ rules: [r] }, 'd').length, 1);
  assert.equal(rulesUsing({ rules: [r] }, 'x').length, 0);
});

test('script do level e de objeto compilam juntos', () => {
  const src = buildSource([{ code: 'on("start", () => game.open("Porta"))' }, { code: 'me.on("use", () => me.toggle())', me: { id: 'z', name: 'Alavanca', type: 'zone' } }]);
  const posted = [];
  let handler = null;
  const fn = new Function('postMessage', 'setTimeout', 'setInterval', `${src.replace('onmessage =', 'handler.set =')}`.replace(/^/, 'const handler = arguments[3];\n'));
  const box = { set: null };
  fn((m) => posted.push(m), () => 0, () => 0, box);
  handler = box.set;
  handler({ data: { kind: 'event', type: 'start', state: { vars: {}, items: {}, player: {}, enemies: [], objects: [], names: {} } } });
  handler({ data: { kind: 'event', type: 'use', target: 'outra' } });
  handler({ data: { kind: 'event', type: 'use', target: 'z' } });
  const acts = posted.filter((m) => m.kind === 'actions').flatMap((m) => m.actions);
  assert.deepEqual(acts, [{ type: 'open', target: 'Porta' }, { type: 'toggle', target: 'z' }]);
});
