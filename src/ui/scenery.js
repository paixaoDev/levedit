// Menu "Cenário" no canto da vista 3D: espessura/estilo globais das paredes e
// o fundo procedural (floresta, pedras, morros, montanhas, cidade).
import { el, field } from './fields.js';
import { WALL_STYLES, WALL_DEFAULTS, BACKDROP_STYLES, BACKDROP_DEFAULTS, applyWallDefaults, wallSlot } from '../model.js';
import { BACKDROP_PRESETS } from '../builders/backdrop.js';
import { setByPath } from '../util.js';

const ICON = '<svg viewBox="0 0 24 24"><path d="M3 20l6-10 4 6 3-4 5 8z"/><circle cx="17" cy="6" r="2"/></svg>';

const CSS = `
.vp-menus { position: absolute; right: 14px; top: 12px; z-index: 5; display: flex; gap: 8px; align-items: flex-start; }
.vp-menus > .light-menu { position: relative; right: auto; top: auto; }
.vp-menus .light-pop { position: absolute; right: 0; top: calc(100% + 6px); }
.scenery-pop { width: 260px; max-height: calc(100vh - 170px); overflow: auto; }
.scenery-pop .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.scenery-pop .styles { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.scenery-pop .styles button { padding: 5px 6px; border-radius: 8px; border: 1px solid var(--line-soft, #e7e0d3); background: #fff; cursor: pointer; font: inherit; color: var(--ink, #2f2a24); text-align: left; }
.scenery-pop .styles button.active { border-color: var(--ink, #2f2a24); background: var(--paper, #f4f1ea); font-weight: 600; }
.scenery-pop .swatches { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.scenery-pop .swatches label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted, #8a7a62); }
.scenery-pop .swatches input[type=color] { width: 100%; height: 26px; padding: 0; border: 1px solid var(--line-mid, #d8cfbf); border-radius: 6px; background: none; cursor: pointer; }
.scenery-pop .toggle-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.scenery-pop .toggle-line label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.scenery-pop .mini { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line-soft, #e7e0d3); background: #fff; cursor: pointer; color: var(--ink, #2f2a24); }
.scenery-pop hr { border: 0; border-top: 1px solid var(--line-soft, #e7e0d3); margin: 2px 0; width: 100%; }
body.playing .vp-menus { display: none; }
`;

const LABELS = { color: { forest: 'Copas', rocks: 'Pedras', mounds: 'Topo', mountains: 'Grama', city: 'Prédios' }, color2: { forest: 'Troncos', rocks: 'Detalhe', mounds: 'Encosta', mountains: 'Rocha', city: 'Detalhe' } };

