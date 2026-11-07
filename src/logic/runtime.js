// Executa a lógica do level no modo jogo: regras QUANDO → SE → ENTÃO, contadores,
// inventário, esperas e o objetivo (modo de jogo). Não conhece Three.js: tudo o que
// mexe na cena passa pelo "host" (o PlayMode), o que deixa o runtime testável.
//
// host:
//   act(action)            executa uma ação de cena (open, hide, spawn, message, win...)
//   isEnemyDead(id)        true se o inimigo já foi derrotado
//   enemiesLeft(dormant)   inimigos vivos e acordados (dormant=true conta os dormindo)
//   totalItems()           itens que existem no level
//   playerHealth()         vida atual do player
//   onState?()             inventário ou contadores mudaram (atualiza o HUD)
//   onEvent?(type, target) todo evento disparado (o script também recebe)
import { EVENTS, CONDITIONS } from './schema.js';

const SCENE_ACTIONS = new Set(['open', 'close', 'toggle', 'show', 'hide', 'spawn', 'kill', 'behavior', 'message', 'teleport', 'heal', 'damage', 'goTo', 'moveTo', 'rotate', 'color', 'param', 'push']);

export class LogicRuntime {
  constructor(logic, host, { maxDepth = 16 } = {}) {
    this.logic = logic || { rules: [] };
    this.host = host;
    this.maxDepth = maxDepth;
    this.rules = (this.logic.rules || []).filter((r) => r && r.when && EVENTS[r.when.type]);
    this.vars = new Map();
    this.items = new Map(); // id do item -> quantidade
    this.collected = 0;
    this.fired = new Set(); // regras "só uma vez" que já rodaram
    this.disabled = new Set(this.rules.filter((r) => r.enabled === false).map((r) => r.id));
    this.waits = []; // [{ t, actions, index, rule }]
    this.elapsed = 0;
    this.everyT = new Map(); // regra "a cada N s" -> próximo disparo
    this.ended = null; // { win, text }
    this.depth = 0;
    this.log = [];
  }

  // ------------------------------------------------------------- ciclo
  start() {
    for (const r of this.rules) if (r.when.type === 'every') this.everyT.set(r.id, Math.max(0.1, +r.when.value || 1));
    this.emit('start');
  }

  update(dt) {
    if (this.ended) return;
    this.elapsed += dt;
    for (const r of this.rules) {
      if (r.when.type === 'time' && !this.fired.has(`t:${r.id}`) && this.elapsed >= (+r.when.value || 0)) {
        this.fired.add(`t:${r.id}`);
        this.fire(r);
      } else if (r.when.type === 'every') {
        const next = this.everyT.get(r.id);
        if (next != null && this.elapsed >= next) {
          this.everyT.set(r.id, next + Math.max(0.1, +r.when.value || 1));
          this.fire(r);
        }
      }
    }
    // esperas vencidas continuam de onde pararam
    const due = this.waits.filter((w) => this.elapsed >= w.t);
    if (due.length) {
      this.waits = this.waits.filter((w) => this.elapsed < w.t);
      for (const w of due) this.runActions(w.actions, w.rule, w.index);
    }
    this.checkGoal('tick');
  }

  // ------------------------------------------------------------- eventos
  /** Dispara um evento: roda as regras que esperam por ele. */
  emit(type, target = null) {
    if (this.ended) return;
    if (this.depth > this.maxDepth) return; // regra que dispara a si mesma em loop
    this.depth++;
    try {
      this.host.onEvent?.(type, target);
      for (const r of this.rules) {
        if (r.when.type !== type) continue;
        if (r.when.target && r.when.target !== target) continue;
        this.fire(r);
        if (this.ended) break;
      }
      this.checkGoal(type, target);
    } finally {
      this.depth--;
    }
  }

  /** Roda uma regra se ela estiver ligada, ainda puder rodar e as condições passarem. */
  fire(r) {
    if (this.ended || this.disabled.has(r.id)) return false;
    if (r.once !== false && this.fired.has(r.id)) return false;
    if (!(r.if || []).every((c) => this.test(c))) return false;
    if (r.once !== false) this.fired.add(r.id);
    this.log.push(r.name || r.id);
    this.runActions(r.do || [], r, 0);
    return true;
  }

  // ------------------------------------------------------------- condições
  test(c) {
    if (!CONDITIONS[c.type]) return true;
    switch (c.type) {
      case 'hasItem': return (this.items.get(c.target) || 0) > 0;
      case 'noItem': return !((this.items.get(c.target) || 0) > 0);
      case 'itemCount': return compare(this.collected, c.op, c.value);
      case 'enemyDead': return !!this.host.isEnemyDead?.(c.target);
      case 'enemyAlive': return !this.host.isEnemyDead?.(c.target);
      case 'enemiesLeft': return compare(this.host.enemiesLeft?.() ?? 0, c.op, c.value);
      case 'var': return compare(this.getVar(c.target), c.op, c.value);
      case 'time': return compare(this.elapsed, c.op, c.value);
      case 'health': return compare(this.host.playerHealth?.() ?? 0, c.op, c.value);
      default: return true;
    }
  }

