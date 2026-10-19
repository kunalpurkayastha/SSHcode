// Small helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build one element from an HTML string. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// localStorage that never throws (private windows, blocked storage).
const PREFIX = 'sshcode.';
export const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch { /* blocked */ } },
  keys(prefix) {
    try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX + prefix)).map(k => k.slice(PREFIX.length)); } catch { return []; }
  },
};

// The same for this browser tab only (it survives a reload, a new tab starts empty).
export const tabStore = {
  get(k, d = null) {
    try { const v = sessionStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { sessionStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};

// --- POSIX paths ------------------------------------------------------------
export const basename = p => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop());
export const dirname = p => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
export const join = (d, n) => (d.endsWith('/') ? d : d + '/') + n;
export const isUnder = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
export function relPath(root, p) {
  if (p === root) return '';
  const base = root.endsWith('/') ? root : root + '/';
  return p.startsWith(base) ? p.slice(base.length) : p;
}
export const tildify = (p, home) => (home && home !== '/' && isUnder(p, home) ? '~' + p.slice(home.length) : p);
export const untildify = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
export function extname(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fmtSize(n) {
  if (n == null) return '';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return i ? `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}` : `${n} ${n === 1 ? 'byte' : 'bytes'}`;
}

// --- keyboard ---------------------------------------------------------------
// Shortcuts are written with "Mod" (⌘ on macOS, Ctrl elsewhere) and "Ctrl"
// (the real Control key on every platform, like VS Code's Ctrl+`).
const CODE_KEYS = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'" };

export function keyName(e) {
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (isMac && e.ctrlKey) mods.push('Ctrl');
  if (!isMac && e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

/** Canonical form of a shortcut spec, matching keyName() on this platform. */
export function normKeys(spec) {
  const parts = spec.split('+');
  const key = parts.pop();
  const mods = new Set(parts.map(m => (!isMac && m === 'Ctrl' ? 'Mod' : m)));
  return [...['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].filter(m => mods.has(m)), key].join('+');
}

const MAC_SYM = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'esc', Backspace: '⌫', Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
export function kbd(spec) {
  if (!spec) return '';
  const parts = normKeys(spec).split('+');
  if (isMac) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const key = parts.pop();
    return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(m => MAC_SYM[m]).join('') + (MAC_SYM[key] || key);
  }
  const names = { Mod: 'Ctrl', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  return parts.map(p => names[p] || p).join('+');
}

/** A shortcut as keycaps: ⌘ ⇧ P on macOS, Ctrl Shift P elsewhere. */
export function keycaps(spec) {
  if (!spec) return '';
  let parts;
  if (isMac) {
    const m = kbd(spec).match(/^([⌃⌥⇧⌘]*)(.*)$/);
    parts = [...m[1], m[2]].filter(Boolean);
  } else {
    parts = kbd(spec).split('+');
  }
  return parts.map(p => `<span class="kbd">${esc(p)}</span>`).join('');
}

/** Copy text; falls back to a hidden textarea when the async API is blocked. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/**
 * Keyed update of `parent`'s children from [{key, cls, attrs, html}]. Rows
 * that didn't change keep their element, so focus, inputs and double-clicks
 * survive a re-render.
 */
export function reconcile(parent, items, cache) {
  const next = new Map();
  let prev = null;
  for (const it of items) {
    let rec = cache.get(it.key);
    if (!rec || rec.el.parentNode !== parent || next.has(it.key)) {
      rec = { el: document.createElement('div'), cls: null, html: null, attrs: {} };
    }
    if (rec.cls !== it.cls) { rec.el.className = it.cls; rec.cls = it.cls; }
    if (rec.html !== it.html) { rec.el.innerHTML = it.html; rec.html = it.html; }
    for (const k in it.attrs || {}) {
      const v = it.attrs[k];
      if (rec.attrs[k] === v) continue;
      if (v == null) rec.el.removeAttribute(k); else rec.el.setAttribute(k, v);
      rec.attrs[k] = v;
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (want !== rec.el) parent.insertBefore(rec.el, want);
    next.set(it.key, rec);
    prev = rec.el;
  }
  for (let extra = prev ? prev.nextSibling : parent.firstChild; extra; extra = prev ? prev.nextSibling : parent.firstChild) extra.remove();
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
}

/** Natural, case-insensitive name order (folders first is the caller's job). */
export const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
