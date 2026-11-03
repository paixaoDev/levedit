// Peças procedurais de "natureza" e cidade (pedras, árvores, arbustos, rochedos,
// prédios), juntadas num lote: cada cor vira um único mesh (com contorno CAD),
// o que deixa paredes estilizadas e o fundo leves mesmo com centenas de peças.
import * as THREE from 'three';
import { makeMesh } from '../render/materials.js';
import { shade } from '../util.js';

// Geometrias base (raio/altura 1), sem índice, só posição.
const BASE = {};
function base(key, make) {
  if (!BASE[key]) {
    let g = make();
    if (g.index) g = g.toNonIndexed();
    BASE[key] = g.getAttribute('position').array;
  }
  return BASE[key];
}
const ROCK = () => base('rock', () => new THREE.DodecahedronGeometry(1, 0));
const ROCK2 = () => base('rock2', () => new THREE.IcosahedronGeometry(1, 0));
const BLOB = () => base('blob', () => new THREE.IcosahedronGeometry(1, 1));
const CONE = () => base('cone', () => new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0));
const TRUNK = () => base('trunk', () => new THREE.CylinderGeometry(0.8, 1, 1, 6).translate(0, 0.5, 0));
const BOX = () => base('box', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Lote de peças por cor. */
export class Batch {
  constructor() { this.parts = new Map(); }

  /** Adiciona uma geometria base transformada (posição, rotação xyz, escala xyz). */
  add(arr, color, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    let list = this.parts.get(color);
    if (!list) { list = []; this.parts.set(color, list); }
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      _v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(_m);
      out[i] = _v.x; out[i + 1] = _v.y; out[i + 2] = _v.z;
    }
    list.push(out);
  }

  /** Meshes prontos (um por cor). */
  build(opts = {}) {
    const meshes = [];
    for (const [color, list] of this.parts) {
      let n = 0;
      for (const a of list) n += a.length;
      const pos = new Float32Array(n);
      let o = 0;
      for (const a of list) { pos.set(a, o); o += a.length; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      meshes.push(makeMesh(g, color, { collider: false, threshold: opts.threshold ?? 30, edges: opts.edges, shadow: opts.shadow }));
    }
    return meshes;
  }

  get empty() { return this.parts.size === 0; }
}

// ------------------------------------------------------------------ peças

/** Pedra irregular: raio ~r, altura ~h, girada pelo rnd. */
export function rock(b, rnd, color, x, y, z, r, h = r, yaw = 0) {
  const geo = rnd() < 0.5 ? ROCK() : ROCK2();
  const c = rnd() < 0.35 ? shade(color, -0.12) : rnd() < 0.3 ? shade(color, 0.1) : color;
  b.add(geo, c, x, y + h * 0.42, z, r * (0.85 + rnd() * 0.3), h * 0.55, r * (0.75 + rnd() * 0.3), (rnd() - 0.5) * 0.5, yaw + rnd() * 6.28, (rnd() - 0.5) * 0.5);
}

/** Árvore: pinheiro (cones empilhados) ou copa redonda. h = altura total. */
export function tree(b, rnd, colors, x, y, z, h, r) {
  const trunkH = h * 0.32;
  const tr = Math.max(0.08, Math.min(0.3, r * 0.16));
  b.add(TRUNK(), colors.trunk, x, y, z, tr, trunkH + 0.05, tr, 0, rnd() * 6.28, 0);
  const leaf = rnd() < 0.3 ? shade(colors.leaf, -0.1) : rnd() < 0.25 ? shade(colors.leaf, 0.08) : colors.leaf;
  if (rnd() < 0.55) {
    // pinheiro: 2 ou 3 cones
    const n = rnd() < 0.5 ? 2 : 3;
    const top = h - trunkH * 0.7;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const ch = top * (0.62 - f * 0.12);
      b.add(CONE(), leaf, x, y + trunkH * 0.7 + top * f * 0.62, z, r * (1 - f * 0.3), ch, r * (1 - f * 0.3), 0, rnd() * 6.28, 0);
    }
  } else {
    const cr = Math.min(r * 1.05, (h - trunkH) * 0.55);
    b.add(BLOB(), leaf, x, y + h - cr, z, cr, cr * (0.9 + rnd() * 0.2), cr, 0, rnd() * 6.28, 0);
    if (rnd() < 0.5) b.add(BLOB(), leaf, x + (rnd() - 0.5) * cr, y + h - cr * 1.5, z + (rnd() - 0.5) * cr, cr * 0.7, cr * 0.65, cr * 0.7, 0, rnd() * 6.28, 0);
  }
}

/** Arbusto: bolhas sobrepostas. */
export function bush(b, rnd, color, x, y, z, r, h = r) {
  const n = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    const c = rnd() < 0.35 ? shade(color, -0.1) : color;
    const rr = r * (0.6 + rnd() * 0.4);
    b.add(BLOB(), c, x + (rnd() - 0.5) * r * 0.8, y + h * 0.5 * (0.7 + rnd() * 0.4), z + (rnd() - 0.5) * r * 0.8, rr, h * 0.5 * (0.8 + rnd() * 0.3), rr, 0, rnd() * 6.28, 0);
  }
}

/** Placa de rocha (rochedo / colunas de basalto). */
export function slab(b, rnd, color, x, y, z, w, d, h, yaw) {
  const c = rnd() < 0.4 ? shade(color, -0.1) : rnd() < 0.3 ? shade(color, 0.08) : color;
  b.add(BOX(), c, x, y - 0.1, z, w, h + 0.1, d, (rnd() - 0.5) * 0.12, yaw + (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.12);
}

/** Prédio: bloco com coroamento e, às vezes, recuo no topo. */
export function building(b, rnd, colors, x, y, z, w, d, h, yaw) {
  const c = rnd() < 0.3 ? shade(colors.wall, -0.08) : rnd() < 0.3 ? shade(colors.wall, 0.06) : colors.wall;
  b.add(BOX(), c, x, y, z, w, h, d, 0, yaw, 0);
  b.add(BOX(), colors.trim, x, y + h, z, w + 0.2, 0.25, d + 0.2, 0, yaw, 0);
  if (h > 8 && rnd() < 0.55) {
    const f = 0.55 + rnd() * 0.25;
    const h2 = h * (0.12 + rnd() * 0.2);
    b.add(BOX(), c, x, y + h + 0.25, z, w * f, h2, d * f, 0, yaw, 0);
  }
  // faixas de janelas (no tom do coroamento) em prédios mais baixos
  if (h <= 14) {
    const floors = Math.max(1, Math.floor(h / 3.2));
    for (let i = 1; i <= floors; i++) {
      const fy = y + i * (h / (floors + 1)) - 0.3;
      b.add(BOX(), colors.trim, x, fy, z, w + 0.04, 0.5, d + 0.04, 0, yaw, 0);
    }
  }
}

/** Cor "natural" de cada estilo quando a cor escolhida é o branco padrão. */
export const NATURAL = {
  rocks: '#b9a88a',
  cliff: '#a39478',
  trees: '#7fa36a',
  bushes: '#8fb07a',
};
export const TRUNK_COLOR = '#8a7a62';
