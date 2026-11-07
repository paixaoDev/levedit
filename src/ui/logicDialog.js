// Janela "Lógica do jogo": modo simples (objetivo + regras QUANDO → SE → ENTÃO,
// sem código) e modo avançado (script do level e lista dos scripts de objetos).
import { el } from './fields.js';
import { svgIcon, UI_ICONS, TOOL_ICONS } from './icons.js';
import { BEHAVIORS } from '../model.js';
import { EVENTS, CONDITIONS, ACTIONS, OPS, GOALS, makeRule, makeStep, targetsFor, varNames, describeRule } from '../logic/schema.js';
import { SCRIPT_EXAMPLE } from '../logic/script.js';

const TARGET_HINT = { item: 'item', enemy: 'inimigo', zone: 'zona', asset: 'objeto', thing: 'objeto', place: 'lugar', rule: 'regra' };

export class LogicDialog {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.tab = 'simple';
    this.focusRule = null;
    this.$ = document.getElementById('logic-dialog');
    this.$.addEventListener('close', () => { this.focusRule = null; });
    this.store.addEventListener('change', () => { if (this.$.open && !this._self) this.render(); });
    window.addEventListener('play:start', () => { if (this.$.open) this.$.close(); });
  }

  get logic() { return this.store.doc.logic; }

  open({ tab, ruleId } = {}) {
    if (tab) this.tab = tab;
    this.focusRule = ruleId || null;
    this.render();
    if (!this.$.open) this.$.showModal();
    if (ruleId) requestAnimationFrame(() => this.$.querySelector(`[data-rule="${ruleId}"]`)?.scrollIntoView({ block: 'center' }));
  }

  /** Muda a lógica do level (com desfazer) e redesenha a janela. */
  edit(fn, rerender = true) {
    this._self = true;
    try { this.store.mutate((d) => fn(d.logic, d), { ids: [], structure: false }); } finally { this._self = false; }
    if (rerender) this.render();
  }

  nameOf(id) {
    if (!id) return '';
    const o = this.store.get(id);
    return o ? o.name : (this.logic.rules.find((r) => r.id === id)?.name || '(removido)');
  }

  // ------------------------------------------------------------ desenho
  render() {
    const d = this.$;
    const scroll = d.querySelector('.logic-body')?.scrollTop || 0;
    d.innerHTML = '';
    const tabBtn = (id, label, icon) => el('button', {
      type: 'button', class: this.tab === id ? 'active' : '', 'aria-pressed': String(this.tab === id),
      onclick: () => { this.tab = id; this.render(); }, html: `${svgIcon(icon)}<span>${label}</span>`,
    });
    d.append(el('div', { class: 'dialog-head' },
      el('h3', {}, 'Lógica do jogo'),
      el('div', { class: 'seg logic-tabs', role: 'group', 'aria-label': 'Modo' },
        tabBtn('simple', 'Simples', UI_ICONS.bolt), tabBtn('advanced', 'Avançado (script)', UI_ICONS.code)),
      el('form', { method: 'dialog' }, el('button', { class: 'icon-btn', 'aria-label': 'Fechar', html: svgIcon(UI_ICONS.close) }))));
    const body = el('div', { class: 'logic-body' });
    if (this.tab === 'simple') this.renderSimple(body);
    else this.renderAdvanced(body);
    d.append(body);
    body.scrollTop = scroll;
  }

  renderSimple(box) {
    const L = this.logic;
    const doc = this.store.doc;
    // objetivo
    const g = L.goal;
    const goalSel = select(Object.fromEntries(Object.entries(GOALS).map(([k, v]) => [k, v.label])), g.type, (v) => this.edit((l) => { l.goal.type = v; }));
    const zones = targetsFor('zone', doc);
    box.append(el('section', { class: 'logic-goal' },
      el('div', { class: 'logic-sec-head' }, el('span', { class: 'chip-ico', html: svgIcon(UI_ICONS.flag) }), el('h4', {}, 'Modo de jogo')),
      el('div', { class: 'logic-row' },
        el('label', {}, 'Para vencer'), goalSel,
        GOALS[g.type]?.zone ? select({ '': zones.length ? '— escolha a zona —' : '— crie uma zona (Z) —', ...Object.fromEntries(zones.map((z) => [z.id, z.name])) }, g.zoneId || '', (v) => this.edit((l) => { l.goal.zoneId = v || null; })) : null,
        GOALS[g.type]?.seconds ? numberIn(g.seconds, (v) => this.edit((l) => { l.goal.seconds = v; }), 's') : null),
      el('div', { class: 'logic-row' },
        el('label', {}, 'Tempo limite'), numberIn(L.timeLimit, (v) => this.edit((l) => { l.timeLimit = Math.max(0, v); }), 's'),
        el('span', { class: 'muted' }, '0 = sem limite. Acabou o tempo, perde (ou vence, no modo sobreviver).')),
    ));

    // regras
    const head = el('div', { class: 'logic-sec-head' },
      el('span', { class: 'chip-ico', html: svgIcon(UI_ICONS.logic) }), el('h4', {}, 'Regras'),
      el('span', { class: 'muted' }, 'Quando algo acontece, se as condições valem, então faça.'),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => this.addRule(), html: `${svgIcon(UI_ICONS.plus)}<span>Nova regra</span>` }));
    box.append(head);
    box.append(el('div', { class: 'logic-templates' }, el('span', { class: 'muted' }, 'Modelos:'),
      ...TEMPLATES.map((t) => el('button', { class: 'btn small', type: 'button', onclick: () => this.addRule(t.make(doc)), 'data-tip': t.tip }, t.label))));
    if (!L.rules.length) {
      box.append(el('p', { class: 'logic-empty' }, 'Nenhuma regra ainda. Comece por um modelo, como "Chave abre porta": coloque um Item (I) e uma Porta (asset), e escolha os dois na regra.'));
    }
    for (const r of L.rules) box.append(this.ruleCard(r));
  }

  addRule(props = {}) {
    const r = makeRule({ name: `Regra ${this.logic.rules.length + 1}`, ...props });
    this.focusRule = r.id;
    this.edit((l) => { l.rules.push(r); });
    requestAnimationFrame(() => this.$.querySelector(`[data-rule="${r.id}"]`)?.scrollIntoView({ block: 'nearest' }));
    return r;
  }

  ruleCard(r) {
    const idx = this.logic.rules.indexOf(r);
    const upd = (fn, rerender = true) => this.edit((l) => { const x = l.rules.find((y) => y.id === r.id); if (x) fn(x); }, rerender);
    const name = el('input', { class: 'rule-name', value: r.name, 'aria-label': 'Nome da regra', spellcheck: 'false' });
    name.addEventListener('change', () => upd((x) => { x.name = name.value; }, false));
    const enabled = toggle(r.enabled !== false, (v) => upd((x) => { x.enabled = v; }), 'Ligada');
    const once = toggle(r.once !== false, (v) => upd((x) => { x.once = v; }), 'Só uma vez');
    const card = el('article', { class: `rule-card ${r.enabled === false ? 'off' : ''} ${this.focusRule === r.id ? 'focus' : ''}`, 'data-rule': r.id });
    card.append(el('div', { class: 'rule-head' }, name, enabled, once,
      el('div', { class: 'rule-tools' },
        iconB(UI_ICONS.chevron, 'Subir', () => this.move(idx, -1), 'up', idx === 0),
        iconB(UI_ICONS.chevron, 'Descer', () => this.move(idx, 1), 'down', idx === this.logic.rules.length - 1),
        iconB(UI_ICONS.copy, 'Duplicar', () => this.addRule({ ...JSON.parse(JSON.stringify(r)), id: undefined, name: `${r.name} cópia` })),
        iconB(UI_ICONS.trash, 'Excluir regra', () => this.edit((l) => { l.rules = l.rules.filter((x) => x.id !== r.id); }), 'danger'))));

    // QUANDO
    const ev = EVENTS[r.when.type] || EVENTS.start;
    const whenRow = el('div', { class: 'rule-line' }, el('span', { class: 'kw when' }, 'Quando'),
      select(Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label])), r.when.type, (v) => upd((x) => { x.when = { type: v, target: null, value: x.when.value ?? 5 }; })),
      ev.target ? this.targetInput(ev.target, r.when.target, (v) => upd((x) => { x.when.target = v; }), ev.any) : null,
      ev.value ? numberIn(r.when.value ?? 5, (v) => upd((x) => { x.when.value = v; }, false), 's') : null);
    card.append(whenRow);

    // SE
    const ifBox = el('div', { class: 'rule-steps' });
    (r.if || []).forEach((c, i) => ifBox.append(this.stepRow('if', c, i === 0 ? 'Se' : 'e', (fn, rr) => upd((x) => fn(x.if[i]), rr), () => upd((x) => x.if.splice(i, 1)))));
    card.append(ifBox);
    // ENTÃO
    const doBox = el('div', { class: 'rule-steps' });
    (r.do || []).forEach((a, i) => doBox.append(this.stepRow('do', a, i === 0 ? 'Então' : 'e', (fn, rr) => upd((x) => fn(x.do[i]), rr), () => upd((x) => x.do.splice(i, 1)),
      i > 0 ? () => upd((x) => { const t = x.do[i - 1]; x.do[i - 1] = x.do[i]; x.do[i] = t; }) : null)));
    if (!r.do?.length) doBox.append(el('div', { class: 'rule-line' }, el('span', { class: 'kw do' }, 'Então'), el('span', { class: 'muted' }, 'adicione uma ação')));
    card.append(doBox);
    card.append(el('div', { class: 'rule-add' },
      addMenu('+ Condição', CONDITIONS, (t) => upd((x) => { (x.if ||= []).push(makeStep(t, 'if')); })),
      addMenu('+ Ação', ACTIONS, (t) => upd((x) => { (x.do ||= []).push(makeStep(t, 'do')); }), true),
      el('span', { class: 'rule-sum muted' }, describeRule(r, (id) => this.nameOf(id)))));
    return card;
  }

  move(i, dir) {
    this.edit((l) => {
      const j = i + dir;
      if (j < 0 || j >= l.rules.length) return;
      [l.rules[i], l.rules[j]] = [l.rules[j], l.rules[i]];
    });
  }

  stepRow(kind, s, label, upd, remove, up) {
    const defs = kind === 'if' ? CONDITIONS : ACTIONS;
    const def = defs[s.type] || {};
    const row = el('div', { class: 'rule-line' }, el('span', { class: `kw ${kind === 'if' ? 'if' : 'do'}` }, label),
      select(Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.label])), s.type, (v) => upd((x) => { Object.keys(x).forEach((k) => delete x[k]); Object.assign(x, makeStep(v, kind)); })));
    if (def.target) row.append(this.targetInput(def.target, s.target, (v) => upd((x) => { x.target = v; }, def.target === 'var' ? false : true)));
    if (def.op) row.append(select(OPS, s.op || '>=', (v) => upd((x) => { x.op = v; }, false), 'op'));
    if (def.value === 'number') row.append(numberIn(s.value ?? 1, (v) => upd((x) => { x.value = v; }, false)));
    if (def.value === 'seconds') row.append(numberIn(s.value ?? 2, (v) => upd((x) => { x.value = v; }, false), 's'));
    if (def.value === 'behavior') row.append(select(BEHAVIORS, s.value || 'chase', (v) => upd((x) => { x.value = v; }, false)));
    if (def.text) {
      const t = el('input', { type: 'text', class: 'step-text', value: s.text || '', placeholder: 'Texto', 'aria-label': 'Texto' });
      t.addEventListener('change', () => upd((x) => { x.text = t.value; }, false));
      row.append(t);
      if (s.type === 'message') row.append(numberIn(s.value ?? 3, (v) => upd((x) => { x.value = v; }, false), 's'));
    }
    row.append(el('span', { class: 'grow' }));
    if (up) row.append(iconB(UI_ICONS.chevron, 'Subir', up, 'up'));
    row.append(iconB(UI_ICONS.close, 'Remover', remove));
    return row;
  }

  /** Campo de alvo: lista de objetos, contador (texto livre) ou regra. */
  targetInput(kind, value, onChange, any) {
    if (kind === 'var') {
      const listId = 'logic-vars';
      const inp = el('input', { type: 'text', class: 'var-in', value: value || '', placeholder: 'contador', list: listId, 'aria-label': 'Nome do contador', spellcheck: 'false' });
      inp.addEventListener('change', () => onChange(inp.value.trim() || null));
      const dl = el('datalist', { id: listId }, ...varNames(this.logic).map((n) => el('option', { value: n })));
      return el('span', { class: 'var-wrap' }, inp, dl);
    }
    let opts;
    if (kind === 'rule') opts = Object.fromEntries(this.logic.rules.map((r) => [r.id, r.name]));
    else opts = Object.fromEntries(targetsFor(kind, this.store.doc).map((o) => [o.id, o.name]));
    const head = any ? { '': any } : { '': Object.keys(opts).length ? `— escolha ${TARGET_HINT[kind] ? `o ${TARGET_HINT[kind]}` : ''} —` : `— nenhum ${TARGET_HINT[kind] || ''} no level —` };
    if (value && !opts[value]) opts[value] = '(removido)';
    return select({ ...head, ...opts }, value || '', (v) => onChange(v || null), 'target');
  }

  // ------------------------------------------------------------ avançado
  renderAdvanced(box) {
    const L = this.logic;
    box.append(el('p', { class: 'info' }, 'Modo avançado: JavaScript que roda isolado durante o teste. Ele recebe os eventos do jogo e manda ações (abrir portas, mover objetos, mudar parâmetros do player, controlar inimigos). As regras do modo simples continuam valendo junto.'));
    box.append(el('div', { class: 'logic-row' }, toggle(!!L.scriptEnabled, (v) => this.edit((l) => { l.scriptEnabled = v; }), 'Script do level ligado'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small', type: 'button', onclick: () => { if (!L.script.trim() || window.confirm('Trocar o script atual pelo exemplo?')) this.edit((l) => { l.script = SCRIPT_EXAMPLE; l.scriptEnabled = true; }); } }, 'Carregar exemplo')));
    const ta = el('textarea', { class: 'code', spellcheck: 'false', rows: 16, 'aria-label': 'Script do level', placeholder: "on('start', () => game.message('Boa sorte!'));" });
    ta.value = L.script || '';
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const a = ta.selectionStart; ta.setRangeText('  ', a, ta.selectionEnd, 'end'); }
      e.stopPropagation();
    });
    ta.addEventListener('change', () => this.edit((l) => { l.script = ta.value; }, false));
    box.append(ta);
    box.append(el('details', { class: 'group api-ref' }, el('summary', {}, el('span', {}, 'Referência da API'), el('span', { class: 'chev', html: svgIcon(UI_ICONS.chevron) })),
      el('pre', { class: 'api' }, API_REF)));
    // scripts de objetos
    const withScript = this.store.doc.objects.filter((o) => o.script?.trim());
    box.append(el('div', { class: 'logic-sec-head' }, el('span', { class: 'chip-ico', html: svgIcon(UI_ICONS.code) }), el('h4', {}, 'Scripts de objetos'),
      el('span', { class: 'muted' }, 'Player, inimigos, assets, itens e zonas podem ter um script próprio: selecione o objeto e abra "Script (avançado)" nas propriedades.')));
    if (!withScript.length) box.append(el('p', { class: 'logic-empty' }, 'Nenhum objeto com script ainda.'));
    else {
      box.append(el('div', { class: 'attach-list' }, ...withScript.map((o) => el('button', {
        class: 'btn small', type: 'button', onclick: () => { this.$.close(); this.store.select(o.id); this.app.panels.openGroup('Script (avançado)'); },
        html: `${svgIcon(TOOL_ICONS[o.type] || UI_ICONS.code)}<span>${escapeHtml(o.name)}${o.scriptEnabled === false ? ' (desligado)' : ''}</span>`,
      }))));
    }
  }
}

