// Controles na tela para o modo jogo em celular/tablet. Cada tipo de player
// ganha o seu conjunto:
//   FPS        joystick (andar; empurrado até o fim corre) · arrastar no resto da
//              tela mira · botões Atirar (segurar = rajada) e Pular
//   Plataforma joystick (andar relativo à câmera) · arrastar gira a câmera ·
//              botão Pular (segurar pula mais alto; no ar, pulo duplo)
//   Carro      volante (joystick só na horizontal) · pedais Acelerar e Ré ·
//              botão Drift (freio de mão)
// O joystick aparece onde o dedo toca na metade esquerda da tela.

const STICK_R = 52; // raio útil do joystick, em px

const BUTTONS = {
  fps: [
    { id: 'fire', label: 'Atirar', big: true, icon: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>' },
    { id: 'jump', label: 'Pular', icon: '<path d="M12 19V6M6 11l6-6 6 6"/>' },
  ],
  platform: [
    { id: 'jump', label: 'Pular', big: true, icon: '<path d="M12 19V6M6 11l6-6 6 6"/>' },
  ],
  car: [
    { id: 'gas', label: 'Acelerar', big: true, icon: '<path d="M12 19V6M6 11l6-6 6 6"/>' },
    { id: 'brake', label: 'Ré', icon: '<path d="M12 5v13M6 13l6 6 6-6"/>' },
    { id: 'drift', label: 'Drift', icon: '<path d="M4 17c4 0 5-10 9-10s3 6 7 6"/><path d="M17 10l3 3-3 3"/>' },
  ],
};

const HELP = {
  fps: 'Joystick anda (até o fim corre) · arraste a tela para mirar',
  platform: 'Joystick anda · arraste a tela para girar a câmera · pule em cima dos inimigos',
  car: 'Volante à esquerda · Acelerar, Ré e Drift à direita · atropele inimigos',
};

export class TouchControls {
  constructor(parent, mode) {
    this.mode = mode;
    this.stick = { x: 0, y: 0, id: null, ox: 0, oy: 0 };
    this.look = { dx: 0, dy: 0, id: null, x: 0, y: 0 };
    this.held = new Set();
    this.pressed = new Set(); // bordas de descida ainda não consumidas
    this.lastTouchAt = 0;

    const el = document.createElement('div');
    el.className = `tc tc-${mode}`;
    el.innerHTML = `
      <div class="tc-stick" hidden><div class="tc-knob"></div></div>
      <div class="tc-stick-hint">${mode === 'car' ? 'volante' : 'mover'}</div>
      <div class="tc-buttons">${(BUTTONS[mode] || []).map((b) => `
        <button type="button" class="tc-btn${b.big ? ' big' : ''}" data-btn="${b.id}" aria-label="${b.label}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${b.icon}</svg><span>${b.label}</span>
        </button>`).join('')}
      </div>`;
    parent.prepend(el);
    this.el = el;
    this.$stick = el.querySelector('.tc-stick');
    this.$knob = el.querySelector('.tc-knob');
    this.help = HELP[mode] || '';

    this._down = (e) => this.onDown(e);
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
    el.addEventListener('pointerdown', this._down);
    el.addEventListener('pointermove', this._move);
    el.addEventListener('pointerup', this._up);
    el.addEventListener('pointercancel', this._up);
    el.addEventListener('lostpointercapture', this._up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  destroy() { this.el.remove(); }

  // ---------------------------------------------------------- leitura
  /** Joystick em -1..1 (y positivo = para frente). */
  get x() { return this.stick.x; }
  get y() { return this.stick.y; }
  get magnitude() { return Math.hypot(this.stick.x, this.stick.y); }
  isHeld(id) { return this.held.has(id); }
  /** true uma vez por toque no botão. */
  take(id) { const had = this.pressed.has(id); this.pressed.delete(id); return had; }
  /** Arraste acumulado de mira/câmera desde a última leitura, em px. */
  takeLook() { const d = { dx: this.look.dx, dy: this.look.dy }; this.look.dx = 0; this.look.dy = 0; return d; }

  // ---------------------------------------------------------- eventos
  onDown(e) {
    e.preventDefault();
    this.lastTouchAt = performance.now();
    const btn = e.target.closest?.('[data-btn]');
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ponteiro já solto */ }
    if (btn) {
      const id = btn.dataset.btn;
      btn.classList.add('on');
      this.held.add(id);
      this.pressed.add(id);
      this._btnOf ??= new Map();
      this._btnOf.set(e.pointerId, btn);
      return;
    }
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < r.width * 0.45 && this.stick.id == null) {
      Object.assign(this.stick, { id: e.pointerId, ox: x, oy: y, x: 0, y: 0 });
      this.$stick.style.left = `${x}px`;
      this.$stick.style.top = `${y}px`;
      this.$stick.hidden = false;
      this.el.classList.add('stick-on');
      this._knob(0, 0);
    } else if (this.look.id == null) {
      Object.assign(this.look, { id: e.pointerId, x: e.clientX, y: e.clientY });
    }
  }

  onMove(e) {
    if (e.pointerId === this.stick.id) {
      const r = this.el.getBoundingClientRect();
      let dx = e.clientX - r.left - this.stick.ox, dy = e.clientY - r.top - this.stick.oy;
      if (this.mode === 'car') dy = 0;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
      this.stick.x = dx / STICK_R;
      this.stick.y = -dy / STICK_R;
      // zona morta pequena para o player não "escorregar"
      if (Math.hypot(this.stick.x, this.stick.y) < 0.12) { this.stick.x = 0; this.stick.y = 0; }
      this._knob(dx, dy);
    } else if (e.pointerId === this.look.id) {
      this.look.dx += e.clientX - this.look.x;
      this.look.dy += e.clientY - this.look.y;
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    }
  }

  onUp(e) {
    const btn = this._btnOf?.get(e.pointerId);
    if (btn) {
      this._btnOf.delete(e.pointerId);
      btn.classList.remove('on');
      // outro dedo ainda segurando o mesmo botão?
      if (![...this._btnOf.values()].includes(btn)) this.held.delete(btn.dataset.btn);
    }
    if (e.pointerId === this.stick.id) {
      Object.assign(this.stick, { id: null, x: 0, y: 0 });
      this.$stick.hidden = true;
      this.el.classList.remove('stick-on');
    }
    if (e.pointerId === this.look.id) this.look.id = null;
  }

  _knob(dx, dy) { this.$knob.style.transform = `translate(${dx}px, ${dy}px)`; }
}

/** Há tela de toque como entrada principal? */
export function prefersTouch() {
  return !!window.matchMedia?.('(pointer: coarse)').matches;
}
