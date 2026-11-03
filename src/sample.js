// Level de exemplo: "Templo das Raízes", uma dungeon original de aventura vista de
// cima. Pátio de entrada, saguão, átrio circular com lóbulos fundidos, alas leste e
// oeste, antecâmara com porta trancada, salão do guardião e um andar de cima
// (mezanino, passarela e câmara do tesouro) que desce por escadaria até o chefe.
// Mostra salas circulares, salas sobrepostas fundidas, paredes em arco, portas
// automáticas, tetos, luzes, escada entre níveis, assets, player e inimigos.
import { emptyDoc, makeLevel, makeObject } from './model.js';
import { circlePoints } from './editor/polar.js';

const STONE = '#f4f1ea';
const FLOOR = '#e9e2d4';
const DARK_FLOOR = '#d8cbb3';
const MOSS = '#9bb57a';
const WATER = '#6d9bb8';
const GOLD = '#d9a441';
const TORCH = '#ffb36b';

const ROOF = { enabled: true, thickness: 0.25, color: STONE };
const roomWalls = (height = 3.4) => ({ enabled: true, height, thickness: 0.45, color: STONE, mode: 'continuous' });
const corWalls = (height = 3.4, mode = 'continuous') => ({ left: true, right: true, height, thickness: 0.45, color: STONE, mode, capStart: false, capEnd: false });

/** Retângulo (x0..x1, z0..z1) como contorno de área. */
const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];

/** Parede em arco no anel (cx, cz, r) de a0 a a1 (graus, anti-horário), em trechos de até 90°. */
function arcWall(cx, cz, r, a0, a1) {
  const n = Math.max(1, Math.ceil((a1 - a0) / 90));
  const step = ((a1 - a0) / n) * (Math.PI / 180);
  const b = Math.tan(step / 4);
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 * (Math.PI / 180) + step * k;
    const p = { x: cx + r * Math.cos(a), z: cz + r * Math.sin(a) };
    if (k < n) p.b = b;
    pts.push(p);
  }
  return pts;
}

/** Ponto no anel (cx, cz, r) no ângulo a (graus). */
const onRing = (cx, cz, r, a) => ({ x: cx + r * Math.cos((a * Math.PI) / 180), z: cz + r * Math.sin((a * Math.PI) / 180) });

