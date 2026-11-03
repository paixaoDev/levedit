// Fundo do level: cenário procedural (floresta, pedras, morros, montanhas,
// cidade) em volta do espaço jogável. É só para ver: não tem colisão e, no
// jogo, o player não sai da pegada do level (veja Footprint.blocked).
import * as THREE from 'three';
import { makeMesh } from '../render/materials.js';
import { rng, clamp, lerp, smoothstep } from '../util.js';
import { Batch, rock, tree, bush, building } from './nature.js';
import { BACKDROP_DEFAULTS } from '../model.js';
import { Footprint, noise2D } from './footprint.js';

export { Footprint };

/** Cores sugeridas ao trocar o estilo. */
export const BACKDROP_PRESETS = {
  forest: { color: '#5f8f6a', color2: '#8a7a62', ground: '#d5dcc0' },
  rocks: { color: '#b9a88a', color2: '#8a7a62', ground: '#e6dfcf' },
  mounds: { color: '#9bb57a', color2: '#c2a983', ground: '#ece5d6' },
  mountains: { color: '#9bb57a', color2: '#a39478', ground: '#dfe0cc' },
  city: { color: '#e9e2d4', color2: '#8a7a62', ground: '#d9d5cc' },
};

/**
 * Pegada (XZ) de tudo que é jogável no level: corredores, áreas, paredes,
 * escadas e assets. Agentes, luzes e marcadores do editor ficam de fora.
 */
export function levelFootprint(root, objectsById, { pad = 60, maxCells = 420 } = {}) {
  const tris = [];
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((m) => {
    if (!m.isMesh || m.userData.editorOnly || m.userData.isDepthTwin) return;
    let p = m;
    while (p && !p.userData.objId) p = p.parent;
    const o = p && objectsById(p.userData.objId);
    if (!o || o.type === 'agent' || o.type === 'light') return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
      arr[i * 2] = v.x; arr[i * 2 + 1] = v.z;
      box.expandByPoint(v);
    }
    tris.push(arr);
  });
  if (box.isEmpty()) return null;
  return Footprint.fromTriangles(tris, { minX: box.min.x, minZ: box.min.z, maxX: box.max.x, maxZ: box.max.z, minY: box.min.y }, { pad, maxCells });
}

/**
 * Constrói o grupo do fundo.
 * @param {Footprint} fp pegada do level (com margem para o raio do cenário)
 * @param {object} settings doc.settings.backdrop
 * @param {number} baseY altura do chão (nível mais baixo)
 */