const API_REF = `Eventos: on('start'|'pickup'|'kill'|'allKilled'|'enter'|'exit'|'use'|
        'varChange'|'playerHurt'|'playerDied'|'tick', (alvo, estado) => {})
Ações:  game.open/close/toggle/show/hide(alvo)   game.spawn/kill(inimigo)
        game.behavior(inimigo, 'idle'|'wander'|'patrol'|'chase'|'guard'|'flee')
        game.goTo(inimigo, x, z)   game.moveTo(objeto, x, z, { y, seconds })
        game.rotate(objeto, graus, segundos)   game.color(alvo, '#hex')
        game.param('player' | inimigo, 'speed'|'jump'|'gravity'|'damage'..., valor)
        game.push(x, y, z)   game.teleport(lugar)   game.heal(n)   game.damage(n)
        game.give(item)   game.message(texto, s)   game.win(texto)   game.lose(texto)
        game.setVar(nome, v)   game.addVar(nome, v)   game.var(nome)   game.has(item)
Estado: game.state.player {x,y,z,health,params}  .enemies [{name,x,z,alive,health}]
        .objects [{name,x,y,z,open,hidden}]  .vars  .items  .time
Tempo:  after(s, fn)   every(s, fn)
Objeto: no script de um objeto, "me" é ele: me.on('enter', fn), me.open(),
        me.moveTo(x, z), me.param('speed', 9), me.behavior('flee'), me.state()
Alvos:  nome do objeto como aparece na lista, id, ou 'player'.`;

