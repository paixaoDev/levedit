// Modelo de dados do level (JSON serializável) e valores padrão.
import { uid, withDefaults, deepClone } from './util.js';

export const DOC_VERSION = 1;

export const PALETTE = [
  '#ffffff', '#f4f1ea', '#e9e2d4', '#d8cbb3', '#b9a88a', '#8a7a62', '#5b5144',
  '#c0632f', '#d9a441', '#9bb57a', '#5f8f6a', '#6d9bb8', '#4a6a8f', '#b56b7a', '#2f2a24',
];

export const PROC_DEFAULTS = { seed: 1, gapChance: 0, gapLength: 2, heightVar: 0, jitter: 0, segment: 1 };

// Iluminação do level (preset, ângulo do sol em graus, força da luz interna, exibição dos tetos).
export const LIGHTING_DEFAULTS = { preset: 'editor', sunAngle: 35, interior: 0.8, roofView: 'dotted' };

// Teto: sem teto o espaço recebe o sol; com teto fica só com a luz interna e as luzes pontuais.
export const ROOF_DEFAULTS = { enabled: false, thickness: 0.2, color: '#f4f1ea' };

export const DECO_TYPES = {
  none: 'Nenhuma',
  flowers: 'Canteiro de flores',
  rocks: 'Pedras',
  sidewalk: 'Calçada',
  pillars: 'Pilares',
  hedge: 'Cerca viva',
  crates: 'Caixas',
  lamps: 'Postes',
};

export const TYPE_DEFAULTS = {
  corridor: {
    name: 'Corredor',
    points: [],
    closed: false,
    smooth: 0.5,
    width: 4,
    endLevelId: null,
    groupId: null,
    links: { start: null, end: null },
    joins: { start: 'door', end: 'door' },
    rampStyle: 'ramp',
    stepHeight: 0.25,
    floor: { enabled: true, thickness: 0.2, color: '#f4f1ea' },
    walls: { left: true, right: true, height: 3, thickness: 0.3, color: '#ffffff', mode: 'continuous', capStart: false, capEnd: false },
    roof: ROOF_DEFAULTS,
    proc: PROC_DEFAULTS,
    deco: { type: 'none', side: 'both', density: 0.4, color: '#9bb57a', inset: 0.7, seed: 7 },
  },
  wall: {
    name: 'Parede',
    points: [],
    closed: false,
    smooth: 0,
    height: 3,
    thickness: 0.3,
    color: '#ffffff',
    mode: 'continuous',
    proc: PROC_DEFAULTS,
  },
  area: {
    name: 'Área',
    points: [],
    closed: true,
    smooth: 0,
    floor: { enabled: true, thickness: 0.2, color: '#f4f1ea' },
    walls: { enabled: true, height: 3, thickness: 0.3, color: '#ffffff', mode: 'continuous' },
    joins: { areas: 'door' },
    doorWidth: 1.6,
    roof: ROOF_DEFAULTS,
    proc: PROC_DEFAULTS,
    deco: { type: 'none', side: 'inside', density: 0.4, color: '#9bb57a', inset: 0.7, seed: 7 },
  },
  connector: {
    name: 'Escada',
    style: 'stairs',
    x: 0, z: 0, rotY: 0,
    width: 2,
    fromLevelId: null,
    toLevelId: null,
    slope: 1.6,
    stepHeight: 0.25,
    rails: true,
    color: '#e9e2d4',
  },
  asset: {
    name: 'Asset',
    kind: 'cube',
    x: 0, y: 0, z: 0, rotY: 0,
    scale: { x: 1, y: 1, z: 1 },
    color: '#e9e2d4',
    customId: null,
    collider: true,
  },
  light: {
    name: 'Luz',
    x: 0, z: 0, y: 2.4, rotY: 0,
    color: '#ffd9a0',
    intensity: 8,
    range: 14,
    shadows: true,
  },
  agent: {
    name: 'Agente',
    role: 'player',
    mode: 'fps',
    x: 0, z: 0, rotY: 0,
    color: '#4a6a8f',
    behavior: 'idle',
    pathId: null,
    params: {},
  },
};

export const ASSET_KINDS = {
  cube: 'Cubo',
  cylinder: 'Cilindro',
  sphere: 'Esfera',
  cone: 'Cone',
  wedge: 'Rampa (cunha)',
  platform: 'Plataforma',
  pillar: 'Pilar',
  arch: 'Arco',
  crate: 'Caixa',
  barrel: 'Barril',
  rock: 'Pedra',
  tree: 'Árvore',
  bush: 'Arbusto',
  bench: 'Banco',
  lamp: 'Poste',
  fence: 'Cerca',
  car: 'Carro (prop)',
  door: 'Porta',
  custom: 'Modelo importado',
};