export function buildBackdrop(fp, settings, baseY = 0) {
  const s = { ...BACKDROP_DEFAULTS, ...settings };
  const group = new THREE.Group();
  group.name = 'backdrop';
  if (!fp) return group;
  const rnd = rng((s.seed || 1) * 7121 + 3);
  const R = clamp(s.distance, 8, 160);
  const margin = Math.max(0, s.margin);
  const dens = clamp(s.density, 0.05, 1);
  const hs = clamp(s.height, 0.2, 4);
  const b = new Batch();
  const terrainStyles = s.style === 'mounds' || s.style === 'mountains';

  // chão do cenário (abaixo do piso para não brigar com ele)
  const ext = fp.bounds;
  const pad = R * 1.25;
  const gw = ext.maxX - ext.minX + pad * 2, gd = ext.maxZ - ext.minZ + pad * 2;
  if (!terrainStyles) {
    const g = new THREE.PlaneGeometry(gw, gd).rotateX(-Math.PI / 2).toNonIndexed();
    g.translate((ext.minX + ext.maxX) / 2, baseY - 0.03, (ext.minZ + ext.maxZ) / 2);
    const m = makeMesh(g, s.ground, { collider: false, edges: false, shadow: false });
    m.userData.backdropGround = true;
    group.add(m);
  }

  // amostragem com jitter: espalha pontos numa grade e aceita os que estão fora
  // da pegada (distância >= margem) e dentro do raio do cenário
  const scatter = (spacing, fn) => {
    for (let z = ext.minZ - R; z <= ext.maxZ + R; z += spacing) {
      for (let x = ext.minX - R; x <= ext.maxX + R; x += spacing) {
        const px = x + (rnd() - 0.5) * spacing * 0.9, pz = z + (rnd() - 0.5) * spacing * 0.9;
        const d = fp.distAt(px, pz);
        if (d < margin || d > R) continue;
        fn(px, pz, d);
      }
    }
  };

  switch (s.style) {
    case 'forest': {
      const sp = lerp(6, 1.9, dens);
      scatter(sp, (x, z, d) => {
        if (rnd() < 0.08) return; // clareiras
        const far = clamp((d - margin) / 12, 0, 1);
        const h = hs * lerp(3.5, 8, far * 0.6 + rnd() * 0.4) * (0.8 + rnd() * 0.4);
        const r = Math.max(sp * (0.55 + rnd() * 0.25), h * 0.22);
        // o tronco não pode encostar na pegada
        if (fp.distAt(x, z) - r * 0.3 < margin) return bush(b, rnd, s.color, x, baseY, z, Math.min(1, sp * 0.4), Math.min(1.2, hs));
        tree(b, rnd, { leaf: s.color, trunk: s.color2 }, x, baseY, z, h, r);
        if (d < margin + 3 && rnd() < 0.5) bush(b, rnd, s.color, x + (rnd() - 0.5) * sp, baseY, z + (rnd() - 0.5) * sp, 0.6 + rnd() * 0.5, 0.9);
      });
      break;
    }
    case 'rocks': {
      const sp = lerp(5, 1.6, dens);
      scatter(sp, (x, z, d) => {
        const far = clamp((d - margin) / 18, 0, 1);
        const r = hs * lerp(0.6, 3.2, far) * (0.6 + rnd() * 0.7);
        if (d - r * 0.9 < margin) return;
        rock(b, rnd, s.color, x, baseY - r * 0.15, z, r, r * (0.7 + rnd() * 0.6));
        if (rnd() < 0.3) rock(b, rnd, s.color2, x + r, baseY, z + (rnd() - 0.5) * r, r * 0.4, r * 0.35);
      });
      break;
    }
    case 'city': {
      const lot = lerp(16, 8, dens);
      for (let z = ext.minZ - R; z <= ext.maxZ + R; z += lot) {
        for (let x = ext.minX - R; x <= ext.maxX + R; x += lot) {
          // quarteirão com 1 a 4 prédios; ruas entre os quarteirões
          const split = rnd() < 0.5 ? 1 : 2;
          const cell = (lot - 2) / split;
          for (let i = 0; i < split; i++) {
            for (let j = 0; j < split; j++) {
              const w = cell * (0.7 + rnd() * 0.28), dd = cell * (0.7 + rnd() * 0.28);
              const cx = x + 1 + cell * (i + 0.5), cz = z + 1 + cell * (j + 0.5);
              const d = fp.distAt(cx, cz);
              const half = Math.hypot(w, dd) / 2;
              if (d - half < margin || d > R) continue;
              // perto do level, prédios baixos (não tapam a vista); ao longe, torres
              const far = clamp((d - margin) / 35, 0, 1);
              const h = hs * (3 + rnd() * 5 + far * far * 30 * Math.pow(rnd(), 1.3));
              building(b, rnd, { wall: s.color, trim: s.color2 }, cx, baseY, cz, w, dd, h, 0);
            }
          }
        }
      }
      break;
    }
    case 'mounds':
    case 'mountains':
      group.add(...terrain(fp, s, { R, margin, hs, baseY, rnd }));
      if (s.style === 'mounds' && dens > 0.15) {
        // arbustos e árvores no alto dos morros
        const H = 3 * hs;
        scatter(lerp(12, 4, dens), (x, z, d) => {
          if (d < margin + 4) return;
          const y = baseY + mountH(fp, s, x, z, d, { margin, hs, R });
          if (y < baseY + H * 0.7) return;
          if (rnd() < 0.6) bush(b, rnd, s.color, x, y - 0.1, z, 0.8 + rnd() * 0.6, 1 + rnd() * 0.6);
          else tree(b, rnd, { leaf: s.color, trunk: s.color2 }, x, y - 0.1, z, 3 + rnd() * 2.5, 1.4);
        });
      }
      break;
    default: break;
  }
  if (!b.empty) group.add(...b.build({ threshold: 32, shadow: s.style !== 'city' }));
  group.traverse((m) => { m.userData.backdrop = true; m.raycast = () => {}; if (m.isMesh) m.userData.collider = false; });
  return group;
}

