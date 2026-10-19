// The Settings window, laid out like macOS System Settings: sections down
// the side, grouped rows of controls on the right, a search field that finds
// any setting. Every change applies at once.
import { esc, h, kbd, keycaps, keyName, normKeys, isMac } from './util.js';
import { icons } from './icons.js';
import { api } from './api.js';
import { confirm, toast } from './ui.js';
import { settings, DEFAULTS, TAG_COLORS, hostColor, setHost } from './settings.js';
import { FAMILIES, ACCENTS, sampleHtml } from './themes.js';
import { COMMANDS, keysOf, keyOwner, RESERVED } from './commands.js';

const WALLS = [['aurora', 'Aurora'], ['sky', 'Sky'], ['dusk', 'Dusk'], ['forest', 'Forest'], ['graphite', 'Graphite'], ['plain', 'Plain']];

// Rows: [key, label, control, options/extra, description]
const SECTIONS = [
  {
    id: 'appearance', title: 'Appearance', icon: 'halfCircle', tint: 'blue', groups: [
      { rows: [
        { key: 'appearance', label: 'Appearance', type: 'appearance' },
        { key: 'accent', label: 'Accent colour', type: 'accent' },
        { key: 'wallpaper', label: 'Wallpaper', type: 'wallpaper', desc: 'Shows around the panes and behind the sidebar.' },
      ] },
      { rows: [
        { key: 'layout', label: 'Window style', type: 'seg', options: [['floating', 'Floating'], ['joined', 'Edge to Edge']], desc: 'Floating panes with rounded corners, or panes that meet like VS Code.' },
        { key: 'sidebarGlass', label: 'Translucent sidebar', type: 'switch' },
        { key: 'sidebarSide', label: 'Sidebar', type: 'seg', options: [['left', 'Left'], ['right', 'Right']] },
        { key: 'panelSide', label: 'Terminal panel', type: 'seg', options: [['bottom', 'Bottom'], ['right', 'Right']] },
        { key: 'motion', label: 'Animations', type: 'switch', desc: 'Turn off for an even snappier window.' },
      ] },
    ],
  },
  {
    id: 'editor', title: 'Editor', icon: 'code', tint: 'indigo', groups: [
      { rows: [
        { key: 'editor.theme', label: 'Theme', type: 'themes' },
        { key: 'editor.scheme', label: 'Editor colours', type: 'seg', options: [['auto', 'Match Appearance'], ['light', 'Light'], ['dark', 'Dark']], desc: 'Keep the editor and terminal dark in a light window (or the other way round).' },
      ] },
      { title: 'Text', rows: [
        { key: 'editor.font', label: 'Code font', type: 'select', options: [['default', 'SF Mono / JetBrains Mono'], ['jetbrains', 'JetBrains Mono'], ['system', 'System monospace'], ['custom', 'Other installed font…']], desc: 'Used by the editor and the terminal.' },
        { key: 'editor.fontCustom', label: 'Font name', type: 'text', placeholder: 'e.g. Fira Code', when: () => settings.get('editor.font') === 'custom' },
        { key: 'editor.fontSize', label: 'Font size', type: 'range', min: 9, max: 28, step: 1, unit: 'pt' },
        { key: 'editor.lineHeight', label: 'Line height', type: 'range', min: 1.2, max: 2.2, step: 0.05, fmt: v => `${(+v).toFixed(2)}×` },
        { key: 'editor.ligatures', label: 'Font ligatures', type: 'switch', desc: 'For fonts that have them, like JetBrains Mono (=> ≠ …).' },
      ] },
      { title: 'Display', rows: [
        { key: 'editor.cursorStyle', label: 'Cursor', type: 'seg', options: [['line', 'Bar'], ['block', 'Block'], ['underline', 'Underline']] },
        { key: 'editor.cursorBlinking', label: 'Cursor blinking', type: 'select', options: [['blink', 'Blink'], ['smooth', 'Smooth'], ['phase', 'Fade'], ['expand', 'Expand'], ['solid', 'Never']] },
        { key: 'editor.lineNumbers', label: 'Line numbers', type: 'seg', options: [['on', 'On'], ['relative', 'Relative'], ['off', 'Off']] },
        { key: 'editor.lineHighlight', label: 'Highlight current line', type: 'switch' },
        { key: 'editor.whitespace', label: 'Show whitespace', type: 'select', options: [['none', 'Never'], ['selection', 'In selection'], ['boundary', 'Between words'], ['all', 'Always']] },
        { key: 'editor.indentGuides', label: 'Indent guides', type: 'switch' },
        { key: 'editor.bracketColors', label: 'Colour matching brackets', type: 'switch' },
        { key: 'editor.stickyScroll', label: 'Sticky scroll', type: 'switch', desc: 'Keep the enclosing function and class at the top while you scroll.' },
        { key: 'editor.minimap', label: 'Minimap', type: 'switch' },
        { key: 'editor.wordWrap', label: 'Word wrap', type: 'seg', options: [['off', 'Off'], ['on', 'On']] },
      ] },
      { title: 'Editing', rows: [
        { key: 'editor.tabSize', label: 'Tab size', type: 'seg', options: [[2, '2'], [4, '4'], [8, '8']] },
        { key: 'editor.insertSpaces', label: 'Indent with spaces', type: 'switch' },
        { key: 'editor.detectIndentation', label: 'Detect indentation from the file', type: 'switch' },
        { key: 'editor.autoSave', label: 'Auto save', type: 'select', options: [['off', 'Off'], ['delay', 'After a pause in typing'], ['focus', 'When you switch away']] },
        { key: 'editor.trimWhitespace', label: 'Trim trailing spaces on save', type: 'switch' },
        { key: 'editor.finalNewline', label: 'End files with a newline on save', type: 'switch' },
        { key: 'editor.previewTabs', label: 'Preview tabs', type: 'switch', desc: 'A single click shows a file in a tab that the next one replaces (in italics).' },
      ] },
      { title: 'Markdown', rows: [
        { key: 'editor.markdownView', label: 'Open Markdown files', type: 'seg', options: [['split', 'Side by Side'], ['source', 'Source'], ['preview', 'Preview']], desc: 'Side by side shows the text and the rendered page next to each other, scrolling together.' },
      ] },
    ],
  },
  {
    id: 'terminal', title: 'Terminal', icon: 'terminal', tint: 'graphite', groups: [
      { rows: [
        { key: 'terminal.fontSize', label: 'Font size', type: 'range', min: 9, max: 24, step: 1, unit: 'pt' },
        { key: 'terminal.lineHeight', label: 'Line height', type: 'range', min: 1, max: 1.8, step: 0.02, fmt: v => `${(+v).toFixed(2)}×` },
        { key: 'terminal.cursorStyle', label: 'Cursor', type: 'seg', options: [['bar', 'Bar'], ['block', 'Block'], ['underline', 'Underline']] },
        { key: 'terminal.cursorBlink', label: 'Blinking cursor', type: 'switch' },
      ] },
      { rows: [
        { key: 'terminal.cwd', label: 'New terminals start in', type: 'seg', options: [['folder', 'Sidebar folder'], ['home', 'Home']] },
        { key: 'terminal.copyOnSelect', label: 'Copy on select', type: 'switch' },
        { key: 'terminal.rightClick', label: 'Right-click', type: 'seg', options: [['menu', 'Menu'], ['paste', 'Paste']] },
        { key: 'terminal.bell', label: 'Bell', type: 'seg', options: [['visual', 'Flash'], ['none', 'Silent']] },
        { key: 'terminal.scrollback', label: 'Scrollback', type: 'select', options: [[1000, '1,000 lines'], [8000, '8,000 lines'], [25000, '25,000 lines'], [100000, '100,000 lines']] },
        { key: 'terminal.webgl', label: 'GPU rendering', type: 'switch', desc: 'Draws output with WebGL. Turn off if text looks wrong.' },
      ] },
    ],
  },
  {
    id: 'files', title: 'Files', icon: 'folder', tint: 'sky', groups: [
      { rows: [
        { key: 'files.density', label: 'Row size', type: 'seg', options: [['compact', 'Small'], ['regular', 'Medium'], ['roomy', 'Large']] },
        { key: 'files.colorIcons', label: 'Coloured file icons', type: 'switch' },
        { key: 'files.foldersFirst', label: 'Folders first', type: 'switch' },
        { key: 'files.hidden', label: 'Show hidden files', type: 'switch', desc: 'Names that start with a dot.' },
        { key: 'files.exclude', label: 'Never show', type: 'text', placeholder: 'node_modules, *.pyc, .git', desc: 'Names or patterns (* and ?), separated by commas.' },
      ] },
      { title: 'Folder view', rows: [
        { key: 'files.startView', label: 'Open servers in', type: 'seg', options: [['ide', 'Editor'], ['folders', 'Folder View']], desc: 'Where a new browser tab starts (a reload keeps the view you were in). Switch any time with the grid button next to the tabs.' },
        { key: 'files.folderView', label: 'Show items as', type: 'seg', options: [['icons', 'Icons'], ['list', 'List']] },
        { key: 'files.iconSize', label: 'Icon size', type: 'range', min: 40, max: 128, step: 8, unit: 'px' },
        { key: 'files.thumbnails', label: 'Picture thumbnails', type: 'switch', desc: 'Pictures under 8 MB show as themselves. They’re downloaded to draw them.' },
      ] },
      { rows: [
        { key: 'files.singleClick', label: 'Single click on a file', type: 'seg', options: [['preview', 'Opens it'], ['select', 'Selects it']] },
        { key: 'files.confirmDelete', label: 'Ask before deleting', type: 'switch' },
        { key: 'files.confirmMove', label: 'Ask before moving by drag', type: 'switch' },
      ] },
    ],
  },
  { id: 'servers', title: 'Servers', icon: 'server', tint: 'green', groups: [{ rows: [{ type: 'servers' }] }] },
  { id: 'keyboard', title: 'Keyboard', icon: 'keyboard', tint: 'graphite', groups: [{ rows: [{ type: 'keys' }] }] },
  { id: 'general', title: 'General', icon: 'gear', tint: 'graphite', groups: [{ rows: [{ type: 'general' }] }] },
];

