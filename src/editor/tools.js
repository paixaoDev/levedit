// Ferramentas de edição: seleção/arraste, desenho de curvas (corredor, parede,
// área), colocação (assets, agentes, escadas) e alças de pontos de controle.
import * as THREE from 'three';
import { makeObject, ASSET_KINDS } from '../model.js';
import { buildObject, makeContext } from '../builders/index.js';
import { nodeHalf, attachEnd, detachEnd, findAttachTarget, widthLimit, obstacleLines } from '../builders/corridorPath.js';
import { computeFrames } from '../math/curve.js';
import { applyVisualState, THEME } from '../render/materials.js';
import { snap, lerp, smoothstep, deepClone } from '../util.js';

const PATH_TYPES = new Set(['corridor', 'wall', 'area']);
const MOVABLE = new Set(['asset', 'agent', 'connector']);

export const TOOL_INFO = {
  select: { label: 'Selecionar', key: 'V', hint: 'Clique seleciona (Shift soma) · arraste move · quadrados = nós, losangos = novo nó, bolinhas = largura do nó (Shift: os dois lados) · Ctrl+G agrupa' },
  corridor: { label: 'Corredor', key: 'C', hint: 'Clique para adicionar pontos (comece sobre outro corredor para ramificar com porta) · Enter/duplo clique finaliza · Backspace desfaz · Esc cancela' },
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
    this.linkHint = new THREE.Group();
    this.linkHint.renderOrder = 40;
    vp.helpers.add(this.linkHint);
    this.linkTip = document.createElement('div');
    this.linkTip.className = 'link-tip';
    this.linkTip.hidden = true;
    vp.container.appendChild(this.linkTip);
    this._linkAt = null;
    this._down = null;
    this._bind();
    store.addEventListener('selection', () => this.refreshHandles());
    store.addEventListener('change', () => this.refreshHandles());
    vp.onFrame.push(() => { this._scaleHandles(); this._animateLinkHint(); });
  }

  setTool(t) {
    if (!TOOL_INFO[t]) return;
    this.cancelDraft();
    this.tool = t;
    this._clearPreview();
    this._clearLinkHint();
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
        if (h.kind === 'edge') {
          this.drag = { kind: 'edge', id: h.id, index: h.index, side: h.side, y: h.pos.y, both: e.shiftKey, recorded: false };
          return;
        }
        if (h.kind === 'mid') {
          // insere um ponto no meio do segmento e começa a arrastar
          this.store.mutate((d) => {
            const obj = d.objects.find((x) => x.id === h.id);
            const n = obj.points.length;
            const np = { x: h.pos.x, z: h.pos.z };
            if (obj.type === 'corridor') {
              const j = (h.index + 1) % n;
              const a = obj.points[h.index], b = obj.points[j];
              if (a.wl || b.wl) np.wl = (nodeHalf(obj, h.index, 1) + nodeHalf(obj, j, 1)) / 2;
              if (a.wr || b.wr) np.wr = (nodeHalf(obj, h.index, -1) + nodeHalf(obj, j, -1)) / 2;
            }
            obj.points.splice(h.index + 1, 0, np);
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
      if (hit && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        this.store.select(hit.id, { add: true });
        return;
      }
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
      this._clearLinkHint();
      const h = this._pickHandle(ndc);
      this.vp.dom.style.cursor = h ? (h.kind === 'mid' ? 'copy' : h.kind === 'edge' ? 'ew-resize' : 'grab') : 'default';
      return;
    }
    const p = this._cursorPoint(ndc, e);
    this.cursor = p;
    this.dispatchEvent(new CustomEvent('cursor', { detail: p }));
    if (this.tool === 'corridor') this._showLinkHint(p, this._rawCursor, this.levelY, null);
    else this._clearLinkHint();
    if (PATH_TYPES.has(this.tool)) this._updateDraftPreview();
    else this._updatePlacePreview();
  }

  _onUp(e) {
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      // soltou a ponta de um corredor sobre outro: vira ramificação (nó compartilhado)
      if (d.kind === 'point' && d.recorded && d.endName) {
        this.store.mutate((doc) => {
          const b = doc.objects.find((x) => x.id === d.id);
          if (b) attachEnd(doc, makeContext(doc), b, d.endName);
        }, { ids: [d.id], record: false });
      }
      this.store.emit({ ids: [], structure: true }); // atualiza painéis
      this._clearLinkHint();
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
      else if (h && h.kind === 'edge') {
        this.store.mutate((d) => {
          const pt = d.objects.find((x) => x.id === h.id).points[h.index];
          delete pt.wl; delete pt.wr;
        }, { ids: [h.id] });
      }
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
    this._rawCursor = { x: p.x, z: p.z };
    return this.snapPoint(p, e?.altKey, null, this.tool === 'corridor');
  }

  /**
   * Ímãs: extremidades de caminhos, eixo de corredores existentes (para
   * ramificar um corredor a partir de outro) e grade.
   */
  snapPoint(p, noSnap, excludeId, branch = false, y = null) {
    const out = { x: p.x, z: p.z };
    if (noSnap) return out;
    // ímã nas extremidades de outros caminhos (para emendar corredores)
    let best = null, bestD = 0.9;
    for (const o of this.store.doc.objects) {
      if (!PATH_TYPES.has(o.type) || o.id === excludeId || !o.points.length) continue;
      if (branch && o.type === 'corridor') continue; // tratado abaixo (ligação a nó)
      for (const q of [o.points[0], o.points[o.points.length - 1]]) {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (best) return { x: best.x, z: best.z, snapped: true };
    if (branch) {
      // eixo/nó de outro corredor: a ponta vira ramificação presa a um nó
      const t = findAttachTarget(this.store.doc, this.vp.ctx, p, y ?? this.levelY, excludeId);
      if (t) return { x: t.x, z: t.z, snapped: true, branch: true, target: t };
    }
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
      const cur = this.store.get(d.id);
      const isEnd = cur && !cur.closed && (d.index === 0 || d.index === cur.points.length - 1);
      if (record && isEnd && cur.type === 'corridor') {
        d.endName = d.index === 0 ? 'start' : 'end';
        this.store.mutate((doc) => detachEnd(doc.objects.find((x) => x.id === d.id), d.endName), { ids: [d.id], record: true });
      }
      const branch = cur?.type === 'corridor' && isEnd;
      const p = this.snapPoint(hit, e.altKey, d.id, branch, d.y);
      if (branch) this._showLinkHint(p, hit, d.y, d.id);
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (o?.points[d.index]) o.points[d.index] = { ...o.points[d.index], x: p.x, z: p.z };
      }, { ids: [d.id], record: record && !d.endName });
    } else if (d.kind === 'edge') {
      // largura do corredor neste nó (quina esquerda/direita)
      const o = this.store.get(d.id);
      const P = o.points[d.index];
      const fr = computeFrames(o.points, o.closed)[d.index];
      let w = ((hit.x - P.x) * fr.nx + (hit.z - P.z) * fr.nz) * d.side;
      const st = this.store.doc.settings;
      if (st.snap && !e.altKey) w = snap(w, 0.25);
      w = Math.max(0.3, Math.min(40, w));
      // não deixa a parede entrar em outro corredor/parede/área (Alt atravessa)
      const both = d.both || e.shiftKey;
      let blocked = false;
      if (!e.altKey) {
        if (!d.obstacles) d.obstacles = obstacleLines(this.store.doc, this.vp.ctx, o);
        for (const side of both ? [1, -1] : [d.side]) {
          const lim = widthLimit(this.store.doc, this.vp.ctx, o, d.index, side, d.obstacles);
          if (w > lim) { w = Math.max(Math.min(w, nodeHalf(o, d.index, side)), lim, 0.3); blocked = true; }
        }
      }
      this.store.mutate((doc) => {
        const pt = doc.objects.find((x) => x.id === d.id).points[d.index];
        if (both) { pt.wl = w; pt.wr = w; } else pt[d.side > 0 ? 'wl' : 'wr'] = w;
      }, { ids: [d.id], record });
      if (blocked) {
        const q = { x: P.x + fr.nx * w * d.side, z: P.z + fr.nz * w * d.side };
        this.linkTip.textContent = 'Encostou em outro objeto · Alt atravessa';
        this.linkTip.classList.add('join');
        this._linkAt = new THREE.Vector3(q.x, d.y, q.z);
        this.linkTip.hidden = false;
        this._placeLinkTip();
      } else this._clearLinkHint();
    } else if (d.kind === 'move') {
      const s = this.store.doc.settings;
      let dx = hit.x - d.start.x, dz = hit.z - d.start.z;
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (!o) return;
        if (PATH_TYPES.has(o.type)) {
          if (s.snap && !e.altKey) { dx = snap(dx, s.gridSize / 2); dz = snap(dz, s.gridSize / 2); }
          o.points = d.orig.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));
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
      if (obj.type === 'corridor') {
        this.store.mutate((doc) => {
          const b = doc.objects.find((x) => x.id === obj.id);
          const ctx = makeContext(doc);
          attachEnd(doc, ctx, b, 'start');
          attachEnd(doc, makeContext(doc), b, 'end');
        }, { ids: [obj.id], record: false, structure: true });
      }
      this.setTool('select');
    }
  }

  cancelDraft() {
    this.draft = null;
    this._clearPreview();
    this._clearLinkHint();
  }

  // ---------------------------------------------------------- indicador de conexão
  /**
   * Mostra onde a ponta vai se conectar: anel pulsante no nó alvo (existente ou
   * novo), linha do cursor até ele, nós conectáveis por perto e um rótulo.
   */
  _showLinkHint(p, raw, y, excludeId) {
    this._clearLinkHint();
    if (!p) return;
    const doc = this.store.doc;
    const t = p.target;
    const yy = (t?.y ?? y) + 0.08;
    const near = raw || p;
    // nós conectáveis dos corredores próximos (mesmo nível)
    for (const o of doc.objects) {
      if (o.type !== 'corridor' || o.id === excludeId || o.points.length < 2) continue;
      const oy = this.vp.ctx.levelY(o.levelId);
      if (Math.abs(oy - y) > 1 && Math.abs(this.vp.ctx.levelY(o.endLevelId || o.levelId) - y) > 1) continue;
      o.points.forEach((q, i) => {
        if (Math.hypot(q.x - near.x, q.z - near.z) > 10) return;
        if (t && t.a.id === o.id && t.node === i) return;
        const m = new THREE.Mesh(LINK_GEO.dot, q.jid ? LINK_MAT.dotJoint : LINK_MAT.dot);
        m.position.set(q.x, oy + 0.07, q.z);
        m.rotation.x = -Math.PI / 2;
        m.userData.linkHandle = 0.7;
        m.renderOrder = 40;
        this.linkHint.add(m);
      });
    }
    if (!t) { this._linkAt = null; this.linkTip.hidden = true; return; }
    const mat = t.continuation ? LINK_MAT.ringJoin : LINK_MAT.ring;
    const ring = new THREE.Mesh(LINK_GEO.ring, mat);
    ring.position.set(t.x, yy, t.z);
    ring.rotation.x = -Math.PI / 2;
    ring.userData.linkHandle = 1.6;
    ring.userData.pulse = true;
    ring.renderOrder = 41;
    this.linkHint.add(ring);
    const core = new THREE.Mesh(LINK_GEO.core, mat);
    core.position.copy(ring.position);
    core.rotation.x = -Math.PI / 2;
    core.userData.linkHandle = 1;
    core.renderOrder = 41;
    this.linkHint.add(core);
    if (raw && Math.hypot(raw.x - t.x, raw.z - t.z) > 0.05) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(raw.x, yy, raw.z), new THREE.Vector3(t.x, yy, t.z)]);
      const l = new THREE.Line(g, LINK_MAT.line);
      l.computeLineDistances();
      l.renderOrder = 40;
      l.userData.ownGeometry = true;
      this.linkHint.add(l);
    }
    const name = t.a.name || 'corredor';
    this.linkTip.textContent = t.continuation ? `Emendar com ${name}`
      : t.node >= 0 ? `Conectar ao nó de ${name}` : `Novo nó em ${name}`;
    this.linkTip.classList.toggle('join', !!t.continuation);
    this._linkAt = new THREE.Vector3(t.x, yy, t.z);
    this.linkTip.hidden = false;
    this._placeLinkTip();
  }

  _clearLinkHint() {
    for (const c of [...this.linkHint.children]) {
      this.linkHint.remove(c);
      if (c.userData.ownGeometry) c.geometry.dispose();
    }
    this._linkAt = null;
    if (this.linkTip) this.linkTip.hidden = true;
  }

  _placeLinkTip() {
    if (!this._linkAt) return;
    const v = this._linkAt.clone().project(this.vp.camera);
    const w = this.vp.container.clientWidth, h = this.vp.container.clientHeight;
    this.linkTip.style.left = `${((v.x + 1) / 2) * w}px`;
    this.linkTip.style.top = `${((1 - v.y) / 2) * h}px`;
  }

  _animateLinkHint() {
    if (!this.linkHint.children.length) return;
    const k = 1 + 0.18 * Math.sin(performance.now() / 160);
    for (const c of this.linkHint.children) if (c.userData.pulse) c.scale.multiplyScalar(k);
    this._placeLinkTip();
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
      const h = this._addHandle(this.handles, { x: p.x, y: yAt(i) + 0.05, z: p.z }, 'point', { id: o.id, index: i });
      if (p.jid) h.material = HANDLE_MAT.draft; // nó de junção (ramificação presa aqui)
    }
    if (o.type === 'corridor' && n >= 2) {
      // alças de largura: quina esquerda e direita de cada nó
      const fr = computeFrames(o.points, closed);
      const seg = [];
      for (let i = 0; i < n; i++) {
        const p = o.points[i], y = yAt(i) + 0.05;
        const ends = [];
        for (const side of [1, -1]) {
          const w = nodeHalf(o, i, side) * side;
          const q = { x: p.x + fr[i].nx * w, y, z: p.z + fr[i].nz * w };
          this._addHandle(this.handles, q, 'edge', { id: o.id, index: i, side });
          ends.push(new THREE.Vector3(q.x, y + 0.01, q.z));
        }
        seg.push(ends[0], ends[1]);
      }
      const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg),
        new THREE.LineBasicMaterial({ color: THEME.select, depthTest: false, transparent: true, opacity: 0.7 }));
      ls.renderOrder = 19;
      ls.raycast = () => {};
      this.handles.add(ls);
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
    const geo = isMid ? HANDLE_GEO.mid : kind === 'edge' ? HANDLE_GEO.edge : HANDLE_GEO.point;
    const mat = kind === 'draft' ? HANDLE_MAT.draft : isMid ? HANDLE_MAT.mid : kind === 'edge' ? HANDLE_MAT.edgeHandle : HANDLE_MAT.point;
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
    const rank = { point: 0, edge: 1, mid: 2 };
    hits.sort((a, b) => (rank[a.object.userData.handle] ?? 3) - (rank[b.object.userData.handle] ?? 3));
    const u = hits[0].object.userData;
    return { kind: u.handle, id: u.id, index: u.index, side: u.side, pos: u.pos };
  }

  _scaleHandles() {
    const cam = this.vp.camera;
    const scaleFor = (obj) => {
      if (cam.isOrthographicCamera) return 0.55 / cam.zoom;
      return Math.max(0.15, cam.position.distanceTo(obj.position) * 0.016);
    };
    for (const c of this.handles.children) if (c.userData.handle) c.scale.setScalar(scaleFor(c));
    for (const c of this.vp.helpers.children) if (c.userData.draftHandle) c.scale.setScalar(scaleFor(c));
    for (const c of this.linkHint.children) if (c.userData.linkHandle) c.scale.setScalar(scaleFor(c) * c.userData.linkHandle);
  }
}