// Parâmetros de gameplay por tipo de agente.
export const AGENT_MODES = {
  player: {
    fps: { label: 'FPS', params: { speed: 6, sprint: 1.6, jump: 6.5, gravity: 20, eyeHeight: 1.6, sensitivity: 1, health: 100, fireRate: 6, damage: 25 } },
    platform: { label: 'Plataforma', params: { speed: 7, jump: 9, gravity: 26, doubleJump: true, airControl: 0.6, health: 100, cameraDistance: 10, stompDamage: 50 } },
    car: { label: 'Carro', params: { maxSpeed: 24, accel: 16, brake: 30, turnRate: 2.4, grip: 0.85, health: 100, ramDamage: 40 } },
  },
  enemy: {
    shooter: { label: 'Atirador (FPS)', params: { speed: 3, range: 24, fireRate: 1.2, damage: 10, health: 50, projectileSpeed: 18, accuracy: 0.9 } },
    arcade: { label: 'Arcade', params: { speed: 4.5, range: 14, damage: 20, health: 30, jumpy: true } },
    car: { label: 'Carro', params: { maxSpeed: 16, accel: 10, turnRate: 2, damage: 30, health: 80, range: 30 } },
  },
};

export const BEHAVIORS = {
  idle: 'Parado',
  wander: 'Vagar',
  patrol: 'Patrulhar caminho',
  chase: 'Perseguir',
};

export function makeLevel(name, elevation) {
  return { id: uid('lvl'), name, elevation, visible: true };
}

export function makeObject(type, props = {}) {
  const base = deepClone(TYPE_DEFAULTS[type]);
  const obj = { id: uid(type.slice(0, 3)), type, ...base, ...deepClone(props) };
  return normalizeObject(obj);
}

export function normalizeObject(obj) {
  withDefaults(obj, TYPE_DEFAULTS[obj.type] || {});
  if (obj.type === 'agent') {
    const def = AGENT_MODES[obj.role]?.[obj.mode];
    if (!def) {
      obj.mode = Object.keys(AGENT_MODES[obj.role] || AGENT_MODES.player)[0];
    }
    withDefaults(obj.params, AGENT_MODES[obj.role][obj.mode].params);
  }
  return obj;
}

export function emptyDoc() {
  const l0 = makeLevel('Térreo', 0);
  return {
    version: DOC_VERSION,
    name: 'Novo level',
    settings: { gridSize: 1, snap: true, otherLevels: 'ghost', solidGround: true, lighting: { ...LIGHTING_DEFAULTS } },
    levels: [l0],
    activeLevelId: l0.id,
    objects: [],
    customAssets: {},
  };
}

export function normalizeDoc(doc) {
  const d = withDefaults(doc, emptyDoc());
  if (!d.levels.length) d.levels.push(makeLevel('Térreo', 0));
  if (!d.levels.find((l) => l.id === d.activeLevelId)) d.activeLevelId = d.levels[0].id;
  d.objects = d.objects.filter((o) => TYPE_DEFAULTS[o.type]).map(normalizeObject);
  return d;
}

