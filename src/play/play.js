// Modo jogo: testa o level com o agente player (FPS, plataforma ou carro) e
// inimigos (atirador, arcade, carro) com comportamentos parado/vagar/patrulhar/perseguir.
import * as THREE from 'three';
import { World, CharacterBody, CarBody } from './physics.js';
import { buildAgentBody, corridorSamples, makeContext } from '../builders/index.js';
import { samplePath } from '../math/curve.js';
import { normalizeObject, makeObject } from '../model.js';
import { applyVisualState } from '../render/materials.js';

const V = () => new THREE.Vector3();

export class PlayMode {
  constructor(vp, store) {
    this.vp = vp;
    this.store = store;
    this.active = false;
    this.keys = new Set();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 800);
    this._onKeyDown = (e) => this.onKeyDown(e);
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => this.onMouseMove(e);
    this._onMouseDown = (e) => this.onMouseDown(e);
    this._onMouseUp = () => { this.mouseDown = false; };
    this._onBlur = () => this.keys.clear();
    this._onResize = () => this.resize();
    vp.onFrame.push((dt) => { if (this.active) this.update(dt); });
  }

  // ------------------------------------------------------------- ciclo
  start() {
    if (this.active) return;
    const doc = this.store.doc;
    const ctx = makeContext(doc);
    this.ctx = ctx;
    this.active = true;
    this.vp.playing = true;
    this.store.select(null);
    // todos os objetos em estado normal; esconde marcadores de agentes do editor
    for (const [id, g] of this.vp.objects) {
      const o = this.store.get(id);
      const lvl = this.store.level(o?.levelId);
      g.visible = lvl ? lvl.visible : true;
      applyVisualState(g, 'normal');
      if (o?.type === 'agent') g.visible = false;
    }
    this.vp.helpers.visible = false;
    const minY = Math.min(...doc.levels.map((l) => l.elevation));
    this.world = new World(this.vp.root, { groundY: minY, solidGround: doc.settings.solidGround });
    this.minY = minY;
    this.runtime = new THREE.Group();
    this.vp.scene.add(this.runtime);

    // player
    const agents = doc.objects.filter((o) => o.type === 'agent');
    const sel = agents.find((a) => a.id === this._preferredPlayerId && a.role === 'player');
    let pdata = sel || agents.find((a) => a.role === 'player');
    if (!pdata) {
      const t = this.vp.controls.target;
      pdata = makeObject('agent', { role: 'player', mode: 'fps', x: t.x, z: t.z, levelId: doc.activeLevelId });
      this.toast('Nenhum player no level: usando FPS padrão. Adicione um agente player.');
    }
    this.player = this.makePlayer(normalizeObject(JSON.parse(JSON.stringify(pdata))));
    // primeira pessoa: teto sólido; câmeras de fora continuam vendo através dele
    this.vp.playRoofView = pdata.mode === 'fps' ? 'solid' : 'dotted';
    this.vp.applyLighting();
    for (const g of this.vp.objects.values()) {
      applyVisualState(g, 'normal');
      g.traverse((m) => { if (m.userData.editorOnly) m.visible = false; });
    }
    this.enemies = agents.filter((a) => a.role === 'enemy').map((a) => this.makeEnemy(normalizeObject(JSON.parse(JSON.stringify(a)))));
    this.projectiles = [];
    this.effects = [];
    this.stats = { kills: 0, deaths: 0, time: 0 };
    this.cleared = false;

    this.buildHud();
    this.resize();
    this.camera.position.copy(this.vp.camera.position);
    this.camera.lookAt(this.player.body.pos);
    this.vp.overrideCamera = this.camera;
    this.vp.controls.enabled = false;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.vp.dom.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);
    this.dispatch('start');
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.vp.playing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.vp.scene.remove(this.runtime);
    this.runtime = null;
    this.vp.helpers.visible = true;
    this.vp.overrideCamera = null;
    this.vp.controls.enabled = true;
    this.hud?.remove();
    this.hud = null;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.vp.dom.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    this.keys.clear();
    this.vp.sync({ all: true });
    this.dispatch('stop');
  }

  dispatch(name) { window.dispatchEvent(new CustomEvent(`play:${name}`)); }

  resize() {
    const r = this.vp.container.getBoundingClientRect();
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- entidades
  spawnPos(o) {
    const p = new THREE.Vector3(o.x, this.ctx.levelY(o.levelId) + 0.5, o.z);
    const g = this.world.ground(p, 2);
    if (g) p.y = g.y;
    return p;
  }

  makePlayer(o) {
    const spawn = this.spawnPos(o);
    const mesh = buildAgentBody(o);
    this.runtime.add(mesh);
    const pl = { o, p: o.params, mode: o.mode, mesh, spawn, health: o.params.health, hurtFlash: 0, dead: 0, fireCd: 0 };
    if (o.mode === 'car') {
      pl.body = new CarBody(spawn, o.rotY);
      pl.camPos = spawn.clone().add(new THREE.Vector3(0, 4, -8).applyAxisAngle(new THREE.Vector3(0, 1, 0), o.rotY));
    } else {
      pl.body = new CharacterBody(spawn, { radius: 0.4, height: o.mode === 'fps' ? 1.8 : 1.6 });
    }
    pl.yaw = o.rotY + Math.PI; // câmera olha para -Z local
    pl.pitch = 0;
    pl.camYaw = o.rotY + Math.PI;
    if (o.mode === 'fps') mesh.visible = false;
    return pl;
  }

  makeEnemy(o) {
    const spawn = this.spawnPos(o);
    const mesh = buildAgentBody(o);
    this.runtime.add(mesh);
    const e = { o, p: o.params, mode: o.mode, mesh, spawn, health: o.params.health, cd: Math.random(), hitCd: 0, path: this.pathFor(o), pathIdx: 0, pathDir: 1, wander: null, wanderT: 0, alive: true, flash: 0 };
    e.body = o.mode === 'car' ? new CarBody(spawn, o.rotY) : new CharacterBody(spawn, { radius: o.mode === 'arcade' ? 0.6 : 0.42, height: 1.8 });
    if (e.path.length) {
      // começa no ponto mais próximo do caminho
      let best = 0, bd = Infinity;
      e.path.forEach((q, i) => { const d = q.distanceTo(spawn); if (d < bd) { bd = d; best = i; } });
      e.pathIdx = best;
    }
    return e;
  }

  pathFor(o) {
    if (!o.pathId) return [];
    const src = this.store.get(o.pathId);
    if (!src || !src.points?.length) return [];
    let pts;
    if (src.type === 'corridor') pts = corridorSamples(src, this.ctx).samples;
    else {
      const y = this.ctx.levelY(src.levelId);
      pts = samplePath(src.points, { closed: src.type === 'area' || src.closed, smooth: src.smooth, spacing: 1 }).map((p) => ({ ...p, y }));
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const v = new THREE.Vector3(p.x, p.y ?? 0, p.z);
      if (!out.length || out[out.length - 1].distanceTo(v) > 2.5 || i === pts.length - 1) out.push(v);
    }
    out.closed = src.type === 'area' || !!src.closed;
    return out;
  }

  // ------------------------------------------------------------- input
  onKeyDown(e) {
    if (e.code === 'Escape') {
      if (!document.pointerLockElement) this.stop();
      return;
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.code === 'Space' && !this.keys.has('Space')) this.jumpPressed = true;
    if (e.code === 'KeyR') this.respawn();
    this.keys.add(e.code);
  }

  onMouseMove(e) {
    const pl = this.player;
    if (!pl) return;
    const sens = 0.0022 * (pl.p.sensitivity ?? 1);
    if (document.pointerLockElement === this.vp.dom) {
      pl.yaw -= e.movementX * sens;
      pl.pitch = Math.max(-1.45, Math.min(1.45, pl.pitch - e.movementY * sens));
      if (pl.mode !== 'fps') pl.camYaw -= e.movementX * sens;
    } else if (this.mouseDown && pl.mode !== 'fps') {
      pl.camYaw -= e.movementX * 0.005;
    }
  }

  onMouseDown(e) {
    this.mouseDown = true;
    const pl = this.player;
    if (pl.mode === 'fps') {
      if (document.pointerLockElement !== this.vp.dom) { this.vp.dom.requestPointerLock?.(); return; }
      this.firing = true;
    }
  }

  axis(neg, pos) {
    return (this.keys.has(pos[0]) || this.keys.has(pos[1]) ? 1 : 0) - (this.keys.has(neg[0]) || this.keys.has(neg[1]) ? 1 : 0);
  }

  // ------------------------------------------------------------- update
  update(dt) {
    this.stats.time += dt;
    const pl = this.player;
    if (pl.dead > 0) {
      pl.dead -= dt;
      if (pl.dead <= 0) this.respawn();
    } else {
      if (pl.mode === 'fps') this.updateFps(pl, dt);
      else if (pl.mode === 'platform') this.updatePlatform(pl, dt);
      else this.updateCar(pl, dt);
      if (pl.body.pos.y < this.minY - 40) { this.toast('Caiu do level!'); this.respawn(); }
    }
    this.jumpPressed = false;
    for (const e of this.enemies) if (e.alive) this.updateEnemy(e, dt);
    this.updateProjectiles(dt);
    this.updateEffects(dt);
    this.updateHud(dt);
  }

  updateFps(pl, dt) {
    const p = pl.p;
    const fwd = this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const str = this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const sp = p.speed * (this.keys.has('ShiftLeft') ? p.sprint : 1);
    const f = V().set(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    const r = V().set(Math.cos(pl.yaw), 0, -Math.sin(pl.yaw));
    const wish = f.multiplyScalar(fwd).add(r.multiplyScalar(str));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(sp);
    if (this.jumpPressed && pl.body.onGround) pl.body.vel.y = p.jump;
    pl.body.update(dt, this.world, wish, { gravity: p.gravity, airControl: 0.4 });
    this.camera.position.copy(pl.body.pos).add(V().set(0, p.eyeHeight, 0));
    this.camera.rotation.set(pl.pitch, pl.yaw, 0, 'YXZ');
    pl.mesh.position.copy(pl.body.pos);
    pl.mesh.rotation.y = pl.yaw + Math.PI;
    // tiro
    pl.fireCd -= dt;
    if ((this.firing || (this.mouseDown && document.pointerLockElement)) && pl.fireCd <= 0) {
      this.firing = false;
      pl.fireCd = 1 / p.fireRate;
      this.playerShoot(pl);
    }
  }

  playerShoot(pl) {
    const origin = this.camera.position.clone();
    const dir = V().set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const wh = this.world.raycast(origin, dir, 200);
    let maxD = wh ? wh.distance : 200;
    let target = null;
    const rc = new THREE.Raycaster(origin, dir, 0, maxD);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const h = rc.intersectObject(e.mesh, true)[0];
      if (h && h.distance < maxD) { maxD = h.distance; target = e; }
    }
    const end = origin.clone().addScaledVector(dir, maxD);
    const gun = origin.clone().add(V().set(0.25, -0.2, 0).applyQuaternion(this.camera.quaternion));
    this.tracer(gun, end, 0xc0632f);
    if (target) this.damageEnemy(target, pl.p.damage);
  }

  updatePlatform(pl, dt) {
    const p = pl.p;
    const rot = this.axis(['KeyQ', 'KeyQ'], ['KeyE', 'KeyE']);
    pl.camYaw -= rot * dt * 2.2;
    const fwd = this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const str = this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const a = pl.camYaw;
    const f = V().set(-Math.sin(a), 0, -Math.cos(a));
    const r = V().set(Math.cos(a), 0, -Math.sin(a));
    const wish = f.multiplyScalar(fwd).add(r.multiplyScalar(str));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(p.speed * (this.keys.has('ShiftLeft') ? 1.4 : 1));
    const b = pl.body;
    if (this.jumpPressed) {
      if (b.onGround) { b.vel.y = p.jump; b.jumps = 1; }
      else if (p.doubleJump && b.jumps < 2) { b.vel.y = p.jump * 0.85; b.jumps = 2; this.burst(b.pos, 0xd8cbb3); }
    }
    // pulo curto ao soltar
    if (!this.keys.has('Space') && b.vel.y > 0 && !b.onGround) b.vel.y -= p.gravity * dt * 0.8;
    b.update(dt, this.world, wish, { gravity: p.gravity, airControl: p.airControl });
    pl.mesh.position.copy(b.pos);
    if (wish.lengthSq() > 0.1) {
      const target = Math.atan2(wish.x, wish.z);
      pl.mesh.rotation.y = lerpAngle(pl.mesh.rotation.y, target, Math.min(1, dt * 12));
    }
    // squash & stretch
    const sy = b.onGround ? 1 : 1 + Math.min(0.25, Math.abs(b.vel.y) * 0.02);
    pl.mesh.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    // stomp
    if (b.vel.y < -1) {
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const top = e.body.pos.y + (e.mode === 'car' ? 1.4 : e.mode === 'arcade' ? 1.2 : 1.9);
        const dh = Math.hypot(e.body.pos.x - b.pos.x, e.body.pos.z - b.pos.z);
        if (dh < (e.mode === 'car' ? 1.6 : 0.95) && b.pos.y > top - 0.6 && b.pos.y < top + 0.4) {
          this.damageEnemy(e, p.stompDamage);
          b.vel.y = p.jump * 0.75;
          b.jumps = 1;
        }
      }
    }
    // câmera em terceira pessoa
    const d = p.cameraDistance;
    const desired = V().set(Math.sin(a) * d, d * 0.55 + 1.5, Math.cos(a) * d).add(b.pos);
    this.camera.position.lerp(desired, Math.min(1, dt * 6));
    this.camera.lookAt(b.pos.x, b.pos.y + 1.2, b.pos.z);
  }

  updateCar(pl, dt) {
    const p = pl.p;
    const b = pl.body;
    const input = {
      throttle: this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']),
      steer: -this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      handbrake: this.keys.has('Space'),
    };
    b.update(dt, this.world, input, p);
    pl.mesh.position.copy(b.pos);
    pl.mesh.rotation.y = b.heading;
    // leve inclinação na curva
    pl.mesh.rotation.z = -input.steer * Math.min(1, Math.abs(b.speed) / p.maxSpeed) * 0.06;
    // atropelar inimigos
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.ramCd = (e.ramCd || 0) - dt;
      if (e.body.pos.distanceTo(b.pos) < 2.1 && Math.abs(b.speed) > 5 && e.ramCd <= 0) {
        e.ramCd = 0.6;
        this.damageEnemy(e, p.ramDamage * Math.min(1.5, Math.abs(b.speed) / (p.maxSpeed * 0.6)));
        const push = e.body.pos.clone().sub(b.pos).setY(0).normalize().multiplyScalar(8);
        if (e.body.vel) { e.body.vel.x += push.x; e.body.vel.z += push.z; e.body.vel.y = 4; }
        b.speed *= 0.8;
      }
    }
    const f = b.forward();
    const desired = b.pos.clone().addScaledVector(f, -8.5).add(V().set(0, 3.8, 0));
    this.camera.position.lerp(desired, Math.min(1, dt * 5));
    this.camera.lookAt(b.pos.x + f.x * 4, b.pos.y + 1, b.pos.z + f.z * 4);
  }

  // ------------------------------------------------------------- inimigos
  playerTarget() {
    const b = this.player.body;
    return b.pos.clone().add(V().set(0, this.player.mode === 'car' ? 0.8 : 1.1, 0));
  }

  updateEnemy(e, dt) {
    const p = e.p;
    const pl = this.player;
    const b = e.body;
    const eye = b.pos.clone().add(V().set(0, e.mode === 'car' ? 1 : 1.5, 0));
    const tgt = this.playerTarget();
    const dist = eye.distanceTo(tgt);
    const alivePlayer = pl.dead <= 0;
    const sees = alivePlayer && dist < (p.range ?? 20) && this.world.lineOfSight(eye, tgt);
    if (sees) e.alert = 2.5; else e.alert = Math.max(0, (e.alert || 0) - dt);
    const alerted = e.alert > 0 && alivePlayer;

    let goal = null; // ponto para onde andar
    const behavior = e.o.behavior;
    if (alerted && (behavior === 'chase' || e.mode === 'arcade' || (e.mode === 'car' && behavior !== 'idle'))) goal = pl.body.pos.clone();
    else if (behavior === 'patrol' && e.path.length) goal = this.patrolGoal(e);
    else if (behavior === 'wander' || (behavior === 'patrol' && !e.path.length)) goal = this.wanderGoal(e, dt);
    else if (behavior === 'chase' && !alerted) goal = this.wanderGoal(e, dt);

    if (e.mode === 'shooter') {
      // atirador mantém distância quando vê o player
      if (sees && behavior !== 'chase') goal = null;
      if (sees && behavior === 'chase' && dist < 8) goal = null;
    }

    if (e.mode === 'car') {
      const input = { throttle: 0, steer: 0 };
      if (goal) {
        const to = goal.clone().sub(b.pos);
        const want = Math.atan2(to.x, to.z);
        const diff = angleDiff(want, b.heading);
        input.steer = Math.max(-1, Math.min(1, diff * 2));
        input.throttle = Math.abs(diff) > 1.6 ? -0.5 : Math.abs(diff) > 0.6 ? 0.5 : 1;
        if (to.length() < 2.5 && !alerted) input.throttle = 0.2;
      }
      const hit = b.update(dt, this.world, input, { accel: p.accel, brake: 20, maxSpeed: p.maxSpeed, turnRate: p.turnRate, grip: 0.8 });
      if (hit && Math.abs(b.speed) < 2) { b.speed = -4; b.heading += 0.4; } // destravar
      e.mesh.position.copy(b.pos);
      e.mesh.rotation.y = b.heading;
    } else {
      const wish = V();
      if (goal) {
        const to = goal.clone().sub(b.pos).setY(0);
        const L = to.length();
        if (L > 0.6) wish.copy(to).divideScalar(L).multiplyScalar(p.speed * (alerted && e.mode === 'arcade' ? 1.3 : 1));
      }
      if (e.mode === 'arcade' && p.jumpy && b.onGround && Math.random() < dt * (alerted ? 1.5 : 0.4)) b.vel.y = 6;
      b.update(dt, this.world, wish, { gravity: 22, airControl: 0.7 });
      e.mesh.position.copy(b.pos);
      let face = null;
      if (sees && e.mode === 'shooter') face = Math.atan2(tgt.x - b.pos.x, tgt.z - b.pos.z);
      else if (wish.lengthSq() > 0.1) face = Math.atan2(wish.x, wish.z);
      if (face !== null) e.mesh.rotation.y = lerpAngle(e.mesh.rotation.y, face, Math.min(1, dt * 8));
      if (e.mode === 'arcade') e.mesh.children[0] && (e.mesh.children[0].rotation.y += dt * 3);
    }

    if (b.pos.y < this.minY - 40) { b.pos.copy(e.spawn); if (b.vel) b.vel.set(0, 0, 0); }

    // ataques
    e.cd -= dt;
    e.hitCd -= dt;
    if (e.mode === 'shooter' && sees && e.cd <= 0) {
      e.cd = 1 / p.fireRate;
      const muzzle = b.pos.clone().add(V().set(0, 1.25, 0)).add(V().set(Math.sin(e.mesh.rotation.y), 0, Math.cos(e.mesh.rotation.y)).multiplyScalar(0.8));
      const dir = tgt.clone().sub(muzzle).normalize();
      const spread = (1 - p.accuracy) * 0.25;
      dir.x += (Math.random() - 0.5) * spread; dir.y += (Math.random() - 0.5) * spread; dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();
      this.spawnProjectile(muzzle, dir.multiplyScalar(p.projectileSpeed), p.damage);
    }
    const touchR = e.mode === 'car' ? 2.2 : e.mode === 'arcade' ? 1.1 : 0.9;
    const flat = Math.hypot(pl.body.pos.x - b.pos.x, pl.body.pos.z - b.pos.z);
    const vert = Math.abs(pl.body.pos.y - b.pos.y);
    if (alivePlayer && flat < touchR && vert < 1.4 && e.hitCd <= 0 && (e.mode !== 'car' || Math.abs(b.speed) > 3)) {
      if (!(pl.mode === 'platform' && pl.body.vel.y < -1)) {
        e.hitCd = 0.9;
        this.damagePlayer(p.damage, b.pos);
      }
    }
    if (e.flash > 0) {
      e.flash -= dt;
      e.mesh.scale.setScalar(1 + Math.max(0, e.flash) * 0.6);
    }
  }

  patrolGoal(e) {
    const path = e.path;
    const goal = path[e.pathIdx];
    if (Math.hypot(goal.x - e.body.pos.x, goal.z - e.body.pos.z) < (e.mode === 'car' ? 3 : 1.2)) {
      if (path.closed) e.pathIdx = (e.pathIdx + 1) % path.length;
      else {
        if (e.pathIdx + e.pathDir >= path.length || e.pathIdx + e.pathDir < 0) e.pathDir *= -1;
        e.pathIdx += e.pathDir;
      }
    }
    return path[e.pathIdx];
  }

  wanderGoal(e, dt) {
    e.wanderT -= dt;
    if (!e.wander || e.wanderT <= 0 || Math.hypot(e.wander.x - e.body.pos.x, e.wander.z - e.body.pos.z) < 1) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 6;
      e.wander = e.spawn.clone().add(V().set(Math.sin(a) * r, 0, Math.cos(a) * r));
      e.wanderT = 3 + Math.random() * 3;
    }
    return e.wander;
  }

  damageEnemy(e, dmg) {
    e.health -= dmg;
    e.flash = 0.15;
    this.burst(e.body.pos.clone().add(V().set(0, 1, 0)), 0xc0632f, 5);
    e.alert = 4;
    if (e.health <= 0) {
      e.alive = false;
      this.runtime.remove(e.mesh);
      this.burst(e.body.pos.clone().add(V().set(0, 0.8, 0)), new THREE.Color(e.o.color).getHex(), 14);
      this.stats.kills++;
      if (!this.cleared && this.enemies.every((x) => !x.alive)) {
        this.cleared = true;
        this.toast('Level limpo! Todos os inimigos derrotados.');
      }
    }
  }

  damagePlayer(dmg, from) {
    const pl = this.player;
    if (pl.dead > 0) return;
    pl.health -= dmg;
    pl.hurtFlash = 0.35;
    if (from && pl.body.vel) {
      const push = pl.body.pos.clone().sub(from).setY(0).normalize().multiplyScalar(6);
      pl.body.vel.x += push.x; pl.body.vel.z += push.z;
      if (pl.mode !== 'car') pl.body.vel.y = Math.max(pl.body.vel.y, 3);
    }
    if (pl.health <= 0) {
      pl.dead = 1.6;
      this.stats.deaths++;
      this.toast('Você morreu! Renascendo…');
    }
  }

  respawn() {
    const pl = this.player;
    pl.health = pl.p.health;
    pl.dead = 0;
    pl.body.pos.copy(pl.spawn);
    if (pl.body.vel) pl.body.vel.set(0, 0, 0);
    if (pl.mode === 'car') { pl.body.speed = 0; pl.body.heading = pl.o.rotY; }
    pl.yaw = pl.o.rotY + Math.PI;
    pl.camYaw = pl.yaw;
  }

  // ------------------------------------------------------------- projéteis/efeitos
  spawnProjectile(pos, vel, damage) {
    const m = new THREE.Mesh(PROJ_GEO, PROJ_MAT);
    m.position.copy(pos);
    this.runtime.add(m);
    this.projectiles.push({ m, vel, damage, life: 4 });
  }

  updateProjectiles(dt) {
    const tgt = this.playerTarget();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      const step = pr.vel.length() * dt;
      const dir = pr.vel.clone().normalize();
      const hit = this.world.raycast(pr.m.position.clone(), dir, step);
      // distância do segmento ao player
      const a = pr.m.position, b = a.clone().addScaledVector(dir, step);
      const closest = new THREE.Line3(a, b).closestPointToPoint(tgt, true, V());
      let remove = pr.life <= 0;
      if (closest.distanceTo(tgt) < (this.player.mode === 'car' ? 1.3 : 0.7) && (!hit || hit.distance > a.distanceTo(closest))) {
        this.damagePlayer(pr.damage, a);
        remove = true;
      } else if (hit) {
        this.burst(hit.point, 0x8a7a62, 3);
        remove = true;
      }
      pr.m.position.copy(b);
      if (remove) { this.runtime.remove(pr.m); this.projectiles.splice(i, 1); }
    }
  }

  tracer(a, b, color) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true }));
    this.runtime.add(l);
    this.effects.push({ obj: l, life: 0.08, max: 0.08 });
  }

  burst(pos, color, n = 8) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(BURST_GEO, new THREE.MeshBasicMaterial({ color, transparent: true }));
      m.position.copy(pos);
      const v = V().set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).multiplyScalar(6);
      this.runtime.add(m);
      this.effects.push({ obj: m, vel: v, life: 0.5, max: 0.5 });
    }
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i];
      f.life -= dt;
      if (f.vel) { f.vel.y -= 15 * dt; f.obj.position.addScaledVector(f.vel, dt); }
      f.obj.material.opacity = Math.max(0, f.life / f.max);
      if (f.life <= 0) {
        this.runtime.remove(f.obj);
        f.obj.geometry !== BURST_GEO && f.obj.geometry.dispose();
        f.obj.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------- HUD
  buildHud() {
    const pl = this.player;
    const names = { fps: 'FPS', platform: 'Plataforma', car: 'Carro' };
    const help = {
      fps: 'Clique para travar o mouse · WASD mover · Shift correr · Espaço pular · Clique atirar · R renascer · Esc sair',
      platform: 'WASD mover · Espaço pular (2x = pulo duplo) · Q/E ou arrastar gira câmera · pule em cima dos inimigos · R renascer · Esc sair',
      car: 'W/S acelerar/ré · A/D virar · Espaço freio de mão (drift) · atropele inimigos · R renascer · Esc sair',
    };
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-top">
        <div class="hud-card">
          <div class="hud-label">${names[pl.mode]} · ${escapeHtml(pl.o.name || 'Player')}</div>
          <div class="hud-bar"><div class="hud-bar-fill"></div></div>
        </div>
        <div class="hud-card hud-stats"></div>
        <button class="btn hud-stop" type="button">■ Parar <kbd>Esc</kbd></button>
      </div>
      ${pl.mode === 'fps' ? '<div class="crosshair"></div>' : ''}
      <div class="hud-hurt"></div>
      <div class="hud-toast"></div>
      <div class="hud-help">${help[pl.mode]}</div>`;
    hud.querySelector('.hud-stop').addEventListener('click', () => this.stop());
    this.vp.container.appendChild(hud);
    this.hud = hud;
    this.hudFill = hud.querySelector('.hud-bar-fill');
    this.hudStats = hud.querySelector('.hud-stats');
    this.hudHurt = hud.querySelector('.hud-hurt');
    this.hudToast = hud.querySelector('.hud-toast');
    if (this._pendingToast) { this.toast(this._pendingToast); this._pendingToast = null; }
  }

  updateHud(dt) {
    if (!this.hud) return;
    const pl = this.player;
    this.hudFill.style.width = `${Math.max(0, (pl.health / pl.p.health) * 100)}%`;
    const alive = this.enemies.filter((e) => e.alive).length;
    const spd = pl.mode === 'car' ? ` · ${Math.round(Math.abs(pl.body.speed) * 3.6)} km/h` : '';
    this.hudStats.textContent = `Inimigos ${alive}/${this.enemies.length} · Abates ${this.stats.kills} · Mortes ${this.stats.deaths} · ${this.stats.time.toFixed(0)}s${spd}`;
    pl.hurtFlash = Math.max(0, pl.hurtFlash - dt);
    this.hudHurt.style.opacity = String(pl.hurtFlash * 1.6);
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.hudToast.classList.remove('show');
    }
  }

  toast(msg) {
    if (!this.hudToast) { this._pendingToast = msg; return; }
    this.hudToast.textContent = msg;
    this.hudToast.classList.add('show');
    this._toastT = 3;
  }
}

const PROJ_GEO = new THREE.IcosahedronGeometry(0.14, 1);
const PROJ_MAT = new THREE.MeshBasicMaterial({ color: 0xc0632f });
const BURST_GEO = new THREE.BoxGeometry(0.12, 0.12, 0.12);

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function lerpAngle(a, b, t) { return a + angleDiff(b, a) * t; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
