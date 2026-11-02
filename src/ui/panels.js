// Painéis: níveis, lista de objetos, opções da ferramenta e propriedades.
import { el, field, group } from './fields.js';
import { DECO_TYPES, ASSET_KINDS, AGENT_MODES, BEHAVIORS, makeLevel, normalizeObject } from '../model.js';
import { ASSET_ICONS } from '../builders/assets.js';
import { setByPath } from '../util.js';
import { samplePath, pathLength } from '../math/curve.js';
import { TOOL_INFO } from '../editor/tools.js';

const TYPE_LABEL = { corridor: 'Corredor', wall: 'Parede', area: 'Área', connector: 'Conector', asset: 'Asset', agent: 'Agente' };
const GROUP_ORDER = ['corridor', 'area', 'wall', 'connector', 'asset', 'agent'];
const GROUP_LABEL = { corridor: 'Corredores', area: 'Áreas', wall: 'Paredes', connector: 'Escadas e rampas', asset: 'Assets', agent: 'Agentes' };

const PARAM_LABELS = {
  speed: 'Velocidade', sprint: 'Mult. corrida', jump: 'Força do pulo', gravity: 'Gravidade', eyeHeight: 'Altura olhos',
  sensitivity: 'Sensibilidade', health: 'Vida', fireRate: 'Tiros/seg', damage: 'Dano', doubleJump: 'Pulo duplo',
  airControl: 'Controle no ar', cameraDistance: 'Dist. câmera', stompDamage: 'Dano do pisão', maxSpeed: 'Vel. máxima',
  accel: 'Aceleração', brake: 'Freio', turnRate: 'Giro', grip: 'Aderência', ramDamage: 'Dano impacto',
  range: 'Alcance visão', projectileSpeed: 'Vel. projétil', accuracy: 'Precisão', jumpy: 'Saltitante',
};
const PARAM_RANGES = {
  grip: [0.05, 1, 0.01], airControl: [0, 1, 0.05], accuracy: [0, 1, 0.05], sensitivity: [0.1, 3, 0.1],
};

const RULE_PRESETS = {
  limpo: { label: 'Limpo', proc: { gapChance: 0, heightVar: 0, jitter: 0 }, mode: 'continuous' },
  ruinas: { label: 'Ruínas', proc: { gapChance: 0.18, gapLength: 2, heightVar: 0.55, jitter: 0.12 }, mode: 'blocks' },
  organico: { label: 'Orgânico', proc: { gapChance: 0, heightVar: 0.25, jitter: 0.6 }, mode: 'continuous' },
  muralha: { label: 'Muralha', proc: { gapChance: 0.03, gapLength: 1, heightVar: 0.12, jitter: 0, segment: 2 }, mode: 'blocks' },
  portas: { label: 'Com portas', proc: { gapChance: 0.06, gapLength: 2, heightVar: 0, jitter: 0 }, mode: 'continuous' },
};

