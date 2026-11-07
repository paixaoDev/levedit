// Vocabulário da lógica do jogo: eventos (QUANDO), condições (SE) e ações (ENTÃO),
// mais os modos de jogo (objetivo). O editor monta os formulários a partir daqui e
// o modo jogo executa as regras com o LogicRuntime (runtime.js).
//
// Uma regra fica salva no level assim:
//   { id, name, enabled, once,
//     when: { type: 'pickup', target: 'ite_x' | null, value },
//     if:   [{ type: 'hasItem', target, op, value }],
//     do:   [{ type: 'open', target: 'ass_y', value, text }] }
//
// target: tipo de alvo que o campo aceita
//   item · enemy · zone · asset · thing (asset/item/inimigo/zona) · place (onde teleportar)
//   var (nome de contador) · rule (outra regra)
// any: o alvo pode ficar vazio ("qualquer")

export const EVENTS = {
  start: { label: 'O jogo começar' },
  pickup: { label: 'Pegar um item', target: 'item', any: 'qualquer item' },
  kill: { label: 'Derrotar um inimigo', target: 'enemy', any: 'qualquer inimigo' },
  allKilled: { label: 'Todos os inimigos forem derrotados' },
  enter: { label: 'O player entrar na zona', target: 'zone' },
  exit: { label: 'O player sair da zona', target: 'zone' },
  use: { label: 'O player usar a zona (F)', target: 'zone' },
  time: { label: 'Passar N segundos', value: 'seconds' },
  every: { label: 'A cada N segundos', value: 'seconds' },
  varChange: { label: 'Um contador mudar', target: 'var' },
  playerHurt: { label: 'O player levar dano' },
  playerDied: { label: 'O player morrer' },
};

export const OPS = { '==': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' };

export const CONDITIONS = {
  hasItem: { label: 'Tem o item', target: 'item' },
  noItem: { label: 'Não tem o item', target: 'item' },
  itemCount: { label: 'Itens coletados', op: true, value: 'number' },
  enemyDead: { label: 'Inimigo derrotado', target: 'enemy' },
  enemyAlive: { label: 'Inimigo vivo', target: 'enemy' },
  enemiesLeft: { label: 'Inimigos restantes', op: true, value: 'number' },
  var: { label: 'Contador', target: 'var', op: true, value: 'number' },
  time: { label: 'Tempo de jogo (s)', op: true, value: 'number' },
  health: { label: 'Vida do player', op: true, value: 'number' },
};

export const ACTIONS = {
  open: { label: 'Abrir (porta/objeto)', target: 'asset' },
  close: { label: 'Fechar', target: 'asset' },
  toggle: { label: 'Abrir/fechar', target: 'asset' },
  show: { label: 'Mostrar', target: 'thing' },
  hide: { label: 'Esconder', target: 'thing' },
  spawn: { label: 'Despertar inimigo', target: 'enemy' },
  kill: { label: 'Derrotar inimigo', target: 'enemy' },
  behavior: { label: 'Mudar comportamento', target: 'enemy', value: 'behavior' },
  message: { label: 'Mostrar mensagem', text: true },
  addVar: { label: 'Somar no contador', target: 'var', value: 'number' },
  setVar: { label: 'Definir contador', target: 'var', value: 'number' },
  give: { label: 'Dar item ao player', target: 'item' },
  teleport: { label: 'Teleportar player para', target: 'place' },
  heal: { label: 'Curar player', value: 'number' },
  damage: { label: 'Causar dano no player', value: 'number' },
  wait: { label: 'Esperar (s)', value: 'seconds' },
  enableRule: { label: 'Ligar regra', target: 'rule' },
  disableRule: { label: 'Desligar regra', target: 'rule' },
  win: { label: 'Vencer o level', text: true },
  lose: { label: 'Perder o level', text: true },
};

export const GOALS = {
  killAll: { label: 'Derrotar todos os inimigos' },
  reachZone: { label: 'Chegar numa zona', zone: true },
  collectAll: { label: 'Coletar todos os itens' },
  survive: { label: 'Sobreviver por N segundos', seconds: true },
  rules: { label: 'Livre (as regras decidem)' },
};

/** Valor inicial de uma regra nova. */
export function makeRule(props = {}) {
  return {
    id: `rul_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: 'Nova regra',
    enabled: true,
    once: true,
    when: { type: 'start', target: null, value: 5 },
    if: [],
    do: [],
    ...props,
  };
}

/** Valores padrão para um passo novo (condição ou ação) do tipo dado. */
export function makeStep(type, kind = 'do') {
  const def = (kind === 'if' ? CONDITIONS : ACTIONS)[type] || {};
  const s = { type, target: null };
  if (def.op) s.op = '>=';
  if (def.value === 'number') s.value = type === 'heal' || type === 'damage' ? 25 : 1;
  if (def.value === 'seconds') s.value = 2;
  if (def.value === 'behavior') s.value = 'chase';
  if (def.text) s.text = type === 'win' ? 'Você venceu!' : type === 'lose' ? 'Fim de jogo' : 'Mensagem';
  return s;
}

/** Objetos do level que servem de alvo para um tipo de campo. */
export function targetsFor(kind, doc) {
  const objs = doc.objects || [];
  const enemy = (o) => o.type === 'agent' && o.role === 'enemy';
  switch (kind) {
    case 'item': return objs.filter((o) => o.type === 'item');
    case 'enemy': return objs.filter(enemy);
    case 'zone': return objs.filter((o) => o.type === 'zone');
    case 'asset': return objs.filter((o) => o.type === 'asset');
    case 'thing': return objs.filter((o) => o.type === 'asset' || o.type === 'item' || o.type === 'zone' || enemy(o));
    case 'place': return objs.filter((o) => o.type === 'zone' || o.type === 'item' || o.type === 'asset' || o.type === 'agent');
    default: return [];
  }
}

/** Nomes de contadores usados nas regras (para sugerir no editor). */
export function varNames(logic) {
  const out = new Set();
  for (const r of logic?.rules || []) {
    if (r.when?.type === 'varChange' && r.when.target) out.add(r.when.target);
    for (const s of [...(r.if || []), ...(r.do || [])]) if ((s.type === 'var' || s.type === 'addVar' || s.type === 'setVar') && s.target) out.add(s.target);
  }
  return [...out];
}

/** Regras que citam um objeto (no QUANDO, no SE ou no ENTÃO). */
export function rulesUsing(logic, id) {
  return (logic?.rules || []).filter((r) => r.when?.target === id || (r.if || []).some((s) => s.target === id) || (r.do || []).some((s) => s.target === id));
}

/** Frase curta que descreve uma regra ("Pegar Chave → Abrir Porta"). */
export function describeRule(r, nameOf = (id) => id) {
  const ev = EVENTS[r.when?.type];
  if (!ev) return r.name;
  let w = ev.label;
  if (ev.target) w += ` ${r.when.target ? nameOf(r.when.target) : ev.any || '?'}`;
  if (ev.value) w = w.replace('N', String(r.when.value ?? '?'));
  const acts = (r.do || []).map((a) => {
    const d = ACTIONS[a.type];
    if (!d) return '?';
    if (a.type === 'message') return `"${a.text || ''}"`;
    return d.target ? `${d.label} ${a.target ? nameOf(a.target) : '?'}` : d.label;
  });
  return `${w} → ${acts.join(', ') || 'nada'}`;
}
