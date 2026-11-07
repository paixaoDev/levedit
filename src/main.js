// Ponto de entrada: monta o app e liga store, viewport, ferramentas, painéis e modo jogo.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Store } from './store.js';
import { Viewport } from './editor/viewport.js';
import { Tools, TOOL_INFO } from './editor/tools.js';
import { Panels } from './ui/panels.js';
import { LightingMenu } from './ui/lighting.js';
import { LogicDialog } from './ui/logicDialog.js';
import { TOOL_ICONS, UI_ICONS, svgIcon } from './ui/icons.js';
import { PlayMode } from './play/play.js';
import { emptyDoc } from './model.js';
import { sampleDoc } from './sample.js';
import { customModels } from './builders/assets.js';
import { makeContext, corridorSamples } from './builders/index.js';
import { nodeHalf, attachEnd } from './builders/corridorPath.js';
import { closestOnPolyline } from './math/curve.js';
import { deepClone, uid } from './util.js';


const PLAY_BTN = {
  play: '<svg viewBox="0 0 24 24" class="solid"><path d="M8 5v14l11-7z"/></svg><span>Testar</span>',
  stop: '<svg viewBox="0 0 24 24" class="solid"><path d="M7 7h10v10H7z"/></svg><span>Parar</span>',
};

class App {
  constructor() {
    this.store = new Store();
    this.store.init();
    this.vp = new Viewport(document.getElementById('viewport'), this.store);
    this.tools = new Tools(this.vp, this.store); // registra listeners antes do OrbitControls
    this.vp.initControls();
    this.play = new PlayMode(this.vp, this.store);
    this.panels = new Panels(this);
    this.lightMenu = new LightingMenu(this);
    this.logic = new LogicDialog(this);
    this.buildToolbar();
    this.bindTouchUi();
    this.bindTips();
    this.bindUi();
    this.bindStore();
    this.loadCustomModels().then(() => this.vp.sync({ all: true }));
    this.vp.sync({ all: true });
    this.vp.frameAll();
    this.panels.renderAll();
    this.updateChrome();
    this.vp.start();
  }

  // ------------------------------------------------------------ UI
  buildToolbar() {
    const bar = document.getElementById('toolbar');
    const groups = [['select'], ['corridor', 'area', 'wall'], ['connector', 'asset', 'light', 'agent'], ['item', 'zone']];
    for (const g of groups) {
      const box = document.createElement('div');
      box.className = 'dock-group';
      for (const t of g) {
        const info = TOOL_INFO[t];
        const b = document.createElement('button');
        b.className = 'tool-btn';
        b.dataset.tool = t;
        b.dataset.tip = info.label;
        b.dataset.key = info.key;
        b.dataset.side = 'right';
        b.setAttribute('aria-label', `${info.label} (${info.key})`);
        b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${TOOL_ICONS[t]}"/></svg>`;
        b.addEventListener('click', () => this.tools.setTool(t));
        box.append(b);
      }
      bar.append(box);
    }
  }

