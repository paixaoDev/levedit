// Material único do editor (todos os objetos usam o mesmo shader, só muda a cor)
// e linhas de contorno estilo CAD em bege escuro.
//
// Transparência sem sobreposição: o "fantasma" (outros níveis) e o teto visto
// no editor não usam alpha. São opacos e descartam pixels num padrão de pontos
// em espaço de tela (screen-door). Assim duas camadas fantasmas nunca somam
// opacidade: onde se cruzam, só a da frente aparece, sempre em pontinhos.
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

/** Escala do padrão de pontos (pixel ratio do renderer). */
export const STIPPLE = { value: 1 };

// Exibição do teto: 'dotted' (pontilhado), 'solid' ou 'hidden' (só faz sombra).
let roofView = 'dotted';
export function setRoofView(v) { roofView = v; }
export function getRoofView() { return roofView; }

const matCache = new Map();
const edgeMats = {
  normal: new THREE.LineBasicMaterial({ color: THEME.line }),
  // opaco: linhas fantasmas que se cruzam não escurecem
  ghost: new THREE.LineBasicMaterial({ color: 0xd5cab8 }),
  selected: new THREE.LineBasicMaterial({ color: THEME.select }),
  roof: new THREE.LineBasicMaterial({ color: 0xc4b79f }),
  hidden: new THREE.LineBasicMaterial({ visible: false }),
};

/**
 * Descarta pixels fora de uma grade de pontos (linhas alternadas deslocadas).
 * `cell` = tamanho da célula em px CSS; `radius` = raio do ponto (0..0.5 da célula).
 */
function stipple(m, cell, radius) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uStipple = STIPPLE;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uStipple;\nvoid main() {\n  {\n    vec2 sp = gl_FragCoord.xy / (uStipple * ${cell.toFixed(1)});\n    sp.x += 0.5 * mod(floor(sp.y), 2.0);\n    if (length(fract(sp) - 0.5) > ${radius.toFixed(3)}) discard;\n  }`);
  };
  m.customProgramCacheKey = () => `stipple-${cell}-${radius}`;
  return m;
}

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    ...extra,
  });
}

/** Material padrão (MeshStandard flat) com a cor pedida. `ghost` = pontilhado. */
export function getMaterial(color = '#ffffff', ghost = false) {
  const key = `${color}|${ghost ? 1 : 0}`;
  let m = matCache.get(key);
  if (!m) {
    if (ghost) {
      // cor puxada para o fundo para continuar leve, em pontos
      const c = new THREE.Color(color).lerp(new THREE.Color(THEME.background), 0.35);
      m = stipple(standard(c), 3, 0.36);
    } else {
      m = standard(color);
    }
    matCache.set(key, m);
  }
  return m;
}

/** Material do teto conforme a exibição atual (e fantasma em outro nível). */
export function getRoofMaterial(color = '#ffffff', ghost = false) {
  const view = roofView;
  const key = `roof|${color}|${view}|${ghost ? 1 : 0}`;
  let m = matCache.get(key);
  if (!m) {
    if (view === 'hidden') {
      // invisível, mas continua no shadow map (bloqueia o sol)
      m = standard(color, { colorWrite: false, depthWrite: false });
    } else if (view === 'dotted' || ghost) {
      const c = new THREE.Color(color).lerp(new THREE.Color(THEME.background), ghost ? 0.45 : 0.15);
      m = stipple(standard(c, { side: THREE.DoubleSide }), ghost ? 4 : 3.5, ghost ? 0.22 : 0.26);
    } else {
      m = standard(color, { side: THREE.DoubleSide });
    }
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
 * @param {{collider?:boolean, threshold?:number, edges?:boolean, shadow?:boolean}} opts
 */
export function makeMesh(geometry, color, opts = {}) {
  const mesh = new THREE.Mesh(geometry, getMaterial(color));
  mesh.userData.baseColor = color;
  mesh.userData.collider = opts.collider !== false;
  mesh.castShadow = opts.shadow !== false;
  mesh.receiveShadow = true;
  if (opts.edges !== false) {
    const lines = new THREE.LineSegments(edgesFor(geometry, opts.threshold ?? 25), getEdgeMaterial('normal'));
    lines.userData.isEdge = true;
    lines.raycast = () => {};
    mesh.add(lines);
  }
  return mesh;
}

/** Teto: sem colisão e sem clique (seleciona-se o que está embaixo, através dele). */
export function makeRoofMesh(geometry, color) {
  const mesh = makeMesh(geometry, color, { collider: false, threshold: 30 });
  mesh.userData.roof = true;
  mesh.material = getRoofMaterial(color);
  mesh.raycast = () => {};
  for (const c of mesh.children) c.userData.roofEdge = true;
  return mesh;
}

// Pré-passe de profundidade dos fantasmas: desenha só o depth (sem cor) antes
// dos pontos. Assim, entre duas superfícies fantasmas, só a da frente aparece;
// o que está atrás dela some em vez de vazar pelos furos do pontilhado. Objetos
// normais (desenhados antes) continuam aparecendo entre os pontos.
const DEPTH_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const GHOST_ORDER = { depth: 1, color: 2 };

function setDepthTwin(mesh, on) {
  let twin = mesh.userData.depthTwin;
  if (on && !twin) {
    twin = new THREE.Mesh(mesh.geometry, DEPTH_MAT);
    twin.raycast = () => {};
    twin.castShadow = twin.receiveShadow = false;
    twin.renderOrder = GHOST_ORDER.depth;
    twin.userData.isDepthTwin = true;
    mesh.userData.depthTwin = twin;
    mesh.add(twin);
  }
  if (twin) twin.visible = on;
  mesh.renderOrder = on ? GHOST_ORDER.color : 0;
}

/** Aplica estado visual (normal / fantasma / selecionado) a uma árvore. */
export function applyVisualState(root, state) {
  const ghost = state === 'ghost';
  root.traverse((o) => {
    if (o.userData.isDepthTwin) return;
    if (o.isLineSegments && o.userData.isEdge) {
      o.renderOrder = ghost ? GHOST_ORDER.color : 0;
      if (o.userData.roofEdge) {
        o.material = getEdgeMaterial(roofView === 'hidden' ? 'hidden' : state === 'selected' ? 'selected' : roofView === 'dotted' || ghost ? 'roof' : 'normal');
      } else {
        o.material = getEdgeMaterial(ghost ? 'ghost' : state === 'selected' ? 'selected' : 'normal');
      }
    } else if (o.isMesh && o.userData.roof) {
      o.material = getRoofMaterial(o.userData.baseColor, ghost);
      setDepthTwin(o, ghost && roofView !== 'hidden');
    } else if (o.isMesh && o.userData.baseColor) {
      o.material = getMaterial(o.userData.baseColor, ghost);
      setDepthTwin(o, ghost);
    }
  });
}
