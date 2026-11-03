// Ferramentas de edição: seleção/arraste, desenho de curvas (corredor, parede,
// área), colocação (assets, agentes, escadas) e alças de pontos de controle.
import * as THREE from 'three';
import { makeObject, ASSET_KINDS } from '../model.js';
import { buildObject, makeContext } from '../builders/index.js';
import { nodeHalf, halfAt, attachEnd, detachEnd, findAttachTarget, findAreaTarget, widthLimit, obstacleLines, nodeCollisions, hasAgents, pushCorridor, markEdited } from '../builders/corridorPath.js';
import { computeFrames, offsetPoints, samplePath, segmentArc, arcPoint, hasArcs, expandArcs, closestOnPolyline } from '../math/curve.js';
import { circlePoints, circleOf, polarSources, polarSnap, ringsOf, withArcs, refitArcs, arcToRing, attachParam, wallLines, nearestWall, onLine } from './polar.js';
import { applyVisualState, THEME } from '../render/materials.js';
import { snap, lerp, smoothstep, deepClone } from '../util.js';

const PATH_TYPES = new Set(['corridor', 'wall', 'area']);
const MOVABLE = new Set(['asset', 'agent', 'connector', 'light']);

export const TOOL_INFO = {
  select: { label: 'Selecionar', key: 'V', touch: 'Toque para selecionar · 1 dedo gira · 2 dedos movem e dão zoom', hint: 'Clique para selecionar · Shift soma · arraste para mover · Ctrl+G agrupa corredores' },
  corridor: { label: 'Corredor', key: 'C', touch: 'Toque para pôr pontos · Concluir termina', hint: 'Clique para pôr pontos · Enter ou duplo clique termina · Esc cancela' },
  wall: { label: 'Parede', key: 'W', touch: 'Toque para pôr pontos · em sala circular os pontos encaixam nos anéis', hint: 'Clique para pôr pontos ou arraste a partir de uma parede para extrudar · em sala circular encaixa nos anéis · Alt solta' },
  area: { label: 'Área', key: 'A', touch: 'Toque para desenhar o contorno · toque no primeiro ponto fecha', hint: 'Desenhe o contorno · clique no primeiro ponto ou Enter para fechar' },
  connector: { label: 'Escada/Rampa', key: 'S', touch: 'Toque para posicionar · liga este andar ao de cima', hint: 'Clique para posicionar · R gira · liga este andar ao de cima' },
  asset: { label: 'Asset', key: 'O', touch: 'Escolha o asset em Propriedades e toque na cena para colocar', hint: 'Escolha o asset no painel e clique para colocar · Shift mantém a ferramenta' },
  agent: { label: 'Agente', key: 'P', touch: 'Escolha player ou inimigo em Propriedades e toque para colocar', hint: 'Escolha player ou inimigo no painel e clique para colocar' },
  light: { label: 'Luz', key: 'L', touch: 'Toque para colocar um ponto de luz', hint: 'Clique para colocar um ponto de luz · aparece com a luz Dia, Entardecer ou Noite' },
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
      area: { smooth: 0, shape: 'free' },
      // grade polar das salas circulares: distância entre anéis e divisões da volta
      polar: { step: 2, divisions: 24 },
      asset: { kind: 'cube', color: '#e9e2d4' },
      agent: { role: 'player', mode: 'fps' },
      connector: { style: 'stairs' },
      light: { color: '#ffd9a0', intensity: 8, range: 14, y: 2.4 },
    };
    this.draft = null;
    this.drag = null;
    this.cursor = null;
    this.preview = null;
    this.handles = new THREE.Group();
    this.handles.renderOrder = 10;
    vp.helpers.add(this.handles);
    this.draftLine = null;
    this.guides = new THREE.Group(); // grade polar e linha-guia da parede
    this.guides.renderOrder = 18;
    vp.helpers.add(this.guides);
    this._guideCache = null;
    this.linkHint = new THREE.Group();
    this.linkHint.renderOrder = 40;
    vp.helpers.add(this.linkHint);
    this.linkTip = document.createElement('div');
    this.linkTip.className = 'link-tip';
    this.linkTip.hidden = true;
    vp.container.appendChild(this.linkTip);
    this._linkAt = null;
    this._down = null;
    // toque: dedos na tela, gesto de dois dedos (câmera) e toque longo
    this._touches = new Map();
    this._multi = false;
    this._press = null;
    this._lastTouchAt = 0;
    this.multiSelect = false; // "somar à seleção" no celular (equivale ao Shift)
    const mq = window.matchMedia?.('(pointer: coarse)');
    this.coarse = !!mq?.matches;
    mq?.addEventListener?.('change', (ev) => { this.coarse = ev.matches; });
    this._bind();
    store.addEventListener('selection', () => { this._railCache = null; this.refreshHandles(); });
    store.addEventListener('change', () => { this._guideCache = null; this._railCache = null; this.refreshHandles(); });
    vp.onFrame.push(() => { this._scaleHandles(); this._animateLinkHint(); });
  }

  setTool(t) {
    if (!TOOL_INFO[t]) return;
    this.cancelDraft();
    this.tool = t;
    this._clearPreview();
    this._clearLinkHint();
    this._clearGuides();
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
    dom.addEventListener('pointerdown', (e) => { if (!this._synth) this._onDown(e); });
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    window.addEventListener('pointercancel', (e) => this._onUp(e, true));
    // no celular o toque longo vira "contextmenu" e dois toques viram "dblclick":
    // o toque tem seus próprios gestos, então esses eventos são ignorados
    dom.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!this._recentTouch()) this._onContext(e); });
    dom.addEventListener('dblclick', (e) => { if (this.draft && !this._recentTouch()) { e.preventDefault(); this.finishDraft(); } });
  }

  _recentTouch() { return performance.now() - this._lastTouchAt < 1200; }

  _setControls(on) {
    if (this.vp.controls) this.vp.controls.enabled = on;
  }

  _onDown(e) {
    if (this.vp.playing) return;
    if (e.pointerType === 'touch') { this._touchDown(e); return; }
    this.vp.dom.focus();
    this._down = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
    this._pointerDown(e);
  }

  /** Clique (mouse/caneta) ou toque já confirmado: seleciona, arrasta, desenha ou coloca. */
  _pointerDown(e) {
    if (e.button !== 0) return; // direito/meio: câmera
    const ndc = this.vp.ndc(e);
    const t = this.tool;
    const touch = e.pointerType === 'touch';

    if (t === 'select') {
      const h = this._pickHandle(ndc, touch);
      if (h) {
        this._setControls(false);
        const o = this.store.get(h.id);
        if (h.kind === 'edge') {
          this.drag = { kind: 'edge', id: h.id, index: h.index, side: h.side, y: h.pos.y, both: e.shiftKey, recorded: false };
          return;
        }
        if (h.kind === 'radius') {
          this.drag = { kind: 'radius', id: h.id, y: h.pos.y, recorded: false };
          return;
        }
        if (h.kind === 'center') {
          const y = this.vp.ctx.levelY(o.levelId);
          const start = this.vp.groundPoint(ndc, y);
          if (start) this.drag = { kind: 'move', id: h.id, y, start, recorded: false, orig: deepClone(o.points) };
          return;
        }
        if (h.kind === 'mid') {
          // insere um ponto no meio do segmento e começa a arrastar
          this.store.mutate((d) => {
            const obj = d.objects.find((x) => x.id === h.id);
            const n = obj.points.length;
            const np = { x: h.pos.x, z: h.pos.z };
            const a0 = obj.points[h.index];
            if (a0.b) {
              // arco: divide ao meio, as duas metades continuam no mesmo círculo
              const half = Math.tan(Math.atan(a0.b) / 2);
              obj.points[h.index] = { ...a0, b: half };
              np.b = half;
            }
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
      // linha-guia da parede selecionada: clicar puxa uma parede nova dali
      // (Alt arrasta a parede selecionada em vez de puxar uma nova)
      const ra = e.altKey ? null : this._railAt(ndc, touch);
      if (ra) { this._extrudeFrom(ra, e); return; }
      const hit = this.vp.pickObject(ndc);
      if (hit && (e.shiftKey || e.ctrlKey || e.metaKey || (touch && this.multiSelect))) {
        this.store.select(hit.id, { add: true });
        return;
      }
      if (hit) {
        this.store.select(hit.id);
        const o = this.store.get(hit.id);
        const y = o.type === 'agent' || o.type === 'asset' || o.type === 'light' ? this.vp.ctx.levelY(o.levelId) : hit.point.y;
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
    if (t === 'area' && this.options.area.shape === 'circle') {
      // sala circular: 1º clique = centro, 2º clique (ou soltar o arraste) = raio
      if (!this.draft) {
        this.draft = { type: t, circle: true, points: [{ x: p.x, z: p.z }] };
        this._dragDraw = true;
        this._updateDraftPreview();
        this._emitDraft();
      } else this.finishDraft();
      return;
    }
    if (PATH_TYPES.has(t)) {
      if (!this.draft) { this.draft = { type: t, points: [] }; this._dragDraw = t === 'wall'; }
      const pts = this.draft.points;
      const first = pts[0];
      if (pts.length >= 3 && first && Math.hypot(first.x - p.x, first.z - p.z) < 0.6) {
        this.draft.closed = true;
        this.finishDraft();
        return;
      }
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 0.05) pts.push({ x: p.x, z: p.z, pol: p.pol, onWall: p.onWall });
      this._updateDraftPreview();
      this._emitDraft();
      return;
    }
    this._place(p, e.shiftKey);
  }

  _onMove(e) {
    if (this.vp.playing) return;
    if (e.pointerType === 'touch') { this._touchMove(e); return; }
    if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 4) this._down.moved = true;
    if (e.target !== this.vp.dom && !this.drag) return;
    const ndc = this.vp.ndc(e);
    if (this.drag) { this._doDrag(ndc, e); return; }
    if (this.tool === 'select') {
      this._clearLinkHint();
      const h = this._pickHandle(ndc);
      const ra = h || e.altKey ? null : this._railAt(ndc);
      if (ra) this._showRailHint(ra);
      this.vp.dom.style.cursor = h ? (h.kind === 'mid' ? 'copy' : h.kind === 'edge' ? 'ew-resize' : 'grab') : ra ? 'copy' : 'default';
      return;
    }
    const p = this._cursorPoint(ndc, e);
    this.cursor = p;
    this.dispatchEvent(new CustomEvent('cursor', { detail: p }));
    if (this.tool === 'corridor') this._showLinkHint(p, this._rawCursor, this.levelY, null);
    else this._clearLinkHint();
    if (this.tool === 'wall' || this.tool === 'area') this._updateGuides(p, this.levelY);
    if (PATH_TYPES.has(this.tool)) this._updateDraftPreview();
    else this._updatePlacePreview();
  }

  _onUp(e, cancelled = false) {
    if (e.pointerType === 'touch') {
      if (!this._touches.delete(e.pointerId)) return;
      this._clearPress();
      const d = this._down;
      const isTap = d?.touch && d.id === e.pointerId && !d.moved && !d.consumed && !this._multi && !cancelled && !this.drag;
      if (!this._touches.size) this._multi = false;
      if (isTap && !this.vp.playing) this._tap(e);
    }
    this._finishDrag();
    // arrastou desde o 1º ponto: a parede (ou o raio do círculo) termina onde soltou
    const dragDraw = this._dragDraw;
    this._dragDraw = false;
    if (dragDraw && e.pointerType !== 'touch' && e.button === 0) {
      const d = this.draft;
      if (d && this._down?.moved && this.cursor && !cancelled) {
        if (d.circle) this.finishDraft();
        else if (d.points.length === 1) {
          const c = this.cursor, a = d.points[0];
          if (Math.hypot(c.x - a.x, c.z - a.z) > 0.3) {
            d.points.push({ x: c.x, z: c.z, pol: c.pol, onWall: c.onWall });
            this.finishDraft({ keepTool: true });
          }
        }
      }
    }
    this._setControls(true);
    if (e.button === 0 || e.pointerType === 'touch') this._down = null;
  }

  _finishDrag() {
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
      this._clearGuides();
    }
  }

  // ---------------------------------------------------------- toque
  // Um dedo: girar a câmera (Planta: mover) e tocar para selecionar/desenhar.
  // Alças e objetos pequenos já selecionados arrastam direto; um corredor,
  // parede ou área selecionado arrasta depois de segurar o dedo. Dois dedos:
  // mover e dar zoom (pinça), sempre, mesmo no meio de um arraste.
  // Segurar numa alça: remove o nó (quadrado) ou reseta a largura (bolinha).
  _touchDown(e) {
    this._lastTouchAt = performance.now();
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._touches.size > 1) { this._beginMultiTouch(); return; }
    this._multi = false;
    this._down = { x: e.clientX, y: e.clientY, button: 0, moved: false, touch: true, id: e.pointerId };
    if (this.tool === 'select') {
      const ndc = this.vp.ndc(e);
      const h = this._pickHandle(ndc, true);
      if (h) {
        this._pointerDown(e);
        if (h.kind !== 'mid') {
          this._armPress(() => {
            if (!this.drag || this.drag.recorded) return;
            this.drag = null;
            this._down.consumed = true;
            this._contextAction(h);
            navigator.vibrate?.(12);
          }, 520);
        }
      } else if (this._railAt(ndc, true)) {
        this._pointerDown(e); // toque na linha-guia: puxa a parede e já arrasta a ponta
      } else {
        const hit = this.vp.pickObject(ndc);
        const o = hit && this.store.isSelected(hit.id) ? this.store.get(hit.id) : null;
        if (o && MOVABLE.has(o.type)) this._pointerDown(e);
        else if (o && PATH_TYPES.has(o.type)) {
          this._armPress(() => {
            const start = this.vp.groundPoint(ndc, hit.point.y);
            if (!start) return;
            this._setControls(false);
            this.drag = { kind: 'move', id: o.id, y: hit.point.y, start, recorded: false, orig: deepClone(o.points) };
            this._down.moved = true; // a partir daqui, mexer o dedo arrasta
            navigator.vibrate?.(12);
            this.dispatchEvent(new CustomEvent('toast', { detail: 'Arraste para mover' }));
          }, 420);
        }
      }
    }
    if (this._down) this._down.ctrlTracks = this.vp.controls?.enabled !== false;
  }

  _touchMove(e) {
    if (!this._touches.has(e.pointerId)) return;
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._multi) return;
    const d = this._down;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { d.moved = true; this._clearPress(); }
    if (this.drag && d.moved) this._doDrag(this.vp.ndc(e), e);
  }

  /** Toque rápido sem arrastar: seleciona, põe ponto ou coloca objeto. */
  _tap(e) {
    const ndc = this.vp.ndc(e);
    if (this.tool === 'select') {
      const hit = this.vp.pickObject(ndc);
      if (hit) this.store.select(hit.id, { add: this.multiSelect });
      else if (!this.multiSelect) this.store.select(null);
      return;
    }
    const p = this._cursorPoint(ndc, e);
    this.cursor = p;
    this.dispatchEvent(new CustomEvent('cursor', { detail: p }));
    this._pointerDown(e);
    this._setControls(true);
    this._emitDraft();
  }

  /** Segundo dedo: encerra o que o primeiro fazia e entrega os dois à câmera. */
  _beginMultiTouch() {
    this._multi = true;
    this._clearPress();
    const d = this._down;
    this._down = null;
    this._finishDrag();
    const c = this.vp.controls;
    if (!c) return;
    c.enabled = true;
    // o OrbitControls só conhece o primeiro dedo se estava ligado quando ele
    // tocou; se não estava (arraste de alça), apresenta o dedo a ele agora
    const first = d && this._touches.get(d.id);
    if (first && !d.ctrlTracks) {
      this._synth = true;
      try {
        this.vp.dom.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: d.id, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
          clientX: first.x, clientY: first.y, button: 0, buttons: 1,
        }));
      } finally { this._synth = false; }
    }
  }

  _armPress(fn, ms) {
    this._clearPress();
    this._press = setTimeout(() => { this._press = null; if (this._down && !this._down.moved && !this._multi) fn(); }, ms);
  }

  _clearPress() { if (this._press) { clearTimeout(this._press); this._press = null; } }

  _emitDraft() { this.dispatchEvent(new CustomEvent('draftchange', { detail: { points: this.draft?.points.length || 0, type: this.draft?.type } })); }

  /** Desfaz o último ponto do rascunho (Backspace ou botão no celular). */
  undoDraftPoint() {
    if (!this.draft) return;
    this.draft.points.pop();
    if (!this.draft.points.length) this.cancelDraft();
    else this._updateDraftPreview();
    this._emitDraft();
  }

  _onContext(e) {
    if (this.vp.playing) return;
    const moved = this._down?.moved;
    this._down = null;
    if (moved) return; // foi órbita
    if (this.draft) { this.finishDraft(); return; }
    if (this.tool === 'select') {
      const h = this._pickHandle(this.vp.ndc(e));
      if (h) this._contextAction(h);
    } else if (this.tool !== 'select') {
      this.setTool('select');
    }
  }

  /** Botão direito (ou toque longo) numa alça: remove o nó ou reseta a largura. */
  _contextAction(h) {
    if (h.kind === 'point') this._deletePoint(h.id, h.index);
    else if (h.kind === 'edge') {
      this.store.mutate((d) => {
        const pt = d.objects.find((x) => x.id === h.id).points[h.index];
        delete pt.wl; delete pt.wr;
      }, { ids: [h.id] });
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
    if (e.key === 'Backspace' && this.draft) { this.undoDraftPoint(); return true; }
    return false;
  }

  // ---------------------------------------------------------- snapping
  _cursorPoint(ndc, e) {
    const p = this.vp.groundPoint(ndc, this.levelY);
    if (!p) return null;
    this._rawCursor = { x: p.x, z: p.z };
    return this.snapPoint(p, e?.altKey, null, this.tool === 'corridor', null, this.draft?.type || this.tool);
  }

  /**
   * Ímãs: extremidades de caminhos, eixo de corredores existentes (para
   * ramificar um corredor a partir de outro) e grade.
   */
  snapPoint(p, noSnap, excludeId, branch = false, y = null, kind = null) {
    const out = { x: p.x, z: p.z };
    if (noSnap) return out;
    // paredes e áreas: grade polar das salas circulares e linhas de parede
    const walls = kind === 'wall' || kind === 'area';
    let g = null;
    if (walls) {
      g = this._guideData(y ?? this.levelY, excludeId);
      const ps = polarSnap(p, g.sources, this.options.polar);
      if (ps) {
        const on = g.lines.find((l) => onLine(ps, l, 0.06));
        const nw = nearestWall(p, g.lines, 0.3);
        if (!on && nw && Math.hypot(nw.x - ps.x, nw.z - ps.z) > 0.3) return { x: nw.x, z: nw.z, snapped: true, onWall: nw.line };
        return { x: ps.x, z: ps.z, snapped: true, pol: ps.pol, onWall: on || null };
      }
    }
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
    if (walls) {
      const nw = nearestWall(p, g.lines, 0.5);
      if (nw) return { x: nw.x, z: nw.z, snapped: true, onWall: nw.line };
    }
    if (branch) {
      // eixo/nó de outro corredor: a ponta vira ramificação presa a um nó
      const t = findAttachTarget(this.store.doc, this.vp.ctx, p, y ?? this.levelY, excludeId);
      if (t) return { x: t.x, z: t.z, snapped: true, branch: true, target: t };
      // borda/interior de uma área: a ponta abre porta na parede dela
      const at = findAreaTarget(this.store.doc, this.vp.ctx, p, y ?? this.levelY, excludeId);
      if (at) return { x: at.snap ? at.x : p.x, z: at.snap ? at.z : p.z, snapped: at.snap, branch: true, target: at };
    }
    const s = this.store.doc.settings;
    if (s.snap) { out.x = snap(p.x, s.gridSize / 2); out.z = snap(p.z, s.gridSize / 2); }
    return out;
  }

  /** Salas circulares e linhas de parede do nível (cache até o documento mudar). */
  _guideData(y, excludeId) {
    const key = `${y}|${excludeId || ''}`;
    if (this._guideCache?.key !== key) {
      const doc = this.store.doc, ctx = this.vp.ctx;
      this._guideCache = { key, sources: polarSources(doc, ctx, y, excludeId), lines: wallLines(doc, ctx, y, excludeId) };
    }
    return this._guideCache;
  }

  /**
   * Desenha a grade polar da sala sob o cursor (anéis, raios, anel ativo) e a
   * linha-guia da parede de onde dá para extrudar.
   */
  _updateGuides(p, y) {
    this._clearGuides();
    if (!p) return;
    const yy = y + 0.06;
    const V = (x, z) => new THREE.Vector3(x, yy, z);
    const add = (obj) => { obj.renderOrder = 18; obj.raycast = () => {}; obj.userData.ownGeometry = true; this.guides.add(obj); };
    if (p.pol) {
      const src = this._guideCache?.sources.find((s) => s.id === p.pol.sid);
      if (src) {
        const { step, divisions } = this.options.polar;
        const circle = (r) => {
          const n = Math.max(24, Math.ceil(r * 8));
          return Array.from({ length: n + 1 }, (_, k) => V(src.cx + Math.cos((k / n) * 2 * Math.PI) * r, src.cz + Math.sin((k / n) * 2 * Math.PI) * r));
        };
        const rings = ringsOf(src, step);
        const seg = [];
        for (const r of rings) {
          const c = circle(r);
          for (let k = 1; k < c.length; k++) seg.push(c[k - 1], c[k]);
        }
        const da = (2 * Math.PI) / Math.max(3, divisions);
        for (let k = 0; k < divisions; k++) {
          const a = k * da;
          seg.push(V(src.cx, src.cz), V(src.cx + Math.cos(a) * src.ring0, src.cz + Math.sin(a) * src.ring0));
        }
        add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), GUIDE_MAT.grid));
        if (p.pol.ring >= 0) add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle(p.pol.r)), GUIDE_MAT.ring));
      }
    }
    if (p.onWall) {
      const pts = p.onWall.pts.map((q) => V(q.x, q.z));
      if (p.onWall.closed && pts.length) pts.push(pts[0].clone());
      add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), GUIDE_MAT.wall));
    }
    if (p.pol || p.onWall) {
      const dot = new THREE.Mesh(LINK_GEO.core, LINK_MAT.ring);
      dot.position.set(p.x, yy + 0.01, p.z);
      dot.rotation.x = -Math.PI / 2;
      dot.renderOrder = 41;
      dot.userData.linkHandle = 0.8;
      dot.raycast = () => {};
      this.linkHint.add(dot);
    }
  }

  _clearGuides() {
    for (const c of [...this.guides.children]) {
      this.guides.remove(c);
      if (c.userData.ownGeometry) c.geometry.dispose();
    }
  }

  // ---------------------------------------------------------- linha-guia (extrudar)
  /** Linha-guia da parede selecionada (parede solta ou parede de área). */
  _rail() {
    const o = this.store.get(this.store.selection);
    if (!o || this.store.multi.size > 1 || this.vp.playing) return null;
    const H = o.type === 'wall' ? o.height : o.type === 'area' && o.walls?.enabled ? o.walls.height : null;
    if (H == null) return null;
    if (this._railCache?.id !== o.id) {
      const ctx = this.vp.ctx;
      const y = ctx.levelY(o.levelId);
      const line = wallLines({ objects: [o] }, ctx, y)[0];
      const th = o.type === 'wall' ? o.thickness : o.walls.thickness;
      this._railCache = line ? { id: o.id, o, line, y, top: y + H + 0.02, H, th } : { id: o.id, none: true };
    }
    return this._railCache.none ? null : this._railCache;
  }

  /** Quantos metros valem `px` pixels de tela perto de ndc, no plano y. */
  _worldPx(ndc, y, px) {
    const a = this.vp.groundPoint(ndc, y);
    const r = this.vp.dom.getBoundingClientRect();
    const b = this.vp.groundPoint(new THREE.Vector2(ndc.x + (2 * px) / (r.width || 1), ndc.y), y);
    return a && b ? a.distanceTo(b) : 0.5;
  }

  /**
   * Ponto da linha-guia sob o cursor: { S, tx, tz, raw, r } ou null. Numa parede
   * que segue um anel, o ponto encaixa nos raios da grade polar.
   */
  _railAt(ndc, touch = false, noSnap = false) {
    const r = this._rail();
    if (!r) return null;
    // o cursor sobre a própria parede (face ou topo); no toque, perto do topo também vale
    const group = this.vp.objects.get(r.o.id);
    const meshes = [];
    group?.traverse((m) => { if (m.isMesh && m.visible && !m.userData.floor && !m.userData.roof) meshes.push(m); });
    const ray = this.vp.raycaster(ndc);
    const h = meshes.length ? ray.intersectObjects(meshes, false)[0] : null;
    let hit = h?.point || null;
    let c = hit && closestOnPolyline(r.line.pts, hit, r.line.closed);
    if (!c || c.d > r.th / 2 + 0.2) {
      hit = this.vp.groundPoint(ndc, r.top);
      c = hit && closestOnPolyline(r.line.pts, hit, r.line.closed);
      if (!c || c.d > Math.max(r.th / 2 + 0.05, this._worldPx(ndc, r.top, touch ? 26 : 8))) return null;
    }
    // em que face está: +1 / -1 (lados) ou 0 (topo)
    const nx = -c.tz, nz = c.tx;
    const off = (hit.x - c.x) * nx + (hit.z - c.z) * nz;
    const side = hit.y < r.top - 0.06 && Math.abs(off) > r.th * 0.25 ? Math.sign(off) : 0;
    const hy = Math.max(r.y + 0.05, Math.min(r.top, hit.y));
    let S = { x: c.x, z: c.z };
    if (!noSnap) {
      const ps = polarSnap(S, polarSources(this.store.doc, this.vp.ctx, r.y), this.options.polar);
      if (ps && onLine(ps, r.line, 0.08)) S = ps;
    }
    return { S, tx: c.tx, tz: c.tz, raw: hit, r, side, hy };
  }

  _showRailHint(ra) {
    // linha percorrendo a parede: na face apontada (na altura do cursor) ou no topo
    const { r, side, hy } = ra;
    const pts = r.line.pts;
    const fr = computeFrames(pts, r.line.closed);
    const d = side * (r.th / 2 + 0.015);
    const line = offsetPoints(pts, fr, d).map((q) => new THREE.Vector3(q.x, side ? hy : r.top, q.z));
    if (r.line.closed && line.length) line.push(line[0].clone());
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), GUIDE_MAT.face);
    l.renderOrder = 40;
    l.userData.ownGeometry = true;
    l.raycast = () => {};
    this.linkHint.add(l);
    const c = closestOnPolyline(pts, ra.S, r.line.closed);
    const k = c ? Math.min(fr.length - 1, c.i) : 0;
    const at = new THREE.Vector3(ra.S.x + fr[k].nx * d, side ? hy : r.top, ra.S.z + fr[k].nz * d);
    const ring = new THREE.Mesh(LINK_GEO.core, LINK_MAT.ring);
    ring.position.copy(at);
    if (side) ring.lookAt(at.x + fr[k].nx * side, at.y, at.z + fr[k].nz * side);
    else ring.rotation.x = -Math.PI / 2;
    ring.userData.linkHandle = 1.1;
    ring.userData.pulse = true;
    ring.renderOrder = 41;
    ring.raycast = () => {};
    this.linkHint.add(ring);
    this.linkTip.textContent = 'Clique para puxar uma parede daqui';
    this.linkTip.classList.remove('join');
    this._linkAt = at.clone();
    this.linkTip.hidden = false;
    this._placeLinkTip();
  }

  /**
   * Cria uma parede saindo da linha-guia, perpendicular a ela (no anel, vira
   * radial), para o lado do cursor; sem lado claro, para dentro da sala. Já
   * começa arrastando a ponta nova.
   */
  _extrudeFrom(ra, e) {
    const { S, raw, r } = ra;
    let nx = -ra.tz, nz = ra.tx;
    let side = ra.side || (raw.x - S.x) * nx + (raw.z - S.z) * nz;
    if (!ra.side && Math.abs(side) < 0.08) {
      const pol = S.pol;
      let C = pol ? { x: pol.cx, z: pol.cz } : null;
      if (!C && r.o.type === 'area') {
        const pts = r.o.points;
        C = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, z: pts.reduce((a, p) => a + p.z, 0) / pts.length };
      }
      side = C ? (C.x - S.x) * nx + (C.z - S.z) * nz : 1;
    }
    if (side < 0) { nx = -nx; nz = -nz; }
    const L = this.options.polar.step;
    let E = { x: S.x + nx * L, z: S.z + nz * L };
    const sE = this.snapPoint(E, e.altKey, null, false, r.y, 'wall');
    if (Math.hypot(sE.x - S.x, sE.z - S.z) > 0.3) E = sE;
    const count = this.store.doc.objects.filter((o) => o.type === 'wall').length + 1;
    const obj = makeObject('wall', {
      name: `Parede ${count}`, levelId: r.o.levelId, height: this.options.wall.height,
      points: [
        { x: S.x, z: S.z, att: attachParam(r.o, S) || undefined },
        { x: E.x, z: E.z, att: this._attachFor(sE.onWall, sE) || undefined },
      ].map((q) => (q.att ? q : { x: q.x, z: q.z })),
    });
    this.store.addObject(obj);
    this._clearLinkHint();
    this._setControls(false);
    this.drag = { kind: 'point', id: obj.id, index: 1, y: r.y, recorded: true };
    if (this._down) this._down.moved = true;
  }

  /** Prendedor para um ponto encaixado numa linha de parede (só se a ponta ficar nela). */
  _attachFor(line, p, selfId = null) {
    if (!line || line.id === selfId || !onLine(p, line, 0.08)) return null;
    return attachParam(this.store.get(line.id), p);
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
      const p = this.snapPoint(hit, e.altKey, d.id, branch, d.y, cur?.type);
      if (branch) this._showLinkHint(p, hit, d.y, d.id);
      else if (cur?.type === 'wall' || cur?.type === 'area') { this._clearLinkHint(); this._updateGuides(p, d.y); }
      // nó do meio de um corredor: não entra em outro objeto (empurra corredores sem agentes)
      const guard = cur?.type === 'corridor' && !isEnd && !e.altKey;
      const ids = [d.id];
      let res = null, at = null;
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (!o?.points[d.index]) return;
        markEdited(doc, o);
        const prev = { ...o.points[d.index] };
        const place = (t) => { o.points[d.index] = { ...prev, x: lerp(prev.x, p.x, t), z: lerp(prev.z, p.z, t) }; };
        if (!guard) {
          place(1);
          if (o.type === 'wall') {
            // ponta solta sobre outra parede fica presa a ela; fora dela, solta
            const att = this._attachFor(p.onWall, p, o.id);
            const { att: _old, ...pt } = o.points[d.index];
            o.points[d.index] = att ? { ...pt, att } : pt;
          }
          if (o.type === 'wall' || o.type === 'area') {
            refitArcs(o, d.index, polarSources(doc, this.vp.ctx, d.y, o.id));
            arcToRing(o, d.index, p.pol);
          }
          return;
        }
        const ctx = this.vp.ctx;
        const ignore = new Set(nodeCollisions(doc, ctx, o, d.index).keys()); // já encostava antes
        place(1);
        res = this._pushAway(doc, o, d.index, { ignore });
        ids.push(...res.pushed);
        const obstacles = obstacleLines(doc, ctx, o);
        const bad = () => [...nodeCollisions(doc, ctx, o, d.index, { obstacles }).keys()].some((id) => !ignore.has(id));
        if (bad()) {
          let lo = 0, hi = 1;
          for (let k = 0; k < 7; k++) {
            const mid = (lo + hi) / 2;
            place(mid);
            if (bad()) hi = mid; else lo = mid;
          }
          place(lo);
          res.blocked = true;
        }
        at = o.points[d.index];
      }, { ids, record: record && !d.endName });
      if (guard) this._overlapTip(res, at, d.y);
    } else if (d.kind === 'edge') {
      // largura do corredor neste nó (quina esquerda/direita)
      const o = this.store.get(d.id);
      const P = o.points[d.index];
      const fr = computeFrames(o.points, o.closed)[d.index];
      let w = ((hit.x - P.x) * fr.nx + (hit.z - P.z) * fr.nz) * d.side;
      const st = this.store.doc.settings;
      if (st.snap && !e.altKey) w = snap(w, 0.25);
      w = Math.max(0.3, Math.min(40, w));
      // não deixa a parede entrar em outro objeto: corredores sem agentes são
      // empurrados (os nós mais próximos), o resto bloqueia (Alt atravessa)
      const both = d.both || e.shiftKey;
      const sides = both ? [1, -1] : [d.side];
      const ids = [d.id];
      let res = null;
      this.store.mutate((doc) => {
        const ob = doc.objects.find((x) => x.id === d.id);
        markEdited(doc, ob);
        const setW = (v) => {
          const q = { ...ob.points[d.index] };
          for (const sd of sides) q[sd > 0 ? 'wl' : 'wr'] = v;
          ob.points[d.index] = q;
        };
        if (e.altKey) { setW(w); return; }
        const ctx = this.vp.ctx;
        const before = { ...ob, points: ob.points.map((q) => ({ ...q })) };
        setW(w);
        res = this._pushAway(doc, ob, d.index, { sides, minHalf: (q, sd) => halfAt(before, q.ctrl, sd) });
        ids.push(...res.pushed);
        // o que sobrou (áreas, paredes, corredores com agentes) limita a largura
        ob.points[d.index] = before.points[d.index];
        const obstacles = obstacleLines(doc, ctx, ob);
        for (const side of sides) {
          const lim = widthLimit(doc, ctx, ob, d.index, side, obstacles);
          if (w > lim) { w = Math.max(Math.min(w, nodeHalf(ob, d.index, side)), lim, 0.3); res.blocked = true; }
        }
        setW(w);
      }, { ids, record });
      this._overlapTip(res, { x: P.x + fr.nx * w * d.side, z: P.z + fr.nz * w * d.side }, d.y);
    } else if (d.kind === 'radius') {
      const o = this.store.get(d.id);
      const c = circleOf(o);
      if (!c) return;
      const st = this.store.doc.settings;
      let r = Math.hypot(hit.x - c.cx, hit.z - c.cz);
      if (st.snap && !e.altKey) r = snap(r, st.gridSize / 2);
      r = Math.max(0.5, Math.min(200, r));
      this.store.mutate((doc) => {
        const ob = doc.objects.find((x) => x.id === d.id);
        markEdited(doc, ob);
        ob.points = circlePoints(c.cx, c.cz, r);
      }, { ids: [d.id], record });
      this.linkTip.textContent = `Raio ${r.toFixed(2)} m`;
      this.linkTip.classList.remove('join');
      this._linkAt = new THREE.Vector3(c.cx + r, d.y, c.cz);
      this.linkTip.hidden = false;
      this._placeLinkTip();
    } else if (d.kind === 'move') {
      const s = this.store.doc.settings;
      let dx = hit.x - d.start.x, dz = hit.z - d.start.z;
      this.store.mutate((doc) => {
        const o = doc.objects.find((x) => x.id === d.id);
        if (!o) return;
        markEdited(doc, o);
        if (PATH_TYPES.has(o.type)) {
          if (s.snap && !e.altKey) { dx = snap(dx, s.gridSize / 2); dz = snap(dz, s.gridSize / 2); }
          o.points = d.orig.map(({ att, ...p }) => ({ ...p, x: p.x + dx, z: p.z + dz })); // mover solta as pontas presas
        } else {
          const step = s.snap && !e.altKey ? s.gridSize / 2 : 0;
          o.x = snap(d.orig.x + dx, step);
          o.z = snap(d.orig.z + dz, step);
        }
      }, { ids: [d.id], record });
    }
  }

  /**
   * Resolve o corredor `o` entrando em outros perto do nó `index`: empurra os
   * corredores sem agentes; os demais ficam em `stuck` (id -> 'agents' | 'block').
   */
  _pushAway(doc, o, index, opts) {
    const ctx = this.vp.ctx;
    const pushed = new Set(), stuck = new Map(), agents = new Map();
    for (let it = 0; it < 4; it++) {
      const hits = nodeCollisions(doc, ctx, o, index, opts);
      let moved = false;
      for (const h of hits.values()) {
        if (opts.ignore?.has(h.id)) continue;
        const Y = h.type === 'corridor' ? doc.objects.find((x) => x.id === h.id) : null;
        if (!Y) { stuck.set(h.id, 'block'); continue; }
        if (!agents.has(Y.id)) agents.set(Y.id, hasAgents(doc, ctx, Y));
        if (agents.get(Y.id)) { stuck.set(h.id, 'agents'); continue; }
        if (h.inside) { stuck.set(h.id, 'block'); continue; } // eixo já dentro: empurrar não resolve
        if (pushCorridor(doc, ctx, Y, h, h.overflow + 0.05)) { pushed.add(Y.id); moved = true; } else stuck.set(h.id, 'block');
      }
      if (!moved) break;
    }
    return { pushed: [...pushed], stuck, blocked: false };
  }

  /** Dica perto do cursor: empurrou / encostou / tem agentes. */
  _overlapTip(res, at, y) {
    if (!res || !at || (!res.blocked && !res.pushed.length)) { this._clearLinkHint(); return; }
    const name = (id) => this.store.get(id)?.name || 'corredor';
    const withAgents = [...res.stuck].find(([, why]) => why === 'agents');
    let text;
    if (res.blocked && withAgents) text = `${name(withAgents[0])} tem agentes: só encosta · Alt atravessa`;
    else if (res.blocked) text = 'Encostou em outro objeto · Alt atravessa';
    else text = `Empurrando ${res.pushed.map(name).join(', ')} · Alt atravessa`;
    this.linkTip.textContent = text;
    this.linkTip.classList.add('join');
    this._linkAt = new THREE.Vector3(at.x, y, at.z);
    this.linkTip.hidden = false;
    this._placeLinkTip();
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
    if (this.draft?.circle) {
      const c = points[0], r = this._draftRadius();
      props.points = circlePoints(c.x, c.z, r);
      props.shape = 'circle';
      props.smooth = 0;
    } else if (t === 'wall' || t === 'area') {
      props.points = withArcs(points, t === 'area' || !!this.draft?.closed);
      if (t === 'wall') points.forEach((q, i) => { const att = this._attachFor(q.onWall, q); if (att) props.points[i].att = att; });
    } else props.points = points.map(({ pol, ...q }) => q);
    if (t === 'corridor') {
      Object.assign(props, { width: opt.width, endLevelId: opt.endLevelId || null, rampStyle: opt.rampStyle });
      if (opt.deco && opt.deco !== 'none') props.deco = { type: opt.deco, side: 'both', density: 0.4, color: opt.deco === 'rocks' ? '#b9a88a' : opt.deco === 'sidewalk' ? '#d8cbb3' : '#9bb57a', inset: 0.7, seed: Math.floor(Math.random() * 999) };
    }
    if (t === 'wall') props.height = opt.height;
    if (this.draft?.closed && t !== 'area') props.closed = true;
    const count = this.store.doc.objects.filter((o) => o.type === t).length + 1;
    props.name = `${props.shape === 'circle' ? 'Sala circular' : TOOL_INFO[t].label} ${count}`;
    return makeObject(t, props);
  }

  /** Raio do círculo em desenho: do centro até o cursor (com ímã). */
  _draftRadius() {
    const c = this.draft.points[0], q = this.cursor;
    let r = q ? Math.hypot(q.x - c.x, q.z - c.z) : 0;
    const st = this.store.doc.settings;
    if (st.snap) r = snap(r, st.gridSize / 2);
    return Math.max(0.5, r);
  }

  _updateDraftPreview() {
    this._clearPreview();
    if (!this.draft) return;
    const pts = [...this.draft.points];
    if (this.cursor) pts.push({ x: this.cursor.x, z: this.cursor.z, pol: this.cursor.pol });
    const y = this.levelY + 0.03;
    // linha de controle (com os arcos que a grade polar vai criar)
    let line = pts;
    if (this.draft.circle) {
      const c = pts[0];
      line = [c, ...samplePath(circlePoints(c.x, c.z, this._draftRadius()), { closed: true, spacing: 0.5 })];
    } else if (this.draft.type === 'wall' || this.draft.type === 'area') {
      const arcs = withArcs(pts);
      if (hasArcs(arcs)) line = expandArcs(arcs);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(line.map((p) => new THREE.Vector3(p.x, y, p.z)));
    this.draftLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: THEME.accent, dashSize: 0.4, gapSize: 0.25, depthTest: false }));
    this.draftLine.computeLineDistances();
    this.draftLine.renderOrder = 20;
    this.vp.helpers.add(this.draftLine);
    for (const p of this.draft.points) this._addHandle(this.vp.helpers, { x: p.x, y, z: p.z }, 'draft');
    if (pts.length >= 2) {
      const obj = this._draftObject(pts);
      if (obj.type === 'area' && pts.length < 3 && !this.draft.circle) return;
      this.preview = buildObject(obj, this.vp.ctx);
      applyVisualState(this.preview, 'ghost');
      this.vp.helpers.add(this.preview);
    }
  }

  finishDraft({ keepTool = false } = {}) {
    const d = this.draft;
    if (!d) return;
    if (d.circle && this.cursor) d.points = [d.points[0], { x: this.cursor.x, z: this.cursor.z }];
    const min = d.circle ? 2 : d.type === 'area' ? 3 : 2;
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
      if (keepTool) { this._clearGuides(); this._clearLinkHint(); } else this.setTool('select');
    }
    this._emitDraft();
  }

  cancelDraft() {
    const had = !!this.draft;
    this.draft = null;
    this._clearPreview();
    this._clearLinkHint();
    if (had) this._emitDraft();
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
        if (t && t.a && t.a.id === o.id && t.node === i) return;
        const m = new THREE.Mesh(LINK_GEO.dot, q.jid ? LINK_MAT.dotJoint : LINK_MAT.dot);
        m.position.set(q.x, oy + 0.07, q.z);
        m.rotation.x = -Math.PI / 2;
        m.userData.linkHandle = 0.7;
        m.renderOrder = 40;
        this.linkHint.add(m);
      });
    }
    if (!t) { this._linkAt = null; this.linkTip.hidden = true; return; }
    if (t.area) {
      // porta na parede da área: anel na borda
      const ring = new THREE.Mesh(LINK_GEO.ring, LINK_MAT.ring);
      ring.position.set(t.bx, yy, t.bz);
      ring.rotation.x = -Math.PI / 2;
      ring.userData.linkHandle = 1.6;
      ring.userData.pulse = true;
      ring.renderOrder = 41;
      this.linkHint.add(ring);
      this.linkTip.textContent = `Porta na área ${t.area.name || ''}`.trim();
      this.linkTip.classList.remove('join');
      this._linkAt = new THREE.Vector3(t.bx, yy, t.bz);
      this.linkTip.hidden = false;
      this._placeLinkTip();
      return;
    }
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
    if (t === 'light') {
      return makeObject('light', { name: `Luz ${count}`, levelId, x: p.x, z: p.z, color: opt.color, intensity: opt.intensity, range: opt.range, y: opt.y });
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
    const rail = this._rail();
    if (rail) {
      const pts = rail.line.pts.map((q) => new THREE.Vector3(q.x, rail.top, q.z));
      if (rail.line.closed && pts.length) pts.push(pts[0].clone());
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), GUIDE_MAT.rail);
      l.computeLineDistances();
      l.renderOrder = 18;
      l.raycast = () => {};
      this.handles.add(l);
    }
    const y0 = this.vp.ctx.levelY(o.levelId);
    const y1 = o.type === 'corridor' && o.endLevelId ? this.vp.ctx.levelY(o.endLevelId) : y0;
    const n = o.points.length;
    const yAt = (i) => lerp(y0, y1, n > 1 ? smoothstep(i / (n - 1)) : 0);
    const closed = o.type === 'area' || o.closed;
    const circ = circleOf(o);
    if (circ) {
      // sala circular: centro move, bolinha muda o raio
      this._addHandle(this.handles, { x: circ.cx, y: y0 + 0.05, z: circ.cz }, 'center', { id: o.id });
      this._addHandle(this.handles, { x: circ.cx + circ.r, y: y0 + 0.05, z: circ.cz }, 'radius', { id: o.id });
      const ring = samplePath(o.points, { closed: true, spacing: 0.5 }).map((p) => new THREE.Vector3(p.x, y0 + 0.06, p.z));
      ring.push(ring[0].clone());
      ring.unshift(new THREE.Vector3(circ.cx, y0 + 0.06, circ.cz), new THREE.Vector3(circ.cx + circ.r, y0 + 0.06, circ.cz));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring),
        new THREE.LineDashedMaterial({ color: THEME.select, dashSize: 0.3, gapSize: 0.2, depthTest: false, transparent: true, opacity: 0.9 }));
      l.computeLineDistances();
      l.renderOrder = 19;
      l.raycast = () => {};
      this.handles.add(l);
      return;
    }
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
      const arc = segmentArc(a, b, a.b);
      const m = arc ? arcPoint(arc, 0.5) : { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      this._addHandle(this.handles, { x: m.x, y: y + 0.05, z: m.z }, 'mid', { id: o.id, index: i });
    }
    // polígono de controle (arcos seguem a curva)
    let pts;
    if (hasArcs(o.points)) {
      const dense = expandArcs(o.points, closed);
      pts = dense.map((p) => new THREE.Vector3(p.x, yAt(Math.min(n - 1, Math.round(p._c))) + 0.06, p.z));
    } else pts = o.points.map((p, i) => new THREE.Vector3(p.x, yAt(i) + 0.06, p.z));
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
    const round = kind === 'edge' || kind === 'radius';
    const geo = isMid ? HANDLE_GEO.mid : round ? HANDLE_GEO.edge : HANDLE_GEO.point;
    const mat = kind === 'draft' ? HANDLE_MAT.draft : isMid ? HANDLE_MAT.mid : round ? HANDLE_MAT.edgeHandle : kind === 'center' ? HANDLE_MAT.draft : HANDLE_MAT.point;
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

  _pickHandle(ndc, touch = false) {
    if (!this.handles.children.length) return null;
    const list = this.handles.children.filter((c) => c.userData.handle);
    const rc = this.vp.raycaster(ndc);
    const hits = rc.intersectObjects(list, false);
    // pontos têm prioridade sobre meios
    const rank = { point: 0, radius: 0, center: 1, edge: 1, mid: 2 };
    let obj = null;
    if (hits.length) {
      hits.sort((a, b) => (rank[a.object.userData.handle] ?? 3) - (rank[b.object.userData.handle] ?? 3));
      obj = hits[0].object;
    } else if (touch) {
      // dedo é impreciso: a alça mais perto na tela, num raio de ~30 px
      const r = this.vp.dom.getBoundingClientRect();
      const v = new THREE.Vector3();
      let best = 30;
      for (const c of list) {
        v.copy(c.position).project(this.vp.camera);
        if (v.z > 1) continue;
        const dist = Math.hypot(((v.x - ndc.x) * r.width) / 2, ((v.y - ndc.y) * r.height) / 2) + (rank[c.userData.handle] ?? 3) * 4;
        if (dist < best) { best = dist; obj = c; }
      }
    }
    if (!obj) return null;
    const u = obj.userData;
    return { kind: u.handle, id: u.id, index: u.index, side: u.side, pos: u.pos };
  }

  _scaleHandles() {
    const cam = this.vp.camera;
    const k = this.coarse ? 1.4 : 1; // alças maiores para o dedo
    const scaleFor = (obj) => {
      if (cam.isOrthographicCamera) return (0.55 * k) / cam.zoom;
      return Math.max(0.15, cam.position.distanceTo(obj.position) * 0.016 * k);
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

const GUIDE_MAT = {
  grid: new THREE.LineBasicMaterial({ color: THEME.line, depthTest: false, transparent: true, opacity: 0.22 }),
  ring: new THREE.LineBasicMaterial({ color: THEME.accent, depthTest: false, transparent: true, opacity: 0.85 }),
  wall: new THREE.LineBasicMaterial({ color: THEME.select, depthTest: false, transparent: true, opacity: 0.95 }),
  face: new THREE.LineBasicMaterial({ color: THEME.accent, depthTest: true, transparent: true, opacity: 0.95, linewidth: 2 }),
  rail: new THREE.LineDashedMaterial({ color: THEME.accent, dashSize: 0.5, gapSize: 0.25, depthTest: false, transparent: true, opacity: 0.95 }),
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
