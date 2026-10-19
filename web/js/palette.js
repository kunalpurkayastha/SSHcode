// A Spotlight-style picker: Go to File (every sidebar folder, on every
// server), commands (>), go to line (:), Go to Folder, Add Server, the editor
// theme (previewed as you move) and language mode.
import { esc, h, store, basename, dirname, join, relPath, tildify, untildify, keycaps, byName } from './util.js';
import { icons, fileIcon, folderIcon } from './icons.js';
import { spinner } from './ui.js';
import { api } from './api.js';
import { languages, languageName } from './editor.js';
import { settings, hostColor, hostLabel } from './settings.js';
import { FAMILIES } from './themes.js';

/** Subsequence match with bonuses for word starts and runs. */
export function fuzzy(q, s) {
  if (!q) return { score: 0, pos: [] };
  const sl = s.toLowerCase();
  let qi = 0, score = 0, prev = -2;
  const pos = [];
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (sl[i] !== q[qi]) continue;
    let bonus = 1;
    if (i === prev + 1) bonus += 5;
    const c = s[i - 1];
    if (i === 0 || c === '/' || c === '_' || c === '-' || c === '.' || c === ' ') bonus += 8;
    else if (s[i] !== sl[i] && c === c.toLowerCase()) bonus += 6;
    score += bonus;
    pos.push(i);
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  return { score: score - s.length * 0.02 - pos[0] * 0.05, pos };
}

function marked(s, pos, offset = 0) {
  if (!pos || !pos.length) return esc(s);
  const set = new Set(pos.map(p => p - offset));
  let out = '';
  for (let i = 0; i < s.length; i++) out += set.has(i) ? `<b>${esc(s[i])}</b>` : esc(s[i]);
  return out;
}

/** "web1:/data", "user@host:~/proj" → {host, path}. */
function hostAndPath(q) {
  const m = q.match(/^((?:[^@\s/:]+@)?[^:\s/@]+):([/~].*)$/);
  return m ? { host: m[1], path: m[2] } : null;
}

export class Palette {
  constructor(ws) {
    this.ws = ws;
    this.indexes = new Map();   // root id -> {path, files, truncated, at} | {loading}
    this.dirCache = new Map();  // "host\npath" -> folder names | {error}
    this.hosts = null;
  }

  // --- file index ---------------------------------------------------------------
  recentKey() { return `recent:${this.ws.host}`; }
  recents() {
    // Older versions kept bare paths (on the workspace's own server).
    return store.get(this.recentKey(), []).map(x => (typeof x === 'string' ? { h: this.ws.host, p: x } : x)).filter(x => x && x.p);
  }
  noteRecent(host, path) {
    const list = this.recents().filter(x => !(x.h === host && x.p === path));
    list.unshift({ h: host, p: path });
    store.set(this.recentKey(), list.slice(0, 50));
  }

  loadIndex(root, force = false) {
    const cur = this.indexes.get(root.id);
    if (cur && cur.path === root.path) {
      if (cur.loading) return cur.loading;
      if (!force && Date.now() - cur.at < 60000) return Promise.resolve(cur);
    }
    const entry = { path: root.path, loading: null };
    entry.loading = this.ws.conn(root.host).call('/api/find', { query: { root: root.path } }).then(r => {
      const idx = { path: root.path, files: r.files, truncated: r.truncated, at: Date.now() };
      if (this.indexes.get(root.id) === entry) this.indexes.set(root.id, idx);
      return idx;
    }, e => {
      if (this.indexes.get(root.id) === entry) this.indexes.delete(root.id);
      throw e;
    });
    this.indexes.set(root.id, entry);
    return entry.loading;
  }

  invalidate(root) {
    if (root) this.indexes.delete(root.id); else this.indexes.clear();
    this.dirCache.clear();
  }

  readyRoots() {
    return this.ws.roots.filter(r => { const i = this.indexes.get(r.id); return i && !i.loading && i.path === r.path; });
  }

  // --- modes ----------------------------------------------------------------------
  files(initial = '') {
    this.open({ value: initial, placeholder: 'Search files by name  ( > commands   : line )', mode: 'files' });
    const roots = this.ws.roots.filter(r => this.ws.conn(r.host).state === 'ok');
    this.indexError = null;
    for (const r of roots) this.loadIndex(r).then(() => this.update(), e => { this.indexError = e.message; this.update(); });
  }

