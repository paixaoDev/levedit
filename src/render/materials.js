// Material único do editor (todos os objetos usam o mesmo shader, só muda a cor)
// e linhas de contorno estilo CAD em bege escuro.
import * as THREE from 'three';

export const THEME = {
  background: 0xfbfaf6,
  line: 0x8a7a62,
  lineSoft: 0xd8cfbf,
  gridMajor: 0xb9ab93,
  gridMinor: 0xe7e0d3,
  accent: 0xc0632f,
  select: 0xd9822b,
};

const matCache = new Map();
const edgeMats = {
  normal: new THREE.LineBasicMaterial({ color: THEME.line }),
  ghost: new THREE.LineBasicMaterial({ color: THEME.line, transparent: true, opacity: 0.18, depthWrite: false }),
  selected: new THREE.LineBasicMaterial({ color: THEME.select }),
};

/** Material padrão (MeshStandard flat) com a cor pedida. */
export function getMaterial(color = '#ffffff', ghost = false) {
  const key = `${color}|${ghost ? 1 : 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      transparent: ghost,
      opacity: ghost ? 0.22 : 1,
      depthWrite: !ghost,
    });
    matCache.set(key, m);
  }
  return m;
}

export function getEdgeMaterial(kind = 'normal') {
  return edgeMats[kind] || edgeMats.normal;
}

const edgeGeoCache = new WeakMap();
function edgesFor(geometry, threshold) {
  let e = edgeGeoCache.get(geometry);
  if (!e) {
    e = new THREE.EdgesGeometry(geometry, threshold);
    edgeGeoCache.set(geometry, e);
  }
  return e;
}

/**
 * Cria um mesh com o material padrão e contorno CAD.
 * @param {THREE.BufferGeometry} geometry
 * @param {string} color
 * @param {{collider?:boolean, threshold?:number, edges?:boolean}} opts
 */
export function makeMesh(geometry, color, opts = {}) {
  const mesh = new THREE.Mesh(geometry, getMaterial(color));
  mesh.userData.baseColor = color;
  mesh.userData.collider = opts.collider !== false;
  if (opts.edges !== false) {
    const lines = new THREE.LineSegments(edgesFor(geometry, opts.threshold ?? 25), getEdgeMaterial('normal'));
    lines.userData.isEdge = true;
    lines.raycast = () => {};
    mesh.add(lines);
  }
  return mesh;
}

/** Aplica estado visual (normal / fantasma / selecionado) a uma árvore. */
export function applyVisualState(root, state) {
  root.traverse((o) => {
    if (o.isLineSegments && o.userData.isEdge) {
      o.material = getEdgeMaterial(state === 'ghost' ? 'ghost' : state === 'selected' ? 'selected' : 'normal');
    } else if (o.isMesh && o.userData.baseColor) {
      o.material = getMaterial(o.userData.baseColor, state === 'ghost');
    }
  });
}