/** Altura do relevo num ponto (0 na beira do level). */
function mountH(fp, s, x, z, d, { margin, hs, R }) {
  const n = noise2D(s.seed || 1);
  if (s.style === 'mounds') {
    // degrau tipo "morrinho" de jogo de plataforma: sobe rápido e vira platô
    const H = 3 * hs;
    const t = smoothstep(clamp((d - margin) / 3.2, 0, 1));
    const bumps = 0.75 + 0.35 * n(x * 0.06, z * 0.06) + 0.25 * n(x * 0.17 + 9, z * 0.17 - 4);
    const tier = d > margin + 14 ? smoothstep(clamp((d - margin - 14) / 4, 0, 1)) * H * 0.8 * (0.6 + 0.5 * n(x * 0.03, z * 0.03 + 7)) : 0;
    return t * H * bumps + tier;
  }
  // montanhas: planície perto, cordilheira ao longe
  const H = 26 * hs;
  const start = margin + Math.min(10, R * 0.2);
  const t = smoothstep(clamp((d - start) / Math.max(8, R * 0.55), 0, 1));
  let f = 0, amp = 1, fr = 0.018;
  for (let o = 0; o < 4; o++) { f += amp * (1 - Math.abs(n(x * fr + o * 13, z * fr - o * 7))); amp *= 0.5; fr *= 2.1; }
  return t * H * Math.pow(f / 1.875, 1.6) + t * 1.5;
}

/** Malha de relevo em grade, colorida por inclinação/altura (topo, encosta, chão). */
function terrain(fp, s, { R, margin, hs, baseY }) {
  const ext = fp.bounds;
  const x0 = ext.minX - R * 1.15, z0 = ext.minZ - R * 1.15;
  const w = ext.maxX - ext.minX + R * 2.3, d = ext.maxZ - ext.minZ + R * 2.3;
  const cell = Math.max(s.style === 'mounds' ? 0.8 : 1.6, Math.max(w, d) / 260);
  const nx = Math.ceil(w / cell), nz = Math.ceil(d / cell);
  const H = new Float32Array((nx + 1) * (nz + 1));
  const peak = s.style === 'mounds' ? 3 * hs : 26 * hs;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      const dd = fp.distAt(x, z);
      H[j * (nx + 1) + i] = dd <= margin ? 0 : mountH(fp, s, x, z, dd, { margin, hs, R });
    }
  }
  const snow = '#f4f1ea';
  const buckets = new Map();
  const put = (c, ...p) => { let a = buckets.get(c); if (!a) buckets.set(c, (a = [])); a.push(...p); };
  const P = (i, j) => [x0 + i * cell, baseY - 0.04 + H[j * (nx + 1) + i], z0 + j * cell];
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const up = Math.abs(ny / len);
    const hAvg = (a[1] + b[1] + c[1]) / 3 - baseY;
    let col;
    if (hAvg < 0.12) col = s.ground;
    else if (s.style === 'mounds') col = up < 0.8 ? s.color2 : s.color;
    else col = hAvg > peak * 0.68 && up > 0.55 ? snow : up < 0.72 ? s.color2 : s.color;
    put(col, ...a, ...b, ...c);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1);
      tri(a, e, c); tri(a, c, b);
    }
  }
  const meshes = [];
  for (const [col, arr] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const m = makeMesh(g, col, { collider: false, edges: col !== s.ground, threshold: 40, shadow: s.style === 'mounds' });
    meshes.push(m);
  }
  return meshes;
}
