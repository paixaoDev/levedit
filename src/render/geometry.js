// Construtores de geometria procedural: faixas (ribbons) para paredes e pisos,
// lajes poligonais e prismas. Tudo com sombreamento flat (não indexado).
import * as THREE from 'three';
import { computeFrames, offsetPoints, signedArea } from '../math/curve.js';

class TriBuilder {
  constructor() { this.pos = []; }
  tri(a, b, c) { this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Faixa genérica: seções transversais retangulares definidas por borda esquerda
 * e direita (XZ), com y inferior/superior por amostra.
 */
export function ribbon(left, right, yBottom, yTop, { closed = false, caps = true } = {}) {
  const n = left.length;
  const tb = new TriBuilder();
  if (n < 2) return tb.build();
  const V = (p, y) => ({ x: p.x, y, z: p.z });
  const sec = (i) => ({
    Lb: V(left[i], yBottom[i]), Lt: V(left[i], yTop[i]),
    Rb: V(right[i], yBottom[i]), Rt: V(right[i], yTop[i]),
  });
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = sec(k), b = sec((k + 1) % n);
    tb.quad(a.Lb, a.Lt, b.Lt, b.Lb); // lado esquerdo
    tb.quad(a.Rb, b.Rb, b.Rt, a.Rt); // lado direito
    tb.quad(a.Lt, a.Rt, b.Rt, b.Lt); // topo
    tb.quad(a.Lb, b.Lb, b.Rb, a.Rb); // base
  }
  if (!closed && caps) {
    const s = sec(0), e = sec(n - 1);
    tb.quad(s.Lb, s.Rb, s.Rt, s.Lt);
    tb.quad(e.Lb, e.Lt, e.Rt, e.Rb);
  }
  return tb.build();
}

/** Parede ao longo de uma linha central com espessura e alturas por amostra. */
export function wallGeometry(center, heights, thickness, { closed = false, caps = true, frames } = {}) {
  const f = frames || computeFrames(center, closed);
  const L = offsetPoints(center, f, thickness / 2);
  const R = offsetPoints(center, f, -thickness / 2);
  const yb = center.map((p) => p.y ?? 0);
  const yt = center.map((p, i) => (p.y ?? 0) + (Array.isArray(heights) ? heights[i] : heights));
  return ribbon(L, R, yb, yt, { closed, caps });
}

/** Piso entre duas bordas (com y no topo das amostras) e espessura. */
export function floorGeometry(left, right, thickness, { closed = false } = {}) {
  const yt = left.map((p) => p.y ?? 0);
  const yb = yt.map((y) => y - thickness);
  return ribbon(left, right, yb, yt, { closed, caps: true });
}

/** Laje poligonal (área fechada) com topo em y. */
export function slabGeometry(points, y, thickness) {
  const pts = signedArea(points) < 0 ? points : [...points].reverse();
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y - thickness, 0);
  const ni = g.index ? g.toNonIndexed() : g;
  ni.computeVertexNormals();
  return ni;
}

/** Caixa entre dois pontos (XZ), com largura, base e altura. */
export function boxBetween(a, b, width, yBottom, height) {
  const center = [a, b];
  const f = computeFrames(center, false);
  const L = offsetPoints(center, f, width / 2);
  const R = offsetPoints(center, f, -width / 2);
  return ribbon(L, R, [yBottom, yBottom], [yBottom + height, yBottom + height], { caps: true });
}

/** Geometrias compartilhadas (cache) para decoração/assets. */
const shared = new Map();
export function sharedGeometry(key, factory) {
  if (!shared.has(key)) {
    const g = factory();
    const ni = g.index ? g.toNonIndexed() : g;
    ni.computeVertexNormals();
    ni.__shared = true;
    shared.set(key, ni);
  }
  return shared.get(key);
}