export function sampleDoc() {
  const doc = emptyDoc();
  doc.name = 'Templo das Raízes';
  doc.settings.lighting = { ...doc.settings.lighting, preset: 'day', sunAngle: 40, interior: 1.1 };
  const l0 = doc.levels[0];
  l0.name = 'Térreo';
  const l1 = makeLevel('Galeria superior', 4);
  doc.levels.push(l1);
  const objs = doc.objects;
  const add = (type, props) => { const o = makeObject(type, props); objs.push(o); return o; };
  const room = (name, levelId, points, extra = {}) => add('area', {
    name, levelId, points, floor: { enabled: true, thickness: 0.2, color: FLOOR }, walls: roomWalls(), roof: ROOF, doorWidth: 2, ...extra,
  });
  const circleRoom = (name, levelId, cx, cz, r, extra = {}) => room(name, levelId, circlePoints(cx, cz, r), { shape: 'circle', ...extra });
  const corridor = (name, levelId, points, extra = {}) => add('corridor', {
    name, levelId, points, smooth: 0.5, width: 4, floor: { enabled: true, thickness: 0.2, color: DARK_FLOOR }, walls: corWalls(), roof: ROOF, ...extra,
  });
  const light = (name, levelId, x, z, extra = {}) => add('light', { name, levelId, x, z, y: 2.6, color: TORCH, intensity: 9, range: 13, shadows: false, ...extra });
  const asset = (kind, name, levelId, x, z, extra = {}) => add('asset', { kind, name, levelId, x, z, ...extra });

  // ------------------------------------------------------------ Térreo
  // Pátio de entrada: ruína a céu aberto, muretas irregulares e jardim
  room('Pátio de entrada', l0.id, rect(-10, 41, 10, 54), {
    roof: { enabled: false, thickness: 0.25, color: STONE },
    floor: { enabled: true, thickness: 0.2, color: '#e3dccb' },
    walls: { enabled: true, height: 1.4, thickness: 0.5, color: STONE, mode: 'blocks' },
    proc: { seed: 11, gapChance: 0, gapLength: 2, heightVar: 0.35, jitter: 0.1, segment: 1.5 },
    deco: { type: 'flowers', side: 'inside', density: 0.3, color: MOSS, inset: 1, seed: 5 },
  });
  for (const [x, z, k] of [[-7, 51, 'tree'], [7, 50.5, 'tree'], [-7.5, 44.5, 'bush'], [7.5, 44, 'bush'], [-4, 52, 'rock'], [5, 52.5, 'rock']]) {
    asset(k, k === 'tree' ? 'Árvore' : k === 'bush' ? 'Arbusto' : 'Pedra', l0.id, x, z, { color: k === 'rock' ? '#b9a88a' : MOSS, rotY: x * 0.3 });
  }
  asset('pillar', 'Obelisco', l0.id, -3, 44, { color: '#d8cbb3', scale: { x: 1, y: 0.8, z: 1 } });
  asset('pillar', 'Obelisco', l0.id, 3, 44, { color: '#d8cbb3', scale: { x: 1, y: 0.8, z: 1 } });
  light('Fogueira do pátio', l0.id, 0, 47.5, { y: 1.2, intensity: 7, range: 10, shadows: true });
  asset('rock', 'Fogueira', l0.id, 0, 47.5, { color: '#8a7a62', scale: { x: 0.8, y: 0.5, z: 0.8 } });

  // Portão: corredor curto com arco entre o pátio e o saguão
  corridor('Portão', l0.id, [{ x: 0, z: 42.5 }, { x: 0, z: 35 }], { width: 4.5 });
  asset('arch', 'Arco do portão', l0.id, 0, 40, { color: '#d8cbb3', scale: { x: 1.3, y: 1, z: 1 } });

  // Saguão com colunata
  room('Saguão', l0.id, rect(-8, 22, 8, 37));
  for (const x of [-4.5, 4.5]) for (const z of [26, 30, 34]) asset('pillar', 'Coluna', l0.id, x, z, { color: STONE });
  light('Tocha do saguão O', l0.id, -6.8, 29.5);
  light('Tocha do saguão L', l0.id, 6.8, 29.5);
  asset('bench', 'Banco', l0.id, -6.6, 25, { rotY: Math.PI / 2, color: '#b9a88a' });
  asset('bench', 'Banco', l0.id, 6.6, 25, { rotY: -Math.PI / 2, color: '#b9a88a' });

  corridor('Corredor sul', l0.id, [{ x: 0, z: 23.5 }, { x: 0, z: 15.5 }]);
  light('Tocha do corredor sul', l0.id, 0, 20, { intensity: 6, range: 9 });

  // Átrio central: sala circular com quatro lóbulos fundidos (forma de flor)
  const AX = 0, AZ = 6, AR = 10.5;
  circleRoom('Átrio central', l0.id, AX, AZ, AR, { floor: { enabled: true, thickness: 0.2, color: FLOOR } });
  for (const a of [45, 135, 225, 315]) {
    const c = onRing(AX, AZ, 8.4, a);
    circleRoom('Lóbulo do átrio', l0.id, c.x, c.z, 4.6, { floor: { enabled: true, thickness: 0.2, color: '#e3dccb' } });
    light('Braseiro do lóbulo', l0.id, onRing(AX, AZ, 10, a).x, onRing(AX, AZ, 10, a).z, { intensity: 7, range: 10 });
    asset('barrel', 'Braseiro', l0.id, onRing(AX, AZ, 10, a).x, onRing(AX, AZ, 10, a).z, { color: '#8a7a62', scale: { x: 1.2, y: 0.8, z: 1.2 } });
  }
  // anel interno em arco com quatro passagens (N, S, L, O)
  for (const a of [0, 90, 180, 270]) {
    add('wall', { name: 'Anel do átrio', levelId: l0.id, points: arcWall(AX, AZ, 5.2, a + 14, a + 76), height: 1.6, thickness: 0.4, color: '#e9e2d4' });
  }
  asset('platform', 'Altar', l0.id, AX, AZ, { color: '#d8cbb3', scale: { x: 0.9, y: 1, z: 0.9 } });
  asset('sphere', 'Cristal', l0.id, AX, AZ, { y: 0.4, color: '#6d9bb8', scale: { x: 1.1, y: 1.6, z: 1.1 }, collider: false });
  light('Luz do cristal', l0.id, AX, AZ, { y: 3, color: '#a8d4ff', intensity: 12, range: 16, shadows: true });

  // Ala oeste: Sala das tochas (a céu aberto, com escada para o mezanino)
  corridor('Corredor oeste', l0.id, [{ x: -9.5, z: AZ }, { x: -14, z: AZ - 1 }, { x: -19.5, z: AZ }], { width: 3.6 });
  room('Sala das tochas', l0.id, rect(-34, -2, -18, 15), {
    roof: { enabled: false, thickness: 0.25, color: STONE },
    floor: { enabled: true, thickness: 0.2, color: '#e3dccb' },
    deco: { type: 'rocks', side: 'inside', density: 0.25, color: '#b9a88a', inset: 0.9, seed: 3 },
  });
  add('connector', { name: 'Escada do mezanino', levelId: l0.id, fromLevelId: l0.id, toLevelId: l1.id, x: -29.5, z: 13.2, rotY: Math.PI, width: 2.6, color: '#d8cbb3' });
  for (const [x, z] of [[-32.5, 13.5], [-19.5, 13.5], [-19.5, -0.5]]) light('Tocha da ala oeste', l0.id, x, z, { intensity: 8, range: 11 });
  for (const [x, z, k] of [[-21, 1.5, 'crate'], [-22.2, 1.2, 'crate'], [-21.5, 2.7, 'barrel'], [-20.5, 12.5, 'barrel'], [-24, 13.4, 'crate']]) {
    asset(k, k === 'crate' ? 'Caixa' : 'Barril', l0.id, x, z, { color: k === 'crate' ? GOLD : '#c0632f', rotY: x });
  }

  // Ala leste: Cripta da água (sala circular com espelho d'água e ilha)
  corridor('Corredor leste', l0.id, [{ x: 9.5, z: AZ }, { x: 14, z: AZ + 1 }, { x: 19.5, z: AZ }], { width: 3.6 });
  const CX = 28, CZ = 6;
  circleRoom('Cripta da água', l0.id, CX, CZ, 9);
  room('Espelho d\'água', l0.id, circlePoints(CX, CZ, 5.6), {
    shape: 'circle', roof: { enabled: false, thickness: 0.25, color: STONE },
    floor: { enabled: true, thickness: 0.12, color: WATER },
    walls: { enabled: false, height: 0.5, thickness: 0.2, color: STONE, mode: 'continuous' },
  });
  for (const [r, a] of [[5.1, 182], [3.9, 194], [2.6, 178]]) {
    const p = onRing(CX, CZ, r, a);
    asset('cylinder', 'Pedra de passagem', l0.id, p.x, p.z, { color: '#d8cbb3', scale: { x: 1.3, y: 0.3, z: 1.3 } });
  }
  asset('cylinder', 'Ilha', l0.id, CX, CZ, { color: '#d8cbb3', scale: { x: 2.4, y: 0.35, z: 2.4 } });
  asset('crate', 'Baú da chave', l0.id, CX, CZ, { y: 0.35, color: GOLD });
  light('Luz da cripta', l0.id, CX, CZ, { y: 3.2, color: '#9fd0ff', intensity: 10, range: 14, shadows: true });
  for (const a of [60, 120, 240, 300]) {
    const p = onRing(CX, CZ, 7.6, a);
    asset('pillar', 'Coluna da cripta', l0.id, p.x, p.z, { color: STONE });
  }

  // Antecâmara: estátuas e a porta trancada do guardião
  corridor('Corredor norte', l0.id, [{ x: 0, z: AZ - 9.5 }, { x: 0, z: -8.5 }]);
  room('Antecâmara', l0.id, rect(-7, -19, 7, -7.5));
  for (const x of [-4, 4]) {
    asset('cube', 'Pedestal', l0.id, x, -16, { color: '#d8cbb3', scale: { x: 1.2, y: 0.8, z: 1.2 } });
    asset('sphere', 'Estátua', l0.id, x, -16, { y: 0.8, color: '#b9a88a', scale: { x: 1.1, y: 1.6, z: 1.1 } });
    light('Tocha da antecâmara', l0.id, x * 1.5, -9.5, { intensity: 7, range: 10 });
  }
  corridor('Passagem do guardião', l0.id, [{ x: 0, z: -18 }, { x: 0, z: -25.5 }], { width: 4.5 });
  asset('door', 'Porta trancada', l0.id, 0, -21.5, { color: '#8a7a62', scale: { x: 2.4, y: 1.3, z: 1.4 } });

  // Salão do guardião: sala do chefe circular, alcovas fundidas e anéis em arco
  const BX = 0, BZ = -38, BR = 13.5;
  circleRoom('Salão do guardião', l0.id, BX, BZ, BR, { floor: { enabled: true, thickness: 0.2, color: '#d8cbb3' }, walls: roomWalls(4) });
  for (const a of [215, 325]) {
    const c = onRing(BX, BZ, 12.5, a);
    circleRoom('Alcova', l0.id, c.x, c.z, 4.2, { walls: roomWalls(4), floor: { enabled: true, thickness: 0.2, color: '#cdbf9f' } });
    light('Chama da alcova', l0.id, onRing(BX, BZ, 14, a).x, onRing(BX, BZ, 14, a).z, { color: '#ff8a5c', intensity: 9, range: 11 });
  }
  for (const [a0, a1] of [[20, 70], [110, 160], [200, 250], [290, 340]]) {
    add('wall', { name: 'Anel do guardião', levelId: l0.id, points: arcWall(BX, BZ, 8, a0, a1), height: 1.2, thickness: 0.5, color: '#e9e2d4' });
  }
  for (let k = 0; k < 8; k++) {
    const p = onRing(BX, BZ, 11, 22.5 + k * 45);
    asset('pillar', 'Coluna do salão', l0.id, p.x, p.z, { color: STONE, scale: { x: 1.3, y: 1, z: 1.3 } });
  }
  asset('platform', 'Tablado do chefe', l0.id, BX, BZ, { color: '#b9a88a', scale: { x: 1.3, y: 1, z: 1.3 } });
  light('Fogo do guardião', l0.id, BX, BZ, { y: 3.4, color: '#ff7a4a', intensity: 14, range: 18, shadows: true });

  // ------------------------------------------------------------ Galeria superior
  // Mezanino sobre a ala oeste (plataforma sem parede), passarela e câmara do tesouro
  room('Mezanino', l1.id, rect(-34, -2, -25, 7), {
    roof: { enabled: false, thickness: 0.25, color: STONE },
    floor: { enabled: true, thickness: 0.3, color: '#e3dccb' },
    walls: { enabled: false, height: 1.1, thickness: 0.25, color: STONE, mode: 'continuous' },
    deco: { type: 'pillars', side: 'inside', density: 0.2, color: STONE, inset: 0.5, seed: 2 },
  });
  corridor('Passarela', l1.id, [{ x: -29.5, z: -0.5 }, { x: -29.5, z: -9 }, { x: -27.5, z: -16 }, { x: -27, z: -22.8 }], {
    width: 3.2, roof: { enabled: false, thickness: 0.25, color: STONE },
    walls: corWalls(1.1, 'blocks'), proc: { seed: 4, gapChance: 0, gapLength: 1, heightVar: 0.2, jitter: 0.05, segment: 1.2 },
  });
  light('Lanterna da passarela', l1.id, -29, -9, { y: 1.8, intensity: 6, range: 10 });
  const TX = -27, TZ = -28;
  circleRoom('Câmara do tesouro', l1.id, TX, TZ, 6.5, { floor: { enabled: true, thickness: 0.3, color: '#e3dccb' } });
  asset('crate', 'Baú do tesouro', l1.id, TX - 2.5, TZ - 2, { color: GOLD, scale: { x: 1.4, y: 1, z: 1 }, rotY: 0.5 });
  asset('barrel', 'Jarro', l1.id, TX - 4, TZ + 1.5, { color: '#c0632f' });
  asset('barrel', 'Jarro', l1.id, TX - 3.3, TZ + 3, { color: '#c0632f' });
  light('Brilho do tesouro', l1.id, TX - 1.5, TZ - 1, { color: '#ffd27a', intensity: 10, range: 12, shadows: true });
  // escadaria que desce da câmara do tesouro direto no salão do guardião
  corridor('Escadaria do guardião', l1.id, [{ x: TX + 4.5, z: TZ - 1 }, { x: -17, z: -32 }, { x: -10.5, z: -36 }], {
    endLevelId: l0.id, rampStyle: 'stairs', stepHeight: 0.25, width: 3.2,
  });
  light('Tocha da escadaria', l1.id, -17, -32, { y: 1.5, intensity: 7, range: 10 });

  // ------------------------------------------------------------ Agentes
  add('agent', { name: 'Herói', role: 'player', mode: 'platform', levelId: l0.id, x: 0, z: 50, rotY: Math.PI, color: '#5f8f6a' });
  add('agent', { name: 'Bolota do átrio', role: 'enemy', mode: 'arcade', behavior: 'wander', levelId: l0.id, x: -6, z: 0, color: '#b56b7a' });
  add('agent', { name: 'Bolota do átrio', role: 'enemy', mode: 'arcade', behavior: 'wander', levelId: l0.id, x: 6, z: 12, color: '#b56b7a' });
  const ring = objs.find((o) => o.name === 'Corredor oeste');
  add('agent', { name: 'Sentinela', role: 'enemy', mode: 'shooter', behavior: 'patrol', pathId: ring.id, levelId: l0.id, x: -14, z: AZ - 1, color: '#c0632f' });
  add('agent', { name: 'Morcego da cripta', role: 'enemy', mode: 'arcade', behavior: 'wander', levelId: l0.id, x: CX + 5, z: CZ - 5, color: '#4a6a8f' });
  add('agent', { name: 'Guardião da tesouraria', role: 'enemy', mode: 'arcade', behavior: 'chase', levelId: l1.id, x: TX + 1, z: TZ + 2, color: '#b56b7a' });
  add('agent', {
    name: 'Guardião', role: 'enemy', mode: 'shooter', behavior: 'chase', levelId: l0.id, x: BX, z: BZ - 2, rotY: 0, color: '#2f2a24',
    params: { speed: 2.4, range: 22, fireRate: 1.6, damage: 15, health: 400, projectileSpeed: 16, accuracy: 0.85 },
  });
  return doc;
}