  // ------------------------------------------------------------- ações
  /** Executa as ações em ordem; "Esperar" guarda o resto para depois. */
  runActions(actions, rule = null, from = 0) {
    for (let i = from; i < actions.length; i++) {
      if (this.ended) return;
      const a = actions[i];
      if (!a) continue;
      if (a.type === 'wait') {
        this.waits.push({ t: this.elapsed + Math.max(0, +a.value || 0), actions, index: i + 1, rule });
        return;
      }
      this.exec(a);
    }
  }

  exec(a) {
    switch (a.type) {
      case 'addVar': this.setVar(a.target, this.getVar(a.target) + (+a.value || 0)); break;
      case 'setVar': this.setVar(a.target, +a.value || 0); break;
      case 'give': this.addItem(a.target, Math.max(1, +a.value || 1), false); break;
      case 'enableRule': this.ruleOn(a.target, true); break;
      case 'disableRule': this.ruleOn(a.target, false); break;
      case 'win': this.end(true, a.text); break;
      case 'lose': this.end(false, a.text); break;
      default:
        if (SCENE_ACTIONS.has(a.type)) this.host.act?.(a);
    }
  }

  // ------------------------------------------------------------- estado
  getVar(name) { return this.vars.get(String(name ?? '')) || 0; }

  setVar(name, v) {
    const k = String(name ?? '');
    if (!k) return;
    const old = this.getVar(k);
    this.vars.set(k, v);
    this.host.onState?.();
    if (old !== v) this.emit('varChange', k);
  }

  /** Player pegou (ou ganhou) um item. pickup=true dispara o evento "Pegar um item". */
  addItem(id, n = 1, pickup = true) {
    if (!id) return;
    this.items.set(id, (this.items.get(id) || 0) + n);
    this.collected += n;
    this.host.onState?.();
    if (pickup) this.emit('pickup', id);
  }

  ruleOn(ref, on) {
    const r = this.rules.find((x) => x.id === ref || x.name === ref);
    if (!r) return;
    if (on) {
      this.disabled.delete(r.id);
      this.fired.delete(r.id); // religar deixa rodar de novo
      if (r.when.type === 'every') this.everyT.set(r.id, this.elapsed + Math.max(0.1, +r.when.value || 1));
    } else this.disabled.add(r.id);
  }

  end(win, text) {
    if (this.ended) return;
    this.ended = { win: !!win, text: text || (win ? 'Você venceu!' : 'Fim de jogo') };
    this.host.act?.({ type: win ? 'win' : 'lose', text: this.ended.text });
  }

  // ------------------------------------------------------------- objetivo
  /** Modo de jogo: confere vitória/derrota depois de cada evento e a cada quadro. */
  checkGoal(type, target) {
    if (this.ended) return;
    const g = this.logic.goal || { type: 'killAll' };
    const limit = +this.logic.timeLimit || 0;
    if (limit > 0 && this.elapsed >= limit) {
      this.end(g.type === 'survive', g.type === 'survive' ? 'Você sobreviveu!' : 'O tempo acabou!');
      return;
    }
    switch (g.type) {
      case 'killAll':
        if (type === 'allKilled' && (this.host.enemiesLeft?.(true) ?? 0) === 0) this.end(true, 'Level limpo! Todos os inimigos derrotados.');
        break;
      case 'reachZone':
        if (type === 'enter' && g.zoneId && target === g.zoneId) this.end(true, 'Você chegou ao destino!');
        break;
      case 'collectAll': {
        const total = this.host.totalItems?.() ?? 0;
        if (type === 'pickup' && total > 0 && this.pickedDistinct() >= total) this.end(true, 'Você coletou tudo!');
        break;
      }
      case 'survive':
        if (this.elapsed >= (+g.seconds || 60)) this.end(true, 'Você sobreviveu!');
        break;
      default: break;
    }
  }

  pickedDistinct() {
    let n = 0;
    for (const v of this.items.values()) if (v > 0) n++;
    return n;
  }

  /** Resumo serializável para o script e o HUD. */
  snapshot() {
    return {
      time: this.elapsed,
      vars: Object.fromEntries(this.vars),
      items: Object.fromEntries(this.items),
      collected: this.collected,
    };
  }
}

export function compare(a, op, b) {
  const x = +a, y = +b;
  switch (op) {
    case '==': return x === y;
    case '!=': return x !== y;
    case '>': return x > y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>=':
    default: return x >= y;
  }
}