let current = null;

/** Open Settings (one window at a time). section: a section id to start in. */
export function openSettings({ ws = null, section } = {}) {
  if (current) { current.show(section); return current; }
  current = new SettingsWindow(ws);
  current.show(section || 'appearance');
  return current;
}

class SettingsWindow {
  constructor(ws) {
    this.ws = ws;
    this.query = '';
    this.wrap = h(`<div class="settings-wrap"><div class="settings glass-pop" role="dialog" aria-label="Settings">
      <nav class="set-side">
        <label class="set-search">${icons.search}<input placeholder="Search" spellcheck="false" autocomplete="off" aria-label="Search settings"></label>
        <div class="set-nav"></div>
      </nav>
      <main class="set-main"><header class="set-head"><h2></h2><button class="ib set-close" title="Close (Esc)">${icons.xmark}</button></header><div class="set-body"></div></main>
    </div></div>`);
    this.nav = this.wrap.querySelector('.set-nav');
    this.body = this.wrap.querySelector('.set-body');
    this.title = this.wrap.querySelector('.set-head h2');
    this.search = this.wrap.querySelector('.set-search input');
    this.nav.innerHTML = SECTIONS.map(s => `<button data-s="${s.id}"><span class="set-ic ${s.tint}">${icons[s.icon]}</span>${esc(s.title)}</button>`).join('');
    this.prevFocus = document.activeElement;
    document.body.appendChild(this.wrap);
    this.bind();
    this.off = settings.on('*', (v, k) => this.onChange(k));
  }

