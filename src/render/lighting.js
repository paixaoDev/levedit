// Iluminação da cena: presets (editor plano, dia, entardecer, noite), sol com
// sombra, luz global interna e luzes pontuais colocadas no level.
//
// Teto e luz: os tetos entram no shadow map do sol, então um corredor/área "com
// teto" fica na sombra do sol. A luz interna (userData.ignoresRoofs) tem o shadow
// map desenhado com os tetos escondidos (veja installRoofShadowPass): ela entra
// em qualquer espaço fechado e faz sombra só com paredes, objetos e agentes. Ela usa o mesmo azimute do
// sol, mais a pino, então fora as sombras dela caem dentro das do sol (vira um
// reforço de contato perto da base) e não aparece sombra dupla.
import * as THREE from 'three';
import { THEME } from './materials.js';
import { LIGHTING_DEFAULTS } from '../model.js';

export { LIGHTING_DEFAULTS };

export const LIGHT_PRESETS = {
  editor: { label: 'Editor (plano)' },
  day: { label: 'Dia' },
  dusk: { label: 'Entardecer' },
  night: { label: 'Noite' },
};

export const ROOF_VIEWS = { dotted: 'Pontilhado', solid: 'Sólido', hidden: 'Oculto' };


// parâmetros de cada preset (intensidades em escala física do three r160)
const P = {
  editor: { bg: THEME.background, hemi: [0xffffff, 0xd9cfbd, 1.35], sun: [0xffffff, 1.35, 60], fill: 0.45, shadows: false, interior: 0, points: false },
  day: { bg: 0xf3f0e8, hemi: [0xeaf2ff, 0xcabfa8, 0.95], sun: [0xfff4e2, 2.3, 52], fill: 0, shadows: true, interior: 1.3, points: true },
  dusk: { bg: 0xeadccb, hemi: [0xf2c9a4, 0x8f7a6a, 0.7], sun: [0xffb070, 2.4, 16], fill: 0, shadows: true, interior: 1, points: true },
  night: { bg: 0x1f2430, hemi: [0x5a6a8f, 0x2a2a33, 0.35], sun: [0x9fb4ff, 0.5, 48], fill: 0, shadows: true, interior: 0.6, points: true },
};

export class LightRig {
  constructor(scene) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd9cfbd, 1.35);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.35);
    this.fill = new THREE.DirectionalLight(0xfff3e0, 0.45);
    this.fill.position.set(-40, 25, -30);
    this.interior = new THREE.DirectionalLight(0xfff1dc, 0);
    for (const l of [this.sun, this.interior]) {
      l.shadow.mapSize.set(2048, 2048);
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.04;
      scene.add(l.target);
    }
    this.interior.userData.ignoresRoofs = true; // teto bloqueia o sol, não a luz interna
    this.interior.shadow.radius = 4;
    scene.add(this.hemi, this.sun, this.fill, this.interior);
    this.bounds = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 6, 20));
    this.settings = { ...LIGHTING_DEFAULTS };
    this.lit = false;
  }

  /** Aplica as configurações do documento (doc.settings.lighting). */
  apply(settings = {}) {
    const s = { ...LIGHTING_DEFAULTS, ...settings };
    this.settings = s;
    const p = P[s.preset] || P.editor;
    this.lit = s.preset !== 'editor';
    this.scene.background = new THREE.Color(p.bg);
    if (this.scene.fog) this.scene.fog.color.set(p.bg);
    this.hemi.color.set(p.hemi[0]);
    this.hemi.groundColor.set(p.hemi[1]);
    this.hemi.intensity = p.hemi[2];
    this.sun.color.set(p.sun[0]);
    this.sun.intensity = p.sun[1];
    this.fill.intensity = p.fill;
    this.sun.castShadow = p.shadows;
    this.interior.intensity = p.interior * s.interior;
    this.interior.castShadow = p.shadows && this.interior.intensity > 0;
    this.interior.visible = this.interior.intensity > 0;
    this._elev = p.sun[2];
    this.fit();
  }

  /** Enquadra as câmeras de sombra no level (chamar após reconstruir a cena). */
  fit(box) {
    if (box && !box.isEmpty()) this.bounds.copy(box);
    const c = this.bounds.getCenter(new THREE.Vector3());
    const r = Math.max(10, this.bounds.getSize(new THREE.Vector3()).length() * 0.5 + 2);
    const az = THREE.MathUtils.degToRad(this.settings.sunAngle ?? 35);
    const place = (light, elevDeg) => {
      const el = THREE.MathUtils.degToRad(elevDeg);
      const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      light.position.copy(c).addScaledVector(dir, r * 2);
      light.target.position.copy(c);
      light.target.updateMatrixWorld();
      const cam = light.shadow.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 0.5; cam.far = r * 4;
      cam.updateProjectionMatrix();
      // mapa mais fino para levels pequenos, maior para grandes
      const size = r > 60 ? 4096 : 2048;
      if (light.shadow.mapSize.x !== size) {
        light.shadow.mapSize.set(size, size);
        light.shadow.map?.dispose();
        light.shadow.map = null;
      }
    };
    place(this.sun, this._elev ?? 60);
    place(this.interior, 74);
  }
}

/** Constrói a luz pontual de um objeto 'light' (corpo do editor fica no builder). */
export function makePointLight(o) {
  const l = new THREE.PointLight(new THREE.Color(o.color), o.intensity, o.range, 2);
  l.castShadow = !!o.shadows;
  l.shadow.mapSize.set(512, 512);
  l.shadow.bias = -0.002;
  l.shadow.normalBias = 0.03;
  l.shadow.camera.near = 0.1;
  l.shadow.camera.far = o.range;
  l.userData.pointLight = true;
  return l;
}

/**
 * O three desenha todos os shadow maps numa passada só. Aqui ela é dividida em
 * duas: primeiro as luzes normais (com tetos), depois as que ignoram tetos, com
 * os tetos escondidos só durante essa segunda passada.
 */
export function installRoofShadowPass(renderer, getRoofs) {
  const sm = renderer.shadowMap;
  const render = sm.render.bind(sm);
  sm.render = (lights, scene, camera) => {
    const normal = [], noRoof = [];
    for (const l of lights) (l.userData.ignoresRoofs ? noRoof : normal).push(l);
    if (normal.length) render(normal, scene, camera);
    if (!noRoof.length) return;
    const roofs = getRoofs().filter((m) => m.visible);
    for (const m of roofs) m.visible = false;
    render(noRoof, scene, camera);
    for (const m of roofs) m.visible = true;
  };
}
