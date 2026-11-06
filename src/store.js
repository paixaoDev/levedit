// Store do documento: mutações, undo/redo por snapshot e autosave local.
import { normalizeDoc } from './model.js';
import { sampleDoc } from './sample.js';
import { debounce, deepClone } from './util.js';
import { syncLinks, markEdited } from './builders/corridorPath.js';
import { syncAttachments } from './editor/polar.js';
import { syncVertical, withDescendants } from './levels.js';

const STORAGE_KEY = 'levedit.doc.v1';
const MAX_HISTORY = 120;

export class Store extends EventTarget {
  constructor() {
    super();
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // id do objeto selecionado (principal)
    this.multi = new Set(); // seleção múltipla (inclui o principal)
    this._autosave = debounce(() => this.saveLocal(), 600);
  }

  init() {
    let doc = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) doc = JSON.parse(raw);
    } catch { /* storage indisponível */ }
    this.load(doc || sampleDoc(), { resetHistory: true });
  }

  load(doc, { resetHistory = true } = {}) {
    this.doc = normalizeDoc(deepClone(doc));
    if (resetHistory) { this.undoStack = []; this.redoStack = []; }
    this.selection = null;
    this.multi = new Set();
    this.emit({ all: true });
    this.emitSelection();
    this._autosave();
  }

  saveLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc)); } catch { /* cheio/bloqueado */ }
  }

  snapshot() {
    this.undoStack.push(JSON.stringify(this.doc));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Aplica uma mutação. ids: objetos afetados (para reconstrução parcial);
   * all: reconstrói tudo (ex.: elevação de nível mudou).
   */
  mutate(fn, { ids = null, all = false, record = true, structure = false } = {}) {
    if (record) this.snapshot();
    fn(this.doc);
    syncLinks(this.doc);
    syncAttachments(this.doc); // paredes presas acompanham a origem
    syncVertical(this.doc); // alturas presas a andares e filhos no andar do pai
    if (ids) ids = [...withDescendants(this.doc, ids)]; // quem está preso é reconstruído junto
    this.emit({ ids, all, structure });
    this._autosave();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.undoStack.pop());
    this._afterHistory();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.redoStack.pop());
    this._afterHistory();
  }

  _afterHistory() {
    for (const id of [...this.multi]) if (!this.get(id)) this.multi.delete(id);
    if (this.selection && !this.get(this.selection)) this.selection = [...this.multi][0] || null;
    this.emit({ all: true, structure: true });
    this.emitSelection();
    this._autosave();
  }

  emit(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  get(id) {
    return this.doc.objects.find((o) => o.id === id) || null;
  }

  level(id) {
    return this.doc.levels.find((l) => l.id === id) || null;
  }

  get activeLevel() {
    return this.level(this.doc.activeLevelId) || this.doc.levels[0];
  }

  /** Seleciona um objeto; com add=true alterna na seleção múltipla. */
  select(id, { add = false } = {}) {
    if (add && id) {
      if (this.multi.has(id)) {
        this.multi.delete(id);
        if (this.selection === id) this.selection = [...this.multi].pop() || null;
      } else {
        this.multi.add(id);
        this.selection = id;
      }
    } else {
      if (this.selection === id && this.multi.size <= 1) return;
      this.selection = id;
      this.multi = new Set(id ? [id] : []);
    }
    this.emitSelection();
  }

  isSelected(id) {
    return this.multi.has(id);
  }

  get selectedObjects() {
    return [...this.multi].map((id) => this.get(id)).filter(Boolean);
  }

  emitSelection() {
    this.dispatchEvent(new CustomEvent('selection', { detail: { id: this.selection } }));
  }

  addObject(obj) {
    this.mutate((d) => { d.objects.push(obj); if (obj.points) markEdited(d, obj); }, { ids: [obj.id], structure: true });
    this.select(obj.id);
  }

  removeObject(id) {
    const gone = withDescendants(this.doc, [id]); // o que está preso vai junto
    this.mutate((d) => {
      d.objects = d.objects.filter((o) => !gone.has(o.id));
      for (const o of d.objects) if (o.pathId === id) o.pathId = null;
    }, { ids: [...gone], structure: true });
    for (const g of gone) this.multi.delete(g);
    if (gone.has(this.selection)) this.select(null);
  }
}
