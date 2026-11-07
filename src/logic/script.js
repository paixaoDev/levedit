// Script do level (avançado): JavaScript do autor rodando num Web Worker isolado,
// sem acesso à página. O worker recebe os eventos do jogo e um retrato do estado
// e devolve ações, que passam pelo mesmo executor das regras.
//
// API dentro do script:
//   on('pickup', (alvo, estado) => { ... })     eventos: start, pickup, kill, allKilled,
//                                               enter, exit, use, varChange, playerHurt,
//                                               playerDied, tick (5x por segundo)
//   game.open('Porta 1')  game.close  game.toggle  game.show  game.hide
//   game.spawn('Inimigo 2')  game.kill  game.behavior('Inimigo 2', 'chase')
//   game.goTo('Inimigo 2', x, z)   leva o inimigo até um ponto (null solta)
//   game.message('Olá', 3)  game.win('texto')  game.lose('texto')
//   game.heal(20)  game.damage(10)  game.teleport('Zona 1')  game.give('Chave')
//   game.setVar('pontos', 0)  game.addVar('pontos', 1)  game.var('pontos')
//   game.has('Chave')  game.state  (player, inimigos, objetos, contadores, itens, tempo)
//   game.moveTo('Plataforma', x, z, { y, seconds })  game.rotate('Portão', 90, 0.6)
//   game.color('Caixa 1', '#c0632f')  game.param('player', 'speed', 12)  game.push(0, 12, 0)
//   after(segundos, fn)  every(segundos, fn)
// Os alvos podem ser o nome do objeto (como aparece na lista), o id ou 'player'.
//
// Script de um objeto (player, inimigo, asset, item ou zona): o mesmo código, mais
// "me", que é o próprio objeto. me.on('enter', fn) só escuta eventos desse objeto
// (zona: enter/exit/use · item: pickup · inimigo: kill · player: playerHurt/playerDied);
// me.open(), me.hide(), me.moveTo(x, z), me.param('speed', 9), me.state() etc.

const PRELUDE = `
'use strict';
const __h = {};
let __out = [];
let __state = { time: 0, vars: {}, items: {}, player: {}, enemies: [], objects: [], names: {} };
const on = (ev, fn) => { (__h[ev] ||= []).push(fn); };
const __push = (a) => { __out.push(a); };
const __flush = () => { if (__out.length) { postMessage({ kind: 'actions', actions: __out }); __out = []; } };
const __guard = (fn, ...args) => { try { fn(...args); } catch (e) { postMessage({ kind: 'error', message: String(e && e.message || e) }); } __flush(); };
const after = (s, fn) => setTimeout(() => __guard(fn), Math.max(0, s * 1000));
const every = (s, fn) => setInterval(() => __guard(fn), Math.max(100, s * 1000));
const game = {
  open: (t) => __push({ type: 'open', target: t }),
  close: (t) => __push({ type: 'close', target: t }),
  toggle: (t) => __push({ type: 'toggle', target: t }),
  show: (t) => __push({ type: 'show', target: t }),
  hide: (t) => __push({ type: 'hide', target: t }),
  spawn: (t) => __push({ type: 'spawn', target: t }),
  kill: (t) => __push({ type: 'kill', target: t }),
  behavior: (t, b) => __push({ type: 'behavior', target: t, value: b }),
  goTo: (t, x, z) => __push({ type: 'goTo', target: t, value: x == null ? null : { x: +x, z: +z } }),
  message: (text, seconds) => __push({ type: 'message', text: String(text), value: seconds }),
  win: (text) => __push({ type: 'win', text }),
  lose: (text) => __push({ type: 'lose', text }),
  heal: (n) => __push({ type: 'heal', value: n }),
  damage: (n) => __push({ type: 'damage', value: n }),
  teleport: (t) => __push({ type: 'teleport', target: t }),
  give: (t) => __push({ type: 'give', target: t }),
  moveTo: (t, x, z, o = {}) => __push({ type: 'moveTo', target: t, value: { x: +x, z: +z, y: o.y, seconds: o.seconds } }),
  rotate: (t, deg, seconds) => __push({ type: 'rotate', target: t, value: deg, seconds }),
  color: (t, c) => __push({ type: 'color', target: t, value: String(c) }),
  param: (t, key, v) => __push({ type: 'param', target: t, key: String(key), value: v }),
  push: (x, y, z) => __push({ type: 'push', value: { x: +x || 0, y: +y || 0, z: +z || 0 } }),
  setVar: (n, v) => { __state.vars[n] = +v || 0; __push({ type: 'setVar', target: n, value: v }); },
  addVar: (n, v = 1) => { __state.vars[n] = (__state.vars[n] || 0) + (+v || 0); __push({ type: 'addVar', target: n, value: v }); },
  var: (n) => __state.vars[n] || 0,
  has: (t) => (__state.items[t] || __state.items[__state.names[t]] || 0) > 0,
  get state() { return __state; },
};
const __OWN = { zone: ['enter', 'exit', 'use'], item: ['pickup'], enemy: ['kill'], player: ['playerHurt', 'playerDied'] };
function __obj(info) {
  const id = info.id;
  const me = { id, name: info.name, type: info.type, role: info.role };
  me.on = (ev, fn) => on(ev, (t, s) => { if (ev === 'tick' || t === id || !(__OWN[info.role || info.type] || []).includes(ev)) fn(t, s); });
  for (const k of ['open', 'close', 'toggle', 'show', 'hide', 'spawn', 'kill', 'teleport', 'give']) me[k] = () => game[k](id);
  me.behavior = (b) => game.behavior(id, b);
  me.goTo = (x, z) => game.goTo(id, x, z);
  me.moveTo = (x, z, o) => game.moveTo(id, x, z, o);
  me.rotate = (d, s) => game.rotate(id, d, s);
  me.color = (c) => game.color(id, c);
  me.param = (k, v) => game.param(id, k, v);
  me.state = () => (__state.player.id === id ? __state.player : null) || __state.enemies.find((e) => e.id === id) || __state.objects.find((o) => o.id === id) || null;
  return me;
}
onmessage = (e) => {
  const m = e.data;
  if (m.state) __state = m.state;
  if (m.kind === 'event') for (const fn of (__h[m.type] || [])) __guard(fn, m.target, __state);
};
`;