  commands() { this.open({ value: '>', placeholder: 'Type a command', mode: 'files' }); }
  line() { this.open({ value: ':', placeholder: 'Go to line', mode: 'files' }); }

  /** Finder's Go to Folder for one sidebar folder; with add, the pick becomes a new sidebar folder. */
  /** pick(host, path): instead of moving the sidebar folder (the folder view uses this). */
  openFolder(root = this.ws.activeRoot(), { add = false, pick = null } = {}) {
    this.target = root;
    this.adding = add;
    this.pick = pick;
    const home = this.ws.conn(root.host).home;
    const start = tildify(root.path, home);
    this.folderStart = start === '/' ? '/' : start + '/';
    const where = this.ws.multiHost() ? ` on ${hostLabel(root.host)}` : '';
    this.open({ value: this.folderStart, placeholder: add ? `Add a folder${where}: /data, ~/projects…` : `Go to folder${where}: /data, ~/projects, src…`, mode: 'folder' });
    this.input.select();
  }

  /** Pick a host from ~/.ssh/config (or type host, user@host or host:/path). */
  addServer() {
    this.pickHost({
      title: 'Add a server to the sidebar: pick a host, or type host:/folder',
      pick: (host, path) => this.ws.addRoot(host, path),
    });
  }

  pickHost({ title, pick }) {
    this.onHost = pick;
    this.open({ value: '', placeholder: title, mode: 'hosts' });
    if (!this.hosts) {
      api('/api/hosts').then(d => { this.hosts = d.hosts; this.update(); }, e => { this.hosts = []; this.hostError = e.message; this.update(); });
    }
  }

  /** Editor themes, previewed as you move through them; Esc puts the old one back. */
  themes() {
    this.themeBefore = settings.get('editor.theme');
    this.previewing = false;
    this.open({ value: '', placeholder: 'Editor theme (↑↓ to preview)', mode: 'theme' });
    this.sel = Math.max(0, FAMILIES.findIndex(f => f.id === this.themeBefore));
    this.previewing = true;
    this.paint();
  }

  language() {
    const cur = this.ws.editor.active && this.ws.editor.active.model ? this.ws.editor.active.model.getLanguageId() : null;
    this.open({ value: '', placeholder: `Select a language mode${cur ? ` (now ${languageName(cur)})` : ''}`, mode: 'lang' });
  }

  // --- picker -----------------------------------------------------------------------
  open({ value, placeholder, mode }) {
    this.close();
    this.mode = mode;
    this.sel = 0;
    this.items = [];
    this.wrap = h(`<div class="palette-wrap"><div class="palette glass-pop" role="dialog" aria-label="Quick Open">
      <div class="pal-input">${icons.search}<input spellcheck="false" autocomplete="off" aria-label="Search"><span class="mode"></span></div>
      <div class="pal-list" role="listbox"></div></div></div>`);
    document.body.appendChild(this.wrap);
    this.input = this.wrap.querySelector('input');
    this.list = this.wrap.querySelector('.pal-list');
    this.input.placeholder = placeholder;
    this.input.value = value;
    this.prevFocus = document.activeElement;
    this.input.focus();
    this.input.setSelectionRange(value.length, value.length);
    this.input.addEventListener('input', () => { this.sel = 0; this.update(); });
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.wrap.addEventListener('mousedown', e => { if (e.target === this.wrap) { e.preventDefault(); this.cancel(); } });
    this.list.addEventListener('mousemove', e => {
      const it = e.target.closest('.pal-item');
      if (it && +it.dataset.i !== this.sel) { this.sel = +it.dataset.i; this.paint(); }
    });
    this.list.addEventListener('click', e => {
      const it = e.target.closest('.pal-item');
      if (it) { this.sel = +it.dataset.i; this.accept(); }
    });
    this.update();
  }

  close(restoreFocus = false) {
    if (!this.wrap) return;
    this.wrap.remove();
    this.wrap = null;
    if (restoreFocus && this.prevFocus && this.prevFocus.focus) this.prevFocus.focus();
  }

  cancel() {
    if (this.mode === 'theme' && this.themeBefore) settings.set('editor.theme', this.themeBefore);
    this.close(true);
  }

