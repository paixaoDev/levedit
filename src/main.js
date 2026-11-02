// Ponto de entrada: monta o app e liga store, viewport, ferramentas, painéis e modo jogo.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Store } from './store.js';
import { Viewport } from './editor/viewport.js';
import { Tools, TOOL_INFO } from './editor/tools.js';
import { Panels } from './ui/panels.js';
import { PlayMode } from './play/play.js';
import { emptyDoc, sampleDoc } from './model.js';
import { customModels } from './builders/assets.js';
import { makeContext, corridorSamples } from './builders/index.js';
import { nodeHalf, attachEnd } from './builders/corridorPath.js';
import { closestOnPolyline } from './math/curve.js';
import { deepClone, uid } from './util.js';

const TOOL_ICONS = {
  select: 'M5 3l13 8-6 1.5L9 19z',
  corridor: 'M3 20c3-8 6-12 9-12s4 4 9-4 M5 21c3-8 6-11 8-11s3 3 8-4',
  wall: 'M3 7h18v10H3z M3 12h18 M9 7v5 M15 12v5',
  area: 'M4 5h16v14H4z M4 5l3 3h10l3-3 M7 8v8 M17 8v8',
  connector: 'M4 20h4v-4h4v-4h4V8h4',
  asset: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  agent: 'M12 3a3 3 0 1 0 0.01 0z M7 21v-6a5 5 0 0 1 10 0v6',
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
    this.buildToolbar();
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
    for (const [t, info] of Object.entries(TOOL_INFO)) {
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.dataset.tool = t;
      b.title = `${info.label} (${info.key})`;
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${TOOL_ICONS[t]}"/></svg><span class="lbl">${info.label}</span><kbd>${info.key}</kbd>`;
      b.addEventListener('click', () => this.tools.setTool(t));
      bar.append(b);
    }
  }

  bindUi() {
    const $ = (id) => document.getElementById(id);
    $('btn-undo').addEventListener('click', () => this.store.undo());
    $('btn-redo').addEventListener('click', () => this.store.redo());
    $('view-3d').addEventListener('click', () => this.setView('3d'));
    $('view-top').addEventListener('click', () => this.setView('top'));
    $('btn-snap').addEventListener('click', () => this.toggleSnap());
    $('btn-play').addEventListener('click', () => (this.play.active ? this.play.stop() : this.startPlay()));
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
    window.addEventListener('play:start', () => { document.body.classList.add('playing'); $('btn-play').textContent = '■ Parar'; });
    window.addEventListener('play:stop', () => { document.body.classList.remove('playing'); $('btn-play').textContent = '▶ Testar'; this.tools.refreshHandles(); });
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
    document.getElementById('status-hint').textContent = TOOL_INFO[this.tools.tool].hint;
    document.getElementById('view-hint').textContent = `${this.vp.view === '3d' ? 'Perspectiva' : 'Planta'} · ${lvl.name}`;
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
    if (c.points) c.points = c.points.map((p) => ({ ...p, x: p.x + 2, z: p.z + 2 }));
    else { c.x += 2; c.z += 2; }
    this.store.addObject(c);
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
      case 'new':
        if (window.confirm('Começar um level vazio? (o atual pode ser recuperado com Ctrl+Z)')) {
          const prev = JSON.stringify(this.store.doc);
          this.store.load(emptyDoc());
          this.store.undoStack.push(prev);
          this.vp.frameAll();
        }
        break;
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
