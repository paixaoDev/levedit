// Campos de formulário gerados a partir de um esquema simples.
import { getByPath, deg, rad } from '../util.js';
import { PALETTE } from '../model.js';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

const fmt = (v, step) => {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const dec = step && step < 1 ? Math.min(3, String(step).split('.')[1]?.length || 2) : 0;
  return String(+v.toFixed(dec));
};

/**
 * @param {object} obj objeto alvo
 * @param {object} f {key,label,type,min,max,step,options,show,deg}
 * @param {(key:string, value:any, final:boolean)=>void} onChange
 */
export function field(obj, f, onChange) {
  if (f.show && !f.show(obj)) return null;
  let value = getByPath(obj, f.key);
  if (f.deg) value = deg(value || 0);
  const id = `f_${f.key.replace(/\W/g, '_')}_${Math.random().toString(36).slice(2, 6)}`;
  const out = (v) => (f.deg ? rad(v) : v);
  let control;
  switch (f.type) {
    case 'range': {
      const num = el('input', { type: 'number', step: f.step ?? 0.1, min: f.min, max: f.max, value: fmt(value, f.step) });
      const rng = el('input', { type: 'range', id, min: f.min, max: f.max, step: f.step ?? 0.1, value });
      rng.addEventListener('input', () => { num.value = fmt(+rng.value, f.step); onChange(f.key, out(+rng.value), false); });
      rng.addEventListener('change', () => onChange(f.key, out(+rng.value), true));
      num.addEventListener('change', () => { if (num.value === '') return; rng.value = num.value; onChange(f.key, out(+num.value), true); });
      control = el('div', { class: 'range' }, rng, num);
      break;
    }
    case 'number': {
      control = el('input', { type: 'number', id, step: f.step ?? 0.1, min: f.min, max: f.max, value: fmt(value, f.step ?? 0.1) });
      control.addEventListener('change', () => { if (control.value !== '') onChange(f.key, out(+control.value), true); });
      break;
    }
    case 'bool': {
      const cb = el('input', { type: 'checkbox', id, checked: !!value });
      cb.addEventListener('change', () => onChange(f.key, cb.checked, true));
      control = el('label', { class: 'toggle' }, cb, f.text || '');
      break;
    }
    case 'select': {
      const opts = typeof f.options === 'function' ? f.options(obj) : f.options;
      control = el('select', { id });
      for (const [v, label] of Object.entries(opts)) {
        const o = el('option', { value: v }, label);
        if (String(value ?? '') === v) o.selected = true;
        control.append(o);
      }
      control.addEventListener('change', () => onChange(f.key, control.value === '' ? null : control.value, true));
      break;
    }
    case 'color': {
      const input = el('input', { type: 'color', id, value: value || '#ffffff' });
      input.addEventListener('input', () => onChange(f.key, input.value, false));
      input.addEventListener('change', () => onChange(f.key, input.value, true));
      const sw = PALETTE.map((c) => el('button', {
        class: 'swatch', type: 'button', title: c, style: `background:${c}`,
        onclick: () => { input.value = c; onChange(f.key, c, true); },
      }));
      control = el('div', { class: 'color-row' }, input, ...sw);
      break;
    }
    case 'text':
    default: {
      control = el('input', { type: 'text', id, value: value ?? '' });
      control.addEventListener('change', () => onChange(f.key, control.value, true));
    }
  }
  return el('div', { class: 'field' }, el('label', { for: id }, f.label), control);
}

export function group(title, children, open = true) {
  const d = el('details', { class: 'group', open }, el('summary', {}, title));
  d.append(...children.filter(Boolean));
  return d;
}
