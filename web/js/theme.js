// Appearance: light or dark (following the system unless pinned), the accent
// colour, and the editor theme, which also colours the editor and terminal
// panes (they can stay dark in a light window, like Xcode). onTheme listeners
// run whenever any of that changes.
import { store } from './util.js';
import { settings } from './settings.js';
import { family, accentColor, monacoTheme, termTheme } from './themes.js';

const mq = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export const themePref = () => settings.get('appearance');
export const setThemePref = pref => settings.set('appearance', pref);
export const isDark = () => document.documentElement.dataset.theme === 'dark';

/** Whether the editor and terminal panes are dark. */
export function paneDark() {
  const s = settings.get('editor.scheme');
  return s === 'dark' || (s !== 'light' && isDark());
}

/** The theme variant the editor and terminal use now. */
export function variant() {
  const f = family(settings.get('editor.theme'));
  return paneDark() ? f.dark : f.light;
}

export const accent = () => accentColor(settings.get('accent'), paneDark());
export const editorTheme = () => monacoTheme(variant(), paneDark(), accent());
export const terminalTheme = () => termTheme(variant(), paneDark(), accent());

let last = '';
function apply() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref !== 'light' && mq.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const v = variant();
  root.dataset.pane = paneDark() ? 'dark' : 'light';
  root.style.setProperty('--pane', v.bg);
  // What boot.js paints before any module loads, for either system appearance.
  const f = family(settings.get('editor.theme'));
  const scheme = settings.get('editor.scheme');
  const pane = d => { const pd = scheme === 'dark' || (scheme !== 'light' && d); return { bg: (pd ? f.dark : f.light).bg, scheme: pd ? 'dark' : 'light' }; };
  store.set('pane', { dark: pane(true), light: pane(false) });
  const sig = [root.dataset.theme, root.dataset.pane, settings.get('editor.theme'), settings.get('accent')].join();
  if (sig !== last) {
    last = sig;
    listeners.forEach(fn => fn(dark));
  }
}

export function onTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

mq.addEventListener('change', apply);
for (const k of ['appearance', 'accent', 'editor.theme', 'editor.scheme']) settings.on(k, apply);
apply();
