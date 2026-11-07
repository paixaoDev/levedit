// Viewport 3D: renderer, câmeras (perspectiva e planta/topo), grid CAD,
// sincronização documento → cena e utilidades de picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { THEME, STIPPLE, applyVisualState, setRoofView } from '../render/materials.js';
import { LightRig, installRoofShadowPass } from '../render/lighting.js';
import { buildObject, makeContext } from '../builders/index.js';
import { objectLevelIds } from '../levels.js';

export class Viewport {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // sombras sempre habilitadas no renderer; cada luz liga/desliga a sua
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    STIPPLE.value = this.renderer.getPixelRatio();
    container.appendChild(this.renderer.domElement);
    this.dom = this.renderer.domElement;
    this.dom.tabIndex = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEME.background);
    this.scene.fog = new THREE.Fog(THEME.background, 140, 320);

    this.lights = new LightRig(this.scene);
    this.roofs = [];
    installRoofShadowPass(this.renderer, () => this.roofs);

    this.root = new THREE.Group();
    this.root.name = 'level';
    this.helpers = new THREE.Group();
    this.helpers.name = 'helpers';
    this.gridGroup = new THREE.Group();
    this.scene.add(this.root, this.gridGroup, this.helpers);

    this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.persp.position.set(28, 34, 42);
    this.ortho = new THREE.OrthographicCamera(-30, 30, 30, -30, -500, 1000);
    this.ortho.position.set(0, 200, 0.001);
    this.ortho.zoom = 1;
    this.camera = this.persp;
    this.view = '3d';

    this.objects = new Map(); // id -> Object3D
    this.ctx = makeContext(store.doc);
    this.overrideCamera = null; // usado pelo modo jogo
    this.onFrame = [];
    this._buildGrid();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Cria controles depois que os listeners das ferramentas forem registrados. */
  initControls() {
    const mk = (cam) => {
      const c = new OrbitControls(cam, this.dom);
      c.enableDamping = true;
      c.dampingFactor = 0.12;
      c.screenSpacePanning = false;
      c.maxPolarAngle = Math.PI * 0.495;
      c.zoomToCursor = true;
      return c;
    };
    this.controlsPersp = mk(this.persp);
    this.controlsPersp.target.set(4, 2, 10);
    this.controlsPersp.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controlsOrtho = mk(this.ortho);
    this.controlsOrtho.enableRotate = false;
    this.controlsOrtho.screenSpacePanning = true;
    this.controlsOrtho.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // toque: um dedo gira (Planta: move), dois dedos movem e dão zoom
    this.controlsPersp.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controlsOrtho.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controlsOrtho.target.set(0, 0, 0);
    this.controlsOrtho.enabled = false;
    this.controls = this.controlsPersp;
    this.controlsPersp.update();
  }

  setView(view) {
    if (view === this.view) return;
    const prevTarget = this.controls.target.clone();
    this.view = view;
    if (view === 'top') {
      this.camera = this.ortho;
      this.controls = this.controlsOrtho;
      this.controlsPersp.enabled = false;
      this.controlsOrtho.enabled = true;
      this.ortho.position.set(prevTarget.x, prevTarget.y + 200, prevTarget.z + 0.001);
      this.controlsOrtho.target.copy(prevTarget);
      const dist = this.persp.position.distanceTo(prevTarget);
      this.ortho.zoom = THREE.MathUtils.clamp(60 / dist, 0.1, 10);
      this.ortho.updateProjectionMatrix();
    } else {
      this.camera = this.persp;
      this.controls = this.controlsPersp;
      this.controlsOrtho.enabled = false;
      this.controlsPersp.enabled = true;
      this.controlsPersp.target.copy(prevTarget);
    }
    this.controls.update();
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    STIPPLE.value = this.renderer.getPixelRatio();
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const s = 30;
    this.ortho.left = (-s * w) / h;
    this.ortho.right = (s * w) / h;
    this.ortho.top = s;
    this.ortho.bottom = -s;
    this.ortho.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ grid
  _buildGrid() {
    this.gridGroup.clear();
    const step = this.store.doc.settings.gridSize || 1;
    const extent = 120;
    const n = Math.floor(extent / step);
    const minor = [], major = [];
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      const arr = Math.abs(Math.round(v / step)) % 5 === 0 ? major : minor;
      arr.push(-extent, 0, v, extent, 0, v, v, 0, -extent, v, 0, extent);
    }
    const mk = (arr, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const l = new THREE.LineSegments(g, m);
      l.raycast = () => {};
      return l;
    };
    this.gridGroup.add(mk(minor, THEME.gridMinor, 0.9), mk(major, THEME.gridMajor, 0.7));
    const axes = [];
    axes.push(-extent, 0, 0, extent, 0, 0, 0, 0, -extent, 0, 0, extent);
    this.gridGroup.add(mk(axes, THEME.line, 0.55));
    this._gridStep = step;
    this.updateGrid();
  }

  updateGrid() {
    if ((this.store.doc.settings.gridSize || 1) !== this._gridStep) return this._buildGrid();
    this.gridGroup.position.y = (this.store.activeLevel?.elevation ?? 0) + 0.005;
  }

  // ------------------------------------------------------------ sync
  sync(detail = { all: true }) {
    this.ctx = makeContext(this.store.doc);
    const doc = this.store.doc;
    if (detail.all) {
      for (const obj of this.objects.values()) this._dispose(obj);
      this.objects.clear();
      this.root.clear();
      for (const o of doc.objects) this._add(o);
    } else if (detail.ids) {
      // junções: mudar um corredor pode abrir/fechar portas nos outros
      const ids = new Set(detail.ids);
      // corredores e áreas abrem portas uns nos outros: mudou um, reconstrói todos
      const linked = (t) => t === 'corridor' || t === 'area';
      const touchesCorridor = [...ids].some((id) => linked(this.store.get(id)?.type) || (this.objects.get(id) && !this.store.get(id)));
      if (touchesCorridor) for (const o of doc.objects) if (linked(o.type)) ids.add(o.id);
      for (const id of ids) {
        const old = this.objects.get(id);
        if (old) { this.root.remove(old); this._dispose(old); this.objects.delete(id); }
        const o = this.store.get(id);
        if (o) this._add(o);
      }
    }
    this.updateGrid();
    this.roofs = [];
    this.root.traverse((m) => { if (m.userData.roof) this.roofs.push(m); });
    this.applyLighting();
    this.updateVisualStates();
  }

  /** Preset de luz, exibição dos tetos e enquadramento das sombras. */
  applyLighting() {
    const L = this.store.doc.settings.lighting || {};
    this.lights.apply(L);
    const box = new THREE.Box3();
    for (const g of this.objects.values()) if (g.visible !== false) box.expandByObject(g);
    this.lights.fit(box);
    // no jogo em primeira pessoa o teto é sólido; no editor segue a escolha
    setRoofView(this.playing ? (this.playRoofView || 'solid') : (L.roofView || 'dotted'));
    const night = L.preset === 'night';
    for (const l of this.gridGroup.children) l.material.opacity = (l.userData.baseOpacity ??= l.material.opacity) * (night ? 0.35 : 1);
  }

  _add(o) {
    try {
      const g = buildObject(o, this.ctx);
      this.objects.set(o.id, g);
      this.root.add(g);
    } catch (err) {
      console.error('Falha ao construir', o, err);
    }
  }

  _dispose(obj) {
    // Geometrias compartilhadas (cache) não são descartadas.
    obj.traverse((m) => {
      if (m.isMesh && m.geometry && !m.geometry.__shared) {
        m.geometry.dispose();
        for (const c of m.children) if (c.isLineSegments && c.userData.isEdge) c.geometry.dispose();
      }
      if (m.isLine && !m.isLineSegments) { m.geometry.dispose(); m.material.dispose(); }
      if (m.userData.lightBulb) m.material.dispose();
      if (m.userData.ownMaterial) { m.material.dispose(); if (!m.geometry.__shared) m.geometry.dispose(); }
      if (m.isLight) m.dispose();
    });
  }

  updateVisualStates() {
    const doc = this.store.doc;
    const active = doc.activeLevelId;
    const mode = doc.settings.otherLevels;
    for (const [id, g] of this.objects) {
      const o = this.store.get(id);
      if (!o) continue;
      const lvl = this.store.level(o.levelId);
      const levelVisible = lvl ? lvl.visible : true;
      // corredores/escadas entre andares e assets que atravessam andares contam em todos eles
      const other = !objectLevelIds(o, doc).has(active);
      g.visible = levelVisible && !(other && mode === 'hide');
      const state = this.store.isSelected(id) ? 'selected' : other && mode === 'ghost' ? 'ghost' : 'normal';
      applyVisualState(g, state);
      const lit = this.lights.lit;
      g.traverse((m) => {
        if (m.userData.editorOnly) m.visible = !this.playing;
        if (m.userData.pointLight) m.visible = lit && g.visible;
        if (m.userData.zoneFill) m.material.opacity = state === 'selected' ? 0.26 : state === 'ghost' ? 0.05 : 0.12;
      });
    }
  }

  // ------------------------------------------------------------ picking
  ndc(ev) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  raycaster(ndc) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  /** Interseção com plano horizontal y. */
  groundPoint(ndc, y = this.store.activeLevel?.elevation ?? 0) {
    const rc = this.raycaster(ndc);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, p) ? p : null;
  }

  pickObject(ndc) {
    const rc = this.raycaster(ndc);
    const visible = [...this.objects.values()].filter((g) => g.visible);
    const hits = rc.intersectObjects(visible, true).filter((h) => h.object.visible && !h.object.isLineSegments && isVisibleChain(h.object));
    const active = this.store.doc.activeLevelId;
    // preferir objetos do nível ativo quando os outros estão "fantasma"
    const ordered = this.store.doc.settings.otherLevels === 'ghost'
      ? [...hits.filter((h) => onLevel(h.object, active)), ...hits.filter((h) => !onLevel(h.object, active))]
      : hits;
    for (const h of ordered) {
      let o = h.object;
      while (o && !o.userData.objId) o = o.parent;
      if (o) return { id: o.userData.objId, point: h.point };
    }
    return null;
  }

  // ------------------------------------------------------------ loop
  start() {
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      for (const f of this.onFrame) f(dt);
      if (!this.overrideCamera) this.controls?.update();
      this.renderer.render(this.scene, this.overrideCamera || this.camera);
    };
    loop();
  }

  /** Enquadra todo o level na câmera. */
  frameAll() {
    const box = new THREE.Box3();
    for (const g of this.objects.values()) if (g.visible) box.expandByObject(g);
    if (box.isEmpty()) box.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 2, 10));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(8, box.getSize(new THREE.Vector3()).length() * 0.5);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 0.8;
    const dir = new THREE.Vector3(0.55, 0.75, 0.9).normalize();
    this.controlsPersp.target.copy(c);
    this.persp.position.copy(c).addScaledVector(dir, dist);
    this.controlsOrtho.target.copy(c);
    this.ortho.position.set(c.x, c.y + 200, c.z + 0.001);
    const aspect = this.persp.aspect || 1;
    this.ortho.zoom = THREE.MathUtils.clamp(30 / (r * Math.min(1, aspect) * 0.9), 0.05, 10);
    this.ortho.updateProjectionMatrix();
    this.controls.update();
  }

  focus(point) {
    const delta = point.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.controls.update();
  }
}

function isVisibleChain(o) {
  while (o) { if (!o.visible) return false; o = o.parent; }
  return true;
}

function onLevel(o, levelId) {
  while (o && !o.userData.objId) o = o.parent;
  return o?.userData.levelIds ? o.userData.levelIds.has(levelId) : o?.userData.levelId === levelId;
}