export class SceneryMenu {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    if (!document.getElementById('scenery-menu-css')) document.head.append(el('style', { id: 'scenery-menu-css' }, CSS));
    this.btn = el('button', { class: 'light-btn', type: 'button', title: 'Paredes e fundo do level', 'aria-haspopup': 'true' });
    this.pop = el('div', { class: 'light-pop scenery-pop', hidden: true });
    this.root = el('div', { class: 'light-menu scenery-menu' }, this.btn, this.pop);
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    // as duas pílulas (Cenário e Luz) ficam lado a lado no canto
    const wrap = el('div', { class: 'vp-menus' }, this.root);
    if (app.lightMenu?.root) wrap.append(app.lightMenu.root);
    app.vp.container.append(wrap);
    this.btn.addEventListener('click', () => {
      this.pop.hidden = !this.pop.hidden;
      if (app.lightMenu && !this.pop.hidden) app.lightMenu.pop.hidden = true;
      this.render();
    });
    app.lightMenu?.btn.addEventListener('click', () => { this.pop.hidden = true; });
    document.addEventListener('pointerdown', (e) => { if (!this.root.contains(e.target)) this.pop.hidden = true; });
    this.store.addEventListener('change', (e) => { if (e.detail.all) this.render(); else this.renderButton(); });
    this.render();
  }

  get walls() { return { ...WALL_DEFAULTS, ...(this.store.doc.settings.walls || {}) }; }
  get bd() { return { ...BACKDROP_DEFAULTS, ...(this.store.doc.settings.backdrop || {}) }; }

  /** Espessura/estilo global: vale para todas as paredes que não estão personalizadas. */
  setWalls(key, value, final) {
    const record = !this._gesture;
    this._gesture = !final;
    const ids = [];
    this.store.mutate((d) => {
      d.settings.walls = { ...WALL_DEFAULTS, ...(d.settings.walls || {}), [key]: value };
      for (const o of d.objects) if (applyWallDefaults(o, d.settings)) ids.push(o.id);
    }, { ids, record });
    if (final) { this.render(); this.app.panels?.renderProps(); }
  }

  setBackdrop(key, value, final = true) {
    const record = !this._gesture;
    this._gesture = !final;
    this.store.mutate((d) => {
      d.settings.backdrop = { ...BACKDROP_DEFAULTS, ...(d.settings.backdrop || {}) };
      setByPath(d.settings.backdrop, key, value);
      // trocar o estilo traz as cores sugeridas dele
      if (key === 'style' && BACKDROP_PRESETS[value]) Object.assign(d.settings.backdrop, BACKDROP_PRESETS[value]);
    }, { ids: [], record });
    if (final && (key === 'style' || key === 'enabled')) this.render();
  }

  renderButton() {
    const B = this.bd;
    this.btn.innerHTML = `${ICON}<span>Cenário${B.enabled ? `: ${BACKDROP_STYLES[B.style] || ''}` : ''}</span>`;
    this.btn.classList.toggle('on', !!B.enabled);
  }

  render() {
    this.renderButton();
    if (this.pop.hidden) return;
    const W = this.walls, B = this.bd;
    const custom = this.store.doc.objects.filter((o) => wallSlot(o)?.custom).length;
    const wf = (f) => field(W, f, (k, v, fin) => this.setWalls(k, v, fin));
    const bf = (f) => field(B, f, (k, v, fin) => this.setBackdrop(k, v, fin));
    const styleBtns = (opts, cur, on) => el('div', { class: 'styles' }, ...Object.entries(opts).map(([k, label]) => el('button', {
      type: 'button', class: cur === k ? 'active' : '', onclick: () => on(k),
    }, label)));
    const colorIn = (key, label) => {
      const input = el('input', { type: 'color', value: B[key] });
      input.addEventListener('input', () => this.setBackdrop(key, input.value, false));
      input.addEventListener('change', () => this.setBackdrop(key, input.value, true));
      return el('label', {}, label, input);
    };
    const enabled = el('input', { type: 'checkbox', checked: !!B.enabled });
    enabled.addEventListener('change', () => this.setBackdrop('enabled', enabled.checked));

    this.pop.replaceChildren(...[
      el('h4', {}, 'Paredes do level'),
      wf({ key: 'thickness', label: 'Espessura (todas)', type: 'range', min: 0.05, max: 6, step: 0.05 }),
      el('div', {}, styleBtns(WALL_STYLES, W.style, (k) => this.setWalls('style', k, true))),
      el('p', { class: 'info' }, custom
        ? `${custom} parede(s) personalizada(s) mantêm a própria espessura e estilo (ligue/desligue no inspetor).`
        : 'Para mudar uma parede só, selecione e ligue "Personalizar" no inspetor. Pedras e árvores ficam melhores com 1 a 3 m de espessura.'),
      el('hr'),
      el('div', { class: 'toggle-line' }, el('h4', {}, 'Fundo'), el('label', {}, enabled, 'mostrar')),
      B.enabled ? null : el('p', { class: 'info' }, 'Preenche o entorno com floresta, pedras, morros, montanhas ou prédios. É só cenário: o player vê, mas não entra.'),
      ...(B.enabled ? [
        styleBtns(BACKDROP_STYLES, B.style, (k) => this.setBackdrop('style', k)),
        el('div', { class: 'swatches' }, colorIn('color', LABELS.color[B.style] || 'Cor'), colorIn('color2', LABELS.color2[B.style] || 'Detalhe'), colorIn('ground', 'Chão')),
        bf({ key: 'density', label: 'Densidade', type: 'range', min: 0.05, max: 1, step: 0.05 }),
        bf({ key: 'height', label: 'Altura', type: 'range', min: 0.2, max: 3, step: 0.05 }),
        bf({ key: 'distance', label: 'Alcance (m)', type: 'range', min: 10, max: 120, step: 1 }),
        bf({ key: 'margin', label: 'Afastamento do level (m)', type: 'range', min: 0, max: 12, step: 0.25 }),
        el('div', { class: 'toggle-line' },
          el('label', {}, (() => { const cb = el('input', { type: 'checkbox', checked: !!B.block }); cb.addEventListener('change', () => this.setBackdrop('block', cb.checked)); return cb; })(), 'bloquear saída no jogo'),
          el('button', { type: 'button', class: 'mini', title: 'Outra variação aleatória', onclick: () => this.setBackdrop('seed', 1 + Math.floor(Math.random() * 9999)) }, 'Sortear')),
        el('p', { class: 'info' }, 'Com "bloquear", no modo jogo o player não sai do chão do level, mesmo onde não há parede.'),
      ] : []),
    ].filter(Boolean));
  }
}
