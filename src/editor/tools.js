// Ferramentas de edição: seleção/arraste, desenho de curvas (corredor, parede,
// área), colocação (assets, agentes, escadas) e alças de pontos de controle.
import * as THREE from 'three';
import { makeObject, ASSET_KINDS } from '../model.js';
import { buildObject } from '../builders/index.js';
import { applyVisualState, THEME } from '../render/materials.js';
import { snap, lerp, smoothstep, deepClone } from '../util.js';

const PATH_TYPES = new Set(['corridor', 'wall', 'area']);
const MOVABLE = new Set(['asset', 'agent', 'connector']);

export const TOOL_INFO = {
  select: { label: 'Selecionar', key: 'V', hint: 'Clique para selecionar · arraste para mover · arraste pontos/meios para editar a curva · botão direito no ponto remove' },
  corridor: { label: 'Corredor', key: 'C', hint: 'Clique para adicionar pontos · Enter/duplo clique/botão direito finaliza · Backspace desfaz ponto · Esc cancela' },
  wall: { label: 'Parede', key: 'W', hint: 'Clique para adicionar pontos da parede · Enter finaliza · clique no primeiro ponto fecha' },
  area: { label: 'Área', key: 'A', hint: 'Desenhe o contorno da sala/praça · clique no primeiro ponto ou Enter para fechar' },
  connector: { label: 'Escada/Rampa', key: 'S', hint: 'Clique para posicionar · R gira · liga o nível ativo ao nível de cima' },
  asset: { label: 'Asset', key: 'O', hint: 'Escolha o asset no painel e clique para posicionar · Shift mantém a ferramenta' },
  agent: { label: 'Agente', key: 'P', hint: 'Escolha player ou inimigo no painel e clique para posicionar' },
};

export class Tools extends EventTarget {
  constructor(vp, store) {
    super();
    this.vp = vp;
    this.store = store;
    this.tool = 'select';
    this.options = {
      corridor: { width: 4, endLevelId: null, rampStyle: 'ramp', smooth: 0.5, deco: 'none' },
      wall: { smooth: 0, height: 3 },
      area: { smooth: 0 },
      asset: { kind: 'cube', color: '#e9e2d4' },
      agent: { role: 'player', mode: 'fps' },
      connector: { style: 'stairs' },
    };
    this.draft = null;
    this.drag = null;
    this.cursor = null;
    this.preview = null;
    this.handles = new THREE.Group();
    this.handles.renderOrder = 10;
    vp.helpers.add(this.handles);
    this.draftLine = null;
    this._down = null;
    this._bind();
    store.addEventListener('selection', () => this.refreshHandles());
    store.addEventListener('change', () => this.refreshHandles());
    vp.onFrame.push(() => this._scaleHandles());
  }

  setTool(t) {
    if (!TOOL_INFO[t]) return;
    this.cancelDraft();
    this.tool = t;
    this._clearPreview();
    this.vp.dom.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.dispatchEvent(new CustomEvent('toolchange', { detail: { tool: t } }));
  }

  setOption(tool, key, value) {
    this.options[tool][key] = value;
    this._clearPreview();
    this.dispatchEvent(new CustomEvent('toolchange', { detail: { tool: this.tool } }));
  }

  get levelY() { return this.store.activeLevel?.elevation ?? 0; }

