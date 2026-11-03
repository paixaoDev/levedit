// Física simples baseada em raycasts: chão (com subida de degraus), empurrão
// contra paredes e linha de visão. Suficiente para testar layout de levels.
import * as THREE from 'three';

const DIRS = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  return new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
});

export class World {
  constructor(root, { groundY = 0, solidGround = true, footprint = null } = {}) {
    // com fundo ligado, o espaço fora da pegada do level é só cenário
    this.footprint = footprint;
    this.meshes = [];
    this.boxes = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !o.userData.collider || o.userData.editorOnly) return;
      let p = o, vis = true;
      while (p) { if (!p.visible) { vis = false; break; } p = p.parent; }
      if (!vis) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      this.meshes.push(o);
      this.boxes.push(box);
    });
    this.groundY = groundY;
    this.solidGround = solidGround;
    this.rc = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._down = new THREE.Vector3(0, -1, 0);
    this._box = new THREE.Box3();
  }

  near(pos, r, yLo, yHi) {
    const b = this._box;
    b.min.set(pos.x - r, yLo, pos.z - r);
    b.max.set(pos.x + r, yHi, pos.z + r);
    const out = [];
    for (let i = 0; i < this.meshes.length; i++) if (this.boxes[i].intersectsBox(b)) out.push(this.meshes[i]);
    return out;
  }

  /** Altura do chão sob (x,z), procurando a partir de y+up para baixo. */
  ground(pos, up = 0.55, down = 60) {
    const cand = this.near(pos, 0.2, pos.y - down, pos.y + up);
    let best = null;
    if (cand.length) {
      this.rc.set(this._tmp.set(pos.x, pos.y + up, pos.z), this._down);
      this.rc.far = up + down;
      const hits = this.rc.intersectObjects(cand, false);
      if (hits.length) best = { y: hits[0].point.y, normal: hits[0].face?.normal };
    }
    if (this.solidGround && pos.y + up >= this.groundY && (!best || best.y < this.groundY)) best = { y: this.groundY };
    return best;
  }

  /** Empurra uma posição para fora das paredes. Retorna true se colidiu. */
  pushOut(pos, radius, heights) {
    let hit = false;
    const cand = this.near(pos, radius + 0.5, pos.y + Math.min(...heights) - 0.1, pos.y + Math.max(...heights) + 0.1);
    if (!cand.length) return false;
    for (const h of heights) {
      for (const d of DIRS) {
        this.rc.set(this._tmp.set(pos.x, pos.y + h, pos.z), d);
        this.rc.far = radius;
        const hits = this.rc.intersectObjects(cand, false);
        if (hits.length) {
          const pen = radius - hits[0].distance;
          if (pen > 0) { pos.x -= d.x * pen; pos.z -= d.z * pen; hit = true; }
        }
      }
    }
    return hit;
  }

  /** Fora do espaço jogável (só quando há fundo bloqueando)? */
  blocked(x, z) {
    return !!this.footprint && this.footprint.blocked(x, z);
  }

  /** Desfaz o passo que levaria para fora do espaço jogável (deslizando no eixo livre). */
  keepInside(pos, px, pz) {
    if (!this.footprint || !this.blocked(pos.x, pos.z) || this.blocked(px, pz)) return false;
    if (!this.blocked(pos.x, pz)) pos.z = pz;
    else if (!this.blocked(px, pos.z)) pos.x = px;
    else { pos.x = px; pos.z = pz; }
    return true;
  }

  /** Primeiro impacto ao longo de um raio. */
  raycast(origin, dir, far) {
    this.rc.set(origin, dir);
    this.rc.far = far;
    const hits = this.rc.intersectObjects(this.meshes, false);
    return hits[0] || null;
  }

  lineOfSight(a, b) {
    const d = this._tmp.copy(b).sub(a);
    const L = d.length();
    if (L < 1e-3) return true;
    d.divideScalar(L);
    const h = this.raycast(a.clone(), d.clone(), L);
    return !h || h.distance >= L - 0.3;
  }
}

