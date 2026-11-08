// Gizmo de transformação no viewport: setas para mover, anel para girar e
// cubos para escalar. Fica sempre do mesmo tamanho na tela (maior no toque) e
// desenha por cima da cena. A conta de cada arraste está em transform.js.
import * as THREE from 'three';
import { transformCaps, rootsOf, pivotOf } from './transform.js';

export const GIZMO_MODES = {
  move: { label: 'Mover', key: '1' },
  rotate: { label: 'Girar', key: '2' },
  scale: { label: 'Escalar', key: '3' },
};

const COLORS = { x: 0xc8553d, y: 0x5f9a5a, z: 0x3f74b8, all: 0x8a7a62, rot: 0xd9822b };
const HOVER = 0xf0a32c;
const PX = { mouse: 112, touch: 150 }; // comprimento do eixo na tela

const mat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false });
const HIT_MAT = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

const AXIS_DIR = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const UP = new THREE.Vector3(0, 1, 0);

export class Gizmo {
  constructor(vp, store) {
    this.vp = vp;
    this.store = store;
    this.mode = 'move'; // escolhido na barra
    this.shown = 'move'; // o que aparece (cai para Mover quando o escolhido não serve)
    this.group = new THREE.Group();
    this.group.name = 'gizmo';
    this.group.renderOrder = 50;
    this.group.visible = false;
    vp.helpers.add(this.group);
    this.parts = []; // { axis, mesh, hit, color }
    this.hover = null;
    this.active = null;
    this.coarse = false;
    this.pivot = null;
    this.ids = [];
    this.caps = null;
    this.single = null;
  }

  setMode(m) {
    if (!GIZMO_MODES[m] || m === this.mode) return;
    this.mode = m;
    if (this._key) this.refresh();
  }

  /** O modo escolhido serve para a seleção atual? */
  supports(m) {
    if (!this.caps) return false;
    return m === 'move' || (m === 'rotate' ? this.caps.rotate : !!this.caps.scale);
  }

  /** O que está selecionado e que o gizmo pode transformar (um ou vários). */
  targets() {
    const doc = this.store.doc;
    const objs = rootsOf(doc, [...this.store.multi]);
    return objs.filter((o) => transformCaps(o));
  }

  /** Reconstrói o gizmo para a seleção e o modo atuais. */
  refresh() {
    const objs = this.vp.playing ? [] : this.targets();
    if (!objs.length) { this._clear(); this.caps = null; this._key = null; return; }
    const many = objs.length > 1;
    const caps = objs.map((o) => transformCaps(o));
    // vários: só o que todos aceitam; escalar é só de um por vez
    const c = {
      move: { x: true, z: true, y: !many && caps[0].move.y },
      rotate: caps.every((k) => k.rotate),
      scale: many ? null : caps[0].scale,
      localAxes: !many && caps[0].localAxes,
    };
    this.caps = c;
    this.ids = objs.map((o) => o.id);
    this.single = many ? null : objs[0];
    const ly = this.vp.ctx.levelY;
    // girando ou escalando, o centro fica parado até soltar
    if (!this.active || this.mode === 'move') {
      const ps = objs.map((o) => pivotOf(o, this.store.doc, ly));
      this.pivot = new THREE.Vector3(
        ps.reduce((a, p) => a + p.x, 0) / ps.length,
        Math.min(...ps.map((p) => p.y)),
        ps.reduce((a, p) => a + p.z, 0) / ps.length,
      );
    }
    const top = this.vp.camera.isOrthographicCamera; // na planta o eixo Y aponta para a tela
    // o modo escolhido não serve (ex.: escalar com vários): mostra o Mover sem trocar a escolha
    const m = this.supports(this.mode) ? this.mode : 'move';
    this.shown = m;
    // mesma forma de antes: só reposiciona (o arraste chama isto a cada movimento)
    const key = JSON.stringify([m, c, top, this.coarse]);
    if (key === this._key && this.group.children.length) { this._place(); return; }
    this._clear();
    this._key = key;
    if (m === 'move') {
      this._arrow('x', 'cone');
      this._arrow('z', 'cone');
      if (c.move.y && !top) this._arrow('y', 'cone');
      this._plane();
    } else if (m === 'rotate') {
      this._ring();
    } else if (m === 'scale') {
      if (c.scale.x) this._arrow('x', 'box');
      if (c.scale.z) this._arrow('z', 'box');
      if (c.scale.y && !top) this._arrow('y', 'box');
      if (c.scale.yTop && !c.scale.y && !top) this._arrow('y', 'box'); // asset preso a um andar: estica até outro
      if (c.scale.uniform) this._center();
    }
    this._place();
  }

