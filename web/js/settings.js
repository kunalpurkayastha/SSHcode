// Personalization: every setting with its default. Only values that differ
// from the default are stored (localStorage, shared by every sshcode tab and
// kept in step between them); modules read settings.get(key) and follow
// changes with settings.on(key, fn).
import { store } from './util.js';

export const DEFAULTS = {
  // appearance
  appearance: 'system',          // system | light | dark
  accent: 'blue',                // blue purple pink red orange yellow green graphite
  wallpaper: 'aurora',           // aurora sky dusk forest graphite plain
  sidebarGlass: true,
  layout: 'floating',            // floating (panes with gaps) | joined (edge to edge)
  sidebarSide: 'left',           // left | right
  panelSide: 'bottom',           // bottom | right
  motion: true,
  // editor
  'editor.theme': 'xcode',
  'editor.scheme': 'auto',       // auto (follow appearance) | dark | light
  'editor.font': 'default',      // default | jetbrains | system | custom
  'editor.fontCustom': '',
  'editor.fontSize': 13,
  'editor.lineHeight': 1.6,
  'editor.ligatures': false,
  'editor.cursorStyle': 'line',  // line | block | underline
  'editor.cursorBlinking': 'blink',
  'editor.lineNumbers': 'on',    // on | relative | off
  'editor.minimap': false,
  'editor.wordWrap': 'off',
  'editor.whitespace': 'selection',
  'editor.bracketColors': false,
  'editor.stickyScroll': false,
  'editor.indentGuides': true,
  'editor.lineHighlight': true,
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.detectIndentation': true,
  'editor.autoSave': 'off',      // off | delay | focus
  'editor.trimWhitespace': false,
  'editor.finalNewline': false,
  'editor.previewTabs': true,
  'editor.markdownView': 'split', // split (side by side) | source | preview
  // terminal
  'terminal.fontSize': 13,
  'terminal.lineHeight': 1.22,
  'terminal.cursorStyle': 'bar', // bar | block | underline
  'terminal.cursorBlink': true,
  'terminal.scrollback': 8000,
  'terminal.copyOnSelect': false,
  'terminal.rightClick': 'menu', // menu | paste
  'terminal.webgl': true,
  'terminal.bell': 'visual',     // visual | none
  'terminal.cwd': 'folder',      // folder | home
  // files
  'files.hidden': true,
  'files.exclude': '',
  'files.foldersFirst': true,
  'files.density': 'regular',    // compact | regular | roomy
  'files.colorIcons': true,
  'files.singleClick': 'preview', // preview | select
  'files.confirmDelete': true,
  'files.confirmMove': true,
  'files.startView': 'ide',      // ide (editor and terminal) | folders (folder view)
  'files.folderView': 'icons',   // icons | list
  'files.iconSize': 64,          // folder view icons, px
  'files.thumbnails': true,      // pictures as their own icons in the folder view
  // keyboard: command id -> shortcut ('' = none)
  keys: {},
  // servers: alias -> {color, label}
  hosts: {},
};

const KEY = 'settings';
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const listeners = new Map();
let values = load();

function load() {
  const saved = store.get(KEY, null);
  if (saved && typeof saved === 'object') return saved;
  // First run of this version: carry over the preferences kept separately before.
  const v = {};
  const old = (k, to, map = x => x) => { const x = store.get(k, null); if (x !== null) v[to] = map(x); };
  old('theme', 'appearance');
  old('prefs.wrap', 'editor.wordWrap');
  old('prefs.minimap', 'editor.minimap');
  old('prefs.fontSize', 'editor.fontSize');
  old('prefs.autoSave', 'editor.autoSave', on => (on ? 'delay' : 'off'));
  old('prefs.hidden', 'files.hidden');
  for (const k of Object.keys(v)) if (same(v[k], DEFAULTS[k])) delete v[k];
  return v;
}

function emit(k, v) {
  for (const fn of [...(listeners.get(k) || []), ...(listeners.get('*') || [])]) {
    try { fn(v, k); } catch (e) { console.error(e); }
  }
}

export const settings = {
  get(k) { return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : DEFAULTS[k]; },
  set(k, v) {
    if (same(this.get(k), v)) return;
    values = { ...values };
    if (same(v, DEFAULTS[k])) delete values[k]; else values[k] = v;
    store.set(KEY, values);
    emit(k, this.get(k));
  },
  isDefault(k) { return !Object.prototype.hasOwnProperty.call(values, k); },
  reset(k) { this.set(k, DEFAULTS[k]); },
  resetAll() { for (const k of Object.keys(values)) this.reset(k); },
  /** fn(value, key) on every change of `k` ('*' for all). Returns an unsubscribe function. */
  on(k, fn) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
    return () => listeners.get(k).delete(fn);
  },
  /** Everything that differs from the defaults (for export). */
  changed() { return { ...values }; },
  /** Replace everything with `obj` (import); unknown keys are dropped. */
  replace(obj) {
    const next = {};
    for (const [k, v] of Object.entries(obj || {})) if (k in DEFAULTS && !same(v, DEFAULTS[k])) next[k] = v;
    const keys = new Set([...Object.keys(values), ...Object.keys(next)]);
    values = next;
    store.set(KEY, values);
    for (const k of keys) emit(k, this.get(k));
  },
};

// Another sshcode tab changed something: follow along.
window.addEventListener('storage', e => {
  if (e.key !== 'sshcode.' + KEY) return;
  let next = {};
  try { next = JSON.parse(e.newValue) || {}; } catch { return; }
  const prev = values;
  values = next;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!same(prev[k], next[k])) emit(k, settings.get(k));
  }
});

// --- per-server look ---------------------------------------------------------
export const TAG_COLORS = ['blue', 'indigo', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'gray'];
const AUTO = ['blue', 'indigo', 'teal', 'green', 'orange', 'pink'];

/** A server's colour: the one picked in Settings, else one derived from its name. */
export function hostColor(alias) {
  const h = settings.get('hosts')[alias];
  if (h && h.color) return h.color;
  return AUTO[[...String(alias)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AUTO.length];
}

export function hostLabel(alias) {
  const h = settings.get('hosts')[alias];
  return (h && h.label) || alias;
}

export function setHost(alias, patch) {
  const all = { ...settings.get('hosts') };
  const next = { ...(all[alias] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
  if (Object.keys(next).length) all[alias] = next; else delete all[alias];
  settings.set('hosts', all);
}

// --- the page's own attributes (wallpaper, accent, density…) -------------------
export function applyRoot() {
  const d = document.documentElement.dataset;
  d.accent = settings.get('accent');
  d.wall = settings.get('wallpaper');
  d.layout = settings.get('layout');
  d.motion = settings.get('motion') ? 'on' : 'off';
  d.glass = settings.get('sidebarGlass') ? 'on' : 'off';
  d.density = settings.get('files.density');
  d.icons = settings.get('files.colorIcons') ? 'color' : 'mono';
  d.liga = settings.get('editor.ligatures') ? 'on' : 'off';
}
for (const k of ['accent', 'wallpaper', 'layout', 'motion', 'sidebarGlass', 'files.density', 'files.colorIcons', 'editor.ligatures']) settings.on(k, applyRoot);
applyRoot();