// ------------------------------------------------------------ modelos de regra
const first = (doc, kind, pred = () => true) => targetsFor(kind, doc).find(pred)?.id || null;
const door = (doc) => first(doc, 'asset', (o) => o.kind === 'door') || first(doc, 'asset');
const TEMPLATES = [
  { label: 'Chave abre porta', tip: 'Pegar um item abre uma porta', make: (doc) => ({ name: 'Chave abre porta', when: { type: 'pickup', target: first(doc, 'item', (o) => o.kind === 'key') || first(doc, 'item') }, if: [], do: [{ type: 'open', target: door(doc) }, { type: 'message', text: 'Uma porta se abriu!', value: 3 }] }) },
  { label: 'Inimigo abre porta', tip: 'Derrotar um inimigo abre uma porta', make: (doc) => ({ name: 'Derrotar abre porta', when: { type: 'kill', target: first(doc, 'enemy') }, if: [], do: [{ type: 'open', target: door(doc) }] }) },
  { label: 'Alavanca (F)', tip: 'Apertar F numa zona abre e fecha uma porta', make: (doc) => ({ name: 'Alavanca', once: false, when: { type: 'use', target: first(doc, 'zone') }, if: [], do: [{ type: 'toggle', target: door(doc) }] }) },
  { label: 'Emboscada', tip: 'Entrar numa zona acorda um inimigo', make: (doc) => ({ name: 'Emboscada', when: { type: 'enter', target: first(doc, 'zone') }, if: [], do: [{ type: 'spawn', target: first(doc, 'enemy', (o) => o.active === false) || first(doc, 'enemy') }, { type: 'message', text: 'Cuidado!', value: 2 }] }) },
  { label: 'Contador', tip: 'Cada moeda soma 1; com 3, vence', make: () => ({ name: 'Moedas', once: false, when: { type: 'pickup', target: null }, if: [], do: [{ type: 'addVar', target: 'moedas', value: 1 }] }) },
  { label: 'Ondas', tip: 'Quando todos caem, acorda a próxima onda', make: (doc) => ({ name: 'Próxima onda', when: { type: 'allKilled', target: null }, if: [], do: [{ type: 'wait', value: 2 }, { type: 'spawn', target: first(doc, 'enemy', (o) => o.active === false) }, { type: 'message', text: 'Nova onda!', value: 2 }] }) },
];