/** Corpo de personagem (cápsula aproximada). */
export class CharacterBody {
  constructor(pos, { radius = 0.4, height = 1.8 } = {}) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.radius = radius;
    this.height = height;
    this.onGround = false;
    this.jumps = 0;
  }

  /**
   * @param {THREE.Vector3} wish velocidade horizontal desejada
   * @param {{gravity:number, airControl?:number}} p
   */
  update(dt, world, wish, p) {
    const control = this.onGround ? 1 : (p.airControl ?? 0.5);
    const k = Math.min(1, 14 * control * dt);
    this.vel.x += (wish.x - this.vel.x) * k;
    this.vel.z += (wish.z - this.vel.z) * k;
    this.vel.y -= p.gravity * dt;
    // integra em sub-passos para não atravessar paredes finas
    const steps = Math.max(1, Math.ceil((Math.hypot(this.vel.x, this.vel.z) * dt) / (this.radius * 0.8)));
    const sdt = dt / steps;
    const wasGround = this.onGround;
    for (let s = 0; s < steps; s++) {
      const px = this.pos.x, pz = this.pos.z;
      this.pos.x += this.vel.x * sdt;
      this.pos.z += this.vel.z * sdt;
      this.pos.y += this.vel.y * sdt;
      world.pushOut(this.pos, this.radius, [0.6, this.height * 0.6, this.height - 0.15]);
      world.keepInside?.(this.pos, px, pz);
    }
    const g = world.ground(this.pos, 0.55);
    const snap = wasGround ? 0.35 : 0.02;
    if (g && this.vel.y <= 0 && this.pos.y <= g.y + snap) {
      this.pos.y = g.y;
      this.vel.y = 0;
      this.onGround = true;
      this.jumps = 0;
    } else {
      this.onGround = false;
    }
  }
}

/** Física de carro arcade com derrapagem controlada por "grip". */
export class CarBody {
  constructor(pos, heading) {
    this.pos = pos.clone();
    this.heading = heading;
    this.speed = 0;
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.onGround = false;
    this.radius = 1.1;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  update(dt, world, input, p) {
    const { throttle = 0, steer = 0, handbrake = false } = input;
    if (throttle > 0) this.speed += p.accel * throttle * dt;
    else if (throttle < 0) this.speed += (this.speed > 0.5 ? -p.brake : -p.accel * 0.6) * -throttle * dt;
    else this.speed *= 1 - Math.min(1, 0.8 * dt);
    if (handbrake) this.speed *= 1 - Math.min(1, 1.5 * dt);
    this.speed = Math.max(-p.maxSpeed * 0.4, Math.min(p.maxSpeed, this.speed));
    const turnFactor = Math.max(-1, Math.min(1, this.speed / (p.maxSpeed * 0.25)));
    this.heading += steer * p.turnRate * dt * turnFactor * (handbrake ? 1.4 : 1);
    const desired = this.forward().multiplyScalar(this.speed);
    const grip = handbrake ? 0.12 : p.grip;
    const k = 1 - Math.pow(1 - Math.min(0.999, grip), dt * 12);
    this.vel.lerp(desired, k);
    this.vy -= 25 * dt;
    const steps = Math.max(1, Math.ceil((this.vel.length() * dt) / 0.6));
    let hit = false;
    for (let s = 0; s < steps; s++) {
      const px = this.pos.x, pz = this.pos.z;
      this.pos.addScaledVector(this.vel, dt / steps);
      this.pos.y += (this.vy * dt) / steps;
      if (world.pushOut(this.pos, this.radius, [0.6, 1.1])) hit = true;
      if (world.keepInside?.(this.pos, px, pz)) hit = true;
    }
    if (hit) { this.speed *= 0.55; this.vel.multiplyScalar(0.6); }
    const g = world.ground(this.pos, 0.7);
    if (g && this.vy <= 0 && this.pos.y <= g.y + (this.onGround ? 0.5 : 0.05)) {
      this.pos.y = g.y; this.vy = 0; this.onGround = true;
    } else this.onGround = false;
    return hit;
  }
}