export class LevelScript {
  /**
   * @param {{code:string, me?:object}[]|string} parts script do level e/ou scripts de objetos
   * @param {(actions:object[]) => void} onActions
   * @param {(message:string) => void} onError
   */
  constructor(parts, onActions, onError) {
    this.ok = false;
    if (typeof parts === 'string') parts = [{ code: parts }];
    parts = (parts || []).filter((p) => p.code?.trim());
    if (typeof Worker === 'undefined' || !parts.length) return;
    this.source = buildSource(parts);
    const body = this.source;
    this.url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
    try {
      this.worker = new Worker(this.url);
    } catch (e) {
      onError(String(e.message || e));
      return;
    }
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m?.kind === 'actions' && Array.isArray(m.actions)) onActions(m.actions.slice(0, 200));
      else if (m?.kind === 'error') onError(m.message);
    };
    this.worker.onerror = (e) => { e.preventDefault?.(); onError(e.message || 'erro no script'); };
    this.ok = true;
  }

  send(type, target, state) {
    if (!this.ok) return;
    try { this.worker.postMessage({ kind: 'event', type, target, state }); } catch { /* estado não serializável */ }
  }

  stop() {
    this.worker?.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
    this.ok = false;
  }
}

/** Junta o prelúdio e os scripts; cada script de objeto roda numa função com "me". */
export function buildSource(parts) {
  const blocks = parts.map((p) => {
    const label = p.me ? `script de ${p.me.name}` : 'script do level';
    const head = p.me ? `(function (me) {\n` : `(function () {\n`;
    const tail = p.me ? `\n})(__obj(${JSON.stringify(p.me)}));` : `\n})();`;
    return `try {\n${head}${p.code}${tail}\n} catch (e) { postMessage({ kind: 'error', message: ${JSON.stringify(label)} + ': ' + String(e && e.message || e) }); }`;
  });
  return `${PRELUDE}\n${blocks.join('\n')}\n__flush();\n`;
}

export const SCRIPT_EXAMPLE = `// Exemplo: cada moeda vale 1 ponto; com 3 pontos a porta abre.
on('start', () => {
  game.setVar('pontos', 0);
  game.message('Junte 3 moedas!', 3);
});

on('pickup', (item) => {
  game.addVar('pontos', 1);
  if (game.var('pontos') >= 3) {
    game.open('Porta 1');
    game.message('A porta abriu!');
  }
});

// Inimigo que vigia o player: quando ele chega perto, persegue
on('tick', (_, s) => {
  for (const e of s.enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(e.x - s.player.x, e.z - s.player.z);
    if (d < 6) game.behavior(e.name, 'chase');
  }
});
`;

/** Exemplos para o script de cada tipo de objeto. */
export const OBJECT_SCRIPT_EXAMPLES = {
  player: `// Player: fica mais rápido com pouca vida e ganha um super pulo numa zona
on('playerHurt', () => {
  const p = game.state.player;
  if (p.health < 30) { me.param('speed', 10); game.message('Adrenalina!', 2); }
});
on('enter', (zona) => {
  if (game.state.names['Trampolim'] === zona) game.push(0, 14, 0);
});`,
  enemy: `// Inimigo: vigia, persegue quando o player chega perto e foge com pouca vida
me.on('tick', (_, s) => {
  const e = me.state();
  if (!e || !e.alive) return;
  const d = Math.hypot(e.x - s.player.x, e.z - s.player.z);
  if (e.health < 15) me.behavior('flee');
  else if (d < 7) me.behavior('chase');
  else me.behavior('guard');
});`,
  asset: `// Objeto: plataforma que vai e volta a cada 3 segundos
let ida = true;
every(3, () => {
  const s = me.state();
  me.moveTo(ida ? s.x + 6 : s.x - 6, s.z, { seconds: 2.5 });
  ida = !ida;
});`,
  item: `// Item: ao ser pego, abre a porta e acorda o guarda
me.on('pickup', () => {
  game.open('Porta 1');
  game.spawn('Inimigo 1');
  game.message('Alguém ouviu você...');
});`,
  zone: `// Zona: alavanca que alterna o portão ao apertar F
me.on('use', () => {
  game.toggle('Portão');
  game.addVar('alavancas', 1);
});`,
};