  // ---------------------------------------------------------- eventos
  _bind() {
    const dom = this.vp.dom;
    dom.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    dom.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onContext(e); });
    dom.addEventListener('dblclick', (e) => { if (this.draft) { e.preventDefault(); this.finishDraft(); } });
  }

  _setControls(on) {
    if (this.vp.controls) this.vp.controls.enabled = on;
  }

  _onDown(e) {
    if (this.vp.playing) return;
    this.vp.dom.focus();
    this._down = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
    if (e.button !== 0) return; // direito/meio: câmera
    const ndc = this.vp.ndc(e);
    const t = this.tool;

    if (t === 'select') {
      const h = this._pickHandle(ndc);
      if (h) {
        this._setControls(false);
        const o = this.store.get(h.id);
        if (h.kind === 'mid') {
          // insere um ponto no meio do segmento e começa a arrastar
          this.store.mutate((d) => {
            const obj = d.objects.find((x) => x.id === h.id);
            obj.points.splice(h.index + 1, 0, { x: h.pos.x, z: h.pos.z });
          }, { ids: [h.id] });
          this.drag = { kind: 'point', id: h.id, index: h.index + 1, y: h.pos.y, recorded: true };
        } else if (e.altKey && o.points.length > (o.type === 'area' ? 3 : 2)) {
          this._deletePoint(h.id, h.index);
        } else {
          this.drag = { kind: 'point', id: h.id, index: h.index, y: h.pos.y, recorded: false };
        }
        return;
      }
      const hit = this.vp.pickObject(ndc);
      if (hit) {
        this.store.select(hit.id);
        const o = this.store.get(hit.id);
        const y = o.type === 'agent' || o.type === 'asset' ? this.vp.ctx.levelY(o.levelId) : hit.point.y;
        const start = this.vp.groundPoint(ndc, y);
        if (start) {
          this._setControls(false);
          this.drag = {
            kind: 'move', id: hit.id, y, start, recorded: false,
            orig: PATH_TYPES.has(o.type) ? deepClone(o.points) : { x: o.x, z: o.z },
          };
        }
      } else {
        this.store.select(null);
      }
      return;
    }

    const p = this._cursorPoint(ndc, e);
    if (!p) return;
    this._setControls(false);
    if (PATH_TYPES.has(t)) {
      if (!this.draft) this.draft = { type: t, points: [] };
      const pts = this.draft.points;
      const first = pts[0];
      if (pts.length >= 3 && first && Math.hypot(first.x - p.x, first.z - p.z) < 0.6) {
        this.draft.closed = true;
        this.finishDraft();
        return;
      }
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.05) pts.push({ x: p.x, z: p.z });
      this._updateDraftPreview();
      return;
    }
    this._place(p, e.shiftKey);
  }

  _onMove(e) {
    if (this.vp.playing) return;
    if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 4) this._down.moved = true;
    if (e.target !== this.vp.dom && !this.drag) return;
    const ndc = this.vp.ndc(e);
    if (this.drag) { this._doDrag(ndc, e); return; }
    if (this.tool === 'select') {
      const h = this._pickHandle(ndc);
      this.vp.dom.style.cursor = h ? (h.kind === 'mid' ? 'copy' : 'grab') : 'default';
      return;
    }
    const p = this._cursorPoint(ndc, e);
    this.cursor = p;
    this.dispatchEvent(new CustomEvent('cursor', { detail: p }));
    if (PATH_TYPES.has(this.tool)) this._updateDraftPreview();
    else this._updatePlacePreview();
  }

  _onUp(e) {
    if (this.drag) {
      this.drag = null;
      this.store.emit({ ids: [], structure: true }); // atualiza painéis
    }
    this._setControls(true);
    if (e.button === 0) this._down = null;
  }

  _onContext(e) {
    if (this.vp.playing) return;
    const moved = this._down?.moved;
    this._down = null;
    if (moved) return; // foi órbita
    if (this.draft) { this.finishDraft(); return; }
    if (this.tool === 'select') {
      const h = this._pickHandle(this.vp.ndc(e));
      if (h && h.kind === 'point') this._deletePoint(h.id, h.index);
    } else if (this.tool !== 'select') {
      this.setTool('select');
    }
  }

  onKey(e) {
    if (e.key === 'Escape') {
      if (this.draft) this.cancelDraft();
      else if (this.tool !== 'select') this.setTool('select');
      else this.store.select(null);
      return true;
    }
    if (e.key === 'Enter' && this.draft) { this.finishDraft(); return true; }
    if (e.key === 'Backspace' && this.draft) {
      this.draft.points.pop();
      if (!this.draft.points.length) this.cancelDraft();
      else this._updateDraftPreview();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------- snapping
  _cursorPoint(ndc, e) {
    const p = this.vp.groundPoint(ndc, this.levelY);
    if (!p) return null;
    return this.snapPoint(p, e?.altKey, null);
  }

  snapPoint(p, noSnap, excludeId) {
    const out = { x: p.x, z: p.z };
    if (noSnap) return out;
    // ímã nas extremidades de outros caminhos (para emendar corredores)
    let best = null, bestD = 0.9;
    for (const o of this.store.doc.objects) {
      if (!PATH_TYPES.has(o.type) || o.id === excludeId || !o.points.length) continue;
      for (const q of [o.points[0], o.points[o.points.length - 1]]) {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (best) return { x: best.x, z: best.z, snapped: true };
    const s = this.store.doc.settings;
    if (s.snap) { out.x = snap(p.x, s.gridSize / 2); out.z = snap(p.z, s.gridSize / 2); }
    return out;
  }

  // ---------------------------------------------------------- arraste
  _doDrag(ndc, e) {
    const d = this.drag;
    const hit = this.vp.groundPoint(ndc, d.y);
    if (!hit) return;
    const record = !d.recorded;
    d.recorded = true;
    if (d.kind === 'point') {
      const p = this.snapPoint(hit, e.altKey, d.id);
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (o?.points[d.index]) o.points[d.index] = { x: p.x, z: p.z };
      }, { ids: [d.id], record });
    } else if (d.kind === 'move') {
      const s = this.store.doc.settings;
      let dx = hit.x - d.start.x, dz = hit.z - d.start.z;
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (!o) return;
        if (PATH_TYPES.has(o.type)) {
          if (s.snap && !e.altKey) { dx = snap(dx, s.gridSize / 2); dz = snap(dz, s.gridSize / 2); }
          o.points = d.orig.map((p) => ({ x: p.x + dx, z: p.z + dz }));
        } else {
          const step = s.snap && !e.altKey ? s.gridSize / 2 : 0;
          o.x = snap(d.orig.x + dx, step);
          o.z = snap(d.orig.z + dz, step);
        }
      }, { ids: [d.id], record });
    }
  }

  _deletePoint(id, index) {
    const o = this.store.get(id);
    if (!o || o.points.length <= (o.type === 'area' ? 3 : 2)) return;
    this.store.mutate((d) => d.objects.find((x) => x.id === id).points.splice(index, 1), { ids: [id] });
  }

  rotateSelection(sign = 1) {
    const o = this.store.get(this.store.selection);
    if (!o || !MOVABLE.has(o.type)) return;
    this.store.mutate((d) => { d.objects.find((x) => x.id === o.id).rotY += (sign * Math.PI) / 12; }, { ids: [o.id] });
  }

  // ---------------------------------------------------------- desenho
  _draftObject(points) {
    const t = this.draft?.type || this.tool;
    const opt = this.options[t] || {};
    const props = { levelId: this.store.doc.activeLevelId, points, smooth: opt.smooth ?? 0 };
    if (t === 'corridor') {
      Object.assign(props, { width: opt.width, endLevelId: opt.endLevelId || null, rampStyle: opt.rampStyle });
      if (opt.deco && opt.deco !== 'none') props.deco = { type: opt.deco, side: 'both', density: 0.4, color: opt.deco === 'rocks' ? '#b9a88a' : opt.deco === 'sidewalk' ? '#d8cbb3' : '#9bb57a', inset: 0.7, seed: Math.floor(Math.random() * 999) };
    }
    if (t === 'wall') props.height = opt.height;
    if (this.draft?.closed && t !== 'area') props.closed = true;
    const count = this.store.doc.objects.filter((o) => o.type === t).length + 1;
    props.name = `${TOOL_INFO[t].label} ${count}`;
    return makeObject(t, props);
  }

  _updateDraftPreview() {
    this._clearPreview();
    if (!this.draft) return;
    const pts = [...this.draft.points];
    if (this.cursor) pts.push({ x: this.cursor.x, z: this.cursor.z });
    const y = this.levelY + 0.03;
    // linha de controle
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, y, p.z)));
    this.draftLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: THEME.accent, dashSize: 0.4, gapSize: 0.25, depthTest: false }));
    this.draftLine.computeLineDistances();
    this.draftLine.renderOrder = 20;
    this.vp.helpers.add(this.draftLine);
    for (const p of this.draft.points) this._addHandle(this.vp.helpers, { x: p.x, y, z: p.z }, 'draft');
    if (pts.length >= 2) {
      const obj = this._draftObject(pts);
      if (obj.type === 'area' && pts.length < 3) return;
      this.preview = buildObject(obj, this.vp.ctx);
      applyVisualState(this.preview, 'ghost');
      this.vp.helpers.add(this.preview);
    }
  }

  finishDraft() {
    const d = this.draft;
    if (!d) return;
    const min = d.type === 'area' ? 3 : 2;
    this.draft = null;
    this._clearPreview();
    if (d.points.length >= min) {
      this.draft = d; // _draftObject lê o tipo do rascunho
      const obj = this._draftObject(d.points);
      this.draft = null;
      this.store.addObject(obj);
      this.setTool('select');
    }
  }

  cancelDraft() {
    this.draft = null;
    this._clearPreview();
  }

  _clearPreview() {
    if (this.preview) { this.vp.helpers.remove(this.preview); this.preview = null; }
    if (this.draftLine) { this.vp.helpers.remove(this.draftLine); this.draftLine.geometry.dispose(); this.draftLine = null; }
    for (const c of [...this.vp.helpers.children]) if (c.userData.draftHandle) this.vp.helpers.remove(c);
  }

  // ---------------------------------------------------------- colocação
  _placeObject(p) {
    const t = this.tool;
    const opt = this.options[t];
    const levelId = this.store.doc.activeLevelId;
    const count = this.store.doc.objects.filter((o) => o.type === t).length + 1;
    if (t === 'asset') {
      return makeObject('asset', { name: `${opt.label || ASSET_KINDS[opt.kind] || opt.kind} ${count}`, kind: opt.kind, customId: opt.customId || null, color: opt.color, levelId, x: p.x, z: p.z });
    }
    if (t === 'agent') {
      const role = opt.role;
      const isPlayer = role === 'player';
      return makeObject('agent', {
        name: isPlayer ? `Player ${count}` : `Inimigo ${count}`, role, mode: opt.mode, levelId, x: p.x, z: p.z,
        color: isPlayer ? '#4a6a8f' : opt.mode === 'arcade' ? '#b56b7a' : '#c0632f',
        behavior: isPlayer ? 'idle' : opt.mode === 'car' ? 'chase' : 'wander',
      });
    }
    if (t === 'connector') {
      const lv = [...this.store.doc.levels].sort((a, b) => a.elevation - b.elevation);
      const cur = this.store.activeLevel;
      const idx = lv.findIndex((l) => l.id === cur.id);
      const other = lv[idx + 1] || lv[idx - 1];
      return makeObject('connector', {
        name: `${opt.style === 'ramp' ? 'Rampa' : 'Escada'} ${count}`, style: opt.style, levelId, x: p.x, z: p.z,
        fromLevelId: cur.id, toLevelId: other ? other.id : cur.id,
      });
    }
    return null;
  }

  _place(p, keep) {
    if (this.tool === 'connector' && this.store.doc.levels.length < 2) {
      this.dispatchEvent(new CustomEvent('toast', { detail: 'Crie um segundo nível para conectar com escada/rampa.' }));
      return;
    }
    const obj = this._placeObject(p);
    if (!obj) return;
    this.store.addObject(obj);
    if (!keep) this.setTool('select');
    else this._clearPreview();
  }

  _updatePlacePreview() {
    if (!this.cursor) return;
    if (!this.preview) {
      const obj = this._placeObject({ x: 0, z: 0 });
      if (!obj) return;
      this.preview = buildObject(obj, this.vp.ctx);
      applyVisualState(this.preview, 'ghost');
      this.preview.userData.baseY = this.preview.position.y;
      this.vp.helpers.add(this.preview);
    }
    this.preview.position.x = this.cursor.x;
    this.preview.position.z = this.cursor.z;
  }

  // ---------------------------------------------------------- alças
  refreshHandles() {
    this.handles.clear();
    if (this.vp.playing) return;
    const o = this.store.get(this.store.selection);
    if (!o || !PATH_TYPES.has(o.type)) return;
    const y0 = this.vp.ctx.levelY(o.levelId);
    const y1 = o.type === 'corridor' && o.endLevelId ? this.vp.ctx.levelY(o.endLevelId) : y0;
    const n = o.points.length;
    const yAt = (i) => lerp(y0, y1, n > 1 ? smoothstep(i / (n - 1)) : 0);
    const closed = o.type === 'area' || o.closed;
    for (let i = 0; i < n; i++) {
      const p = o.points[i];
      this._addHandle(this.handles, { x: p.x, y: yAt(i) + 0.05, z: p.z }, 'point', { id: o.id, index: i });
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = o.points[i], b = o.points[(i + 1) % n];
      const y = (yAt(i) + yAt((i + 1) % n)) / 2;
      this._addHandle(this.handles, { x: (a.x + b.x) / 2, y: y + 0.05, z: (a.z + b.z) / 2 }, 'mid', { id: o.id, index: i });
    }
    // polígono de controle
    const pts = o.points.map((p, i) => new THREE.Vector3(p.x, yAt(i) + 0.06, p.z));
    if (closed && pts.length) pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: THEME.select, dashSize: 0.3, gapSize: 0.2, depthTest: false, transparent: true, opacity: 0.9 }));
    line.computeLineDistances();
    line.renderOrder = 19;
    line.raycast = () => {};
    this.handles.add(line);
  }

  _addHandle(parent, pos, kind, data = {}) {
    const isMid = kind === 'mid';
    const geo = isMid ? HANDLE_GEO.mid : HANDLE_GEO.point;
    const mat = kind === 'draft' ? HANDLE_MAT.draft : isMid ? HANDLE_MAT.mid : HANDLE_MAT.point;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos.x, pos.y, pos.z);
    m.renderOrder = 30;
    m.userData = { handle: kind, ...data, pos: { ...pos } };
    if (kind === 'draft') m.userData.draftHandle = true;
    const edge = new THREE.LineSegments(HANDLE_GEO.edges(geo), HANDLE_MAT.edge);
    edge.renderOrder = 31;
    edge.raycast = () => {};
    m.add(edge);
    parent.add(m);
    return m;
  }

  _pickHandle(ndc) {
    if (!this.handles.children.length) return null;
    const rc = this.vp.raycaster(ndc);
    const hits = rc.intersectObjects(this.handles.children.filter((c) => c.userData.handle), false);
    if (!hits.length) return null;
    // pontos têm prioridade sobre meios
    hits.sort((a, b) => (a.object.userData.handle === 'point' ? 0 : 1) - (b.object.userData.handle === 'point' ? 0 : 1));
    const u = hits[0].object.userData;
    return { kind: u.handle, id: u.id, index: u.index, pos: u.pos };
  }

  _scaleHandles() {
    const cam = this.vp.camera;
    const scaleFor = (obj) => {
      if (cam.isOrthographicCamera) return 0.55 / cam.zoom;
      return Math.max(0.15, cam.position.distanceTo(obj.position) * 0.016);
    };
    for (const c of this.handles.children) if (c.userData.handle) c.scale.setScalar(scaleFor(c));
    for (const c of this.vp.helpers.children) if (c.userData.draftHandle) c.scale.setScalar(scaleFor(c));
  }
}

const HANDLE_GEO = {
  point: new THREE.BoxGeometry(1, 1, 1),
  mid: new THREE.OctahedronGeometry(0.55, 0),
  _edges: new Map(),
  edges(g) {
    if (!this._edges.has(g)) this._edges.set(g, new THREE.EdgesGeometry(g));
    return this._edges.get(g);
  },
};
const HANDLE_MAT = {
  point: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
  mid: new THREE.MeshBasicMaterial({ color: 0xe8d9bf, depthTest: false, transparent: true }),
  draft: new THREE.MeshBasicMaterial({ color: THEME.accent, depthTest: false, transparent: true }),
  edge: new THREE.LineBasicMaterial({ color: THEME.line, depthTest: false, transparent: true }),
};