  // ------------------------------------------------------------ celular
  /**
   * Tela de toque: classe "touch" no body (controles maiores), gaveta com abas
   * para os painéis em telas estreitas e barra de ações rápidas na cena
   * (Concluir/Desfazer ponto ao desenhar; Vários/Girar/Duplicar/Excluir na seleção).
   */
  bindTouchUi() {
    const mq = window.matchMedia('(pointer: coarse)');
    const setTouch = () => { document.body.classList.toggle('touch', mq.matches); this.updateChrome?.(); };
    mq.addEventListener?.('change', setTouch);
    document.body.classList.toggle('touch', mq.matches);

    // gaveta: só existe no layout estreito (CSS); aqui só guardamos qual aba está aberta
    this.sheet = null;
    const tabs = document.getElementById('sheet-tabs');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sheet]');
      if (b) this.setSheet(this.sheet === b.dataset.sheet ? null : b.dataset.sheet);
    });
    // escolher asset/agente precisa do painel: abre sozinho no celular
    this.tools.addEventListener('toolchange', (e) => {
      const t = e.detail.tool;
      if ((t === 'asset' || t === 'agent' || t === 'item') && !this.sheet && this.isNarrow()) this.setSheet('props');
    });
    // abrir um objeto pela lista leva às propriedades dele
    document.getElementById('outliner').addEventListener('click', (e) => {
      if (this.isNarrow() && e.target.closest('li.item') && !this.tools.multiSelect) this.setSheet('props');
    });

    const bar = document.getElementById('touch-bar');
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      const t = this.tools;
      if (act === 'finish') t.draft ? t.finishDraft() : t.setTool('select');
      else if (act === 'undo-point') t.undoDraftPoint();
      else if (act === 'cancel') t.cancelDraft();
      else if (act === 'multi') { t.multiSelect = !t.multiSelect; this.updateTouchBar(); }
      else if (act === 'rotate') t.rotateSelection(1);
      else if (act === 'dup') this.duplicateSelection();
      else if (act === 'del') { for (const id of [...this.store.multi]) this.store.removeObject(id); }
      else if (act === 'clear') this.store.select(null);
    });
    this.tools.addEventListener('draftchange', () => { this.updateTouchBar(); this.updateChrome(); });
  }

  isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

  setSheet(name) {
    this.sheet = name;
    document.body.dataset.sheet = name || '';
    document.querySelectorAll('#sheet-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.sheet === name);
      b.setAttribute('aria-expanded', String(b.dataset.sheet === name));
    });
  }

  /** Barra de ações para quem não tem teclado (só aparece em tela de toque). */
  updateTouchBar() {
    const bar = document.getElementById('touch-bar');
    if (!bar) return;
    const t = this.tools;
    const btn = (act, label, icon, cls = '', extra = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tb-btn ${cls}`;
      b.dataset.act = act;
      b.innerHTML = `${icon ? svgIcon(icon) : ''}<span>${label}</span>`;
      b.setAttribute('aria-label', label);
      if (extra.disabled) b.disabled = true;
      if (extra.pressed != null) b.setAttribute('aria-pressed', String(extra.pressed));
      return b;
    };
    const items = [];
    if (t.draft) {
      const min = t.draft.type === 'area' ? 3 : 2;
      items.push(btn('undo-point', 'Desfazer ponto', 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3', 'compact'));
      items.push(btn('cancel', 'Cancelar', UI_ICONS.close, 'compact'));
      items.push(btn('finish', 'Concluir', 'M5 12l5 5L20 7', 'primary', { disabled: t.draft.points.length < min }));
    } else if (t.tool !== 'select') {
      items.push(btn('finish', 'Pronto', 'M5 12l5 5L20 7'));
    } else {
      const sel = this.store.get(this.store.selection);
      if (sel || t.multiSelect) items.push(btn('multi', 'Vários', 'M4 4h7v7H4z M13 13h7v7h-7z M17 4v6 M14 7h6', t.multiSelect ? 'on' : '', { pressed: t.multiSelect }));
      if (sel) {
        if (['asset', 'agent', 'connector', 'light', 'item', 'zone'].includes(sel.type) && this.store.multi.size === 1) items.push(btn('rotate', 'Girar', UI_ICONS.reset, 'compact'));
        if (this.store.multi.size === 1) items.push(btn('dup', 'Duplicar', UI_ICONS.copy, 'compact'));
        items.push(btn('del', 'Excluir', UI_ICONS.trash, 'danger'));
      }
    }
    bar.replaceChildren(...items);
    bar.hidden = !items.length;
  }

  /** Dicas flutuantes para qualquer elemento com data-tip (nome + atalho). */
  bindTips() {
    const tip = document.getElementById('tip');
    let cur = null;
    const hide = () => { tip.hidden = true; cur = null; };
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest?.('[data-tip]');
      if (t === cur) return;
      if (!t || e.pointerType === 'touch') return hide();
      cur = t;
      tip.innerHTML = '';
      tip.append(t.dataset.tip);
      if (t.dataset.key) { const k = document.createElement('kbd'); k.textContent = t.dataset.key; tip.append(k); }
      tip.hidden = false;
      const r = t.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let x, y;
      if (t.dataset.side === 'right') { x = r.right + 10; y = r.top + r.height / 2 - tr.height / 2; }
      else { x = r.left + r.width / 2 - tr.width / 2; y = r.bottom + 8; }
      x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    document.addEventListener('pointerdown', (e) => { const t = cur; hide(); cur = t && t.contains(e.target) ? t : null; });
    window.addEventListener('play:start', hide);
    document.addEventListener('pointerleave', hide);
  }

  bindUi() {
    const $ = (id) => document.getElementById(id);
    $('btn-undo').addEventListener('click', () => this.store.undo());
    $('btn-redo').addEventListener('click', () => this.store.redo());
    $('view-3d').addEventListener('click', () => this.setView('3d'));
    $('view-top').addEventListener('click', () => this.setView('top'));
    $('btn-snap').addEventListener('click', () => this.toggleSnap());
    $('btn-logic').addEventListener('click', () => this.logic.open());
    $('btn-play').addEventListener('click', () => (this.play.active ? this.play.stop() : this.startPlay()));
    new ResizeObserver(() => { this.vp.resize(); if (this.play.active) this.play.resize(); }).observe(this.vp.container);
    const name = $('doc-name');
    name.addEventListener('change', () => this.store.mutate((d) => { d.name = name.value; }, { ids: [] }));

    const menu = $('menu-file');
    $('btn-file').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', () => { menu.hidden = true; });
    menu.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act) { menu.hidden = true; this.fileAction(act); }
    });
    $('file-json').addEventListener('change', (e) => this.openJson(e.target.files[0]));
    $('file-model').addEventListener('change', (e) => this.loadModelFile(e.target.files[0]));

    this.tools.addEventListener('toolchange', () => { this.panels.renderToolOptions(); this.updateChrome(); });
    this.tools.addEventListener('toast', (e) => this.toast(e.detail));
    this.tools.addEventListener('cursor', (e) => {
      const p = e.detail;
      $('status-cursor').textContent = p ? `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}` : '';
    });
    this.vp.dom.addEventListener('pointermove', (e) => {
      if (this.tools.tool !== 'select' || this.play.active) return;
      const p = this.vp.groundPoint(this.vp.ndc(e));
      if (p) $('status-cursor').textContent = `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}`;
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('play:start', () => { document.body.classList.add('playing'); $('btn-play').innerHTML = PLAY_BTN.stop; });
    window.addEventListener('play:stop', () => { document.body.classList.remove('playing'); $('btn-play').innerHTML = PLAY_BTN.play; this.tools.refreshHandles(); });
    window.addEventListener('beforeunload', () => this.store.saveLocal());
  }

  bindStore() {
    this.store.addEventListener('change', (e) => {
      const d = e.detail;
      if (this.play.active) return;
      this.vp.sync(d);
      if (d.all || d.structure) {
        this.panels.renderLevels();
        this.panels.renderOutliner();
        this.panels.renderProps();
        this.panels.renderToolOptions();
      }
      this.updateChrome();
    });
    this.store.addEventListener('selection', () => {
      this.vp.updateVisualStates();
      this.panels.renderOutliner();
      this.panels.renderProps();
      this.updateChrome();
    });
  }

  updateChrome() {
    const doc = this.store.doc;
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === this.tools.tool));
    document.getElementById('btn-undo').disabled = !this.store.undoStack.length;
    document.getElementById('btn-redo').disabled = !this.store.redoStack.length;
    document.getElementById('btn-snap').classList.toggle('on', !!doc.settings.snap);
    document.getElementById('view-3d').classList.toggle('active', this.vp.view === '3d');
    document.getElementById('view-top').classList.toggle('active', this.vp.view === 'top');
    const name = document.getElementById('doc-name');
    if (document.activeElement !== name) name.value = doc.name;
    const lvl = this.store.activeLevel;
    document.getElementById('status-level').textContent = `${lvl.name} · ${lvl.elevation} m`;
    document.body.dataset.tool = this.tools.tool;
    document.getElementById('status-hint').textContent = this.contextHint();
    const sel = this.store.get(this.store.selection);
    const multi = this.store.multi.size;
    document.getElementById('sheet-props-label').textContent = multi > 1 ? `${multi} selecionados` : sel ? sel.name || 'Propriedades' : this.tools.tool !== 'select' ? TOOL_INFO[this.tools.tool].label : 'Propriedades';
    document.getElementById('sheet-tabs').classList.toggle('has-sel', !!sel);
    this.updateTouchBar();
    document.getElementById('view-hint').textContent = this.vp.view === '3d' ? 'Perspectiva' : 'Planta';
  }

  /** Dica curta para a pílula no rodapé da cena: ferramenta ativa ou o que dá para fazer com a seleção. */
  contextHint() {
    const t = this.tools.tool;
    if (document.body.classList.contains('touch')) return this.touchHint();
    if (t !== 'select') return TOOL_INFO[t].hint;
    if (this.store.multi.size > 1) return 'Ctrl+G agrupa e conecta corredores · Del exclui · Esc limpa a seleção';
    const o = this.store.get(this.store.selection);
    if (!o) return TOOL_INFO.select.hint;
    if (o.type === 'corridor') return 'Arraste os quadrados para mover nós · losango cria nó · bolinhas mudam a largura';
    if (o.type === 'area' && o.shape === 'circle') return 'Passe o mouse na parede e clique para puxar uma parede · centro move · bolinha muda o raio';
    if (o.type === 'wall' || o.type === 'area') return 'Passe o mouse na parede e clique para puxar outra · quadrados movem nós · Alt arrasta';
    return 'Arraste para mover · R gira · Ctrl+D duplica · Del exclui';
  }

  touchHint() {
    const t = this.tools.tool;
    if (t !== 'select') {
      const d = this.tools.draft;
      if (d && d.points.length) return 'Toque para o próximo ponto · Concluir termina';
      return TOOL_INFO[t].touch;
    }
    if (this.tools.multiSelect) return 'Toque nos objetos para somar à seleção';
    if (this.store.multi.size > 1) return 'Vários selecionados · Agrupar fica em Propriedades';
    const o = this.store.get(this.store.selection);
    if (!o) return TOOL_INFO.select.touch;
    if (o.type === 'corridor') return 'Arraste nós e bolinhas · segure um nó para remover, ou o corredor para mover';
    if (o.type === 'area' && o.shape === 'circle') return 'Toque na parede para puxar outra · bolinha muda o raio';
    if (o.type === 'wall' || o.type === 'area') return 'Toque na parede para puxar outra · arraste os nós';
    return 'Arraste para mover · 2 dedos movem a câmera';
  }

  setView(v) { this.vp.setView(v); this.updateChrome(); this.tools.refreshHandles(); }
  toggleSnap() { this.store.mutate((d) => { d.settings.snap = !d.settings.snap; }, { ids: [], record: false }); this.toast(`Ímã na grade ${this.store.doc.settings.snap ? 'ligado' : 'desligado'}`); }

  setActiveLevel(id) {
    if (this.store.doc.activeLevelId === id) return;
    this.store.mutate((d) => { d.activeLevelId = id; }, { ids: [], record: false, structure: true });
    // a câmera acompanha a elevação do nível
    const y = this.store.activeLevel.elevation;
    const c = this.vp.controls;
    const dy = y - c.target.y;
    c.target.y += dy;
    this.vp.camera.position.y += dy;
  }

  cycleLevel(dir) {
    const lv = [...this.store.doc.levels].sort((a, b) => a.elevation - b.elevation);
    const i = lv.findIndex((l) => l.id === this.store.doc.activeLevelId);
    const n = lv[Math.max(0, Math.min(lv.length - 1, i + dir))];
    this.setActiveLevel(n.id);
  }

  onKey(e) {
    if (this.play.active) return;
    if (document.querySelector('dialog[open]')) return; // janela aberta: Esc fecha ela, atalhos ficam parados
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.store.redo() : this.store.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.store.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? this.ungroupSelection() : this.groupSelection(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.fileAction('save'); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.startPlay(); return; }
    if (this.tools.onKey(e)) { e.preventDefault(); return; }
    if (mod || e.altKey) return;
    const k = e.key.toLowerCase();
    const toolKey = Object.entries(TOOL_INFO).find(([, i]) => i.key.toLowerCase() === k);
    if (toolKey) { this.tools.setTool(toolKey[0]); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.store.selection) {
        e.preventDefault();
        for (const id of [...this.store.multi]) this.store.removeObject(id);
      }
      return;
    }
    if (k === 'r') this.tools.rotateSelection(e.shiftKey ? -1 : 1);
    else if (k === 't') this.setView(this.vp.view === '3d' ? 'top' : '3d');
    else if (k === 'g') this.toggleSnap();
    else if (k === 'f') this.focusSelection();
    else if (e.key === 'PageUp') { e.preventDefault(); this.cycleLevel(1); }
    else if (e.key === 'PageDown') { e.preventDefault(); this.cycleLevel(-1); }
    else if (e.key === '?') document.getElementById('help-dialog').showModal();
  }

  // ------------------------------------------------------------ ações
  duplicateSelection() {
    const o = this.store.get(this.store.selection);
    if (!o) return;
    const c = deepClone(o);
    c.id = uid(o.type.slice(0, 3));
    c.name = `${o.name} cópia`;
    if (c.points) c.points = c.points.map(({ att, ...p }) => ({ ...p, x: p.x + 2, z: p.z + 2 }));
    else { c.x += 2; c.z += 2; }
    // o que está preso no original ganha uma cópia presa na cópia
    const kids = [];
    const copyKids = (fromId, toId) => {
      for (const k of this.store.doc.objects.filter((x) => x.parentId === fromId)) {
        const kc = deepClone(k);
        kc.id = uid(k.type.slice(0, 3));
        kc.parentId = toId;
        kids.push(kc);
        copyKids(k.id, kc.id);
      }
    };
    copyKids(o.id, c.id);
    if (kids.length) this.store.mutate((d) => { d.objects.push(c, ...kids); }, { ids: [c.id], structure: true });
    if (kids.length) this.store.select(c.id);
    else this.store.addObject(c);
  }

  /**
   * Ctrl+G: agrupa os corredores selecionados (estilo compartilhado) e tenta
   * conectá-los: a ponta mais próxima de cada um vai para a ponta ou para o
   * eixo de um corredor já no grupo (abrindo porta na lateral).
   */
  groupSelection() {
    const sel = this.store.selectedObjects.filter((o) => o.type === 'corridor');
    if (sel.length < 2) { this.toast('Selecione 2 ou mais corredores (Shift+clique) e aperte Ctrl+G.'); return; }
    const primary = sel[0]; // o primeiro selecionado é o modelo e fica parado
    const gid = primary.groupId || sel.find((o) => o.groupId)?.groupId || uid('grp');
    let connected = 0;
    this.store.mutate((d) => {
      const P = d.objects.find((o) => o.id === primary.id);
      const members = sel.map((o) => d.objects.find((x) => x.id === o.id));
      const ctx = makeContext(d);
      const placed = [P];
      // ordena pelos mais próximos do principal
      const dist0 = (m) => Math.min(...m.points.map((p) => Math.min(...P.points.map((q) => Math.hypot(p.x - q.x, p.z - q.z)))));
      const others = members.filter((m) => m !== P).sort((a, b) => dist0(a) - dist0(b));
      for (const m of members) m.groupId = gid;
      for (const m of others) {
        for (const k of ['walls', 'floor', 'proc', 'deco']) m[k] = deepClone(P[k]);
        m.smooth = P.smooth;
        if (m.closed) { placed.push(m); continue; }
        let best = null;
        for (const t of placed) {
          const sm = corridorSamples(t, ctx).samples;
          for (const idx of [0, m.points.length - 1]) {
            const c = closestOnPolyline(sm, m.points[idx], t.closed);
            if (c && (!best || c.d < best.c.d)) best = { idx, c, t };
          }
        }
        if (best && best.c.d < 15) {
          const { idx, c, t } = best;
          const half = Math.max(nodeHalf(t, 0, 1), nodeHalf(t, 0, -1));
          const ends = t.closed ? [] : [t.points[0], t.points[t.points.length - 1]];
          const near = ends.find((q) => Math.hypot(q.x - c.x, q.z - c.z) < half * 1.5);
          const target = near || { x: c.x, z: c.z };
          m.points[idx] = { ...m.points[idx], x: target.x, z: target.z };
          // lateral: a ponta vira um nó compartilhado do outro corredor
          if (!near) attachEnd(d, makeContext(d), m, idx === 0 ? 'start' : 'end');
          connected++;
        }
        placed.push(m);
      }
    }, { all: true, structure: true });
    this.toast(`Grupo com ${sel.length} corredores · ${connected} conexão(ões)`);
  }

  ungroupSelection() {
    const ids = this.store.selectedObjects.filter((o) => o.groupId).map((o) => o.id);
    if (!ids.length) return;
    this.store.mutate((d) => { for (const o of d.objects) if (ids.includes(o.id)) o.groupId = null; }, { ids, structure: true });
    this.toast('Desagrupado');
  }

  focusSelection() {
    const g = this.vp.objects.get(this.store.selection);
    if (!g) return;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    this.vp.focus(box.getCenter(new THREE.Vector3()));
  }

  startPlay(playerId) {
    this.tools.cancelDraft();
    this.tools.setTool('select');
    const sel = this.store.get(this.store.selection);
    this.play._preferredPlayerId = playerId || (sel?.type === 'agent' && sel.role === 'player' ? sel.id : null);
    this.play.start();
  }

  fileAction(act) {
    switch (act) {
      case 'new': {
        // Sem window.confirm: navegadores que bloqueiam diálogos (ou o "impedir esta
        // página de abrir diálogos") devolvem false na hora e o botão parecia não fazer nada.
        // O level anterior continua a um Ctrl+Z de distância.
        this.tools.cancelDraft();
        this.tools.setTool('select');
        const prev = JSON.stringify(this.store.doc);
        this.store.load(emptyDoc());
        this.store.undoStack.push(prev);
        this.vp.frameAll();
        this.toast('Level vazio criado · Desfazer traz o anterior de volta');
        break;
      }
      case 'sample': {
        const prev = JSON.stringify(this.store.doc);
        this.store.load(sampleDoc());
        this.store.undoStack.push(prev);
        this.vp.frameAll();
        break;
      }
      case 'open': document.getElementById('file-json').click(); break;
      case 'save': this.download(`${slug(this.store.doc.name)}.level.json`, new Blob([JSON.stringify(this.store.doc, null, 2)], { type: 'application/json' })); break;
      case 'import-model': this.importModel(); break;
      case 'export-glb': this.exportGlb(); break;
      case 'screenshot':
        this.vp.renderer.render(this.vp.scene, this.vp.camera);
        this.vp.dom.toBlob((b) => b && this.download(`${slug(this.store.doc.name)}.png`, b));
        break;
      case 'help': document.getElementById('help-dialog').showModal(); break;
      default: break;
    }
  }

  async openJson(file) {
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (!doc.levels || !doc.objects) throw new Error('formato inválido');
      const prev = JSON.stringify(this.store.doc);
      this.store.load(doc);
      this.store.undoStack.push(prev);
      await this.loadCustomModels();
      this.vp.sync({ all: true });
      this.vp.frameAll();
      this.toast(`Level "${this.store.doc.name}" carregado`);
    } catch (err) {
      this.toast(`Não foi possível abrir: ${err.message}`);
    }
    document.getElementById('file-json').value = '';
  }

  importModel() { document.getElementById('file-model').click(); }

  async loadModelFile(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 8 * 1024 * 1024) throw new Error('arquivo maior que 8 MB');
      const id = uid('mdl');
      const name = file.name.replace(/\.(glb|gltf)$/i, '');
      const data = file.name.toLowerCase().endsWith('.gltf') ? new TextDecoder().decode(buf) : bufToBase64(buf);
      const format = file.name.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
      await this.parseModel(id, format === 'glb' ? base64ToBuf(data) : data);
      this.store.mutate((d) => { d.customAssets[id] = { name, format, data }; }, { ids: [], structure: true });
      this.tools.options.asset.kind = 'custom';
      this.tools.options.asset.customId = id;
      this.tools.options.asset.label = name;
      this.tools.setTool('asset');
      this.toast(`Modelo "${name}" importado. Clique no grid para posicionar.`);
    } catch (err) {
      this.toast(`Falha ao importar modelo: ${err.message}`);
    }
    document.getElementById('file-model').value = '';
  }

  parseModel(id, data) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(data, '', (gltf) => {
        const root = gltf.scene;
        // normaliza: base em y=0, centro em xz, tamanho razoável
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const max = Math.max(size.x, size.y, size.z) || 1;
        const s = max > 40 || max < 0.05 ? 2 / max : 1;
        const center = box.getCenter(new THREE.Vector3());
        const wrap = new THREE.Group();
        root.position.set(-center.x, -box.min.y, -center.z);
        wrap.add(root);
        wrap.scale.setScalar(s);
        customModels.set(id, wrap);
        resolve(wrap);
      }, reject);
    });
  }

  async loadCustomModels() {
    const ca = this.store.doc.customAssets || {};
    for (const [id, m] of Object.entries(ca)) {
      if (customModels.has(id)) continue;
      try { await this.parseModel(id, m.format === 'gltf' ? m.data : base64ToBuf(m.data)); } catch (err) { console.warn('Modelo inválido', id, err); }
    }
  }

  exportGlb() {
    const root = new THREE.Group();
    for (const [id, g] of this.vp.objects) {
      const o = this.store.get(id);
      if (!o || o.type === 'agent' || !g.visible) continue;
      const c = g.clone(true);
      const rm = [];
      c.traverse((m) => { if (m.isLineSegments || m.userData.editorOnly) rm.push(m); });
      rm.forEach((m) => m.parent.remove(m));
      root.add(c);
    }
    new GLTFExporter().parse(root, (res) => {
      this.download(`${slug(this.store.doc.name)}.glb`, new Blob([res], { type: 'model/gltf-binary' }));
    }, (err) => this.toast(`Falha ao exportar: ${err.message}`), { binary: true });
  }

  download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
}

function slug(s) { return (s || 'level').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level'; }
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

window.levedit = new App();