export class Panels {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.closedGroups = new Set(['Decoração', 'Piso']);
    this.$levels = document.getElementById('levels');
    this.$outliner = document.getElementById('outliner');
    this.$props = document.getElementById('props');
    this.$tool = document.getElementById('tool-options');
    this.$count = document.getElementById('obj-count');
    this.gesture = false;
    document.getElementById('lvl-add-up').addEventListener('click', () => this.addLevel(1));
    document.getElementById('lvl-add-down').addEventListener('click', () => this.addLevel(-1));
    const other = document.getElementById('other-levels');
    other.addEventListener('change', () => this.store.mutate((d) => { d.settings.otherLevels = other.value; }, { ids: [], record: false }));
    this.$other = other;
  }

  renderAll() {
    this.renderLevels();
    this.renderOutliner();
    this.renderProps();
    this.renderToolOptions();
  }

  // ------------------------------------------------------------ níveis
  addLevel(dir) {
    const lv = this.store.doc.levels;
    const ys = lv.map((l) => l.elevation);
    const y = dir > 0 ? Math.max(...ys) + 4 : Math.min(...ys) - 4;
    const n = lv.length;
    const l = makeLevel(dir > 0 ? `Nível ${n}` : `Subsolo ${lv.filter((x) => x.elevation < 0).length + 1}`, y);
    this.store.mutate((d) => { d.levels.push(l); d.activeLevelId = l.id; }, { all: true, structure: true });
  }

  renderLevels() {
    const doc = this.store.doc;
    this.$other.value = doc.settings.otherLevels;
    this.$levels.innerHTML = '';
    const sorted = [...doc.levels].sort((a, b) => b.elevation - a.elevation);
    for (const l of sorted) {
      const count = doc.objects.filter((o) => o.levelId === l.id).length;
      const eye = el('button', {
        class: `eye ${l.visible ? '' : 'off'}`, title: l.visible ? 'Ocultar' : 'Mostrar',
        html: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
        onclick: (e) => { e.stopPropagation(); this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).visible = !l.visible; }, { ids: [], structure: true }); },
      });
      const name = el('input', { class: 'lvl-name', value: l.name, title: `${count} objetos` });
      name.addEventListener('change', () => this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).name = name.value; }, { ids: [], structure: true }));
      const elev = el('input', { class: 'elev', type: 'number', step: 0.5, value: l.elevation, title: 'Elevação (m)' });
      elev.addEventListener('change', () => this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).elevation = +elev.value; }, { all: true, structure: true }));
      const del = el('button', {
        class: 'eye', title: 'Excluir nível', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        onclick: (e) => { e.stopPropagation(); this.deleteLevel(l, count); },
      });
      const li = el('li', { class: doc.activeLevelId === l.id ? 'active' : '' }, eye, name, elev, del);
      li.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' && doc.activeLevelId === l.id) return;
        this.app.setActiveLevel(l.id);
      });
      this.$levels.append(li);
    }
  }

  deleteLevel(l, count) {
    const doc = this.store.doc;
    if (doc.levels.length <= 1) return this.app.toast('O level precisa de pelo menos um nível.');
    if (count && !window.confirm(`Excluir "${l.name}" e ${count} objeto(s) nele?`)) return;
    this.store.mutate((d) => {
      d.levels = d.levels.filter((x) => x.id !== l.id);
      d.objects = d.objects.filter((o) => o.levelId !== l.id);
      for (const o of d.objects) {
        if (o.endLevelId === l.id) o.endLevelId = null;
        if (o.toLevelId === l.id) o.toLevelId = o.levelId;
        if (o.fromLevelId === l.id) o.fromLevelId = o.levelId;
      }
      if (d.activeLevelId === l.id) d.activeLevelId = d.levels[0].id;
    }, { all: true, structure: true });
    this.store.select(null);
  }

  // ------------------------------------------------------------ objetos
  renderOutliner() {
    const doc = this.store.doc;
    this.$outliner.innerHTML = '';
    this.$count.textContent = String(doc.objects.length);
    const lvName = new Map(doc.levels.map((l) => [l.id, l.name]));
    for (const t of GROUP_ORDER) {
      const items = doc.objects.filter((o) => o.type === t);
      if (!items.length) continue;
      this.$outliner.append(el('li', { class: 'group-label' }, GROUP_LABEL[t]));
      for (const o of items) {
        const color = o.color || o.walls?.color || o.floor?.color || '#fff';
        const li = el('li', {
          class: `item ${this.store.selection === o.id ? 'selected' : ''} ${o.levelId !== doc.activeLevelId ? 'dim' : ''}`,
          title: o.name,
          onclick: () => { this.store.select(o.id); },
          ondblclick: () => this.app.focusSelection(),
        }, el('span', { class: 'dot', style: `background:${color}` }), o.name || TYPE_LABEL[o.type], el('span', { class: 'lvl' }, lvName.get(o.levelId) || ''));
        this.$outliner.append(li);
      }
    }
    if (!doc.objects.length) this.$outliner.append(el('li', { class: 'empty' }, 'Nada ainda. Use Corredor (C) para começar.'));
  }

  // ------------------------------------------------------------ opções de ferramenta
  renderToolOptions() {
    const tools = this.app.tools;
    const t = tools.tool;
    const opt = tools.options[t];
    const box = this.$tool;
    box.innerHTML = '';
    if (t === 'select') return;
    const set = (k, v) => tools.setOption(t, k, v);
    box.append(el('div', { class: 'section-head' }, el('h2', {}, TOOL_INFO[t].label)));
    const levelOpts = () => ({ '': '— mesmo nível —', ...Object.fromEntries(this.store.doc.levels.filter((l) => l.id !== this.store.doc.activeLevelId).map((l) => [l.id, `${l.name} (${l.elevation} m)`])) });
    const onF = (k, v) => set(k, v);
    const add = (...nodes) => box.append(...nodes.filter(Boolean));
    if (t === 'corridor') {
      add(
        field(opt, { key: 'width', label: 'Largura', type: 'range', min: 1, max: 20, step: 0.5 }, onF),
        field(opt, { key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }, onF),
        field(opt, { key: 'endLevelId', label: 'Sobe/desce p/', type: 'select', options: levelOpts }, onF),
        field(opt, { key: 'rampStyle', label: 'Transição', type: 'select', options: { ramp: 'Rampa suave', stairs: 'Degraus' }, show: (o) => !!o.endLevelId }, onF),
        field(opt, { key: 'deco', label: 'Decoração', type: 'select', options: DECO_TYPES }, onF),
      );
    } else if (t === 'wall') {
      box.append(
        field(opt, { key: 'height', label: 'Altura', type: 'range', min: 0.2, max: 10, step: 0.1 }, onF),
        field(opt, { key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }, onF),
      );
    } else if (t === 'area') {
      box.append(field(opt, { key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }, onF));
    } else if (t === 'connector') {
      box.append(field(opt, { key: 'style', label: 'Tipo', type: 'select', options: { stairs: 'Escada', ramp: 'Rampa' } }, onF));
    } else if (t === 'asset') {
      const pal = el('div', { class: 'palette' });
      const kinds = Object.entries(ASSET_KINDS).filter(([k]) => k !== 'custom');
      for (const [k, label] of kinds) {
        pal.append(el('button', {
          type: 'button', class: opt.kind === k ? 'active' : '', title: label,
          onclick: () => { tools.options.asset.customId = null; tools.options.asset.label = label; set('kind', k); },
          html: `<svg viewBox="0 0 24 24"><path d="${ASSET_ICONS[k]}"/></svg><span>${label}</span>`,
        }));
      }
      for (const [cid, ca] of Object.entries(this.store.doc.customAssets || {})) {
        pal.append(el('button', {
          type: 'button', class: opt.kind === 'custom' && opt.customId === cid ? 'active' : '', title: ca.name,
          onclick: () => { tools.options.asset.customId = cid; tools.options.asset.label = ca.name; set('kind', 'custom'); },
          html: `<svg viewBox="0 0 24 24"><path d="${ASSET_ICONS.custom}"/></svg><span>${ca.name.slice(0, 12)}</span>`,
        }));
      }
      box.append(pal, field(opt, { key: 'color', label: 'Cor', type: 'color' }, onF));
      box.append(el('div', { class: 'props-actions' }, el('button', { class: 'btn small', onclick: () => this.app.importModel() }, 'Importar GLB…')));
    } else if (t === 'agent') {
      const pal = el('div', { class: 'palette wide' });
      for (const role of ['player', 'enemy']) {
        for (const [mode, def] of Object.entries(AGENT_MODES[role])) {
          const label = `${role === 'player' ? 'Player' : 'Inimigo'} ${def.label}`;
          pal.append(el('button', {
            type: 'button', class: opt.role === role && opt.mode === mode ? 'active' : '',
            onclick: () => { tools.options.agent.role = role; set('mode', mode); },
            html: `<svg viewBox="0 0 24 24"><path d="${mode === 'car' ? ASSET_ICONS.car : mode === 'arcade' ? 'M12 4l7 4v8l-7 4-7-4V8z M9 11h.01 M15 11h.01' : 'M12 3a3 3 0 1 0 0.01 0z M8 21v-7a4 4 0 0 1 8 0v7'}"/></svg><span>${label}</span>`,
          }));
        }
      }
      box.append(pal);
    }
    box.append(el('p', { class: 'info' }, TOOL_INFO[t].hint));
  }

  // ------------------------------------------------------------ propriedades
  renderProps() {
    const box = this.$props;
    box.innerHTML = '';
    const o = this.store.get(this.store.selection);
    if (!o) return this.renderDocProps(box);
    const onChange = (key, value, final) => this.change(o.id, key, value, final);
    const F = (f) => field(o, f, onChange);
    const doc = this.store.doc;
    const levels = Object.fromEntries(doc.levels.map((l) => [l.id, `${l.name} (${l.elevation} m)`]));
    const levelsOpt = { '': '— nenhum —', ...levels };
    const G = (title, fields, open) => {
      const g = group(title, fields, open ?? !this.closedGroups.has(title));
      g.addEventListener('toggle', () => { if (g.open) this.closedGroups.delete(title); else this.closedGroups.add(title); });
      return g;
    };

    box.append(el('div', { class: 'props-title' }, el('span', { class: 'type' }, TYPE_LABEL[o.type]), el('span', { class: 'muted' }, o.type === 'agent' ? (o.role === 'player' ? 'player' : 'inimigo') : '')));
    box.append(F({ key: 'name', label: 'Nome', type: 'text' }));
    box.append(F({ key: 'levelId', label: 'Nível', type: 'select', options: levels }));

    const actions = el('div', { class: 'props-actions' },
      el('button', { class: 'btn small', onclick: () => this.app.duplicateSelection() }, 'Duplicar'),
      el('button', { class: 'btn small', onclick: () => this.app.focusSelection() }, 'Focar'),
      el('button', { class: 'btn small danger', onclick: () => this.store.removeObject(o.id) }, 'Excluir'),
    );

    const procFields = () => [
      el('div', { class: 'props-actions' }, ...Object.entries(RULE_PRESETS).map(([k, p]) => el('button', { class: 'btn small', onclick: () => this.applyPreset(o.id, p) }, p.label)),
        el('button', { class: 'btn small', title: 'Nova semente aleatória', onclick: () => this.change(o.id, 'proc.seed', Math.floor(Math.random() * 9999), true) }, '🎲 Semente')),
      F({ key: 'proc.segment', label: 'Segmento (m)', type: 'range', min: 0.25, max: 4, step: 0.25 }),
      F({ key: 'proc.seed', label: 'Semente', type: 'number', step: 1 }),
      F({ key: 'proc.gapChance', label: 'Chance de vão', type: 'range', min: 0, max: 0.6, step: 0.01 }),
      F({ key: 'proc.gapLength', label: 'Tamanho vão', type: 'range', min: 1, max: 8, step: 1 }),
      F({ key: 'proc.heightVar', label: 'Variação altura', type: 'range', min: 0, max: 1, step: 0.01 }),
      F({ key: 'proc.jitter', label: 'Irregularidade', type: 'range', min: 0, max: 2, step: 0.01 }),
    ];
    const decoFields = (sides) => [
      F({ key: 'deco.type', label: 'Tipo', type: 'select', options: DECO_TYPES }),
      F({ key: 'deco.side', label: 'Lado', type: 'select', options: sides, show: (x) => x.deco.type !== 'none' }),
      F({ key: 'deco.density', label: 'Densidade', type: 'range', min: 0, max: 1, step: 0.01, show: (x) => !['none', 'sidewalk', 'hedge'].includes(x.deco.type) }),
      F({ key: 'deco.inset', label: 'Recuo', type: 'range', min: 0, max: 3, step: 0.05, show: (x) => x.deco.type !== 'none' }),
      F({ key: 'deco.color', label: 'Cor', type: 'color', show: (x) => x.deco.type !== 'none' }),
      F({ key: 'deco.seed', label: 'Semente', type: 'number', step: 1, show: (x) => x.deco.type !== 'none' }),
    ];

    if (o.type === 'corridor') {
      const samples = samplePath(o.points, { closed: o.closed, smooth: o.smooth, spacing: 0.5 });
      box.append(el('p', { class: 'info' }, `${o.points.length} pontos · ${pathLength(samples, o.closed).toFixed(1)} m`));
      box.append(actions, el('div', { class: 'props-actions' },
        el('button', { class: 'btn small', onclick: () => this.change(o.id, 'points', [...o.points].reverse(), true) }, 'Inverter sentido')));
      box.append(G('Forma', [
        F({ key: 'width', label: 'Largura', type: 'range', min: 1, max: 30, step: 0.5 }),
        F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }),
        F({ key: 'closed', label: 'Fechado (loop)', type: 'bool' }),
      ]));
      box.append(G('Verticalidade', [
        F({ key: 'endLevelId', label: 'Termina no nível', type: 'select', options: levelsOpt }),
        F({ key: 'rampStyle', label: 'Transição', type: 'select', options: { ramp: 'Rampa suave', stairs: 'Degraus' }, show: (x) => !!x.endLevelId }),
        F({ key: 'stepHeight', label: 'Altura degrau', type: 'range', min: 0.1, max: 1, step: 0.05, show: (x) => x.endLevelId && x.rampStyle === 'stairs' }),
      ]));
      box.append(G('Piso', [
        F({ key: 'floor.enabled', label: 'Piso', type: 'bool' }),
        F({ key: 'floor.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 2, step: 0.05, show: (x) => x.floor.enabled }),
        F({ key: 'floor.color', label: 'Cor', type: 'color', show: (x) => x.floor.enabled }),
      ]));
      box.append(G('Paredes', [
        F({ key: 'walls.left', label: 'Esquerda', type: 'bool' }),
        F({ key: 'walls.right', label: 'Direita', type: 'bool' }),
        F({ key: 'walls.height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1 }),
        F({ key: 'walls.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 2, step: 0.05 }),
        F({ key: 'walls.mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' } }),
        F({ key: 'walls.capStart', label: 'Fechar início', type: 'bool' }),
        F({ key: 'walls.capEnd', label: 'Fechar fim', type: 'bool' }),
        F({ key: 'walls.color', label: 'Cor', type: 'color' }),
      ]));
      box.append(G('Regras procedurais', procFields()));
      box.append(G('Decoração', decoFields({ both: 'Ambos', left: 'Esquerda', right: 'Direita' })));
    } else if (o.type === 'wall') {
      box.append(el('p', { class: 'info' }, `${o.points.length} pontos`), actions);
      box.append(G('Forma', [
        F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }),
        F({ key: 'closed', label: 'Fechada', type: 'bool' }),
        F({ key: 'height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1 }),
        F({ key: 'thickness', label: 'Espessura', type: 'range', min: 0.05, max: 3, step: 0.05 }),
        F({ key: 'mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' } }),
        F({ key: 'color', label: 'Cor', type: 'color' }),
      ]));
      box.append(G('Regras procedurais', procFields()));
    } else if (o.type === 'area') {
      box.append(el('p', { class: 'info' }, `${o.points.length} pontos`), actions);
      box.append(G('Forma', [F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 })]));
      box.append(G('Piso', [
        F({ key: 'floor.enabled', label: 'Piso', type: 'bool' }),
        F({ key: 'floor.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 4, step: 0.05, show: (x) => x.floor.enabled }),
        F({ key: 'floor.color', label: 'Cor', type: 'color', show: (x) => x.floor.enabled }),
      ]));
      box.append(G('Paredes', [
        F({ key: 'walls.enabled', label: 'Paredes', type: 'bool' }),
        F({ key: 'walls.height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1, show: (x) => x.walls.enabled }),
        F({ key: 'walls.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 2, step: 0.05, show: (x) => x.walls.enabled }),
        F({ key: 'walls.mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' }, show: (x) => x.walls.enabled }),
        F({ key: 'walls.color', label: 'Cor', type: 'color', show: (x) => x.walls.enabled }),
      ]));
      box.append(G('Regras procedurais', procFields()));
      box.append(G('Decoração', decoFields({ inside: 'Dentro', outside: 'Fora', both: 'Ambos' })));
    } else if (o.type === 'connector') {
      box.append(actions);
      box.append(G('Conexão', [
        F({ key: 'style', label: 'Tipo', type: 'select', options: { stairs: 'Escada', ramp: 'Rampa' } }),
        F({ key: 'fromLevelId', label: 'De', type: 'select', options: levels }),
        F({ key: 'toLevelId', label: 'Para', type: 'select', options: levels }),
        F({ key: 'width', label: 'Largura', type: 'range', min: 0.5, max: 12, step: 0.25 }),
        F({ key: 'slope', label: 'Comprimento/altura', type: 'range', min: 0.8, max: 6, step: 0.1 }),
        F({ key: 'stepHeight', label: 'Altura degrau', type: 'range', min: 0.1, max: 0.6, step: 0.05, show: (x) => x.style === 'stairs' }),
        F({ key: 'rails', label: 'Corrimão', type: 'bool' }),
        F({ key: 'color', label: 'Cor', type: 'color' }),
      ]));
      box.append(G('Transformação', this.transformFields(o, F)));
    } else if (o.type === 'asset') {
      box.append(actions);
      const kinds = { ...ASSET_KINDS };
      if (!Object.keys(doc.customAssets || {}).length) delete kinds.custom;
      box.append(G('Asset', [
        F({ key: 'kind', label: 'Tipo', type: 'select', options: kinds }),
        F({ key: 'customId', label: 'Modelo', type: 'select', options: () => Object.fromEntries(Object.entries(doc.customAssets || {}).map(([k, v]) => [k, v.name])), show: (x) => x.kind === 'custom' }),
        F({ key: 'color', label: 'Cor', type: 'color' }),
        F({ key: 'collider', label: 'Colisão', type: 'bool' }),
      ]));
      box.append(G('Transformação', [
        ...this.transformFields(o, F),
        F({ key: 'y', label: 'Altura (Y)', type: 'number', step: 0.1 }),
        F({ key: 'scale.x', label: 'Escala X', type: 'range', min: 0.1, max: 10, step: 0.05 }),
        F({ key: 'scale.y', label: 'Escala Y', type: 'range', min: 0.1, max: 10, step: 0.05 }),
        F({ key: 'scale.z', label: 'Escala Z', type: 'range', min: 0.1, max: 10, step: 0.05 }),
      ]));
    } else if (o.type === 'agent') {
      box.append(actions);
      const modes = Object.fromEntries(Object.entries(AGENT_MODES[o.role]).map(([k, v]) => [k, v.label]));
      const paths = { '': '— nenhum —', ...Object.fromEntries(doc.objects.filter((x) => ['corridor', 'wall', 'area'].includes(x.type)).map((x) => [x.id, x.name])) };
      const g = [
        F({ key: 'mode', label: o.role === 'player' ? 'Gameplay' : 'Tipo', type: 'select', options: modes }),
        F({ key: 'color', label: 'Cor', type: 'color' }),
      ];
      if (o.role === 'enemy') {
        g.push(F({ key: 'behavior', label: 'Comportamento', type: 'select', options: BEHAVIORS }));
        g.push(F({ key: 'pathId', label: 'Caminho', type: 'select', options: paths, show: (x) => x.behavior === 'patrol' }));
      } else {
        g.push(el('div', { class: 'props-actions' }, el('button', { class: 'btn small primary', onclick: () => this.app.startPlay(o.id) }, '▶ Testar com este player')));
      }
      box.append(G('Agente', g));
      const params = Object.keys(AGENT_MODES[o.role][o.mode].params).map((k) => {
        const v = o.params[k];
        if (typeof v === 'boolean') return F({ key: `params.${k}`, label: PARAM_LABELS[k] || k, type: 'bool' });
        const r = PARAM_RANGES[k];
        return r ? F({ key: `params.${k}`, label: PARAM_LABELS[k] || k, type: 'range', min: r[0], max: r[1], step: r[2] })
          : F({ key: `params.${k}`, label: PARAM_LABELS[k] || k, type: 'number', step: 0.5, min: 0 });
      });
      box.append(G('Gameplay', params));
      box.append(G('Transformação', this.transformFields(o, F)));
    }
  }

  transformFields(o, F) {
    return [
      el('div', { class: 'field' }, el('label', {}, 'Posição X / Z'), el('div', { class: 'vec' }, ...['x', 'z'].map((k) => {
        const i = el('input', { type: 'number', step: 0.5, value: +o[k].toFixed(2) });
        i.addEventListener('change', () => this.change(o.id, k, +i.value, true));
        return i;
      }))),
      F({ key: 'rotY', label: 'Rotação (°)', type: 'range', min: -180, max: 180, step: 1, deg: true }),
    ];
  }

  renderDocProps(box) {
    const doc = this.store.doc;
    const s = doc.settings;
    const onChange = (key, value) => {
      this.store.mutate((d) => setByPath(d.settings, key, value), { all: key === 'gridSize', ids: [], structure: true });
    };
    box.append(el('div', { class: 'section-head' }, el('h2', {}, 'Level')));
    box.append(field(s, { key: 'gridSize', label: 'Grade (m)', type: 'select', options: { 0.5: '0,5 m', 1: '1 m', 2: '2 m', 4: '4 m' } }, (k, v) => onChange(k, +v)));
    box.append(field(s, { key: 'snap', label: 'Ímã na grade', type: 'bool' }, onChange));
    box.append(field(s, { key: 'solidGround', label: 'Chão base sólido', type: 'bool', text: 'no modo jogo' }, onChange));
    const counts = {};
    for (const o of doc.objects) counts[o.type] = (counts[o.type] || 0) + 1;
    box.append(el('div', { class: 'empty' },
      el('p', {}, 'Nada selecionado. Comece desenhando um ', el('b', {}, 'Corredor (C)'), ': clique no grid para criar pontos e Enter para finalizar. As paredes surgem sozinhas seguindo as regras procedurais.'),
      el('p', {}, 'Use ', el('b', {}, 'Níveis'), ' para empilhar andares. Um corredor pode terminar em outro nível (rampa ou degraus) ou use a ferramenta Escada (S).'),
      el('p', {}, 'Coloque um ', el('b', {}, 'Agente player'), ' e inimigos e aperte ', el('b', {}, '▶ Testar'), '.'),
      el('p', { class: 'muted' }, Object.entries(counts).map(([k, v]) => `${v} ${TYPE_LABEL[k].toLowerCase()}`).join(' · ')),
    ));
  }

  applyPreset(id, p) {
    this.store.mutate((d) => {
      const o = d.objects.find((x) => x.id === id);
      Object.assign(o.proc, p.proc);
      if (o.type === 'wall') o.mode = p.mode;
      else o.walls.mode = p.mode;
    }, { ids: [id] });
    this.renderProps();
  }

  change(id, key, value, final) {
    const o = this.store.get(id);
    if (!o) return;
    const record = !this.gesture;
    this.gesture = !final;
    const structural = ['name', 'levelId', 'mode', 'behavior', 'kind', 'endLevelId', 'rampStyle', 'style', 'deco.type', 'floor.enabled', 'walls.enabled', 'customId'].includes(key);
    this.store.mutate((d) => {
      const t = d.objects.find((x) => x.id === id);
      if (key === 'levelId' && t.type === 'connector') {
        if (t.fromLevelId === t.levelId) t.fromLevelId = value;
      }
      setByPath(t, key, value);
      if (key === 'mode' && t.type === 'agent') { t.params = {}; normalizeObject(t); }
      if (key === 'kind' && t.type === 'asset' && value === 'custom' && !t.customId) t.customId = Object.keys(d.customAssets || {})[0] || null;
    }, { ids: [id], record, structure: structural && final });
    if (structural && final) this.renderProps();
  }
}