/** Level de exemplo mostrando corredores, rampa entre níveis, escada, assets e agentes. */
export function sampleDoc() {
  const doc = emptyDoc();
  doc.name = 'Exemplo';
  const l0 = doc.levels[0];
  const l1 = makeLevel('Nível 1', 4);
  doc.levels.push(l1);
  const objs = doc.objects;
  objs.push(makeObject('area', {
    name: 'Praça', levelId: l0.id,
    points: [{ x: -14, z: -10 }, { x: 6, z: -10 }, { x: 6, z: 8 }, { x: -14, z: 8 }],
    walls: { enabled: true, height: 2.5, thickness: 0.3, color: '#ffffff', mode: 'continuous' },
    proc: { seed: 3, gapChance: 0, gapLength: 3, heightVar: 0.15, jitter: 0, segment: 1 },
    deco: { type: 'flowers', side: 'inside', density: 0.35, color: '#9bb57a', inset: 0.9, seed: 4 },
  }));
  const ramp = makeObject('corridor', {
    name: 'Rampa curva', levelId: l0.id, endLevelId: l1.id, smooth: 0.5, width: 4,
    points: [{ x: 6, z: 0 }, { x: 16, z: 0 }, { x: 24, z: 8 }, { x: 24, z: 20 }],
    deco: { type: 'sidewalk', side: 'both', density: 0.4, color: '#d8cbb3', inset: 0.7, seed: 2 },
  });
  objs.push(ramp);
  objs.push(makeObject('corridor', {
    id: 'cor_sample_alto', name: 'Corredor alto', levelId: l1.id, smooth: 0.5, width: 5,
    points: [{ x: 24, z: 20 }, { x: 24, z: 25, jid: 'jsaida' }, { x: 24, z: 30, wl: 4.5, wr: 3.5 }, { x: 10, z: 34 }, { x: -4, z: 30 }],
    walls: { left: true, right: true, height: 3, thickness: 0.3, color: '#ffffff', mode: 'blocks', capStart: false, capEnd: false },
    proc: { seed: 9, gapChance: 0.08, gapLength: 1, heightVar: 0.35, jitter: 0.15, segment: 1.5 },
    deco: { type: 'rocks', side: 'both', density: 0.5, color: '#b9a88a', inset: 0.8, seed: 5 },
  }));
  objs.push(makeObject('corridor', {
    name: 'Saída leste', levelId: l1.id, smooth: 0.5, width: 3,
    points: [{ x: 24, z: 25 }, { x: 34, z: 25 }, { x: 40, z: 31 }],
    walls: { left: true, right: true, height: 3, thickness: 0.3, color: '#ffffff', mode: 'continuous', capStart: false, capEnd: true },
    joins: { start: 'door', end: 'door' },
    links: { start: { id: 'cor_sample_alto', jid: 'jsaida' }, end: null },
    roof: { enabled: true, thickness: 0.2, color: '#f4f1ea' },
  }));
  objs.push(makeObject('light', { name: 'Luz do túnel', levelId: l1.id, x: 32, z: 25, y: 2.3, color: '#ffd9a0', intensity: 6, range: 12 }));
  objs.push(makeObject('light', { name: 'Luz da praça', levelId: l0.id, x: -3, z: -6, y: 3, color: '#ffe2b0', intensity: 14, range: 16 }));
  objs.push(makeObject('area', {
    name: 'Mezanino', levelId: l1.id,
    points: [{ x: -14, z: 8 }, { x: -4, z: 8 }, { x: -4, z: 32 }, { x: -14, z: 32 }],
    walls: { enabled: false, height: 1.1, thickness: 0.2, color: '#ffffff', mode: 'continuous' },
    proc: { seed: 1, gapChance: 0, gapLength: 2, heightVar: 0, jitter: 0, segment: 1 },
    deco: { type: 'lamps', side: 'inside', density: 0.25, color: '#d9a441', inset: 0.6, seed: 3 },
  }));
  objs.push(makeObject('connector', { name: 'Escada', levelId: l0.id, fromLevelId: l0.id, toLevelId: l1.id, x: -9, z: 1.6, rotY: 0, width: 2.5 }));
  objs.push(makeObject('wall', {
    name: 'Muro curvo', levelId: l0.id, smooth: 0.5, height: 2, thickness: 0.4,
    points: [{ x: -4, z: -4 }, { x: 0, z: -1 }, { x: -4, z: 3 }],
  }));
  objs.push(makeObject('asset', { name: 'Árvore', kind: 'tree', levelId: l0.id, x: 2, z: 5, color: '#9bb57a' }));
  objs.push(makeObject('asset', { name: 'Caixa', kind: 'crate', levelId: l0.id, x: -11, z: -7, color: '#d9a441' }));
  objs.push(makeObject('asset', { name: 'Barril', kind: 'barrel', levelId: l1.id, x: 20, z: 31, color: '#c0632f' }));
  objs.push(makeObject('agent', { name: 'Player', role: 'player', mode: 'fps', levelId: l0.id, x: -10, z: -6, rotY: Math.PI * 0.4, color: '#4a6a8f' }));
  objs.push(makeObject('agent', { name: 'Atirador', role: 'enemy', mode: 'shooter', behavior: 'patrol', pathId: null, levelId: l1.id, x: 12, z: 33, color: '#c0632f' }));
  objs.push(makeObject('agent', { name: 'Bolota', role: 'enemy', mode: 'arcade', behavior: 'wander', levelId: l0.id, x: 1, z: 2, color: '#b56b7a' }));
  // atirador patrulha o corredor alto
  objs[objs.length - 2].pathId = objs.find((o) => o.name === 'Corredor alto').id;
  return doc;
}