const HANDLE_GEO = {
  point: new THREE.BoxGeometry(1, 1, 1),
  mid: new THREE.OctahedronGeometry(0.55, 0),
  edge: new THREE.SphereGeometry(0.42, 12, 8),
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
  edgeHandle: new THREE.MeshBasicMaterial({ color: THEME.select, depthTest: false, transparent: true }),
  edge: new THREE.LineBasicMaterial({ color: THEME.line, depthTest: false, transparent: true }),
};

const LINK_GEO = {
  ring: new THREE.RingGeometry(0.62, 0.8, 32),
  core: new THREE.CircleGeometry(0.3, 20),
  dot: new THREE.RingGeometry(0.3, 0.46, 20),
};
const LINK_MAT = {
  ring: new THREE.MeshBasicMaterial({ color: THEME.accent, depthTest: false, transparent: true, side: THREE.DoubleSide }),
  ringJoin: new THREE.MeshBasicMaterial({ color: THEME.select, depthTest: false, transparent: true, side: THREE.DoubleSide }),
  dot: new THREE.MeshBasicMaterial({ color: THEME.line, depthTest: false, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  dotJoint: new THREE.MeshBasicMaterial({ color: THEME.accent, depthTest: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
  line: new THREE.LineDashedMaterial({ color: THEME.accent, dashSize: 0.25, gapSize: 0.18, depthTest: false, transparent: true }),
};
