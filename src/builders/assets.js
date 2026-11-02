// Biblioteca de assets 3D procedurais. Todos usam o mesmo material, só a cor muda.
import * as THREE from 'three';
import { makeMesh, getMaterial } from '../render/materials.js';
import { sharedGeometry, ribbon } from '../render/geometry.js';
import { shade } from '../util.js';

const G = {
  box: (w, h, d) => sharedGeometry(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
  cyl: (rt, rb, h, s = 16) => sharedGeometry(`cyl${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s)),
  ico: (r, d = 0) => sharedGeometry(`ico${r},${d}`, () => new THREE.IcosahedronGeometry(r, d)),
  dodeca: (r) => sharedGeometry(`dod${r}`, () => new THREE.DodecahedronGeometry(r, 0)),
  cone: (r, h, s = 16) => sharedGeometry(`cone${r},${h},${s}`, () => new THREE.ConeGeometry(r, h, s)),
  capsule: (r, l) => sharedGeometry(`cap${r},${l}`, () => new THREE.CapsuleGeometry(r, l, 4, 12)),
  wedge: () => sharedGeometry('wedge', () => ribbon(
    [{ x: 0.5, z: -0.5 }, { x: 0.5, z: 0.5 }], [{ x: -0.5, z: -0.5 }, { x: -0.5, z: 0.5 }], [0, 0], [0.001, 1], { caps: true })),
};

function part(geo, color, x = 0, y = 0, z = 0, opts = {}) {
  const m = makeMesh(geo, color, opts);
  m.position.set(x, y, z);
  if (opts.rx) m.rotation.x = opts.rx;
  if (opts.ry) m.rotation.y = opts.ry;
  if (opts.rz) m.rotation.z = opts.rz;
  if (opts.sx) m.scale.set(opts.sx, opts.sy ?? 1, opts.sz ?? 1);
  return m;
}

const BUILDERS = {
  cube: (c) => [part(G.box(1, 1, 1), c, 0, 0.5, 0)],
  cylinder: (c) => [part(G.cyl(0.5, 0.5, 1), c, 0, 0.5, 0)],
  sphere: (c) => [part(G.ico(0.5, 2), c, 0, 0.5, 0, { threshold: 40 })],
  cone: (c) => [part(G.cone(0.5, 1), c, 0, 0.5, 0)],
  wedge: (c) => [part(G.wedge(), c)],
  platform: (c) => [part(G.box(4, 0.4, 4), c, 0, 0.2, 0)],
  pillar: (c) => [part(G.box(0.6, 4, 0.6), c, 0, 2, 0)],
  arch: (c) => [
    part(G.box(0.5, 3, 0.5), c, -1.25, 1.5, 0),
    part(G.box(0.5, 3, 0.5), c, 1.25, 1.5, 0),
    part(G.box(3, 0.5, 0.5), c, 0, 3.25, 0),
  ],
  crate: (c) => [
    part(G.box(0.9, 0.9, 0.9), c, 0, 0.45, 0),
    part(G.box(0.95, 0.12, 0.95), shade(c, -0.15), 0, 0.06, 0),
    part(G.box(0.95, 0.12, 0.95), shade(c, -0.15), 0, 0.84, 0),
  ],
  barrel: (c) => [
    part(G.cyl(0.35, 0.35, 1, 12), c, 0, 0.5, 0),
    part(G.cyl(0.37, 0.37, 0.08, 12), shade(c, -0.2), 0, 0.25, 0),
    part(G.cyl(0.37, 0.37, 0.08, 12), shade(c, -0.2), 0, 0.75, 0),
  ],
  rock: (c) => [part(G.dodeca(0.6), c, 0, 0.35, 0, { sx: 1, sy: 0.65, sz: 0.85, ry: 0.4 })],
  tree: (c) => [
    part(G.cyl(0.12, 0.18, 1.6, 8), shade(c, -0.45), 0, 0.8, 0),
    part(G.ico(1.1, 0), c, 0, 2.3, 0),
    part(G.ico(0.7, 0), shade(c, 0.12), 0.4, 3.0, 0.2),
  ],
  bush: (c) => [part(G.ico(0.6, 0), c, 0, 0.45, 0, { sx: 1.2, sy: 0.8, sz: 1 })],
  bench: (c) => [
    part(G.box(1.6, 0.1, 0.5), c, 0, 0.45, 0),
    part(G.box(1.6, 0.4, 0.08), c, 0, 0.75, -0.22),
    part(G.box(0.1, 0.45, 0.45), shade(c, -0.3), -0.7, 0.22, 0),
    part(G.box(0.1, 0.45, 0.45), shade(c, -0.3), 0.7, 0.22, 0),
  ],
  lamp: (c) => [
    part(G.cyl(0.06, 0.09, 3.5, 8), shade(c, -0.3), 0, 1.75, 0),
    part(G.box(0.7, 0.12, 0.3), c, 0.25, 3.5, 0),
    part(G.cyl(0.25, 0.25, 0.1, 12), shade(c, -0.3), 0, 0.05, 0),
  ],
  fence: (c) => [
    part(G.box(0.12, 1.1, 0.12), c, -1, 0.55, 0),
    part(G.box(0.12, 1.1, 0.12), c, 1, 0.55, 0),
    part(G.box(2.1, 0.1, 0.06), c, 0, 0.4, 0),
    part(G.box(2.1, 0.1, 0.06), c, 0, 0.85, 0),
  ],
  car: (c) => carParts(c),
  door: (c) => [
    part(G.box(0.15, 2.3, 0.3), shade(c, -0.25), -0.65, 1.15, 0),
    part(G.box(0.15, 2.3, 0.3), shade(c, -0.25), 0.65, 1.15, 0),
    part(G.box(1.45, 0.15, 0.3), shade(c, -0.25), 0, 2.3, 0),
    part(G.box(1.1, 2.15, 0.08), c, 0, 1.08, 0),
  ],
};

export function carParts(c, opts = {}) {
  const wheel = G.cyl(0.36, 0.36, 0.3, 14);
  const dark = shade(c, -0.6);
  const parts = [
    part(G.box(1.8, 0.55, 4), c, 0, 0.6, 0, opts),
    part(G.box(1.55, 0.5, 2), shade(c, 0.25), 0, 1.12, -0.2, opts),
  ];
  for (const [x, z] of [[-0.9, 1.3], [0.9, 1.3], [-0.9, -1.3], [0.9, -1.3]]) {
    parts.push(part(wheel, dark, x, 0.36, z, { ...opts, rz: Math.PI / 2 }));
  }
  return parts;
}

/** Modelos importados (GLB) já carregados: id -> THREE.Object3D */
export const customModels = new Map();

function customParts(asset) {
  const src = customModels.get(asset.customId);
  if (!src) return [part(G.box(1, 1, 1), '#ffffff', 0, 0.5, 0)];
  const root = new THREE.Group();
  src.updateMatrixWorld(true);
  src.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      const m = makeMesh(geo, asset.color, { threshold: 35 });
      root.add(m);
    }
  });
  return [root];
}

export function buildAssetParts(asset) {
  if (asset.kind === 'custom') return customParts(asset);
  const b = BUILDERS[asset.kind] || BUILDERS.cube;
  return b(asset.color);
}

/** Miniatura simples (SVG) para a paleta de assets. */
export const ASSET_ICONS = {
  cube: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8',
  cylinder: 'M6 6a6 2 0 1 0 12 0a6 2 0 1 0-12 0 M6 6v12a6 2 0 0 0 12 0V6',
  sphere: 'M12 4a8 8 0 1 0 0.01 0z M4 12a8 3 0 0 0 16 0',
  cone: 'M12 3L5 18a7 2.5 0 0 0 14 0z',
  wedge: 'M3 18h18V8z M3 18l4-2h14',
  platform: 'M3 11l9-4 9 4-9 4z M3 11v2l9 4 9-4v-2',
  pillar: 'M9 3h6v18H9z',
  arch: 'M4 20V6h16v14 M8 20V10h8v10',
  crate: 'M5 5h14v14H5z M5 5l14 14 M19 5L5 19',
  barrel: 'M7 4h10v16H7z M7 9h10 M7 15h10',
  rock: 'M4 17l3-8 6-3 6 5 1 6z',
  tree: 'M12 3l6 9H6z M12 12v8',
  bush: 'M4 17a5 5 0 0 1 5-7a5 5 0 0 1 9 2a3 3 0 0 1 2 5z',
  bench: 'M3 12h18 M5 12v6 M19 12v6 M3 8h18',
  lamp: 'M12 21V4 M12 4h5 M9 21h6',
  fence: 'M5 6v14 M19 6v14 M3 10h18 M3 16h18',
  car: 'M3 15v-3l3-4h10l3 4v3z M7 17a1.5 1.5 0 1 0 0.01 0 M17 17a1.5 1.5 0 1 0 0.01 0',
  door: 'M7 21V3h10v18 M14 12h1',
  custom: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
};

export { getMaterial };
