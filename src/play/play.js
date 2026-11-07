// Modo jogo: testa o level com o agente player (FPS, plataforma ou carro) e
// inimigos (atirador, arcade, carro) com comportamentos parado/vagar/patrulhar/perseguir.
import * as THREE from 'three';
import { World, CharacterBody, CarBody } from './physics.js';
import { buildAgentBody, buildObject, corridorSamples, makeContext, isBreakable } from '../builders/index.js';
import { samplePath } from '../math/curve.js';
import { normalizeObject, makeObject, itemGroups } from '../model.js';
import { applyVisualState } from '../render/materials.js';
import { TouchControls, prefersTouch } from './touchControls.js';
import { LogicRuntime } from '../logic/runtime.js';
import { LevelScript } from '../logic/script.js';
import { GOALS } from '../logic/schema.js';

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
    // estado inicial de assets e itens definido para o jogo (antes de montar a colisão)
    this.assetState = new Map();
    for (const o of doc.objects) {
      const g = this.vp.objects.get(o.id);
      if (!g) continue;
      if (o.type === 'asset') {
        const st = { g, baseY: g.position.y, open: false, hidden: false, anim: null };
        this.assetState.set(o.id, st);
        if (o.startState === 'hidden') { st.hidden = true; g.visible = false; }
        if (o.startState === 'open') { st.open = true; g.position.y = st.baseY - this.sinkDepth(g); g.visible = false; }
      }
      if (o.type === 'item' && o.hidden) g.visible = false;
    }
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
    for (const e of this.enemies) if (e.o.active === false) { e.dormant = true; e.mesh.visible = false; }
    this.items = doc.objects.filter((o) => o.type === 'item').map((o) => {
      const g = this.vp.objects.get(o.id);
      const breakable = isBreakable(o);
      return { o, g, body: g?.children.find((c) => c.userData.itemBody), taken: false, hidden: !!o.hidden, phase: Math.random() * 6, breakable, hp: breakable ? +o.hp : 0 };
    }).filter((it) => it.g);
    this.zones = doc.objects.filter((o) => o.type === 'zone').map((o) => ({ o, inside: false, off: false }));
    const useRules = new Set((doc.logic?.rules || []).filter((r) => r.when?.type === 'use').map((r) => r.when.target));
    for (const z of this.zones) z.usable = z.o.usable || useRules.has(z.o.id);
    this.anims = [];
    this.projectiles = [];
    this.effects = [];
    this.stats = { kills: 0, deaths: 0, time: 0 };
    this.cleared = false;
    this.ended = null;
    this.paused = false;
    this.scriptT = 0;

    this.buildHud();
    if (prefersTouch()) {
      this.tc = new TouchControls(this.hud, pdata.mode === 'car' || pdata.mode === 'platform' ? pdata.mode : 'fps');
      this.hud.classList.add('touch');
      this.hud.querySelector('.hud-help').textContent = this.tc.help;
    }
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
    this.startLogic(doc);
  }

  // ------------------------------------------------------------- lógica (regras + script)
  startLogic(doc) {
    const logic = doc.logic || {};
    this.logic = new LogicRuntime(logic, {
      act: (a) => this.act(a),
      isEnemyDead: (id) => { const e = this.enemyById(id); return e ? !e.alive : false; },
      enemiesLeft: (withDormant) => this.enemies.filter((e) => e.alive && (withDormant || !e.dormant)).length,
      itemKind: (id) => this.items.find((it) => it.o.id === id)?.o.kind || null,
      itemsLeft: () => this.items.filter((it) => !it.breakable && !it.dropped && !it.taken).length,
      playerHealth: () => this.player.health,
      onState: () => this.renderInventory(),
      onEvent: (type, target) => this.script?.send(type, target, this.scriptState()),
    });
    // scripts: o do level e os de cada objeto rodam juntos num worker isolado
    const parts = [];
    if (logic.scriptEnabled && logic.script?.trim()) parts.push({ code: logic.script });
    for (const o of doc.objects) {
      if (o.script?.trim() && o.scriptEnabled !== false) parts.push({ code: o.script, me: { id: o.id, name: o.name, type: o.type, role: o.role || null } });
    }
    if (parts.length) {
      this.script = new LevelScript(parts,
        (actions) => this.runScriptActions(actions),
        (msg) => { this.toast(`Erro no script: ${msg}`, 5); console.warn('[levedit script]', msg); });
    }
    const g = logic.goal || { type: 'killAll' };
    const grp = itemGroups(doc).find((x) => x.id === g.group);
    this.objectiveText = g.type === 'reachZone' ? `Objetivo: chegar em ${this.store.get(g.zoneId)?.name || 'zona'}`
      : g.type === 'collectGroup' ? `Objetivo: juntar ${Math.max(1, +g.count || 1)} × ${grp?.name || 'item'}`
      : g.type === 'survive' ? `Objetivo: sobreviver ${g.seconds || 60}s`
      : g.type === 'rules' ? '' : `Objetivo: ${GOALS[g.type]?.label.toLowerCase() || ''}`;
    if (this.hudGoal) this.hudGoal.textContent = this.objectiveText;
    this.logic.start();
    this.renderInventory();
  }

  /** Ações vindas do script: alvos por nome viram ids antes de ir para o executor. */
  runScriptActions(actions) {
    if (!this.active || !this.logic) return;
    const fixed = actions.map((a) => {
      if (!a || typeof a !== 'object') return null;
      const b = { ...a };
      if (b.target != null && !['addVar', 'setVar', 'enableRule', 'disableRule'].includes(b.type)) {
        const o = this.resolve(b.target);
        b.target = o ? o.id : b.target;
      }
      return b;
    }).filter(Boolean);
    this.logic.runActions(fixed);
  }

  /** Retrato do jogo mandado ao script. */
  scriptState() {
    const pl = this.player;
    const names = {};
    for (const o of this.store.doc.objects) names[o.name] = o.id;
    const kinds = {};
    for (const it of this.items) kinds[it.o.id] = it.o.kind;
    const groupNames = {};
    for (const gr of itemGroups(this.store.doc)) { groupNames[gr.id.toLowerCase()] = gr.id; groupNames[gr.name.toLowerCase()] = gr.id; }
    const snap = this.logic.snapshot();
    return {
      ...snap,
      names,
      kinds,
      groupNames,
      items: { ...snap.items },
      itemsInLevel: this.items.map((it) => ({ id: it.o.id, name: it.o.name, kind: it.o.kind, x: it.g.position.x, y: it.g.position.y, z: it.g.position.z, taken: it.taken, broken: !!it.broken, hp: it.hp })),
      player: { id: pl.o.id, name: pl.o.name, x: pl.body.pos.x, y: pl.body.pos.y, z: pl.body.pos.z, health: pl.health, maxHealth: pl.p.health, dead: pl.dead > 0, mode: pl.mode, params: { ...pl.p } },
      enemies: this.enemies.map((e) => ({ id: e.o.id, name: e.o.name, x: e.body.pos.x, y: e.body.pos.y, z: e.body.pos.z, alive: e.alive, awake: !e.dormant, health: e.health, behavior: e.o.behavior })),
      objects: [...this.assetState].map(([id, st]) => ({ id, name: this.store.get(id)?.name, x: st.g.position.x, y: st.g.position.y, z: st.g.position.z, open: st.open, hidden: st.hidden })),
    };
  }

  /** Objeto do level por id ou nome ('player' é o player). */
  resolve(t) {
    if (t == null || t === '') return null;
    if (t === 'player') return this.player.o;
    const doc = this.store.doc;
    return doc.objects.find((o) => o.id === t) || doc.objects.find((o) => o.name === t)
      || this.items?.find((it) => it.o.id === t)?.o || null; // itens que caíram de caixas
  }

  enemyById(id) { return this.enemies.find((e) => e.o.id === id) || null; }

  sinkDepth(g) { return (g.userData.height || 2) + 0.1; }

  /** Ações que mexem na cena (o runtime cuida de contadores, itens e regras). */
  act(a) {
    const o = this.resolve(a.target);
    const id = o?.id;
    const pl = this.player;
    switch (a.type) {
      case 'open': case 'close': case 'toggle': {
        const st = this.assetState.get(id);
        if (!st) break;
        const open = a.type === 'open' ? true : a.type === 'close' ? false : !st.open;
        if (open === st.open) break;
        st.open = open;
        st.g.visible = !st.hidden;
        const to = open ? st.baseY - this.sinkDepth(st.g) : st.baseY;
        if (open) this.world.setEnabled(st.g, false);
        this.animate(st, { y: to }, 0.9, () => {
          if (st.open) st.g.visible = false;
          else if (!st.hidden) this.world.setEnabled(st.g, true);
        });
        if (!open && !st.hidden) this.world.setEnabled(st.g, true);
        break;
      }
      case 'show': case 'hide': {
        const show = a.type === 'show';
        const st = this.assetState.get(id);
        if (st) {
          st.hidden = !show;
          st.g.visible = show && !st.open;
          this.world.setEnabled(st.g, show && !st.open);
          if (show) this.burst(st.g.position.clone().add(V().set(0, 1, 0)), 0xd9a441, 8);
          break;
        }
        const it = this.items.find((x) => x.o.id === id);
        if (it) {
          it.hidden = !show;
          it.g.visible = show && !it.taken && !it.broken;
          if (it.breakable && !it.broken) this.world.setEnabled(it.g, show);
          break;
        }
        const z = this.zones.find((x) => x.o.id === id);
        if (z) { z.off = !show; break; }
        const e = this.enemyById(id);
        if (e) show ? this.wake(e) : (e.dormant = true, e.mesh.visible = false);
        break;
      }
      case 'spawn': { const e = this.enemyById(id); if (e) this.wake(e); break; }
      case 'kill': { const e = this.enemyById(id); if (e?.alive && !e.dormant) this.damageEnemy(e, Infinity); break; }
      case 'behavior': { const e = this.enemyById(id); if (e && a.value) { e.o.behavior = a.value; e.goTo = null; } break; }
      case 'goTo': {
        const e = this.enemyById(id);
        if (e) { e.goTo = a.value && isFinite(a.value.x) ? V().set(+a.value.x, e.body.pos.y, +a.value.z) : null; break; }
        const st = this.assetState.get(id);
        if (st && a.value && isFinite(a.value.x)) this.moveAsset(st, a.value);
        break;
      }
      case 'moveTo': {
        const st = this.assetState.get(id);
        if (st && a.value) this.moveAsset(st, a.value);
        break;
      }
      case 'rotate': {
        const st = this.assetState.get(id);
        if (st) this.animate(st, { rotY: st.g.rotation.y + ((+a.value || 0) * Math.PI) / 180 }, Math.max(0.05, +a.seconds || 0.6), () => this.world.setEnabled(st.g, !st.hidden && !st.open));
        break;
      }
      case 'color': {
        const g = this.vp.objects.get(id) || this.enemyById(id)?.mesh || (id === pl.o.id ? pl.mesh : null);
        if (g && a.value) g.traverse((m) => { if (m.isMesh && m.material?.color && !m.userData.editorOnly) { m.material = m.material.clone(); m.material.color.set(a.value); } });
        break;
      }
      case 'param': {
        const tgt = id === pl.o.id || a.target === 'player' ? pl : this.enemyById(id);
        if (tgt && a.key) {
          tgt.p[a.key] = a.value;
          if (a.key === 'health' && tgt === pl) pl.health = Math.min(pl.health, +a.value || 1);
        }
        break;
      }
      case 'push': {
        const v = a.value || {};
        if (pl.body.vel) { pl.body.vel.x += +v.x || 0; pl.body.vel.y += +v.y || 0; pl.body.vel.z += +v.z || 0; pl.body.onGround = false; }
        if (pl.mode === 'car') pl.body.vy = (pl.body.vy || 0) + (+v.y || 0);
        break;
      }
      case 'message': this.toast(a.text || '', +a.value || 3); break;
      case 'teleport': {
        if (!o) break;
        const g = this.vp.objects.get(o.id);
        const p = g ? g.position.clone() : V().set(o.x, this.ctx.levelY(o.levelId), o.z);
        p.y += 0.3;
        const gr = this.world.ground(p, 1.5);
        if (gr) p.y = gr.y;
        pl.body.pos.copy(p);
        if (pl.body.vel) pl.body.vel.set(0, 0, 0);
        if (pl.mode === 'car') pl.body.speed = 0;
        this.burst(p.clone().add(V().set(0, 1, 0)), 0x6d9bb8, 12);
        break;
      }
      case 'hit': {
        const it = this.items.find((x) => x.o.id === id);
        if (it) { this.hitItem(it, +a.value || 10); break; }
        const e = this.enemyById(id);
        if (e?.alive && !e.dormant) this.damageEnemy(e, +a.value || 10);
        break;
      }
      case 'heal': pl.health = Math.min(pl.p.health, pl.health + (+a.value || 0)); break;
      case 'damage': this.damagePlayer(+a.value || 0); break;
      case 'win': case 'lose': this.showEnd(a.type === 'win', a.text); break;
      default: break;
    }
  }

  wake(e) {
    if (!e.alive) {
      e.alive = true;
      e.health = e.p.health;
      e.body.pos.copy(e.spawn);
      if (e.body.vel) e.body.vel.set(0, 0, 0);
      this.runtime.add(e.mesh);
    }
    if (e.dormant || !e.mesh.visible) this.burst(e.body.pos.clone().add(V().set(0, 1, 0)), new THREE.Color(e.o.color).getHex(), 12);
    e.dormant = false;
    e.mesh.visible = true;
    e.mesh.position.copy(e.body.pos);
  }

  moveAsset(st, to) {
    const target = { x: +to.x, z: +to.z };
    if (to.y != null && isFinite(to.y)) target.y = st.baseY + +to.y;
    this.animate(st, target, Math.max(0.05, +to.seconds || 1), () => {
      if (target.y != null) st.baseY = target.y;
      if (!st.hidden && !st.open) this.world.setEnabled(st.g, true);
    });
  }

  /** Anima posição/rotação de um asset; a colisão é refeita no fim. */
  animate(st, to, dur, done) {
    const g = st.g;
    const from = { x: g.position.x, y: g.position.y, z: g.position.z, rotY: g.rotation.y };
    this.anims = this.anims.filter((a) => a.st !== st || Object.keys(a.to).some((k) => !(k in to)));
    this.anims.push({ st, from, to, t: 0, dur, done });
  }

  updateAnims(dt) {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t = Math.min(1, a.t + dt / a.dur);
      const k = a.t * a.t * (3 - 2 * a.t);
      const g = a.st.g;
      for (const key of Object.keys(a.to)) {
        const v = a.from[key] + (a.to[key] - a.from[key]) * k;
        if (key === 'rotY') g.rotation.y = v; else g.position[key] = v;
      }
      if (a.t >= 1) { this.anims.splice(i, 1); a.done?.(); }
    }
  }

  /** Itens: giram, flutuam e são coletados ao encostar. */
  updateItems(dt) {
    const pl = this.player;
    const pp = pl.body.pos;
    const r = pl.mode === 'car' ? 2.2 : 1.2;
    for (const it of this.items) {
      if (it.taken || it.hidden || it.broken) continue;
      if (it.breakable) { it.flash = Math.max(0, (it.flash || 0) - dt); if (it.body) it.body.scale.setScalar(1 + it.flash * 0.6); continue; }
      it.phase += dt;
      if (it.body) {
        it.body.rotation.y += dt * 2;
        it.body.position.y = Math.max(0.2, it.o.y ?? 0.6) + Math.sin(it.phase * 2.5) * 0.12;
      }
      const gp = it.g.position;
      if (pl.dead <= 0 && Math.hypot(gp.x - pp.x, gp.z - pp.z) < r && pp.y > gp.y - 1.2 && pp.y < gp.y + 2.2) {
        it.taken = true;
        it.g.visible = false;
        this.burst(gp.clone().add(V().set(0, 0.8, 0)), new THREE.Color(it.o.color).getHex(), 10);
        if (it.o.kind === 'health') pl.health = Math.min(pl.p.health, pl.health + (+it.o.amount || 25));
        this.toast(`Pegou: ${it.o.name}`, 1.6);
        this.logic.addItem(it.o.id, 1, true);
      }
    }
  }

  /** Zonas: entrar, sair e usar (F ou botão). */
  updateZones() {
    const pl = this.player;
    const p = pl.body.pos;
    let usable = null;
    for (const z of this.zones) {
      const o = z.o;
      const y0 = this.ctx.levelY(o.levelId);
      const dx = p.x - o.x, dz = p.z - o.z;
      const c = Math.cos(-(o.rotY || 0)), s = Math.sin(-(o.rotY || 0));
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      const inside = !z.off && pl.dead <= 0 && Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.d / 2 && p.y >= y0 - 0.6 && p.y <= y0 + o.h;
      if (inside && !z.inside) { z.inside = true; this.logic.emit('enter', o.id); }
      else if (!inside && z.inside) { z.inside = false; this.logic.emit('exit', o.id); }
      if (z.inside && z.usable) usable = z;
    }
    this.usableZone = usable;
    if (this.hudUse) {
      this.hudUse.hidden = !usable;
      if (usable) this.hudUse.querySelector('span').textContent = `${usable.o.useLabel || 'Usar'} · ${usable.o.name}`;
    }
    if (this.usePressed && usable) this.logic.emit('use', usable.o.id);
    this.usePressed = false;
  }

  renderInventory() {
    if (!this.hudInv || !this.logic) return;
    const doc = this.store.doc;
    const chips = [];
    // chaves (e itens de grupos próprios) aparecem pelo nome; o resto, somado por grupo
    for (const [id, n] of this.logic.items) {
      const o = doc.objects.find((x) => x.id === id);
      if (!o || n <= 0 || o.kind !== 'key') continue;
      chips.push(`<span class="inv-chip" style="--c:${o.color}">${escapeHtml(o.name)}${n > 1 ? ` ×${n}` : ''}</span>`);
    }
    for (const gr of itemGroups(doc)) {
      const n = this.logic.groups.get(gr.id) || 0;
      if (n <= 0 || gr.id === 'key' || gr.id === 'health') continue;
      chips.push(`<span class="inv-chip" style="--c:${gr.color}">${escapeHtml(gr.name)} ×${n}</span>`);
    }
    for (const [k, v] of this.logic.vars) chips.push(`<span class="inv-chip var">${escapeHtml(k)}: ${+v.toFixed?.(2) || v}</span>`);
    this.hudInv.innerHTML = chips.join('');
    this.hudInv.hidden = !chips.length;
  }

  showEnd(win, text) {
    this.ended = { win, text };
    this.paused = true;
    if (document.pointerLockElement) document.exitPointerLock();
    if (!this.hud) return;
    this.hudEnd?.remove();
    const box = document.createElement('div');
    box.className = `hud-end ${win ? 'win' : 'lose'}`;
    box.innerHTML = `<div class="hud-end-card">
      <div class="eyebrow">${win ? 'Vitória' : 'Derrota'}</div>
      <h3>${escapeHtml(text || (win ? 'Você venceu!' : 'Fim de jogo'))}</h3>
      <p class="hud-end-stats">${this.stats.time.toFixed(0)}s · ${this.stats.kills} abates · ${this.stats.deaths} mortes · ${this.logic?.collected || 0} itens</p>
      <div class="hud-end-actions">
        ${win ? '<button class="btn" data-end="continue" type="button">Continuar explorando</button>' : ''}
        <button class="btn primary" data-end="restart" type="button">Jogar de novo</button>
        <button class="btn ghost" data-end="stop" type="button">Voltar ao editor</button>
      </div></div>`;
    box.addEventListener('click', (e) => {
      const act = e.target.closest('[data-end]')?.dataset.end;
      if (act === 'continue') { box.remove(); this.paused = false; }
      else if (act === 'restart') { this.stop(); this.start(); }
      else if (act === 'stop') this.stop();
    });
    this.hud.append(box);
    this.hudEnd = box;
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
    this.tc?.destroy();
    this.tc = null;
    this.script?.stop();
    this.script = null;
    this.logic = null;
    this.hudEnd = null;
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
    if (e.code === 'KeyF') this.usePressed = true;
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
    if (this.tc && performance.now() - this.tc.lastTouchAt < 1500) return; // clique de compatibilidade do toque
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

  /** Teclado + joystick na tela: frente (W/↑ ou joystick para cima) e lado (D/→ ou para a direita). */
  moveInput() {
    const tc = this.tc;
    const fwd = this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) + (tc?.y || 0);
    const str = this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) + (tc?.x || 0);
    return { fwd: clamp1(fwd), str: clamp1(str) };
  }

  /** Pulo pedido neste quadro (Espaço ou botão Pular). */
  wantsJump() { return this.jumpPressed || !!this.tc?.take('jump'); }

  // ------------------------------------------------------------- update
  update(dt) {
    if (this.paused) { this.updateEffects(dt); return; }
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
    if (this.tc) { this.tc.pressed.clear(); this.tc.takeLook(); } // nada fica guardado para o próximo quadro
    for (const e of this.enemies) if (e.alive && !e.dormant) this.updateEnemy(e, dt);
    this.updateProjectiles(dt);
    this.updateEffects(dt);
    this.updateAnims(dt);
    if (this.logic) {
      this.updateItems(dt);
      this.updateZones();
      this.logic.update(dt);
      this.scriptT -= dt;
      if (this.script && this.scriptT <= 0) { this.scriptT = 0.2; this.script.send('tick', null, this.scriptState()); }
    }
    this.updateHud(dt);
  }

  updateFps(pl, dt) {
    const p = pl.p;
    const { fwd, str } = this.moveInput();
    const tc = this.tc;
    if (tc) {
      // arrastar no lado direito mira
      const { dx, dy } = tc.takeLook();
      const sens = 0.0045 * (p.sensitivity ?? 1);
      pl.yaw -= dx * sens;
      pl.pitch = Math.max(-1.45, Math.min(1.45, pl.pitch - dy * sens));
    }
    const sprint = this.keys.has('ShiftLeft') || (tc && tc.magnitude > 0.92);
    const sp = p.speed * (sprint ? p.sprint : 1);
    const f = V().set(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    const r = V().set(Math.cos(pl.yaw), 0, -Math.sin(pl.yaw));
    const wish = f.multiplyScalar(fwd).add(r.multiplyScalar(str));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(sp);
    if (this.wantsJump() && pl.body.onGround) pl.body.vel.y = p.jump;
    pl.body.update(dt, this.world, wish, { gravity: p.gravity, airControl: 0.4 });
    this.camera.position.copy(pl.body.pos).add(V().set(0, p.eyeHeight, 0));
    this.camera.rotation.set(pl.pitch, pl.yaw, 0, 'YXZ');
    pl.mesh.position.copy(pl.body.pos);
    pl.mesh.rotation.y = pl.yaw + Math.PI;
    // tiro
    pl.fireCd -= dt;
    const touchFire = tc && (tc.take('fire') || tc.isHeld('fire'));
    if ((this.firing || touchFire || (this.mouseDown && document.pointerLockElement)) && pl.fireCd <= 0) {
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
      if (!e.alive || e.dormant) continue;
      const h = rc.intersectObject(e.mesh, true)[0];
      if (h && h.distance < maxD) { maxD = h.distance; target = e; }
    }
    // caixas e vasos: o raio do mundo para neles, então vale empate com a parede
    let crate = null;
    rc.far = maxD + 0.05;
    for (const it of this.items) {
      if (!it.breakable || it.broken || it.hidden) continue;
      const h = rc.intersectObject(it.g, true)[0];
      if (h && h.distance <= maxD + 0.05) { maxD = h.distance; crate = it; target = null; }
    }
    const end = origin.clone().addScaledVector(dir, maxD);
    const gun = origin.clone().add(V().set(0.25, -0.2, 0).applyQuaternion(this.camera.quaternion));
    this.tracer(gun, end, 0xc0632f);
    if (target) this.damageEnemy(target, pl.p.damage);
    else if (crate) this.hitItem(crate, pl.p.damage);
  }

  updatePlatform(pl, dt) {
    const p = pl.p;
    const rot = this.axis(['KeyQ', 'KeyQ'], ['KeyE', 'KeyE']);
    pl.camYaw -= rot * dt * 2.2;
    if (this.tc) pl.camYaw -= this.tc.takeLook().dx * 0.008; // arrastar gira a câmera
    const { fwd, str } = this.moveInput();
    const a = pl.camYaw;
    const f = V().set(-Math.sin(a), 0, -Math.cos(a));
    const r = V().set(Math.cos(a), 0, -Math.sin(a));
    const wish = f.multiplyScalar(fwd).add(r.multiplyScalar(str));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(p.speed * (this.keys.has('ShiftLeft') ? 1.4 : 1));
    const b = pl.body;
    if (this.wantsJump()) {
      if (b.onGround) { b.vel.y = p.jump; b.jumps = 1; }
      else if (p.doubleJump && b.jumps < 2) { b.vel.y = p.jump * 0.85; b.jumps = 2; this.burst(b.pos, 0xd8cbb3); }
    }
    // pulo curto ao soltar
    if (!this.keys.has('Space') && !this.tc?.isHeld('jump') && b.vel.y > 0 && !b.onGround) b.vel.y -= p.gravity * dt * 0.8;
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
        if (!e.alive || e.dormant) continue;
        const top = e.body.pos.y + (e.mode === 'car' ? 1.4 : e.mode === 'arcade' ? 1.2 : 1.9);
        const dh = Math.hypot(e.body.pos.x - b.pos.x, e.body.pos.z - b.pos.z);
        if (dh < (e.mode === 'car' ? 1.6 : 0.95) && b.pos.y > top - 0.6 && b.pos.y < top + 0.4) {
          this.damageEnemy(e, p.stompDamage);
          b.vel.y = p.jump * 0.75;
          b.jumps = 1;
        }
      }
    }
    // pular em cima de caixa/vaso quebra (ou tira hp)
    if (b.vel.y < -1 || (b.onGround && pl.lastVy < -4)) {
      for (const it of this.items) {
        if (!it.breakable || it.broken || it.hidden) continue;
        const gp = it.g.position;
        const top = gp.y + (it.o.kind === 'vase' ? 0.84 : 0.9);
        if (Math.hypot(gp.x - b.pos.x, gp.z - b.pos.z) < 0.75 && b.pos.y > top - 0.35 && b.pos.y < top + 0.4) {
          this.hitItem(it, p.stompDamage);
          b.vel.y = p.jump * 0.75;
          b.jumps = 1;
        }
      }
    }
    pl.lastVy = b.vel.y;
    // câmera em terceira pessoa
    const d = p.cameraDistance;
    const desired = V().set(Math.sin(a) * d, d * 0.55 + 1.5, Math.cos(a) * d).add(b.pos);
    this.camera.position.lerp(desired, Math.min(1, dt * 6));
    this.camera.lookAt(b.pos.x, b.pos.y + 1.2, b.pos.z);
  }

  updateCar(pl, dt) {
    const p = pl.p;
    const b = pl.body;
    const tc = this.tc;
    const input = {
      throttle: clamp1(this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']) + (tc?.isHeld('gas') ? 1 : 0) - (tc?.isHeld('brake') ? 1 : 0)),
      steer: -clamp1(this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) + (tc?.x || 0)),
      handbrake: this.keys.has('Space') || !!tc?.isHeld('drift'),
    };
    b.update(dt, this.world, input, p);
    pl.mesh.position.copy(b.pos);
    pl.mesh.rotation.y = b.heading;
    // leve inclinação na curva
    pl.mesh.rotation.z = -input.steer * Math.min(1, Math.abs(b.speed) / p.maxSpeed) * 0.06;
    // atropelar inimigos
    for (const e of this.enemies) {
      if (!e.alive || e.dormant) continue;
      e.ramCd = (e.ramCd || 0) - dt;
      if (e.body.pos.distanceTo(b.pos) < 2.1 && Math.abs(b.speed) > 5 && e.ramCd <= 0) {
        e.ramCd = 0.6;
        this.damageEnemy(e, p.ramDamage * Math.min(1.5, Math.abs(b.speed) / (p.maxSpeed * 0.6)));
        const push = e.body.pos.clone().sub(b.pos).setY(0).normalize().multiplyScalar(8);
        if (e.body.vel) { e.body.vel.x += push.x; e.body.vel.z += push.z; e.body.vel.y = 4; }
        b.speed *= 0.8;
      }
    }
    for (const it of this.items) {
      if (!it.breakable || it.broken || it.hidden) continue;
      it.ramCd = (it.ramCd || 0) - dt;
      if (it.g.position.distanceTo(b.pos) < 2.1 && Math.abs(b.speed) > 4 && it.ramCd <= 0) {
        it.ramCd = 0.6;
        this.hitItem(it, p.ramDamage * Math.min(1.5, Math.abs(b.speed) / (p.maxSpeed * 0.6)));
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
    const fromSpawn = Math.hypot(pl.body.pos.x - e.spawn.x, pl.body.pos.z - e.spawn.z);
    if (e.goTo) goal = Math.hypot(e.goTo.x - b.pos.x, e.goTo.z - b.pos.z) > 0.8 ? e.goTo : null;
    else if (behavior === 'flee') {
      if (alerted) goal = b.pos.clone().add(b.pos.clone().sub(pl.body.pos).setY(0).normalize().multiplyScalar(6));
      else goal = this.wanderGoal(e, dt);
    } else if (behavior === 'guard') {
      if (alerted && fromSpawn < (e.o.guardRadius || 8)) goal = pl.body.pos.clone();
      else goal = Math.hypot(e.spawn.x - b.pos.x, e.spawn.z - b.pos.z) > 1 ? e.spawn : null;
    } else if (behavior === 'idle' && e.mode !== 'arcade') goal = null;
    else if (alerted && (behavior === 'chase' || e.mode === 'arcade' || (e.mode === 'car' && behavior !== 'idle'))) goal = pl.body.pos.clone();
    else if (behavior === 'patrol' && e.path.length) goal = this.patrolGoal(e);
    else if (behavior === 'wander' || (behavior === 'patrol' && !e.path.length)) goal = this.wanderGoal(e, dt);
    else if (behavior === 'chase' && !alerted) goal = this.wanderGoal(e, dt);

    if (e.mode === 'shooter') {
      // atirador mantém distância quando vê o player
      if (!e.goTo && behavior !== 'flee') {
        if (sees && behavior !== 'chase' && behavior !== 'guard') goal = null;
        if (sees && (behavior === 'chase' || behavior === 'guard') && dist < 8) goal = null;
      }
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
    if (alivePlayer && behavior !== 'flee' && flat < touchR && vert < 1.4 && e.hitCd <= 0 && (e.mode !== 'car' || Math.abs(b.speed) > 3)) {
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

  /** Ataque num item quebrável: tira hp e, no zero, quebra e solta os itens. */
  hitItem(it, dmg) {
    if (!it.breakable || it.broken || it.hidden) return;
    it.hp -= Math.max(0, +dmg || 0);
    it.flash = 0.15;
    const gp = it.g.position;
    this.burst(gp.clone().add(V().set(0, 0.6, 0)), new THREE.Color(it.o.color).getHex(), 4);
    if (it.hp > 0) return;
    it.broken = true;
    it.g.visible = false;
    this.world.setEnabled(it.g, false);
    this.burst(gp.clone().add(V().set(0, 0.5, 0)), new THREE.Color(it.o.color).getHex(), 16);
    this.dropItems(it);
    this.logic?.emit('break', it.o.id);
  }

  /** Itens que saem de uma caixa quebrada: dropCount do grupo dropKind, em volta dela. */
  dropItems(it) {
    const n = Math.min(30, Math.max(0, Math.round(+it.o.dropCount || 0)));
    const gr = itemGroups(this.store.doc).find((x) => x.id === it.o.dropKind);
    if (!n || !gr) return;
    const gp = it.g.position;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const r = n === 1 ? 0 : 0.7 + Math.random() * 0.3;
      const o = normalizeObject(makeObject('item', {
        name: gr.name, kind: gr.id, color: gr.color, levelId: it.o.levelId,
        x: gp.x + Math.cos(a) * r, z: gp.z + Math.sin(a) * r, y: 0.6, amount: gr.id === 'health' ? 25 : 1,
      }));
      o.id = `${it.o.id}~${i + 1}`;
      const g = buildObject(o, this.ctx);
      g.position.y = gp.y;
      g.traverse((m) => { if (m.userData.editorOnly) m.visible = false; });
      this.runtime.add(g);
      this.items.push({ o, g, body: g.children.find((c) => c.userData.itemBody), taken: false, hidden: false, phase: Math.random() * 6, breakable: false, hp: 0, dropped: true });
    }
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
      this.logic?.emit('kill', e.o.id);
      if (this.enemies.every((x) => !x.alive || x.dormant)) {
        this.cleared = true;
        this.logic?.emit('allKilled');
      }
    }
  }

  damagePlayer(dmg, from) {
    const pl = this.player;
    if (pl.dead > 0) return;
    pl.health -= dmg;
    pl.hurtFlash = 0.35;
    this.logic?.emit('playerHurt', pl.o.id);
    if (from && pl.body.vel) {
      const push = pl.body.pos.clone().sub(from).setY(0).normalize().multiplyScalar(6);
      pl.body.vel.x += push.x; pl.body.vel.z += push.z;
      if (pl.mode !== 'car') pl.body.vel.y = Math.max(pl.body.vel.y, 3);
    }
    if (pl.health <= 0) {
      pl.dead = 1.6;
      this.stats.deaths++;
      this.toast('Você morreu! Renascendo…');
      this.logic?.emit('playerDied', pl.o.id);
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
      <div class="hud-side"><div class="hud-goal"></div><div class="hud-inv" hidden></div></div>
      ${pl.mode === 'fps' ? '<div class="crosshair"></div>' : ''}
      <button class="btn hud-use" type="button" hidden><kbd>F</kbd><span>Usar</span></button>
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
    this.hudGoal = hud.querySelector('.hud-goal');
    this.hudInv = hud.querySelector('.hud-inv');
    this.hudUse = hud.querySelector('.hud-use');
    this.hudUse.addEventListener('click', () => { this.usePressed = true; });
    this.hudUse.addEventListener('pointerdown', (e) => e.stopPropagation());
    if (this._pendingToast) { this.toast(this._pendingToast); this._pendingToast = null; }
  }

  updateHud(dt) {
    if (!this.hud) return;
    const pl = this.player;
    this.hudFill.style.width = `${Math.max(0, (pl.health / pl.p.health) * 100)}%`;
    const awake = this.enemies.filter((e) => !e.dormant);
    const alive = awake.filter((e) => e.alive).length;
    const spd = pl.mode === 'car' ? ` · ${Math.round(Math.abs(pl.body.speed) * 3.6)} km/h` : '';
    const limit = +this.store.doc.logic?.timeLimit || 0;
    const clock = limit > 0 ? `${Math.max(0, limit - this.stats.time).toFixed(0)}s restantes` : `${this.stats.time.toFixed(0)}s`;
    this.hudStats.textContent = `Inimigos ${alive}/${awake.length} · Abates ${this.stats.kills} · Mortes ${this.stats.deaths} · ${clock}${spd}`;
    pl.hurtFlash = Math.max(0, pl.hurtFlash - dt);
    this.hudHurt.style.opacity = String(pl.hurtFlash * 1.6);
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.hudToast.classList.remove('show');
    }
  }

  toast(msg, seconds = 3) {
    if (!this.hudToast) { this._pendingToast = msg; return; }
    this.hudToast.textContent = msg;
    this.hudToast.classList.add('show');
    this._toastT = seconds;
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

function clamp1(v) { return Math.max(-1, Math.min(1, v)); }