  _place() {
    this.group.position.copy(this.pivot);
    this.group.rotation.y = this.shown === 'scale' && this.caps.localAxes ? this._rotY() : 0;
    this.group.visible = true;
    this.update();
  }

  /** Some com o gizmo e libera as geometrias. */
  _clear() {
    this.group.traverse((k) => {
      k.geometry?.dispose();
      if (k.material && k.material !== HIT_MAT) k.material.dispose();
    });
    this.group.clear();
    this.parts = [];
    this.sweep = null;
    this.group.visible = false;
  }

  hide() { this._clear(); this._key = null; }

  _rotY() {
    const o = this.single;
    if (!o) return 0;
    const g = this.vp.objects.get(o.id);
    return g ? g.rotation.y : o.rotY || 0;
  }

  _add(axis, visual, hit, color) {
    visual.renderOrder = 52;
    visual.traverse((k) => { k.renderOrder = 52; k.raycast = () => {}; });
    hit.userData.gizmoAxis = axis;
    this.group.add(visual, hit);
    this.parts.push({ axis, visual, hit, color });
  }

  _arrow(axis, tip) {
    const color = COLORS[axis];
    const g = new THREE.Group();
    const m = mat(color);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.78, 8), m);
    shaft.position.y = 0.17 + 0.39;
    const head = tip === 'cone'
      ? new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.2, 16), m)
      : new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m);
    head.position.y = tip === 'cone' ? 1.05 : 1.0;
    g.add(shaft, head);
    const r = this.coarse ? 0.16 : 0.1;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.05, 8), HIT_MAT);
    hit.position.y = 0.12 + 0.525;
    const wrap = (o) => { const w = new THREE.Group(); w.add(o); orient(w, axis); return w; };
    this._add(axis, wrap(g), wrap(hit), color);
  }

  /** Quadrado no chão: arrasta livre no plano. */
  _plane() {
    const s = 0.3;
    const geo = new THREE.PlaneGeometry(s, s).rotateX(-Math.PI / 2);
    const v = new THREE.Group();
    const fill = new THREE.Mesh(geo, mat(COLORS.rot, 0.28));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: COLORS.rot, depthTest: false, transparent: true }));
    v.add(fill, edge);
    const hs = this.coarse ? 0.46 : 0.34;
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(hs, hs).rotateX(-Math.PI / 2), HIT_MAT);
    this._add('xz', v, hit, COLORS.rot);
    this.parts[this.parts.length - 1].fill = fill;
  }

  _ring() {
    const R = 0.95;
    const v = new THREE.Mesh(new THREE.TorusGeometry(R, 0.014, 6, 96).rotateX(Math.PI / 2), mat(COLORS.rot));
    const tube = this.coarse ? 0.14 : 0.09;
    const hit = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 6, 48).rotateX(Math.PI / 2), HIT_MAT);
    // marcas a cada 45° (ajudam a ler o giro)
    const ticks = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r0 = i % 2 ? R - 0.05 : R - 0.1;
      ticks.push(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * R, 0, Math.sin(a) * R);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
    v.add(new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: COLORS.rot, depthTest: false, transparent: true })));
    this._add('ry', v, hit, COLORS.rot);
    // fatia que mostra o quanto girou durante o arraste
    this.sweep = new THREE.Mesh(new THREE.BufferGeometry(), mat(COLORS.rot, 0.22));
    this.sweep.renderOrder = 51;
    this.sweep.raycast = () => {};
    this.group.add(this.sweep);
  }

  _center() {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), mat(COLORS.all));
    const s = this.coarse ? 0.36 : 0.24;
    const hit = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), HIT_MAT);
    this._add('all', v, hit, COLORS.all);
  }

  /** Estica a seta do eixo ativo enquanto escala (o cubo da ponta acompanha sem deformar). */
  stretch(axis, f) {
    const p = this.parts.find((q) => q.axis === axis);
    const inner = p?.visual.children[0];
    if (!inner || axis === 'all') { if (p) p.visual.scale.setScalar(Math.max(0.3, Math.min(3, f))); return; }
    const k = Math.max(0.15, Math.min(4, f));
    inner.scale.y = k;
    inner.children[1].scale.y = 1 / k;
  }

  /** Fatia do anel de 0 até `angle` (sentido do rotY). */
  setSweep(start, angle) {
    if (!this.sweep) return;
    const n = Math.max(2, Math.ceil(Math.abs(angle) / 0.05));
    const pos = [0, 0, 0];
    for (let i = 0; i <= n; i++) {
      const a = start - (angle * i) / n; // rotY positivo gira no sentido horário visto de cima
      pos.push(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95);
    }
    const idx = [];
    for (let i = 1; i <= n; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.sweep.geometry.dispose();
    this.sweep.geometry = g;
  }

  /** Tamanho constante na tela e destaque do eixo sob o cursor. */
  update() {
    if (!this.group.visible) return;
    const cam = this.vp.camera;
    const h = this.vp.dom.clientHeight || 1;
    const px = this.coarse ? PX.touch : PX.mouse;
    let perPx;
    if (cam.isOrthographicCamera) perPx = (cam.top - cam.bottom) / cam.zoom / h;
    else perPx = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.position.distanceTo(this.group.position)) / h;
    this.group.scale.setScalar(perPx * px);
    const lit = this.active || this.hover;
    for (const p of this.parts) {
      const on = p.axis === lit;
      p.visual.traverse((k) => {
        if (!k.material || k.material === HIT_MAT) return;
        k.material.color.setHex(on ? HOVER : p.color);
      });
      if (p.fill) p.fill.material.opacity = on ? 0.5 : 0.28;
      // com outro eixo ativo, o resto apaga
      p.visual.visible = !this.active || on;
    }
  }

  /** Eixo do gizmo sob o cursor (ou perto do dedo). */
  pick(ndc, touch = false) {
    if (!this.group.visible || !this.parts.length) return null;
    this.group.updateMatrixWorld(true);
    const rc = this.vp.raycaster(ndc);
    const hits = rc.intersectObjects(this.parts.map((p) => p.hit), true);
    if (hits.length) {
      // centro e plano têm prioridade sobre as setas que nascem neles
      const rank = { all: 0, xz: 1 };
      hits.sort((a, b) => (rank[axisOf(a.object)] ?? 2) - (rank[axisOf(b.object)] ?? 2) || a.distance - b.distance);
      return axisOf(hits[0].object);
    }
    if (!touch) return null;
    // dedo: o eixo mais perto na tela, num raio de ~28 px
    const r = this.vp.dom.getBoundingClientRect();
    const toPx = (v) => { const q = v.clone().project(this.vp.camera); return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height, z: q.z }; };
    const at = { x: ((ndc.x + 1) / 2) * r.width, y: ((1 - ndc.y) / 2) * r.height };
    let best = 28, axis = null;
    for (const p of this.parts) {
      const pts = sampleAxis(p.axis, this.group);
      for (const w of pts) {
        const s = toPx(w);
        if (s.z > 1) continue;
        const d = Math.hypot(s.x - at.x, s.y - at.y);
        if (d < best) { best = d; axis = p.axis; }
      }
    }
    return axis;
  }

  /** Direção do eixo no mundo (escala segue o giro do objeto). */
  axisDir(axis) {
    const d = AXIS_DIR[axis].clone();
    if (axis !== 'y') d.applyAxisAngle(UP, this.group.rotation.y);
    return d;
  }

  /** Comprimento de um eixo em metros (escala atual do gizmo). */
  get unit() { return this.group.scale.x; }
}

