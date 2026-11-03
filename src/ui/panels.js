// Painéis: níveis, lista de objetos, opções da ferramenta e propriedades.
import { el, field, group } from './fields.js';
import { DECO_TYPES, ASSET_KINDS, AGENT_MODES, BEHAVIORS, makeLevel, normalizeObject } from '../model.js';
import { ASSET_ICONS } from '../builders/assets.js';
import { setByPath } from '../util.js';
import { samplePath, pathLength } from '../math/curve.js';
import { JOIN_STYLES, markEdited } from '../builders/corridorPath.js';
import { TOOL_INFO } from '../editor/tools.js';
import { roofFields, lightFields } from './lighting.js';
import { TOOL_ICONS, UI_ICONS, svgIcon } from './icons.js';

const TYPE_ICON = { corridor: 'corridor', wall: 'wall', area: 'area', connector: 'connector', asset: 'asset', agent: 'agent', light: 'light' };
const iconBtn = (icon, tip, onclick, cls = '') => el('button', { class: `icon-btn sm ${cls}`, type: 'button', 'data-tip': tip, 'aria-label': tip, onclick, html: svgIcon(UI_ICONS[icon] || icon) });

const TYPE_LABEL = { corridor: 'Corredor', wall: 'Parede', area: 'Área', connector: 'Conector', asset: 'Asset', agent: 'Agente', light: 'Luz' };
const GROUP_ORDER = ['corridor', 'area', 'wall', 'connector', 'asset', 'light', 'agent'];
const GROUP_LABEL = { corridor: 'Corredores', area: 'Áreas', wall: 'Paredes', connector: 'Escadas e rampas', asset: 'Assets', light: 'Luzes', agent: 'Agentes' };

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
    this.closedGroups = new Set(['Decoração', 'Piso', 'Regras procedurais', 'Verticalidade', 'Transformação', 'Junções']);
    this.closedTypes = new Set();
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
      const active = doc.activeLevelId === l.id;
      const eye = el('button', {
        class: `eye ${l.visible ? '' : 'off'}`, type: 'button', 'data-tip': l.visible ? 'Ocultar andar' : 'Mostrar andar', 'aria-label': l.visible ? 'Ocultar andar' : 'Mostrar andar',
        html: svgIcon(l.visible ? UI_ICONS.eye : UI_ICONS.eyeOff),
        onclick: (e) => { e.stopPropagation(); this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).visible = !l.visible; }, { ids: [], structure: true }); },
      });
      const name = el('input', { class: 'lvl-name', value: l.name, 'aria-label': 'Nome do andar', readonly: !active });
      name.addEventListener('change', () => this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).name = name.value; }, { ids: [], structure: true }));
      const elev = el('input', { class: 'elev', type: 'number', step: 0.5, value: l.elevation, 'aria-label': 'Altura do andar (m)', title: 'Altura (m)' });
      elev.addEventListener('change', () => this.store.mutate((d) => { d.levels.find((x) => x.id === l.id).elevation = +elev.value; }, { all: true, structure: true }));
      const del = el('button', {
        class: 'eye del', type: 'button', 'data-tip': 'Excluir andar', 'aria-label': 'Excluir andar', html: svgIcon(UI_ICONS.trash),
        onclick: (e) => { e.stopPropagation(); this.deleteLevel(l, count); },
      });
      const li = el('li', { class: `${active ? 'active' : ''} ${l.visible ? '' : 'hidden-lvl'}` }, eye,
        el('div', { class: 'lvl-main' }, name, el('span', { class: 'lvl-meta' }, count ? `${count} ${count === 1 ? 'objeto' : 'objetos'}` : 'vazio')),
        el('label', { class: 'elev-wrap' }, elev, el('span', {}, 'm')), del);
      li.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' && active) return;
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
      const closed = this.closedTypes.has(t);
      const head = el('li', { class: `group-label ${closed ? 'closed' : ''}`, onclick: () => { closed ? this.closedTypes.delete(t) : this.closedTypes.add(t); this.renderOutliner(); } },
        el('span', { class: 'chev', html: svgIcon(UI_ICONS.chevron) }), GROUP_LABEL[t], el('span', { class: 'n' }, String(items.length)));
      this.$outliner.append(head);
      if (closed) continue;
      for (const o of items) {
        const color = o.color || o.walls?.color || o.floor?.color || '#fff';
        const li = el('li', {
          class: `item ${this.store.isSelected(o.id) ? 'selected' : ''} ${o.levelId !== doc.activeLevelId ? 'dim' : ''}`,
          title: o.name,
          onclick: (e) => { this.store.select(o.id, { add: e.shiftKey || e.ctrlKey || e.metaKey }); },
          ondblclick: () => this.app.focusSelection(),
        },
        el('span', { class: 'ico', style: `--c:${color}`, html: svgIcon(TOOL_ICONS[TYPE_ICON[o.type]]) }),
        el('span', { class: 'nm' }, o.name || TYPE_LABEL[o.type]),
        o.groupId ? el('span', { class: 'grp', title: 'Em grupo', html: svgIcon(UI_ICONS.link) }) : null,
        o.levelId !== doc.activeLevelId ? el('span', { class: 'lvl' }, lvName.get(o.levelId) || '') : null);
        this.$outliner.append(li);
      }
    }
    if (!doc.objects.length) this.$outliner.append(el('li', { class: 'empty' }, 'Nenhum objeto ainda. Escolha uma ferramenta à esquerda da cena para começar.'));
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
    box.append(el('div', { class: 'tool-head' },
      el('span', { class: 'badge', html: svgIcon(TOOL_ICONS[t]) }),
      el('div', {}, el('div', { class: 'eyebrow' }, 'Desenhando'), el('div', { class: 'title' }, TOOL_INFO[t].label)),
      el('button', { class: 'btn ghost small', type: 'button', onclick: () => tools.setTool('select'), 'data-tip': 'Voltar a selecionar', 'data-key': 'Esc / V' }, 'Concluir')));
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
      box.append(el('div', { class: 'props-actions' }, el('button', { class: 'btn small', onclick: () => this.app.importModel(), html: `${svgIcon(UI_ICONS.upload)}<span>Importar modelo GLB…</span>` })));
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
    } else if (t === 'light') {
      box.append(...lightFields((f) => field(opt, f, onF), { placing: true }));
    }
  }

  // ------------------------------------------------------------ propriedades
  renderProps() {
    const box = this.$props;
    box.innerHTML = '';
    const o = this.store.get(this.store.selection);
    if (!o) return this.renderDocProps(box);
    if (this.store.multi.size > 1) return this.renderMulti(box);
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

    const nameIn = el('input', { class: 'obj-name', value: o.name || '', 'aria-label': 'Nome', spellcheck: 'false' });
    nameIn.addEventListener('change', () => onChange('name', nameIn.value, true));
    const lvlSel = el('select', { class: 'obj-level', 'aria-label': 'Andar' }, ...Object.entries(levels).map(([v, label]) => el('option', { value: v, selected: v === o.levelId }, label)));
    lvlSel.addEventListener('change', () => onChange('levelId', lvlSel.value, true));
    const kind = TYPE_LABEL[o.type] + (o.type === 'agent' ? (o.role === 'player' ? ' · player' : ' · inimigo') : '');
    box.append(el('div', { class: 'obj-head' },
      el('span', { class: 'badge', style: `--c:${o.color || o.walls?.color || o.floor?.color || '#fff'}`, html: svgIcon(TOOL_ICONS[TYPE_ICON[o.type]]) }),
      el('div', { class: 'obj-id' }, el('div', { class: 'eyebrow' }, kind), nameIn),
      el('div', { class: 'obj-tools' },
        iconBtn('copy', 'Duplicar', () => this.app.duplicateSelection()),
        iconBtn('focus', 'Focar na cena', () => this.app.focusSelection()),
        iconBtn('trash', 'Excluir', () => this.store.removeObject(o.id), 'danger')),
    ));
    const meta = (text) => el('div', { class: 'obj-meta' }, el('span', { class: 'chip-in' }, el('span', { class: 'chip-ico', html: svgIcon('M3 8l9-5 9 5-9 5z M3 13l9 5 9-5') }), lvlSel), text ? el('span', { class: 'muted' }, text) : null);
    const actions = null;

    const isCor = o.type === 'corridor' || o.type === 'area'; // só abrem onde há ligação
    const procFields = () => [
      el('div', { class: 'props-actions' }, ...Object.entries(RULE_PRESETS).filter(([k]) => !(isCor && k === 'portas')).map(([, p]) => el('button', { class: 'btn small', onclick: () => this.applyPreset(o.id, p) }, p.label)),
        el('button', { class: 'btn small', 'data-tip': 'Nova semente aleatória', onclick: () => this.change(o.id, 'proc.seed', Math.floor(Math.random() * 9999), true), html: `${svgIcon(UI_ICONS.dice)}<span>Sortear</span>` })),
      F({ key: 'proc.segment', label: 'Segmento (m)', type: 'range', min: 0.25, max: 4, step: 0.25 }),
      F({ key: 'proc.seed', label: 'Semente', type: 'number', step: 1 }),
      isCor ? el('p', { class: 'info' }, o.type === 'area' ? 'Áreas só abrem passagem onde chega um corredor ou encosta outra área.' : 'Corredores só abrem passagem onde outro corredor se liga.') : null,
      isCor ? null : F({ key: 'proc.gapChance', label: 'Chance de vão', type: 'range', min: 0, max: 0.6, step: 0.01 }),
      isCor ? null : F({ key: 'proc.gapLength', label: 'Tamanho vão', type: 'range', min: 1, max: 8, step: 1 }),
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
      box.append(meta(`${pathLength(samples, o.closed).toFixed(1)} m · ${o.points.length} nós`));
      box.append(el('div', { class: 'quick' },
        F({ key: 'width', label: 'Largura', type: 'range', min: 1, max: 30, step: 0.5 }),
        F({ key: 'walls.height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1 }),
        F({ key: 'walls.color', label: 'Cor', type: 'color' }),
      ));
      const gi = this.groupInfo(o);
      if (gi) box.append(gi);
      const jn = this.app.vp.ctx.junctions?.().get(o.id);
      const cutsFrom = (jn?.cuts || []).map((c) => this.store.get(c.from)?.name).filter(Boolean);
      box.append(G('Junções', [
        el('p', { class: 'info' }, 'Comece ou termine um corredor sobre outro para ramificar.'),
        F({ key: 'joins.start', label: jn?.trims.start ? 'Início (ligado)' : 'Início', type: 'select', options: JOIN_STYLES }),
        F({ key: 'joins.end', label: jn?.trims.end ? 'Fim (ligado)' : 'Fim', type: 'select', options: JOIN_STYLES }),
        cutsFrom.length ? el('p', { class: 'info' }, `Saídas neste corredor: ${cutsFrom.join(', ')}`) : null,
      ]));
      box.append(G('Forma', [
        F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }),
        F({ key: 'closed', label: 'Em loop', type: 'bool' }),
        el('p', { class: 'info' }, 'Arraste as bolinhas nas quinas de um nó para mudar a largura só ali.'),
        el('div', { class: 'props-actions' },
          el('button', { class: 'btn small', onclick: () => this.reverseCorridor(o.id), html: `${svgIcon(UI_ICONS.swap)}<span>Inverter sentido</span>` }),
          el('button', { class: 'btn small', 'data-tip': 'Volta todos os nós para a largura padrão', onclick: () => this.change(o.id, 'points', o.points.map(({ x, z }) => ({ x, z })), true), html: `${svgIcon(UI_ICONS.reset)}<span>Resetar larguras</span>` })),
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
        F({ key: 'walls.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 2, step: 0.05 }),
        F({ key: 'walls.mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' } }),
        F({ key: 'walls.capStart', label: 'Fechar início', type: 'bool' }),
        F({ key: 'walls.capEnd', label: 'Fechar fim', type: 'bool' }),
      ]));
      box.append(G('Teto e luz', roofFields(F)));
      box.append(G('Regras procedurais', procFields()));
      box.append(G('Decoração', decoFields({ both: 'Ambos', left: 'Esquerda', right: 'Direita' })));
    } else if (o.type === 'wall') {
      box.append(meta(`${o.points.length} nós`));
      box.append(el('div', { class: 'quick' },
        F({ key: 'height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1 }),
        F({ key: 'color', label: 'Cor', type: 'color' }),
      ));
      box.append(G('Forma', [
        F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }),
        F({ key: 'closed', label: 'Fechada', type: 'bool' }),
        F({ key: 'thickness', label: 'Espessura', type: 'range', min: 0.05, max: 3, step: 0.05 }),
        F({ key: 'mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' } }),
      ]));
      box.append(G('Regras procedurais', procFields()));
    } else if (o.type === 'area') {
      box.append(meta(`${o.points.length} nós`));
      box.append(el('div', { class: 'quick' },
        F({ key: 'smooth', label: 'Curvatura', type: 'range', min: 0, max: 1, step: 0.05 }),
        F({ key: 'floor.color', label: 'Cor do piso', type: 'color', show: (x) => x.floor.enabled }),
      ));
      const ja = this.app.vp.ctx.junctions?.().get(o.id);
      const fromNames = [...new Set((ja?.cuts || []).map((c) => this.store.get(c.from)?.name).filter(Boolean))];
      box.append(G('Portas', [
        el('p', { class: 'info' }, 'Termine um corredor dentro ou na borda da área para abrir uma porta.'),
        F({ key: 'joins.areas', label: 'Com áreas vizinhas', type: 'select', options: JOIN_STYLES }),
        F({ key: 'doorWidth', label: 'Largura da porta', type: 'range', min: 0.8, max: 6, step: 0.1, show: (x) => x.joins.areas !== 'none' }),
        fromNames.length ? el('p', { class: 'info' }, `Ligada a: ${fromNames.join(', ')}`) : null,
      ]));
      box.append(G('Piso', [
        F({ key: 'floor.enabled', label: 'Piso', type: 'bool' }),
        F({ key: 'floor.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 4, step: 0.05, show: (x) => x.floor.enabled }),
      ]));
      box.append(G('Paredes', [
        F({ key: 'walls.enabled', label: 'Paredes', type: 'bool' }),
        F({ key: 'walls.height', label: 'Altura', type: 'range', min: 0.2, max: 12, step: 0.1, show: (x) => x.walls.enabled }),
        F({ key: 'walls.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 2, step: 0.05, show: (x) => x.walls.enabled }),
        F({ key: 'walls.mode', label: 'Modo', type: 'select', options: { continuous: 'Contínua', blocks: 'Blocos' }, show: (x) => x.walls.enabled }),
        F({ key: 'walls.color', label: 'Cor', type: 'color', show: (x) => x.walls.enabled }),
      ]));
      box.append(G('Teto e luz', roofFields(F)));
      box.append(G('Regras procedurais', procFields()));
      box.append(G('Decoração', decoFields({ inside: 'Dentro', outside: 'Fora', both: 'Ambos' })));
    } else if (o.type === 'connector') {
      box.append(meta());
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
      box.append(meta());
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
    } else if (o.type === 'light') {
      box.append(meta());
      box.append(G('Luz', lightFields(F)));
      box.append(G('Transformação', this.transformFields(o, F).slice(0, 1)));
    } else if (o.type === 'agent') {
      box.append(meta());
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
        g.push(el('div', { class: 'props-actions' }, el('button', { class: 'btn small primary', onclick: () => this.app.startPlay(o.id), html: `${svgIcon(UI_ICONS.play, 'solid')}<span>Testar com este player</span>` })));
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
    const has = (t) => doc.objects.some((o) => o.type === t);
    const hasPlayer = doc.objects.some((o) => o.type === 'agent' && o.role === 'player');
    const step = (n, done, title, text, tool, key) => el('li', { class: `step ${done ? 'done' : ''}` },
      el('span', { class: 'num' }, done ? '✓' : String(n)),
      el('div', {}, el('div', { class: 'step-title' }, title), el('div', { class: 'step-text' }, text)),
      tool ? el('button', {
        class: 'btn small', type: 'button', 'data-tip': TOOL_INFO[tool].label, 'data-key': key,
        onclick: () => this.app.tools.setTool(tool), html: svgIcon(TOOL_ICONS[tool]),
      }) : el('button', { class: 'btn small primary', type: 'button', onclick: () => this.app.startPlay(), html: svgIcon(UI_ICONS.play, 'solid') }));
    box.append(el('div', { class: 'welcome' },
      el('div', { class: 'eyebrow' }, 'Comece por aqui'),
      el('h3', {}, 'Monte seu level em 3 passos'),
      el('ol', { class: 'steps' },
        step(1, has('corridor') || has('area'), 'Desenhe o caminho', 'Corredor (C) ou Área (A): clique para pôr pontos, Enter termina. As paredes surgem sozinhas.', 'corridor', 'C'),
        step(2, hasPlayer, 'Coloque agentes', 'Um player e alguns inimigos com a ferramenta Agente (P).', 'agent', 'P'),
        step(3, false, 'Teste', 'Aperte Testar para jogar o level.', null),
      ),
      el('p', { class: 'tip-line' }, 'Clique em um objeto para editá-lo · ', el('kbd', {}, '?'), ' mostra todos os atalhos'),
    ));
    const counts = {};
    for (const o of doc.objects) counts[o.type] = (counts[o.type] || 0) + 1;
    const settings = group('Ajustes do level', [
      field(s, { key: 'gridSize', label: 'Grade', type: 'select', options: { 0.5: '0,5 m', 1: '1 m', 2: '2 m', 4: '4 m' } }, (k, v) => onChange(k, +v)),
      field(s, { key: 'snap', label: 'Ímã na grade', type: 'bool' }, onChange),
      field(s, { key: 'solidGround', label: 'Chão sólido', type: 'bool', text: 'no modo jogo' }, onChange),
      Object.keys(counts).length ? el('p', { class: 'info' }, Object.entries(counts).map(([k, v]) => `${v} ${TYPE_LABEL[k].toLowerCase()}`).join(' · ')) : null,
    ], true);
    box.append(settings);
  }

  renderMulti(box) {
    const objs = this.store.selectedObjects;
    const cors = objs.filter((x) => x.type === 'corridor');
    box.append(el('div', { class: 'obj-head' },
      el('span', { class: 'badge multi' }, String(objs.length)),
      el('div', { class: 'obj-id' }, el('div', { class: 'eyebrow' }, 'Seleção'), el('div', { class: 'title' }, `${objs.length} objetos`)),
      el('div', { class: 'obj-tools' }, iconBtn('trash', 'Excluir todos', () => { for (const x of objs) this.store.removeObject(x.id); }, 'danger'))));
    box.append(el('div', { class: 'chips' }, ...objs.map((x) => el('span', { class: 'chip-tag', html: `${svgIcon(TOOL_ICONS[TYPE_ICON[x.type]])}` }, x.name))));
    box.append(el('div', { class: 'callout' },
      el('div', { class: 'step-title' }, 'Agrupar e conectar'),
      el('p', {}, cors.length < 2 ? 'Selecione dois ou mais corredores (Shift+clique) para agrupar.' : 'Corredores do grupo compartilham paredes, piso e regras, e as pontas mais próximas se conectam.'),
      el('div', { class: 'props-actions' },
        el('button', { class: 'btn small primary', disabled: cors.length < 2, 'data-tip': 'Agrupar e conectar', 'data-key': 'Ctrl G', onclick: () => this.app.groupSelection(), html: `${svgIcon(UI_ICONS.link)}<span>Agrupar</span>` }),
        el('button', { class: 'btn small', onclick: () => this.app.ungroupSelection() }, 'Desagrupar'))));
  }

  groupInfo(o) {
    if (!o.groupId) return null;
    const members = this.store.doc.objects.filter((x) => x.groupId === o.groupId);
    return el('div', { class: 'callout row' },
      el('span', { class: 'callout-ico', html: svgIcon(UI_ICONS.link) }),
      el('span', { class: 'grow' }, `Em grupo com ${members.length - 1} ${members.length - 1 === 1 ? 'corredor' : 'corredores'}`),
      el('button', { class: 'btn ghost small', onclick: () => { this.store.select(null); for (const m of members) this.store.select(m.id, { add: true }); } }, 'Selecionar'),
      el('button', { class: 'btn ghost small', onclick: () => this.change(o.id, 'groupId', null, true) }, 'Sair'));
  }

  reverseCorridor(id) {
    const o = this.store.get(id);
    const pts = [...o.points].reverse().map((p) => {
      const q = { x: p.x, z: p.z };
      if (p.wr) q.wl = p.wr;
      if (p.wl) q.wr = p.wl;
      return q;
    });
    this.store.mutate((d) => {
      const t = d.objects.find((x) => x.id === id);
      t.points = pts;
      t.joins = { start: t.joins?.end || 'door', end: t.joins?.start || 'door' };
      if (t.endLevelId) { const lv = t.levelId; t.levelId = t.endLevelId; t.endLevelId = lv; }
    }, { ids: [id], structure: true });
  }

  applyPreset(id, p) {
    const ids = this.groupIds(id);
    this.store.mutate((d) => {
      for (const o of d.objects.filter((x) => ids.includes(x.id))) {
        Object.assign(o.proc, p.proc);
        if (o.type === 'wall') o.mode = p.mode;
        else o.walls.mode = p.mode;
      }
    }, { ids });
    this.renderProps();
  }

  /** ids do grupo de um objeto (ou só ele). */
  groupIds(id) {
    const o = this.store.get(id);
    if (!o?.groupId) return [id];
    return this.store.doc.objects.filter((x) => x.groupId === o.groupId).map((x) => x.id);
  }

  change(id, key, value, final) {
    const o = this.store.get(id);
    if (!o) return;
    // estilo compartilhado no grupo
    const shared = /^(walls|floor|proc|deco|roof)\./.test(key) || key === 'smooth';
    const targets = shared ? this.groupIds(id) : [id];
    const record = !this.gesture;
    this.gesture = !final;
    const structural = ['name', 'levelId', 'mode', 'behavior', 'kind', 'endLevelId', 'rampStyle', 'style', 'deco.type', 'floor.enabled', 'walls.enabled', 'customId', 'roof.enabled', 'shadows'].includes(key);
    this.store.mutate((d) => {
      for (const t of d.objects.filter((x) => targets.includes(x.id))) {
        if (key === 'levelId' && t.type === 'connector') {
          if (t.fromLevelId === t.levelId) t.fromLevelId = value;
        }
        setByPath(t, key, value);
        if (t.points && /^(width|smooth|walls\.)/.test(key)) markEdited(d, t);
        if (key === 'mode' && t.type === 'agent') { t.params = {}; normalizeObject(t); }
        if (key === 'kind' && t.type === 'asset' && value === 'custom' && !t.customId) t.customId = Object.keys(d.customAssets || {})[0] || null;
      }
    }, { ids: targets, record, structure: (structural || key === 'groupId' || key.startsWith('joins')) && final });
    if ((structural || key === 'groupId') && final) this.renderProps();
  }
}