// ------------------------------------------------------------ controles
function select(options, value, onChange, cls = '') {
  const s = el('select', { class: cls });
  for (const [v, label] of Object.entries(options)) {
    const o = el('option', { value: v }, label);
    if (String(value ?? '') === v) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function numberIn(value, onChange, unit) {
  const i = el('input', { type: 'number', step: 0.5, value: String(value ?? 0), class: 'num', 'aria-label': unit === 's' ? 'Segundos' : 'Valor' });
  i.addEventListener('change', () => { if (i.value !== '') onChange(+i.value); });
  return unit ? el('span', { class: 'num-wrap' }, i, el('span', { class: 'unit' }, unit)) : i;
}

function toggle(on, onChange, label) {
  const cb = el('input', { type: 'checkbox', role: 'switch', checked: on });
  cb.addEventListener('change', () => onChange(cb.checked));
  return el('label', { class: 'switch' }, cb, el('span', { class: 'track', 'aria-hidden': 'true' }), el('span', { class: 'switch-text' }, label));
}

function iconB(icon, tip, onclick, cls = '', disabled = false) {
  return el('button', { class: `icon-btn sm ${cls}`, type: 'button', 'data-tip': tip, 'aria-label': tip, onclick, disabled, html: svgIcon(icon) });
}

function addMenu(label, defs, onPick, primary = false) {
  const s = el('select', { class: `add-step ${primary ? 'primary' : ''}`, 'aria-label': label });
  s.append(el('option', { value: '' }, label));
  for (const [k, v] of Object.entries(defs)) s.append(el('option', { value: k }, v.label));
  s.addEventListener('change', () => { if (s.value) onPick(s.value); });
  return s;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