function orient(obj, axis) {
  if (axis === 'x') obj.rotation.z = -Math.PI / 2;
  else if (axis === 'z') obj.rotation.x = Math.PI / 2;
}

function axisOf(o) {
  while (o && !o.userData.gizmoAxis) o = o.parent;
  return o?.userData.gizmoAxis || null;
}

/** Pontos ao longo de uma parte do gizmo, no mundo (para o toque achar a mais perto). */
function sampleAxis(axis, group) {
  const out = [];
  const add = (x, y, z) => out.push(new THREE.Vector3(x, y, z).applyMatrix4(group.matrixWorld));
  if (axis === 'x' || axis === 'y' || axis === 'z') {
    for (let t = 0.25; t <= 1.1; t += 0.12) add(axis === 'x' ? t : 0, axis === 'y' ? t : 0, axis === 'z' ? t : 0);
  } else if (axis === 'ry') {
    for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; add(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95); }
  } else add(0, 0, 0);
  return out;
}

/**
 * Parâmetro t no eixo (origem O, direção a) do ponto mais perto do raio.
 * Retorna null quando o raio está quase paralelo ao eixo (olhando "de ponta").
 */
export function rayAxisParam(ray, O, a) {
  const w0 = new THREE.Vector3().subVectors(ray.origin, O);
  const b = ray.direction.dot(a);
  const den = 1 - b * b;
  if (den < 1e-3) return null;
  return (a.dot(w0) - b * ray.direction.dot(w0)) / den;
}
