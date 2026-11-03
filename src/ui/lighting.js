// Iluminação na interface: campos de teto (corredores/áreas), campos da luz
// pontual e o menu "Luz" flutuante no canto da vista 3D.
import { el, field } from './fields.js';
import { LIGHT_PRESETS, ROOF_VIEWS, LIGHTING_DEFAULTS } from '../render/lighting.js';
import { setByPath } from '../util.js';

/** Campos do teto (F = construtor de campo do inspetor). */
export function roofFields(F) {
  return [
    F({ key: 'roof.enabled', label: 'Teto', type: 'bool', text: 'com teto' }),
    el('p', { class: 'info' }, 'Sem teto recebe a luz de fora (sol). Com teto fica na sombra do sol, iluminado pela luz interna e pelos pontos de luz.'),
    F({ key: 'roof.thickness', label: 'Espessura', type: 'range', min: 0.05, max: 1, step: 0.05, show: (x) => x.roof.enabled }),
    F({ key: 'roof.color', label: 'Cor', type: 'color', show: (x) => x.roof.enabled }),
  ];
}

/** Campos de uma luz pontual (objeto ou opções da ferramenta). */
export function lightFields(F, { placing = false } = {}) {
  return [
    F({ key: 'color', label: 'Cor', type: 'color' }),
    F({ key: 'intensity', label: 'Intensidade', type: 'range', min: 0.5, max: 60, step: 0.5 }),
    F({ key: 'range', label: 'Alcance (m)', type: 'range', min: 2, max: 40, step: 0.5 }),
    F({ key: 'y', label: 'Altura (m)', type: 'range', min: 0.3, max: 10, step: 0.1 }),
    placing ? null : F({ key: 'shadows', label: 'Sombra', type: 'bool', text: 'projeta sombra' }),
  ].filter(Boolean);
}

const SUN_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

const CSS = `
.light-menu { position: absolute; right: 14px; top: 12px; z-index: 5; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; font-size: 12px; }
.light-menu > .light-btn { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line-mid, #d8cfbf); background: rgba(255, 254, 251, 0.94); color: var(--ink, #2f2a24); font: inherit; box-shadow: 0 1px 3px rgba(47,42,36,.08); }
.light-menu > .light-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.light-menu > .light-btn.on { background: var(--ink, #2f2a24); color: #fff; border-color: var(--ink, #2f2a24); }
.light-pop { width: 236px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line-mid, #d8cfbf);
  background: rgba(255, 254, 251, 0.97); box-shadow: 0 6px 24px rgba(47,42,36,.14); display: flex; flex-direction: column; gap: 8px; }
.light-pop[hidden] { display: none; }
.light-pop h4 { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted, #8a7a62); font-weight: 600; }
.light-pop .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.light-pop .presets button { padding: 5px 6px; border-radius: 8px; border: 1px solid var(--line-soft, #e7e0d3); background: #fff; cursor: pointer; font: inherit; color: var(--ink, #2f2a24); }
.light-pop .presets button.active { border-color: var(--ink, #2f2a24); background: var(--paper, #f4f1ea); font-weight: 600; }
.light-pop .field { margin: 0; grid-template-columns: 1fr; gap: 4px; }
.light-pop .field .range { display: grid; grid-template-columns: 1fr 56px; gap: 6px; align-items: center; }
.light-pop .field .range input[type=range] { width: 100%; }
.light-pop .info { margin: 0; font-size: 11px; color: var(--muted, #8a7a62); line-height: 1.35; }
body.playing .light-menu { display: none; }
`;

/** Botão "Luz" + popover com preset, ângulo do sol, luz interna e exibição do teto. */
export class LightingMenu {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    if (!document.getElementById('light-menu-css')) document.head.append(el('style', { id: 'light-menu-css' }, CSS));
    this.btn = el('button', { class: 'light-btn', type: 'button', title: 'Iluminação e sombras', 'aria-haspopup': 'true' });
    this.pop = el('div', { class: 'light-pop', hidden: true });
    this.root = el('div', { class: 'light-menu' }, this.btn, this.pop);
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    app.vp.container.append(this.root);
    this.btn.addEventListener('click', () => { this.pop.hidden = !this.pop.hidden; this.render(); });
    document.addEventListener('pointerdown', (e) => { if (!this.root.contains(e.target)) this.pop.hidden = true; });
    this.store.addEventListener('change', () => this.renderButton());
    this.render();
  }

  get settings() {
    const s = this.store.doc.settings;
    if (!s.lighting) s.lighting = { ...LIGHTING_DEFAULTS };
    return s.lighting;
  }

  set(key, value, final = true) {
    // luz não entra no histórico de desfazer; reconstrução leve (só ajusta luzes/materiais)
    this.store.mutate((d) => { d.settings.lighting ??= { ...LIGHTING_DEFAULTS }; setByPath(d.settings.lighting, key, value); }, { ids: [], record: false });
    if (final && key === 'preset') this.render();
  }

  renderButton() {
    const L = this.settings;
    this.btn.innerHTML = `${SUN_ICON}<span>Luz: ${LIGHT_PRESETS[L.preset]?.label || 'Editor'}</span>`;
    this.btn.classList.toggle('on', L.preset !== 'editor');
  }

  render() {
    this.renderButton();
    if (this.pop.hidden) return;
    const L = this.settings;
    const onF = (k, v, final) => this.set(k, v, final);
    const presets = el('div', { class: 'presets' }, ...Object.entries(LIGHT_PRESETS).map(([k, p]) => el('button', {
      type: 'button', class: L.preset === k ? 'active' : '', onclick: () => this.set('preset', k),
    }, p.label)));
    const lit = L.preset !== 'editor';
    this.pop.replaceChildren(
      el('h4', {}, 'Iluminação'),
      presets,
      lit ? field(L, { key: 'sunAngle', label: 'Direção do sol', type: 'range', min: 0, max: 360, step: 5 }, onF) : null,
      lit ? field(L, { key: 'interior', label: 'Luz interna', type: 'range', min: 0, max: 2, step: 0.05 }, onF) : null,
      lit ? el('p', { class: 'info' }, 'A luz interna ilumina lugares com teto (e faz sombra) sem precisar colocar pontos de luz.') : el('p', { class: 'info' }, 'Escolha Dia, Entardecer ou Noite para ver sol, sombras, tetos e pontos de luz (L).'),
      el('h4', {}, 'Tetos no editor'),
      field(L, { key: 'roofView', label: 'Mostrar', type: 'select', options: ROOF_VIEWS }, onF),
    );
  }
}