  show(section) {
    if (section) this.section = section;
    this.search.value = '';
    this.query = '';
    this.render();
    this.search.focus();
  }

  close() {
    this.off();
    document.removeEventListener('keydown', this.onKey, true);
    if (this.recording) this.stopRecording();
    this.wrap.remove();
    current = null;
    if (this.prevFocus && this.prevFocus.focus) this.prevFocus.focus();
  }

  bind() {
    this.wrap.addEventListener('mousedown', e => { if (e.target === this.wrap) this.close(); });
    this.wrap.querySelector('.set-close').addEventListener('click', () => this.close());
    this.onKey = e => {
      if (this.recording) return;
      if (e.key === 'Escape' && !document.querySelector('.overlays .scrim, .overlays .menu')) {
        e.preventDefault();
        e.stopPropagation();
        if (this.query) { this.search.value = ''; this.query = ''; this.render(); } else this.close();
      }
    };
    document.addEventListener('keydown', this.onKey, true);
    this.nav.addEventListener('click', e => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      this.section = b.dataset.s;
      this.search.value = '';
      this.query = '';
      this.render();
    });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.body.addEventListener('click', e => this.onClick(e));
    this.body.addEventListener('input', e => this.onInput(e));
    this.body.addEventListener('change', e => this.onInput(e, true));
  }

  // --- rendering -------------------------------------------------------------------------
  render() {
    for (const b of this.nav.querySelectorAll('[data-s]')) b.classList.toggle('on', !this.query && b.dataset.s === this.section);
    if (this.query) {
      this.title.textContent = 'Search Results';
      const q = this.query;
      let html = '';
      for (const sec of SECTIONS) {
        const rows = sec.groups.flatMap(g => g.rows).filter(r => r.key && `${r.label} ${r.desc || ''} ${r.key}`.toLowerCase().includes(q));
        if (rows.length) html += `<div class="set-group-title">${esc(sec.title)}</div><div class="set-group">${rows.map(r => this.row(r)).join('')}</div>`;
      }
      const cmds = COMMANDS.filter(c => c.title.toLowerCase().includes(q));
      if (cmds.length) html += `<div class="set-group-title">Keyboard Shortcuts</div><div class="set-group">${cmds.map(c => this.keyRow(c)).join('')}</div>`;
      this.body.innerHTML = html || `<div class="set-none">No settings match “${esc(this.search.value)}”.</div>`;
      return;
    }
    const sec = SECTIONS.find(s => s.id === this.section) || SECTIONS[0];
    this.title.textContent = sec.title;
    this.body.innerHTML = sec.groups.map(g => {
      const rows = g.rows.filter(r => !r.when || r.when());
      if (rows.length === 1 && ['servers', 'keys', 'general'].includes(rows[0].type)) return this.row(rows[0]);
      return `${g.title ? `<div class="set-group-title">${esc(g.title)}</div>` : ''}<div class="set-group">${rows.map(r => this.row(r)).join('')}</div>`;
    }).join('');
    if (sec.id === 'servers') this.loadHosts();
  }

  row(r) {
    if (r.type === 'servers') return this.serversRow();
    if (r.type === 'keys') return this.keysBlock();
    if (r.type === 'general') return this.generalBlock();
    const v = settings.get(r.key);
    const label = `<div class="set-l"><div class="set-t">${esc(r.label)}</div>${r.desc ? `<div class="set-d">${esc(r.desc)}</div>` : ''}</div>`;
    const reset = settings.isDefault(r.key) ? '' : `<button class="set-reset" data-reset="${r.key}" title="Back to the default">${icons.refresh}</button>`;
    let ctl = '';
    if (r.type === 'switch') {
      ctl = `<button class="switch${v ? ' on' : ''}" role="switch" aria-checked="${!!v}" data-k="${r.key}" data-switch></button>`;
    } else if (r.type === 'seg') {
      ctl = `<div class="segc" role="radiogroup">${r.options.map(([val, l]) => `<button role="radio" aria-checked="${val === v}" class="${val === v ? 'on' : ''}" data-k="${r.key}" data-v="${esc(JSON.stringify(val))}">${esc(l)}</button>`).join('')}</div>`;
    } else if (r.type === 'select') {
      ctl = `<span class="popup"><select data-k="${r.key}">${r.options.map(([val, l]) => `<option value="${esc(JSON.stringify(val))}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${icons.upDown}</span>`;
    } else if (r.type === 'range') {
      const shown = r.fmt ? r.fmt(v) : `${v}${r.unit ? ' ' + r.unit : ''}`;
      ctl = `<span class="range"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}" data-k="${r.key}"><output>${esc(shown)}</output></span>`;
    } else if (r.type === 'text') {
      ctl = `<input class="field set-text" data-k="${r.key}" value="${esc(v)}" placeholder="${esc(r.placeholder || '')}" spellcheck="false" autocomplete="off">`;
    } else if (r.type === 'appearance') {
      ctl = `<div class="look-pick">${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([val, l]) =>
        `<button class="look ${val}${v === val ? ' on' : ''}" data-k="appearance" data-v='"${val}"'><span class="look-img"><i></i><b></b></span><span>${l}</span></button>`).join('')}</div>`;
      return `<div class="set-row tall">${label}${ctl}</div>`;
    } else if (r.type === 'accent') {
      ctl = `<div class="accents">${Object.entries(ACCENTS).map(([id, a]) => `<button class="acc${id === v ? ' on' : ''}" style="--c:${a.dark};--cl:${a.light}" data-k="accent" data-v='"${id}"' title="${a.name}"></button>`).join('')}</div>`;
    } else if (r.type === 'wallpaper') {
      ctl = `<div class="walls">${WALLS.map(([id, l]) => `<button class="wall-th${id === v ? ' on' : ''}" data-wall="${id}" data-k="wallpaper" data-v='"${id}"' title="${l}"></button>`).join('')}</div>`;
    } else if (r.type === 'themes') {
      const dark = document.documentElement.dataset.pane === 'dark';
      return `<div class="set-row col">${label}<div class="themes">${FAMILIES.map(f => `<button class="theme-card${f.id === v ? ' on' : ''}" data-k="editor.theme" data-v='"${f.id}"'>${sampleHtml(dark ? f.dark : f.light)}<span>${esc(f.name)}</span></button>`).join('')}</div></div>`;
    }
    return `<div class="set-row" data-row="${r.key}">${label}<div class="set-c">${reset}${ctl}</div></div>`;
  }

  // --- servers ------------------------------------------------------------------------------
  serversRow() {
    return `<div class="set-note">Give each server a colour and a name of your own: they show on its sidebar folder, tabs and terminals, so it's always clear which machine you're on.</div><div class="hosts-list">${this.hosts ? '' : '<div class="set-none">Reading ~/.ssh/config…</div>'}</div>`;
  }

  async loadHosts() {
    if (!this.hosts) {
      try { this.hosts = (await api('/api/hosts')).hosts.map(x => x.alias); } catch { this.hosts = []; }
      for (const a of Object.keys(settings.get('hosts'))) if (!this.hosts.includes(a)) this.hosts.push(a);
    }
    const list = this.body.querySelector('.hosts-list');
    if (!list) return;
    const conf = settings.get('hosts');
    list.innerHTML = this.hosts.length ? this.hosts.map(a => {
      const c = hostColor(a);
      const mine = (conf[a] || {}).color;
      return `<div class="host-set" data-host="${esc(a)}">
        <span class="tile ${c}">${icons.server}</span>
        <div class="hs-main"><input class="field" data-label value="${esc((conf[a] || {}).label || '')}" placeholder="${esc(a)}" spellcheck="false" autocomplete="off" aria-label="Name for ${esc(a)}">
        <div class="m-sw">${TAG_COLORS.map(t => `<button class="sw${mine === t ? ' on' : ''}" style="--c:var(--${t})" data-color="${t}" title="${t}"></button>`).join('')}<button class="sw none${mine ? '' : ' on'}" data-color="" title="Automatic"></button></div></div>
      </div>`;
    }).join('') : '<div class="set-none">No hosts in ~/.ssh/config.</div>';
  }

  // --- keyboard shortcuts ---------------------------------------------------------------------
  keysBlock() {
    const groups = [...new Set(COMMANDS.map(c => c.group))];
    return `<div class="set-note">Click a shortcut to record a new one; ${isMac ? '⌫' : 'Backspace'} removes it, Esc cancels. The browser keeps a few for itself (${['Mod+W', 'Mod+T', 'Mod+N'].map(kbd).join(', ')}).</div>`
      + groups.map(g => `<div class="set-group-title">${esc(g)}</div><div class="set-group">${COMMANDS.filter(c => c.group === g).map(c => this.keyRow(c)).join('')}</div>`).join('');
  }

  keyRow(c) {
    const k = keysOf(c);
    const changed = Object.prototype.hasOwnProperty.call(settings.get('keys'), c.id);
    return `<div class="set-row key-row" data-cmd="${c.id}"><div class="set-l"><div class="set-t">${esc(c.title)}</div></div><div class="set-c">
      ${changed ? `<button class="set-reset" data-keyreset="${c.id}" title="Back to the default (${esc(c.keys ? kbd(c.keys) : 'none')})">${icons.refresh}</button>` : ''}
      <button class="keycap-btn" data-record="${c.id}">${k ? keycaps(k) : '<span class="none">None</span>'}</button></div></div>`;
  }

  record(id, btn) {
    if (this.recording) this.stopRecording();
    btn.classList.add('rec');
    btn.innerHTML = '<span class="none">Type a shortcut…</span>';
    const onKey = e => {
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Control', 'Alt', 'Meta', 'OS'].includes(e.key)) return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { this.stopRecording(); this.render(); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) { this.setKeys(id, ''); this.stopRecording(); return; }
      const name = keyName(e);
      const plain = !/(^|\+)(Mod|Ctrl|Alt|Meta)\+/.test(name) && !/^F\d+$/.test(name);
      if (plain) { btn.innerHTML = '<span class="none">Add ⌃, ⌥ or ⌘ (or use an F key)</span>'; return; }
      if (RESERVED.has(normKeys(name))) { btn.innerHTML = `<span class="none">${esc(kbd(name))} belongs to the browser</span>`; return; }
      this.stopRecording();
      const owner = keyOwner(name, id);
      if (owner) {
        this.setKeys(owner.id, '');
        toast({ title: `${kbd(name)} moved here`, message: `It was “${owner.title}”, which now has no shortcut.`, timeout: 4000 });
      }
      this.setKeys(id, name);
    };
    document.addEventListener('keydown', onKey, true);
    this.recording = { onKey, btn };
  }

  stopRecording() {
    if (!this.recording) return;
    document.removeEventListener('keydown', this.recording.onKey, true);
    this.recording.btn.classList.remove('rec');
    this.recording = null;
  }

  setKeys(id, keys) {
    const all = { ...settings.get('keys') };
    const cmd = COMMANDS.find(c => c.id === id);
    if ((cmd.keys || '') === keys) delete all[id]; else all[id] = keys;
    settings.set('keys', all);
  }

  // --- general ----------------------------------------------------------------------------------
  generalBlock() {
    return `<div class="set-group"><div class="set-row"><div class="set-l"><div class="set-t">Export settings</div><div class="set-d">Save your settings to a file, to keep or to use in another browser.</div></div><div class="set-c"><button class="btn small" data-act="export">Export…</button></div></div>
      <div class="set-row"><div class="set-l"><div class="set-t">Import settings</div><div class="set-d">Load a file saved with Export.</div></div><div class="set-c"><button class="btn small" data-act="import">Import…</button><input type="file" accept="application/json,.json" hidden data-import></div></div>
      <div class="set-row"><div class="set-l"><div class="set-t">Reset all settings</div><div class="set-d">Everything back to how sshcode started out. Your servers, files and terminals aren't touched.</div></div><div class="set-c"><button class="btn small danger" data-act="reset">Reset…</button></div></div></div>`;
  }

  // --- events -----------------------------------------------------------------------------------
  onClick(e) {
    const t = e.target;
    const reset = t.closest('[data-reset]');
    if (reset) { settings.reset(reset.dataset.reset); return; }
    const kreset = t.closest('[data-keyreset]');
    if (kreset) { const all = { ...settings.get('keys') }; delete all[kreset.dataset.keyreset]; settings.set('keys', all); return; }
    const rec = t.closest('[data-record]');
    if (rec) { this.record(rec.dataset.record, rec); return; }
    const sw = t.closest('[data-switch]');
    if (sw) { settings.set(sw.dataset.k, !settings.get(sw.dataset.k)); return; }
    const opt = t.closest('[data-v][data-k]');
    if (opt) { settings.set(opt.dataset.k, JSON.parse(opt.dataset.v)); return; }
    const color = t.closest('[data-color]');
    if (color) { setHost(color.closest('[data-host]').dataset.host, { color: color.dataset.color || null }); return; }
    const act = t.closest('[data-act]');
    if (act) this.act(act.dataset.act);
  }

  onInput(e, committed = false) {
    const t = e.target;
    if (t.matches('[data-import]')) { if (committed) this.importFile(t); return; }
    if (t.matches('[data-label]')) {
      if (committed) setHost(t.closest('[data-host]').dataset.host, { label: t.value.trim() || null });
      return;
    }
    const k = t.dataset.k;
    if (!k) return;
    if (t.tagName === 'SELECT') settings.set(k, JSON.parse(t.value));
    else if (t.type === 'range') {
      const r = SECTIONS.flatMap(s => s.groups.flatMap(g => g.rows)).find(x => x.key === k);
      const v = +t.value;
      const out = t.parentNode.querySelector('output');
      if (out) out.textContent = r && r.fmt ? r.fmt(v) : `${v}${r && r.unit ? ' ' + r.unit : ''}`;
      settings.set(k, v);
      if (committed) { t.blur(); this.onChange(k); }
    } else if (t.classList.contains('set-text')) {
      clearTimeout(this.textTimer);
      this.textTimer = setTimeout(() => settings.set(k, t.value), committed ? 0 : 500);
    }
  }

  async act(a) {
    if (a === 'export') {
      const blob = new Blob([JSON.stringify(settings.changed(), null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sshcode-settings.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else if (a === 'import') {
      this.body.querySelector('[data-import]').click();
    } else if (a === 'reset') {
      if (await confirm('Reset all settings?', 'Appearance, editor, terminal, files, server colours and shortcuts go back to their defaults.', { ok: 'Reset', danger: true })) {
        settings.resetAll();
        toast({ title: 'Settings reset', timeout: 2200 });
      }
    }
  }

  async importFile(input) {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a settings file');
      settings.replace(obj);
      toast({ kind: 'ok', title: 'Settings imported', timeout: 2500 });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t import that file', message: e.message });
    }
  }

  /** Something changed (here, in another tab or by a shortcut): redraw what shows it. */
  onChange(k) {
    if (this.recording) return;
    const focus = document.activeElement;
    // Don't redraw under the cursor of a text field or a dragged slider.
    if (focus && this.body.contains(focus) && (focus.matches('input.set-text, input[data-label]') || (focus.type === 'range' && focus.dataset.k === k))) return;
    const top = this.body.scrollTop;
    this.render();
    this.body.scrollTop = top;
    if (k === 'hosts' || this.section === 'servers') this.loadHosts();
  }
}

// Settings can be opened before any workspace exists (the start page).
export { DEFAULTS };
