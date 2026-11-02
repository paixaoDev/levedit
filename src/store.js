// Store do documento: mutações, undo/redo por snapshot e autosave local.
import { normalizeDoc, sampleDoc } from './model.js';
import { debounce, deepClone } from './util.js';

const STORAGE_KEY = 'levedit.doc.v1';
const MAX_HISTORY = 120;

export class Store extends EventTarget {
  constructor() {
    super();
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // id do objeto selecionado
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
    if (this.selection && !this.get(this.selection)) this.selection = null;
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

  select(id) {
    if (this.selection === id) return;
    this.selection = id;
    this.emitSelection();
  }

  emitSelection() {
    this.dispatchEvent(new CustomEvent('selection', { detail: { id: this.selection } }));
  }

  addObject(obj) {
    this.mutate((d) => d.objects.push(obj), { ids: [obj.id], structure: true });
    this.select(obj.id);
  }

  removeObject(id) {
    this.mutate((d) => {
      d.objects = d.objects.filter((o) => o.id !== id);
      for (const o of d.objects) if (o.pathId === id) o.pathId = null;
    }, { ids: [id], structure: true });
    if (this.selection === id) this.select(null);
  }
}