  onKey(e) {
    const n = this.items.length;
    if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { this.sel = (this.sel + 1) % n; this.paint(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { this.sel = (this.sel - 1 + n) % n; this.paint(); } }
    else if (e.key === 'PageDown') { e.preventDefault(); this.sel = Math.min(n - 1, this.sel + 8); this.paint(); }
    else if (e.key === 'PageUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 8); this.paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); this.accept(); }
    else if (e.key === 'Tab' && this.mode === 'folder') {
      e.preventDefault();
      const it = this.items[this.sel];
      if (it && it.complete) { this.input.value = it.complete; this.sel = 0; this.update(); }
    }
    e.stopPropagation();
  }

  accept() {
    const it = this.items[this.sel];
    if (!it || !it.run) return;
    this.themeBefore = null;
    this.close(false);
    it.run();
  }

  async update(error) {
    if (!this.wrap) return;
    const v = this.input.value;
    const modeEl = this.wrap.querySelector('.mode');
    let items = [];
    let empty = '';
    if (this.mode === 'folder') {
      items = await this.folderItems(v);
      modeEl.textContent = 'Tab to complete';
    } else if (this.mode === 'hosts') {
      modeEl.textContent = '';
      items = this.hostItems(v.trim());
      if (!items.length) empty = this.hosts ? this.hostError || 'No hosts match' : 'loading';
    } else if (this.mode === 'theme') {
      modeEl.textContent = '';
      const q = v.trim().toLowerCase();
      items = FAMILIES.map(f => ({ f, m: fuzzy(q, f.name) })).filter(x => x.m).map(({ f, m }) => ({
        icon: `<span class="theme-dot" style="background:${f.dark.bg};border-color:${f.light.bg}"></span>`,
        label: marked(f.name, m.pos), sub: f.id === this.themeBefore ? 'current' : '', theme: f.id,
        run: () => settings.set('editor.theme', f.id),
      }));
    } else if (this.mode === 'lang') {
      modeEl.textContent = '';
      const q = v.trim().toLowerCase();
      items = languages().map(l => ({ l, m: fuzzy(q, l.name) })).filter(x => x.m)
        .sort((a, b) => b.m.score - a.m.score).slice(0, 80)
        .map(({ l, m }) => ({ label: marked(l.name, m.pos), sub: esc(l.id), run: () => this.ws.editor.setLanguage(l.id) }));
    } else if (v.startsWith('>')) {
      modeEl.textContent = 'Commands';
      items = this.commandItems(v.slice(1).trim().toLowerCase());
      empty = 'No matching commands';
    } else if (v.startsWith(':')) {
      modeEl.textContent = 'Go to Line';
      const m = v.slice(1).match(/^\s*(\d+)(?:[:,](\d+))?/);
      const d = this.ws.editor.active;
      if (!d || d.kind !== 'text') empty = 'Open a text file first';
      else {
        const lines = d.model.getLineCount();
        items = [{ icon: icons.chevronRight, label: m ? `Go to line ${m[1]}${m[2] ? `, column ${m[2]}` : ''}` : `Type a line number between 1 and ${lines}`, run: m ? () => this.ws.editor.goToLine(+m[1], m[2] ? +m[2] : 1) : null }];
      }
    } else {
      const ready = this.readyRoots();
      const count = ready.reduce((a, r) => a + this.indexes.get(r.id).files.length, 0);
      modeEl.textContent = ready.length ? `${count.toLocaleString()}${ready.some(r => this.indexes.get(r.id).truncated) ? '+' : ''} files` : '';
      items = this.fileItems(v.trim());
      if (!items.length) {
        if (error || this.indexError) empty = error || this.indexError;
        else if (!ready.length) empty = 'indexing';
        else empty = 'No matching files';
      }
    }
    if (!this.wrap) return;
    this.items = items;
    if (this.sel >= items.length) this.sel = 0;
    this.render(empty);
  }

  fileItems(q) {
    const ql = q.toLowerCase().replace(/\\/g, '/');
    const roots = this.ws.roots;
    if (!ql) {
      const open = this.ws.editor.docs.map(d => ({ h: d.host, p: d.path }));
      const seen = new Set();
      const out = [];
      const act = this.ws.editor.active;
      for (const x of [...this.recents(), ...open]) {
        const key = `${x.h}\n${x.p}`;
        if (seen.has(key) || (act && act.host === x.h && act.path === x.p)) continue;
        seen.add(key);
        out.push(this.fileItem(x.h, x.p, null, null, 'Recently opened'));
        if (out.length >= 12) break;
      }
      return out;
    }
    const hasSlash = ql.includes('/');
    const scored = [];
    for (const root of this.readyRoots()) {
      for (const f of this.indexes.get(root.id).files) {
        const slash = f.lastIndexOf('/');
        const name = slash >= 0 ? f.slice(slash + 1) : f;
        let m = null, inName = false;
        if (!hasSlash) {
          m = fuzzy(ql, name);
          if (m) { m.score += 40 + (name.toLowerCase().startsWith(ql) ? 30 : 0); inName = true; }
        }
        if (!m) m = fuzzy(ql, f);
        if (!m) continue;
        scored.push({ root, f, name, slash, m, inName });
      }
    }
    scored.sort((a, b) => b.m.score - a.m.score || a.f.length - b.f.length);
    const multi = roots.length > 1;
    return scored.slice(0, 80).map(({ root, f, name, slash, m, inName }) => {
      const dir = slash >= 0 ? f.slice(0, slash) : '';
      const label = inName ? marked(name, m.pos) : marked(name, m.pos.filter(p => p > slash), slash + 1);
      let sub = inName ? esc(dir) : marked(dir, m.pos.filter(p => p < slash));
      if (multi) sub = `<span class="pal-root" style="--hc:var(--${hostColor(root.host)})">${esc(this.rootLabel(root))}</span> ${sub}`;
      return this.fileItem(root.host, join(root.path, f), label, sub);
    });
  }

  rootLabel(root) {
    const name = this.ws.rootName(root);
    return this.ws.multiHost() ? `${hostLabel(root.host)} · ${name}` : name;
  }

  fileItem(host, path, label, sub, group) {
    const name = basename(path);
    let rest = sub;
    if (rest == null) {
      const root = this.ws.rootOf(host, path);
      const rel = root ? relPath(root.path, dirname(path)) : tildify(dirname(path), this.ws.conn(host).home);
      rest = esc((this.ws.multiHost() ? `${hostLabel(host)}: ` : '') + (root && rel === '' ? '' : rel));
    }
    return {
      group, icon: fileIcon(name), label: label || esc(name), sub: rest,
      run: () => { this.ws.editor.open(path, { host, preview: false }); },
    };
  }

  commandItems(q) {
    const all = [...this.ws.commands.filter(c => !c.hidden), ...this.ws.editor.editorActions()];
    const seen = new Set();
    const out = [];
    for (const c of all) {
      if (seen.has(c.title)) continue;
      seen.add(c.title);
      let m = fuzzy(q, c.title);
      if (!m && c.alias && (m = fuzzy(q, c.alias))) m.pos = [];
      if (m) out.push({ c, m });
    }
    if (q) out.sort((a, b) => b.m.score - a.m.score);
    return out.slice(0, 120).map(({ c, m }) => ({
      icon: c.icon ? icons[c.icon] : '', label: marked(c.title, m.pos), keys: c.keys,
      run: () => this.ws.run(c.id, c),
    }));
  }

  hostItems(q) {
    const items = [];
    const hp = hostAndPath(q);
    const ql = (hp ? hp.host : q).toLowerCase();
    const pick = this.onHost;
    if (hp) items.push({ group: 'Connect', icon: icons.folder, label: `Open ${esc(hp.path)}`, sub: `on ${esc(hp.host)}`, run: () => pick(hp.host, hp.path) });
    else if (q && !(this.hosts || []).some(x => x.alias === q)) {
      const m = q.match(/^([^@\s/]+@)?([^:\s/@]+):(\d{1,5})$/);
      const dest = m ? `ssh://${m[1] || ''}${m[2]}:${m[3]}` : q;
      items.push({ group: 'Connect', icon: icons.globe, label: `Connect to “${esc(q)}”`, sub: dest !== q ? esc(dest) : 'any destination ssh understands', run: () => pick(dest) });
    }
    for (const x of this.hosts || []) {
      if (ql && ![x.alias, x.hostname, x.user, x.jump].join(' ').toLowerCase().includes(ql)) continue;
      const port = x.port && x.port !== '22' ? `:${x.port}` : '';
      const where = `${x.user ? x.user + '@' : ''}${x.hostname || ''}${port}${x.jump ? ` via ${x.jump}` : ''}`;
      const here = this.ws.conns.has(x.alias) && this.ws.conn(x.alias).state === 'ok';
      items.push({
        group: 'Hosts', icon: `<span class="pal-tile tile ${hostColor(x.alias)}">${icons.server}</span>`,
        label: esc(hostLabel(x.alias)), sub: esc(where) + (here ? ' · connected' : ''), run: () => pick(x.alias),
      });
    }
    return items;
  }

  async folderItems(v) {
    const root = this.target || this.ws.activeRoot();
    const conn = this.ws.conn(root.host);
    const home = conn.home;
    const raw = v.trim();
    // Absolute, ~-relative, or relative to the folder you're in (like Finder).
    const full = !raw ? '/' : raw.startsWith('/') || raw.startsWith('~') ? untildify(raw, home) : join(root.path, raw);
    const slash = full.lastIndexOf('/');
    const dir = slash <= 0 ? '/' : full.slice(0, slash);
    const part = full.slice(slash + 1).toLowerCase();
    const ck = `${root.host}\n${dir}`;
    let entries = this.dirCache.get(ck);
    if (!entries) {
      this.renderBusy();
      try {
        const r = await conn.call('/api/ls', { query: { path: dir } });
        entries = r.entries.filter(e => e.type === 'dir' || e.type === 'linkdir').map(e => e.name).sort(byName);
      } catch (e) {
        entries = { error: e.message };
      }
      this.dirCache.set(ck, entries);
      if (!this.wrap || this.input.value !== v) return this.items;
    }
    if (entries.error) return [{ icon: icons.warning, label: esc(entries.error), sub: esc(tildify(dir, home)) }];
    const go = this.pick ? p => this.pick(root.host, p) : this.adding ? p => this.ws.addRoot(root.host, p) : p => this.ws.setRootPath(root, p);
    const items = [];
    const group = `In ${tildify(dir, home)}`;
    if (v === this.folderStart) {
      // Untouched: offer the folders you went to before, then what's here.
      for (const p of this.ws.recentFolders(root.host).filter(p => p !== root.path).slice(0, 5)) {
        items.push({ group: 'Recent', icon: icons.clock, label: esc(tildify(p, home)), sub: '', complete: tildify(p, home) + '/', run: () => go(p) });
      }
    }
    if (!part && (this.adding || dir !== root.path)) items.push({ group, icon: icons.folderOpen, label: this.adding ? 'Add this folder' : 'Open this folder', sub: esc(group), run: () => go(dir) });
    const hits = entries.filter(n => (part.startsWith('.') || !n.startsWith('.')) && n.toLowerCase().includes(part))
      .sort((a, b) => (b.toLowerCase().startsWith(part) - a.toLowerCase().startsWith(part)) || byName(a, b));
    for (const n of hits.slice(0, 200)) {
      const path = join(dir, n);
      items.push({ group, icon: folderIcon(), label: esc(n), sub: '', complete: tildify(path, home) + '/', run: () => go(path) });
    }
    if (part && !hits.length) items.push({ group, icon: icons.info, label: `No folder named “${esc(part)}”`, sub: '' });
    return items;
  }

  renderBusy() {
    if (this.list) this.list.innerHTML = `<div class="pal-empty">${spinner(14)}</div>`;
  }

  render(empty) {
    if (!this.items.length) {
      this.list.innerHTML = empty === 'indexing' || empty === 'loading'
        ? `<div class="pal-empty" style="display:flex;gap:8px;align-items:center">${spinner(14)} ${empty === 'loading' ? 'Reading ~/.ssh/config…' : 'Indexing files…'}</div>`
        : empty ? `<div class="pal-empty">${esc(empty)}</div>` : '';
      return;
    }
    let group = null;
    this.list.innerHTML = this.items.map((it, i) => {
      const head = it.group && it.group !== group ? `<div class="pal-group">${esc(it.group)}</div>` : '';
      group = it.group || group;
      return `${head}<div class="pal-item${i === this.sel ? ' on' : ''}" data-i="${i}" role="option">
      <span class="pic">${it.icon || ''}</span><span class="lbl">${it.label}</span><span class="sub">${it.sub || ''}</span>${it.keys ? `<span class="kk">${keycaps(it.keys)}</span>` : ''}</div>`;
    }).join('');
    if (this.mode === 'theme') this.preview();
  }

  paint() {
    this.list.querySelectorAll('.pal-item').forEach((el, i) => el.classList.toggle('on', i === this.sel));
    const on = this.list.querySelector('.pal-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    if (this.mode === 'theme') this.preview();
  }

  preview() {
    if (!this.previewing) return;
    const it = this.items[this.sel];
    if (it && it.theme) settings.set('editor.theme', it.theme);
  }
}
