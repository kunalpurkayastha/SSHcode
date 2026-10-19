// The file tree: one section per folder in the sidebar (folders from several
// servers can sit side by side), lazy folders, multi-select, inline
// create/rename, drag to move or copy (between servers too), drop files from
// the desktop to upload, cut/copy/paste.
import { esc, h, store, basename, dirname, join, isUnder, relPath, tildify, byName, copyText, isMac, keyName, reconcile } from './util.js';
import { icons, fileIcon, folderIcon, mediaKind } from './icons.js';
import { contextMenu, confirm, toastError } from './ui.js';
import { fileUrl, archiveUrl, download } from './api.js';
import { settings, hostColor, hostLabel, setHost, TAG_COLORS } from './settings.js';

const isDirType = t => t === 'dir' || t === 'linkdir';
export const DRAG_TYPE = 'application/x-sshcode-items';
const SPRING_MS = 650;  // hovering a closed folder this long while dragging opens it
const K = (sec, path) => `${sec.root.id}:${path}`;

/** "node_modules, *.pyc, .git" -> one case-insensitive RegExp over names. */
function globRe(patterns) {
  const parts = String(patterns || '').split(/[,\n]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const src = parts.map(p => '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try { return new RegExp(src.join('|'), 'i'); } catch { return null; }
}

export class Explorer {
  constructor(ws) {
    this.ws = ws;
    this.el = h(`<div class="view explorer">
      <div class="tree" tabindex="0" role="tree" aria-label="Files"></div>
      <input type="file" multiple hidden data-up="files">
      <input type="file" multiple hidden webkitdirectory data-up="dir">
    </div>`);
    this.tree = this.el.querySelector('.tree');
    this.secs = [];             // one per sidebar folder, in order
    this.sel = new Set();       // row keys (root id + path)
    this.focusKey = null;
    this.anchor = null;
    this.clip = null;           // {mode: 'cut' | 'copy', items: [{host, path, isDir}]}
    this.editing = null;        // {kind: 'new', sec, dir, isDir} | {kind: 'rename', sec, path}
    this.rows = [];             // visible keys in order (folder headers included)
    this.info = new Map();      // key -> {sec, path, e, depth, isRoot}
    this.uploadTarget = null;
    this.renderQueued = false;
    this.typeahead = { text: '', at: 0 };
    this.prefs();
    this.subs = ['files.hidden', 'files.exclude', 'files.foldersFirst', 'files.singleClick'].map(k => settings.on(k, () => {
      this.prefs();
      for (const sec of this.secs) for (const st of sec.dirs.values()) if (st.entries) this.sort(st.entries);
      this.render();
    }));
    this.bind();
  }

  prefs() {
    this.showHidden = settings.get('files.hidden');
    this.exclude = globRe(settings.get('files.exclude'));
    this.foldersFirst = settings.get('files.foldersFirst');
  }

  sort(entries) {
    return entries.sort((a, b) => (this.foldersFirst ? isDirType(b.type) - isDirType(a.type) : 0) || byName(a.name, b.name));
  }

  visible(name) {
    if (!this.showHidden && name.startsWith('.')) return false;
    return !(this.exclude && this.exclude.test(name));
  }

  dispose() { this.subs.forEach(f => f()); }

  // --- sections (one per sidebar folder) ---------------------------------------------
  setRoots() {
    for (const r of this.ws.roots) this.addRoot(r);
  }

  addRoot(root) {
    const sec = { root, dirs: new Map(), expanded: new Set(), folded: false, rowCache: new Map(), headHtml: '' };
    sec.el = h(`<div class="root-sec" role="group"><div class="root-head" role="treeitem"></div><div class="rows"></div></div>`);
    sec.head = sec.el.querySelector('.root-head');
    sec.body = sec.el.querySelector('.rows');
    this.secs.push(sec);
    this.tree.appendChild(sec.el);
    this.start(sec);
    return sec;
  }

  async start(sec) {
    if (sec.starting) return;
    sec.starting = true;
    const conn = this.ws.conn(sec.root.host);
    this.render();
    try {
      // Other servers sign in quietly; one that needs a password waits for a click.
      try { await conn.ensure(false); } catch { /* shown in the section */ }
      if (!this.secs.includes(sec)) return;
      if (conn.state === 'ok') {
        await this.loadDir(sec, sec.root.path);
        await this.restoreExpanded(sec);
      }
    } finally {
      sec.starting = false;
    }
    this.render();
  }

  removeRoot(root) {
    const sec = this.secOf(root);
    if (!sec) return;
    this.secs = this.secs.filter(s => s !== sec);
    sec.el.remove();
    for (const k of [...this.sel]) if (k.startsWith(root.id + ':')) this.sel.delete(k);
    this.render();
  }

  /** The folder now points somewhere else: start that section over. */
  async rootMoved(root) {
    const sec = this.secOf(root);
    if (!sec) return;
    sec.dirs.clear();
    sec.expanded.clear();
    sec.rowCache.clear();
    sec.body.replaceChildren();
    for (const k of [...this.sel]) if (k.startsWith(root.id + ':')) this.sel.delete(k);
    this.focusKey = this.anchor = null;
    this.editing = null;
    this.render();
    await this.loadDir(sec, root.path);
    await this.restoreExpanded(sec);
  }

  secOf(root) { return this.secs.find(s => s.root === root); }

  focusRoot(root) {
    const sec = this.secOf(root);
    if (!sec) return;
    const k = K(sec, root.path);
    this.sel = new Set([k]);
    this.focusKey = this.anchor = k;
    this.render();
    sec.el.scrollIntoView({ block: 'nearest' });
    this.tree.focus();
  }

  /** The sidebar folder you're working in (selection or focus), if any. */
  currentRoot() {
    const i = this.focusKey && this.info.get(this.focusKey);
    return i ? i.sec.root : null;
  }

  onConnState(conn) {
    if (!this.secs.some(s => s.root.host === conn.host)) return;
    for (const sec of this.secs) {
      if (sec.root.host === conn.host && conn.state === 'ok' && !sec.starting && !sec.dirs.has(sec.root.path)) this.start(sec);
    }
    this.renderSoon();
  }

  // --- data --------------------------------------------------------------------------
  /** bg: use the host's background channel (refreshes, prefetch), so it never
   *  delays a folder you clicked or a file you opened. */
  loadDir(sec, path, { force = false, bg = false } = {}) {
    let st = sec.dirs.get(path);
    if (st && st.pending) return st.pending;
    if (st && st.entries && !force) return Promise.resolve(st);
    if (!st) { st = { entries: null, error: null, pending: null }; sec.dirs.set(path, st); }
    const conn = this.ws.conn(sec.root.host);
    st.pending = (async () => {
      try {
        const r = await conn.call('/api/ls', { query: bg ? { path, bg: '1' } : { path } });
        st.entries = this.sort(r.entries);
        st.error = null;
      } catch (e) {
        if (e.status === 404 && path !== sec.root.path) {
          sec.dirs.delete(path);
          sec.expanded.delete(path);
        } else if (!st.entries) {
          st.error = e.message;
        }
      } finally {
        st.pending = null;
      }
      this.renderSoon();
      return st;
    })();
    if (!st.entries) this.renderSoon();
    return st.pending;
  }

  /** Re-list every section's folder and open subfolders (keeps the tree as it is). */
  async refresh(secs, { bg = false } = {}) {
    await Promise.all((secs || this.secs).map(sec => {
      if (this.ws.conn(sec.root.host).state !== 'ok') return null;
      const dirs = [sec.root.path, ...[...sec.expanded].filter(p => sec.dirs.has(p))];
      return Promise.all([...new Set(dirs)].map(d => this.loadDir(sec, d, { force: true, bg })));
    }));
  }

  refreshHost(host) { return this.refresh(this.secs.filter(s => s.root.host === host)); }

  /** Something changed in `dir` on `host`: re-list it wherever it is shown. */
  refreshDir(host, dir) {
    for (const sec of this.secs) {
      if (sec.root.host === host && sec.dirs.has(dir)) this.loadDir(sec, dir, { force: true });
    }
    if (this.ws.folders) this.ws.folders.refreshDir(host, dir);
  }

  /** In the folder view, the tree picks what it shows instead of opening tabs. */
  get folderMode() { return this.ws.mode === 'files' && !!this.ws.folders; }

  quickLook(it) {
    this.ws.folders.reveal(it.host, it.path).then(() => this.ws.folders.ql.open(it.name));
  }

  prefetch(sec, path) {
    const st = sec.dirs.get(path);
    if (!st || (!st.entries && !st.pending)) this.loadDir(sec, path, { bg: true });
  }

  expandedKey(sec) { return `expanded:${sec.root.host}:${sec.root.path}`; }
  saveExpanded(sec) { store.set(this.expandedKey(sec), [...sec.expanded].slice(0, 300)); }

  async restoreExpanded(sec) {
    const saved = store.get(this.expandedKey(sec), []);
    sec.expanded = new Set(saved.filter(p => p !== sec.root.path && isUnder(p, sec.root.path)));
    let frontier = [sec.root.path];
    while (frontier.length) {
      const next = [];
      for (const d of frontier) {
        for (const e of this.entriesOf(sec, d)) {
          const p = join(d, e.name);
          if (isDirType(e.type) && sec.expanded.has(p)) next.push(p);
        }
      }
      await Promise.all(next.map(p => this.loadDir(sec, p)));
      frontier = next;
    }
    this.render();
  }

  async toggle(sec, path, open = !sec.expanded.has(path)) {
    if (open) {
      sec.expanded.add(path);
      this.render();
      await this.loadDir(sec, path);
    } else {
      sec.expanded.delete(path);
      this.render();
    }
    this.saveExpanded(sec);
  }

  fold(sec, folded = !sec.folded) {
    sec.folded = folded;
    this.render();
  }

  /** Show `path` on `host`: open the folders above it and select it. */
  async reveal(host, path, { select = true, scroll = true } = {}) {
    const root = this.ws.rootOf(host, path);
    const sec = root && this.secOf(root);
    if (!sec || path === root.path) return;
    if (sec.folded) sec.folded = false;
    let cur = root.path;
    for (const part of relPath(root.path, path).split('/').slice(0, -1)) {
      cur = join(cur, part);
      sec.expanded.add(cur);
      await this.loadDir(sec, cur);
    }
    if (select) {
      const k = K(sec, path);
      this.sel = new Set([k]);
      this.focusKey = this.anchor = k;
    }
    this.render();
    const row = this.rowEl(sec, path);
    if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  }

  /** After a copy lands: open its folder and select what arrived. */
  async revealIn(host, dir, names = []) {
    this.ws.showView('explorer');
    const root = this.ws.rootOf(host, dir);
    const sec = root && this.secOf(root);
    if (!sec) return;
    if (dir !== root.path) await this.reveal(host, join(dir, '_'), { select: false });
    await this.loadDir(sec, dir, { force: true });
    if (dir !== root.path) sec.expanded.add(dir);
    this.sel = new Set(names.map(n => K(sec, join(dir, n))));
    this.focusKey = this.anchor = names.length ? K(sec, join(dir, names[0])) : null;
    this.render();
    const row = names.length && this.rowEl(sec, join(dir, names[0]));
    if (row) row.scrollIntoView({ block: 'nearest' });
    this.tree.focus();
  }

  entriesOf(sec, dir) { const st = sec.dirs.get(dir); return (st && st.entries) || []; }

  isDirKey(k) {
    const i = this.info.get(k);
    return !!i && (i.isRoot || isDirType(i.e.type));
  }

  // --- rendering ---------------------------------------------------------------------
  renderSoon() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  render() {
    this.info.clear();
    const rows = [];
    const multi = this.secs.length > 1;
    this.tree.classList.toggle('multi', multi);
    for (const sec of this.secs) {
      const rk = K(sec, sec.root.path);
      this.info.set(rk, { sec, path: sec.root.path, isRoot: true, depth: -1 });
      rows.push(rk);
      this.renderHead(sec, rk, multi);
      const items = [];
      if (!sec.folded) this.walk(sec, sec.root.path, 0, items, rows);
      reconcile(sec.body, items, sec.rowCache);
      sec.el.classList.toggle('folded', sec.folded);
    }
    this.rows = rows;
    const input = this.tree.querySelector('input.rn');
    if (input && !input.dataset.wired) this.wireInput(input);
  }

  renderHead(sec, rk, multi) {
    const { root } = sec;
    const conn = this.ws.conn(root.host);
    const home = conn.home;
    const name = root.path === home ? '~' : root.path === '/' ? '/' : basename(root.path);
    const ic = root.path === '/' ? 'server' : root.path === home ? 'home' : 'folder';
    const hostPill = this.ws.multiHost()
      ? `<span class="host-pill" style="--hc:var(--${hostColor(root.host)})" title="${esc(root.host)}"><i></i><span>${esc(hostLabel(root.host))}</span></span>` : '';
    const where = tildify(root.path, home);
    const html = `${multi ? `<button class="tw-root" data-a="fold" title="${sec.folded ? 'Expand' : 'Collapse'}">${icons.chevronRight}</button>` : ''}`
      + `<button class="loc" data-a="loc" title="${esc(where)} — click to go somewhere else"><span class="loc-ic">${icons[ic]}</span><span class="loc-name">${esc(name)}</span><span class="chev">${icons.chevronDown}</span></button>${hostPill}`
      + `<span class="acts">`
      + (multi ? '' : `<button class="ib sm" data-a="up" title="Enclosing Folder"${root.path === '/' ? ' disabled' : ''}>${icons.arrowUp}</button>`)
      + `<button class="ib sm" data-a="newFile" title="New File">${icons.newFile}</button>`
      + `<button class="ib sm" data-a="newFolder" title="New Folder">${icons.newFolder}</button>`
      + `<button class="ib sm" data-a="refresh" title="Refresh">${icons.refresh}</button>`
      + (multi ? '' : `<button class="ib sm" data-a="collapse" title="Collapse Folders">${icons.collapse}</button>`)
      + `<button class="ib sm" data-a="more" title="More">${icons.ellipsis}</button></span>`;
    if (html !== sec.headHtml) { sec.head.innerHTML = html; sec.headHtml = html; }
    sec.head.dataset.k = rk;
    sec.head.dataset.p = root.path;
    sec.head.classList.toggle('sel', this.sel.has(rk));
    sec.head.setAttribute('aria-expanded', String(!sec.folded));
  }

  walk(sec, dir, depth, items, rows) {
    const st = sec.dirs.get(dir);
    const ed = this.editing;
    if (ed && ed.kind === 'new' && ed.sec === sec && ed.dir === dir) items.push(this.inputRow(dir, depth, ed.isDir));
    if (dir === sec.root.path && !(st && st.entries)) {
      const conn = this.ws.conn(sec.root.host);
      if (conn.state === 'auth') { items.push(this.connRow(sec, `${hostLabel(sec.root.host)} needs you to sign in.`, 'Sign In…')); return; }
      if (conn.state === 'off' && !(st && st.pending)) { items.push(this.connRow(sec, conn.why || 'Not connected.', 'Reconnect')); return; }
      if (conn.state === 'busy' || conn.state === 'idle') { items.push(this.msgRow(sec, dir, depth, 'Connecting…')); return; }
    }
    if (!st || (!st.entries && !st.error)) { items.push(this.msgRow(sec, dir, depth, 'Loading…')); return; }
    if (st.error) { items.push(this.msgRow(sec, dir, depth, st.error, true)); return; }
    let shown = 0;
    for (const e of st.entries) {
      if (!this.visible(e.name)) continue;
      shown++;
      const path = join(dir, e.name);
      const isDir = isDirType(e.type);
      const open = isDir && sec.expanded.has(path);
      const k = K(sec, path);
      this.info.set(k, { sec, path, e, depth });
      rows.push(k);
      items.push(this.entryRow(sec, k, path, e, depth, isDir, open));
      if (open) this.walk(sec, path, depth + 1, items, rows);
    }
    if (!shown && dir === sec.root.path && !(ed && ed.kind === 'new' && ed.sec === sec)) {
      items.push({ key: 'note', cls: 'empty-note', html: 'This folder is empty.<br>Drop files here to upload them.' });
    }
  }

  guides(depth) {
    let s = '';
    for (let k = 0; k < depth; k++) s += `<i class="g" style="left:${k * 14 + 11}px"></i>`;
    return s;
  }

  entryRow(sec, k, path, e, depth, isDir, open) {
    const cls = ['row'];
    if (isDir) cls.push('dir');
    if (open) cls.push('open');
    if (this.sel.has(k)) cls.push('sel');
    if (this.clip && this.clip.mode === 'cut' && this.clip.items.some(i => i.host === sec.root.host && i.path === path)) cls.push('cut');
    if (e.type === 'link' || e.type === 'linkdir' || e.type === 'broken') cls.push('link');
    if (e.name.startsWith('.')) cls.push('hidden-file');
    const renaming = this.editing && this.editing.kind === 'rename' && this.editing.sec === sec && this.editing.path === path;
    const link = e.target ? `<span class="badge" title="→ ${esc(e.target)}">${icons.alias}</span>` : '';
    return {
      key: k,
      cls: cls.join(' '),
      attrs: { 'data-k': k, 'data-p': path, style: `--d:${depth}`, draggable: renaming ? 'false' : 'true', role: 'treeitem', 'aria-expanded': isDir ? String(open) : null },
      html: `${this.guides(depth)}<span class="tw">${isDir ? icons.chevronRight : ''}</span>${isDir ? folderIcon() : fileIcon(e.name)}` +
        (renaming ? `<input class="rn" spellcheck="false" autocomplete="off" value="${esc(e.name)}">` : `<span class="nm">${esc(e.name)}</span>${link}`),
    };
  }

  inputRow(dir, depth, isDir) {
    return {
      key: `new:${dir}`, cls: 'row editing', attrs: { style: `--d:${depth}` },
      html: `${this.guides(depth)}<span class="tw"></span>${isDir ? folderIcon() : `<span class="ic t-gray">${icons.fileText}</span>`}<input class="rn" spellcheck="false" autocomplete="off" placeholder="${isDir ? 'folder name' : 'file name'}">`,
    };
  }

  msgRow(sec, dir, depth, text, err) {
    return {
      key: `msg:${dir}`, cls: `row msg${err ? ' err' : ''}`, attrs: { style: `--d:${depth}` },
      html: `${this.guides(depth)}<span class="tw"></span><span class="nm">${esc(text)}</span>`,
    };
  }

  connRow(sec, text, button) {
    return { key: 'conn', cls: 'conn-row', html: `<span>${esc(text)}</span><button class="btn small" data-a="signin">${esc(button)}</button>` };
  }

  rowEl(sec, path) {
    if (path === sec.root.path) return sec.head;
    const rec = sec.rowCache.get(K(sec, path));
    return rec && rec.el.isConnected ? rec.el : null;
  }

  // --- inline create / rename ---------------------------------------------------
  wireInput(input) {
    input.dataset.wired = '1';
    const ed = this.editing;
    if (!ed) return;
    if (ed.kind === 'rename') {
      const dot = input.value.lastIndexOf('.');
      const i = this.info.get(K(ed.sec, ed.path));
      const isDir = !!i && isDirType(i.e.type);
      input.setSelectionRange(0, dot > 0 && !isDir ? dot : input.value.length);
    }
    input.focus();
    let done = false;
    const row = input.closest('.row');
    const showErr = () => {
      const msg = this.validate(input.value);
      let bubble = row.querySelector('.rn-err');
      if (msg && input.value) {
        if (!bubble) { bubble = document.createElement('div'); bubble.className = 'rn-err'; row.appendChild(bubble); }
        bubble.textContent = msg;
      } else if (bubble) bubble.remove();
    };
    input.addEventListener('input', showErr);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (this.validate(input.value) && input.value.trim()) return; done = true; this.commitEdit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; this.editing = null; this.render(); this.tree.focus(); }
    });
    input.addEventListener('blur', () => {
      if (done || this.editing !== ed) return;
      // Clicking away commits a valid name (like VS Code) and drops an invalid one.
      setTimeout(() => {
        // A re-render swaps in a fresh input (and may blur this one): not a click-away.
        if (done || this.editing !== ed || !input.isConnected || document.activeElement === input) return;
        done = true;
        if (input.value.trim() && !this.validate(input.value)) this.commitEdit(input.value);
        else { this.editing = null; this.render(); }
      }, 0);
    });
  }

  validate(raw) {
    const ed = this.editing;
    if (!ed) return null;
    const value = raw.trim();
    if (!value) return 'A file or folder name must be provided.';
    if (ed.kind === 'rename' && value.includes('/')) return 'Names can’t contain “/”.';
    if (value.startsWith('/')) return 'A name can’t start with “/”.';
    if (value.split('/').some(s => s === '.' || s === '..')) return '“.” and “..” aren’t valid names.';
    const dir = ed.kind === 'new' ? ed.dir : dirname(ed.path);
    const first = value.split('/')[0];
    const clash = this.entriesOf(ed.sec, dir).find(e => e.name === first);
    if (clash && !(ed.kind === 'rename' && clash.name === basename(ed.path))) {
      if (!value.includes('/') || !isDirType(clash.type)) return `“${first}” already exists here. Choose a different name.`;
    }
    return null;
  }

  /** target: {sec, dir} (default: where the selection is). */
  async newEntry(target, isDir) {
    const t = target || this.targetDir();
    if (!t) return;
    const { sec, dir } = t;
    if (sec.folded) sec.folded = false;
    if (dir !== sec.root.path) {
      sec.expanded.add(dir);
      await this.loadDir(sec, dir);
    }
    this.editing = { kind: 'new', sec, dir, isDir };
    this.render();
  }

  startRename(k) {
    const i = this.info.get(k);
    if (!i || i.isRoot) return;
    this.editing = { kind: 'rename', sec: i.sec, path: i.path };
    this.render();
  }

  async commitEdit(raw) {
    const ed = this.editing;
    this.editing = null;
    const value = raw.trim();
    const { sec } = ed;
    const conn = this.ws.conn(sec.root.host);
    if (ed.kind === 'new') {
      const path = join(ed.dir, value);
      try {
        await conn.call('/api/create', { body: { path, dir: ed.isDir, parents: value.includes('/') } });
      } catch (e) {
        toastError(`Couldn’t create “${value}”`, e);
        this.render();
        return;
      }
      // Open every folder on the way to a nested new path.
      let cur = ed.dir;
      for (const part of value.split('/').slice(0, -1)) { cur = join(cur, part); sec.expanded.add(cur); }
      await Promise.all([ed.dir, ...[...sec.expanded].filter(p => isUnder(p, ed.dir))].map(d => this.loadDir(sec, d, { force: true })));
      await this.reveal(sec.root.host, path);
      this.tree.focus();
      if (!ed.isDir) this.ws.editor.open(path, { host: sec.root.host, preview: false });
    } else {
      if (value === basename(ed.path)) { this.render(); this.tree.focus(); return; }
      const dst = join(dirname(ed.path), value);
      try {
        await conn.call('/api/rename', { body: { src: ed.path, dst } });
      } catch (e) {
        toastError(`Couldn’t rename “${basename(ed.path)}”`, e);
        this.render();
        return;
      }
      this.ws.onMoved(sec.root.host, ed.path, dst);
      await this.loadDir(sec, dirname(ed.path), { force: true });
      await this.reveal(sec.root.host, dst);
      this.tree.focus();
    }
  }

  /** Keep folder state and selection in step with a rename/move on `host`. */
  moved(host, src, dst) {
    for (const sec of this.secs) {
      if (sec.root.host !== host) continue;
      const remap = p => (isUnder(p, src) ? dst + p.slice(src.length) : p);
      sec.expanded = new Set([...sec.expanded].map(remap));
      for (const k of [...sec.dirs.keys()]) if (isUnder(k, src)) sec.dirs.delete(k);
      this.saveExpanded(sec);
      const pre = sec.root.id + ':';
      this.sel = new Set([...this.sel].map(k => (k.startsWith(pre) ? pre + remap(k.slice(pre.length)) : k)));
    }
  }

  // --- selection --------------------------------------------------------------------
  item(k) {
    const i = this.info.get(k);
    if (!i) return null;
    return { sec: i.sec, host: i.sec.root.host, path: i.path, isDir: i.isRoot || isDirType(i.e.type), isRoot: !!i.isRoot, name: basename(i.path) };
  }

  /** Selected rows (folder headers left out: they can't be moved or deleted). */
  selected() { return [...this.sel].map(k => this.item(k)).filter(i => i && !i.isRoot); }

  targetDir() {
    const k = this.focusKey && this.sel.has(this.focusKey) ? this.focusKey : null;
    const it = k && this.item(k);
    if (it) return { sec: it.sec, dir: it.isDir ? it.path : dirname(it.path) };
    const sec = this.secs[0];
    return sec ? { sec, dir: sec.root.path } : null;
  }

  // --- operations -----------------------------------------------------------------
  async remove(items) {
    items = items.filter(i => !i.isRoot);
    if (!items.length) return;
    const one = items.length === 1;
    const hosts = [...new Set(items.map(i => i.host))];
    if (settings.get('files.confirmDelete')) {
      const ok = await confirm(
        one ? `Delete “${items[0].name}”?` : `Delete ${items.length} items?`,
        `${one && items[0].isDir ? 'The folder and everything in it will be deleted' : 'This will be deleted'} on ${hosts.map(hostLabel).join(' and ')}. This can’t be undone.`,
        { ok: 'Delete', danger: true, icon: 'trash' });
      if (!ok) return;
    }
    for (const host of hosts) {
      const paths = items.filter(i => i.host === host).map(i => i.path);
      try {
        await this.ws.conn(host).call('/api/delete', { body: { paths } });
      } catch (e) {
        toastError('Couldn’t delete', e);
      }
      for (const sec of this.secs) {
        if (sec.root.host !== host) continue;
        for (const p of paths) {
          this.sel.delete(K(sec, p));
          for (const x of [...sec.expanded]) if (isUnder(x, p)) sec.expanded.delete(x);
        }
        this.saveExpanded(sec);
      }
      this.ws.editor.onDeleted(host, paths);
      for (const d of new Set(paths.map(dirname))) this.refreshDir(host, d);
    }
  }

  /** Copy or move `items` into {sec, dir} (any server), one job per source folder. */
  async transfer(items, target, mode) {
    const dst = { host: target.sec.root.host, dir: target.dir };
    items = items.filter(i => !i.isRoot && !(i.host === dst.host && isUnder(dst.dir, i.path)));
    if (mode === 'move') items = items.filter(i => !(i.host === dst.host && dirname(i.path) === dst.dir));
    if (!items.length) return;
    const groups = new Map();
    for (const i of items) {
      const g = `${i.host}\n${dirname(i.path)}`;
      if (!groups.has(g)) groups.set(g, { host: i.host, dir: dirname(i.path), names: [], folders: new Set() });
      const grp = groups.get(g);
      grp.names.push(basename(i.path));
      if (i.isDir) grp.folders.add(basename(i.path));
    }
    const landed = [];
    for (const src of groups.values()) {
      const it = await this.ws.transfers.run({ src, dst, mode });
      if (it && it.state === 'done') landed.push(...it.targets);
    }
    if (landed.length && dst.host === items[0].host && dst.dir === dirname(items[0].path)) this.revealIn(dst.host, dst.dir, landed);
  }

  /** Drag and drop of tree rows: ask before moving (Settings → Files). */
  async dropItems(items, target, mode) {
    if (mode === 'move' && settings.get('files.confirmMove')) {
      const where = target.dir === this.ws.conn(target.sec.root.host).home ? '~' : basename(target.dir) || '/';
      const toHost = items.some(i => i.host !== target.sec.root.host) ? ` on ${hostLabel(target.sec.root.host)}` : '';
      const ok = await confirm(items.length === 1 ? `Move “${items[0].name}” into “${where}”${toHost}?` : `Move ${items.length} items into “${where}”${toHost}?`, '', { ok: 'Move' });
      if (!ok) return;
    }
    await this.transfer(items, target, mode);
  }

  duplicate(item) { return this.transfer([item], { sec: item.sec, dir: dirname(item.path) }, 'copy'); }

  setClip(mode, items) {
    this.clip = { mode, items: items.map(i => ({ host: i.host, path: i.path, isDir: i.isDir, name: i.name })) };
    this.render();
  }

  async paste(target) {
    if (!this.clip || !target) return;
    const { mode, items } = this.clip;
    if (mode === 'cut') this.clip = null;
    if (target.dir !== target.sec.root.path) target.sec.expanded.add(target.dir);
    await this.transfer(items, target, mode === 'cut' ? 'move' : 'copy');
    this.render();
  }

  download(items) {
    const url = i => (i.isDir ? archiveUrl(i.host, dirname(i.path), [basename(i.path)]) : fileUrl(i.host, i.path));
    if (items.length === 1) { download(url(items[0])); return; }
    const groups = new Map();
    for (const i of items) {
      const g = `${i.host}\n${dirname(i.path)}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    }
    let n = 0;
    for (const list of groups.values()) {
      const u = list.length === 1 ? url(list[0]) : archiveUrl(list[0].host, dirname(list[0].path), list.map(i => basename(i.path)));
      setTimeout(() => download(u), n++ * 400);
    }
  }

  pickUpload(target, folder = false) {
    this.uploadTarget = target || this.targetDir();
    if (this.uploadTarget) this.el.querySelector(`input[data-up="${folder ? 'dir' : 'files'}"]`).click();
  }

  // --- menus ---------------------------------------------------------------------------
  itemMenu(x, y, items) {
    const one = items.length === 1 ? items[0] : null;
    const isDir = one && one.isDir;
    const sec = items[0].sec;
    const host = items[0].host;
    const target = { sec, dir: isDir ? one.path : dirname(items[0].path) };
    const others = this.secs.filter(s => s !== sec && !items.some(i => i.host === s.root.host && isUnder(s.root.path, i.path)));
    const label = s => `${this.ws.multiHost() ? hostLabel(s.root.host) + ' · ' : ''}${tildify(s.root.path, this.ws.conn(s.root.host).home)}`;
    contextMenu(x, y, [
      ...(one && !isDir ? [
        { label: 'Open', action: () => this.ws.editor.open(one.path, { host, preview: false }) },
        ...(mediaKind(one.path) ? [{ label: 'Open as Text', icon: 'code', action: () => this.ws.editor.open(one.path, { host, preview: false, asText: 'lossy' }) }] : []),
        '-',
      ] : []),
      ...(isDir ? [
        { label: 'New File…', icon: 'newFile', action: () => this.newEntry(target, false) },
        { label: 'New Folder…', icon: 'newFolder', action: () => this.newEntry(target, true) },
        '-',
      ] : []),
      { label: 'Open in Terminal', icon: 'terminal', action: () => this.ws.terminal.newTerminal({ host, cwd: target.dir }) },
      ...(isDir ? [
        { label: 'Find in Folder…', icon: 'search', action: () => this.ws.showSearch({ root: sec.root, folder: one.path }) },
        { label: 'Go Into', icon: 'folderOpen', keys: 'Mod+ArrowDown', action: () => this.ws.setRootPath(sec.root, one.path) },
      ] : []),
      '-',
      { label: 'Cut', icon: 'scissors', keys: 'Mod+X', action: () => this.setClip('cut', items) },
      { label: 'Copy', icon: 'copy', keys: 'Mod+C', action: () => this.setClip('copy', items) },
      { label: 'Paste', icon: 'clipboard', keys: 'Mod+V', disabled: !this.clip, action: () => this.paste(target) },
      ...(one ? [{ label: 'Duplicate', action: () => this.duplicate(one) }] : []),
      ...(others.length ? [{ header: 'Copy To' }, ...others.slice(0, 6).map(s => ({ label: label(s), icon: 'arrowRight', action: () => this.transfer(items, { sec: s, dir: s.root.path }, 'copy') }))] : []),
      '-',
      { label: 'Copy Path', action: () => copyText(items.map(i => i.path).join('\n')) },
      { label: 'Copy Relative Path', action: () => copyText(items.map(i => relPath(i.sec.root.path, i.path)).join('\n')) },
      '-',
      { label: items.length > 1 ? `Download ${items.length} Items` : isDir ? 'Download as .tar.gz' : 'Download', icon: 'download', action: () => this.download(items) },
      ...(isDir ? [
        { label: 'Upload Files…', icon: 'upload', action: () => this.pickUpload(target) },
        { label: 'Upload Folder…', icon: 'upload', action: () => this.pickUpload(target, true) },
      ] : []),
      '-',
      ...(one ? [{ label: 'Rename…', icon: 'pencil', keys: 'F2', action: () => this.startRename(K(sec, one.path)) }] : []),
      { label: items.length > 1 ? `Delete ${items.length} Items` : 'Delete', icon: 'trash', keys: isMac ? 'Mod+Backspace' : 'Delete', danger: true, action: () => this.remove(items) },
    ]);
  }

  rootMenu(x, y, sec) {
    const { root } = sec;
    const host = root.host;
    const first = root === this.ws.roots[0];
    const target = { sec, dir: root.path };
    contextMenu(x, y, [
      { label: 'New File…', icon: 'newFile', action: () => this.newEntry(target, false) },
      { label: 'New Folder…', icon: 'newFolder', action: () => this.newEntry(target, true) },
      '-',
      { label: 'Upload Files…', icon: 'upload', action: () => this.pickUpload(target) },
      { label: 'Upload Folder…', icon: 'upload', action: () => this.pickUpload(target, true) },
      { label: 'Paste', icon: 'clipboard', keys: 'Mod+V', disabled: !this.clip, action: () => this.paste(target) },
      '-',
      { label: 'Open in Terminal', icon: 'terminal', action: () => this.ws.terminal.newTerminal({ host, cwd: root.path }) },
      { label: 'Find in Folder…', icon: 'search', action: () => this.ws.showSearch({ root }) },
      { label: 'Enclosing Folder', icon: 'arrowUp', keys: 'Mod+ArrowUp', disabled: root.path === '/', action: () => this.goUp(root) },
      { label: 'Go to Folder…', icon: 'folderOpen', keys: this.ws.keysFor('file.openFolder'), action: () => this.ws.palette.openFolder(root) },
      '-',
      { label: settings.get('files.hidden') ? 'Hide Hidden Files' : 'Show Hidden Files', icon: 'eye', action: () => settings.set('files.hidden', !settings.get('files.hidden')) },
      { label: 'Refresh', icon: 'refresh', action: () => this.refresh([sec]) },
      { label: 'Collapse Folders', icon: 'collapse', action: () => this.collapseAll([sec]) },
      '-',
      { header: `${hostLabel(host)} colour` },
      { swatches: TAG_COLORS, value: (settings.get('hosts')[host] || {}).color || null, pick: c => setHost(host, { color: c }) },
      '-',
      { label: 'Add Server…', icon: 'serverPlus', action: () => this.ws.run('workspace.addServer') },
      { label: 'Add Folder…', icon: 'newFolder', action: () => this.ws.palette.openFolder(root, { add: true }) },
      ...(first ? [] : [
        { label: 'Remove from Sidebar', icon: 'xmark', action: () => this.ws.removeRoot(root) },
        ...(host !== this.ws.host ? [{ label: `Disconnect from ${hostLabel(host)}`, icon: 'power', danger: true, action: () => this.ws.disconnectHost(host) }] : []),
      ]),
    ]);
  }

  goUp(root = this.ws.activeRoot()) {
    if (root.path !== '/') this.ws.setRootPath(root, dirname(root.path));
  }

  /** Finder's path menu: every folder up to /, then Home, recents and Go to Folder. */
  locationMenu(x, y, sec) {
    const { root } = sec;
    const home = this.ws.conn(root.host).home;
    const chain = [];
    for (let p = root.path; ; p = dirname(p)) { chain.push(p); if (p === '/') break; }
    const shown = new Set(chain);
    const icon = p => (p === '/' ? 'server' : p === home ? 'home' : 'folderLine');
    const recent = this.ws.recentFolders(root.host).filter(p => !shown.has(p) && p !== home).slice(0, 6);
    const go = p => this.ws.setRootPath(root, p);
    contextMenu(x, y, [
      ...chain.map(p => ({ label: p === '/' ? '/' : basename(p), icon: icon(p), current: p === root.path, action: () => go(p) })),
      '-',
      ...(shown.has(home) ? [] : [{ label: 'Home', icon: 'home', action: () => go(home) }]),
      ...(recent.length ? [{ header: 'Recent Folders' }, ...recent.map(p => ({ label: tildify(p, home), icon: 'clock', action: () => go(p) }))] : []),
      '-',
      { label: 'Go to Folder…', icon: 'folderOpen', keys: this.ws.keysFor('file.openFolder'), action: () => this.ws.palette.openFolder(root) },
    ]);
  }

  collapseAll(secs = this.secs) {
    for (const sec of secs) { sec.expanded.clear(); this.saveExpanded(sec); }
    this.render();
  }

  // --- events ----------------------------------------------------------------------
  bind() {
    const { tree } = this;
    for (const input of this.el.querySelectorAll('input[type=file]')) {
      input.addEventListener('change', () => {
        const entries = [...input.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
        input.value = '';
        const t = this.uploadTarget || this.targetDir();
        this.uploadTarget = null;
        if (t) this.ws.transfers.upload(t.sec.root.host, t.dir, entries);
      });
    }

    tree.addEventListener('click', e => {
      if (e.target.closest('input')) return;
      const head = e.target.closest('.root-head');
      if (head) { this.onHeadClick(e, head); return; }
      const signin = e.target.closest('[data-a=signin]');
      if (signin) {
        const sec = this.secs.find(s => s.el.contains(signin));
        if (sec) this.ws.conn(sec.root.host).reconnect();
        return;
      }
      const row = e.target.closest('.row[data-k]');
      if (!row) { if (e.target === tree) { this.sel.clear(); this.render(); } return; }
      const k = row.dataset.k;
      const it = this.item(k);
      if (!it) return;
      const multi = isMac ? e.metaKey : e.ctrlKey;
      if (e.shiftKey && this.anchor && this.rows.includes(this.anchor)) {
        const a = this.rows.indexOf(this.anchor), b = this.rows.indexOf(k);
        this.sel = new Set(this.rows.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else if (multi) {
        if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k);
        this.anchor = k;
      } else {
        this.sel = new Set([k]);
        this.anchor = k;
        // e.detail > 1: the second click of a double-click, which shouldn't fold the folder back.
        if (this.folderMode) {
          if (it.isDir) { if (e.detail < 2) this.toggle(it.sec, it.path, true); this.ws.folders.go(it.host, it.path); }
          else this.ws.folders.reveal(it.host, it.path);
        } else if (it.isDir) { if (e.detail < 2) this.toggle(it.sec, it.path); }
        else if (settings.get('files.singleClick') === 'preview') this.ws.editor.open(it.path, { host: it.host, preview: true, focus: false });
      }
      this.focusKey = k;
      this.render();
    });
    tree.addEventListener('dblclick', e => {
      const row = e.target.closest('.row[data-k]');
      const it = row && this.item(row.dataset.k);
      if (!it || it.isDir) return;
      if (this.folderMode) this.quickLook(it);
      else this.ws.editor.open(it.path, { host: it.host, preview: false, focus: true });
    });
    tree.addEventListener('contextmenu', e => {
      e.preventDefault();
      const head = e.target.closest('.root-head');
      const row = head || e.target.closest('.row[data-k]');
      if (!row) {
        const secEl = e.target.closest('.root-sec');
        const sec = this.secs.find(s => s.el === secEl) || this.secs[this.secs.length - 1];
        this.sel.clear();
        this.render();
        if (sec) this.rootMenu(e.clientX, e.clientY, sec);
        return;
      }
      const k = row.dataset.k;
      if (!this.sel.has(k)) { this.sel = new Set([k]); this.anchor = k; }
      this.focusKey = k;
      this.render();
      const it = this.item(k);
      if (it.isRoot) this.rootMenu(e.clientX, e.clientY, it.sec);
      else this.itemMenu(e.clientX, e.clientY, this.selected());
    });
    tree.addEventListener('keydown', e => this.onKey(e));
    let hoverTimer = null;
    tree.addEventListener('mouseover', e => {
      const row = e.target.closest('.row.dir[data-k]');
      clearTimeout(hoverTimer);
      if (row && !row.classList.contains('open')) {
        hoverTimer = setTimeout(() => { const it = this.item(row.dataset.k); if (it) this.prefetch(it.sec, it.path); }, 120);
      }
    });
    tree.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
    this.bindDrag();
  }

  onHeadClick(e, head) {
    const sec = this.secs.find(s => s.head === head);
    if (!sec) return;
    const b = e.target.closest('[data-a]');
    const a = b && b.dataset.a;
    // New File / New Folder go where the selection is (in this folder), like VS Code.
    const picked = this.targetDir();
    const target = picked && picked.sec === sec ? picked : { sec, dir: sec.root.path };
    const r = b && b.getBoundingClientRect();
    if (a === 'fold') this.fold(sec);
    else if (a === 'loc') this.locationMenu(r.left, r.bottom + 4, sec);
    else if (a === 'up') this.goUp(sec.root);
    else if (a === 'newFile') this.newEntry(target, false);
    else if (a === 'newFolder') this.newEntry(target, true);
    else if (a === 'refresh') this.refresh([sec]);
    else if (a === 'collapse') this.collapseAll([sec]);
    else if (a === 'more') this.rootMenu(r.left, r.bottom + 4, sec);
    else {
      const k = K(sec, sec.root.path);
      this.sel = new Set([k]);
      this.focusKey = this.anchor = k;
      if (this.secs.length > 1 && e.detail === 2) this.fold(sec);
      if (this.folderMode) this.ws.folders.go(sec.root.host, sec.root.path);
      this.render();
      this.tree.focus();
    }
  }

  // --- drag and drop: rows move or copy (between servers too), desktop files upload ----
  bindDrag() {
    const { tree } = this;
    tree.addEventListener('dragstart', e => {
      const row = e.target.closest('.row[data-k]');
      const it = row && this.item(row.dataset.k);
      if (!it) return;
      const items = this.sel.has(row.dataset.k) ? this.selected() : [it];
      this.dragging = { items };
      const payload = { ws: this.ws.id, items: items.map(i => ({ host: i.host, path: i.path, isDir: i.isDir })) };
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', items.map(i => i.path).join('\n'));
      // Chrome can drop a single file onto the desktop.
      if (items.length === 1 && !items[0].isDir) {
        e.dataTransfer.setData('DownloadURL', `application/octet-stream:${items[0].name}:${location.origin}${fileUrl(items[0].host, items[0].path)}`);
      }
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    tree.addEventListener('dragend', () => { this.dragging = null; this.setDrop(null); });
    tree.addEventListener('dragenter', e => {
      const ty = e.dataTransfer.types;
      if (ty.includes(DRAG_TYPE) || ty.includes('Files')) e.preventDefault();
    });
    tree.addEventListener('dragover', e => {
      const types = e.dataTransfer.types;
      const own = types.includes(DRAG_TYPE), files = types.includes('Files');
      if (!own && !files) return;
      e.preventDefault();
      const t = this.dropTarget(e.target);
      const effect = t ? this.dropEffect(e, t, own) : 'none';
      e.dataTransfer.dropEffect = effect;
      this.setDrop(effect === 'none' ? null : t, effect, own);
      this.springLoad(e.target, t);
    });
    tree.addEventListener('dragleave', e => { if (!tree.contains(e.relatedTarget)) this.setDrop(null); });
    tree.addEventListener('drop', async e => {
      e.preventDefault();
      const t = this.dropTarget(e.target);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      const effect = t ? this.dropEffect(e, t, !!raw) : 'none';
      this.setDrop(null);
      this.dragging = null;
      if (!t || effect === 'none') return;
      if (raw) {
        let p;
        try { p = JSON.parse(raw); } catch { return; }
        const items = (p.items || []).map(i => ({ ...i, name: basename(i.path), sec: null }));
        this.dropItems(items, t, effect);
        return;
      }
      const entries = await collectDrop(e.dataTransfer);
      this.ws.transfers.upload(t.sec.root.host, t.dir, entries);
    });
  }

  dropTarget(target) {
    const row = target.closest && target.closest('.row[data-k], .root-head');
    let sec, dir;
    if (row && row.dataset.k) {
      const it = this.item(row.dataset.k);
      if (!it) return null;
      sec = it.sec;
      dir = it.isDir ? it.path : dirname(it.path);
    } else {
      const secEl = target.closest && target.closest('.root-sec');
      sec = secEl ? this.secs.find(s => s.el === secEl) : this.secs[this.secs.length - 1];
      if (!sec) return null;
      dir = sec.root.path;
    }
    if (this.ws.conn(sec.root.host).state !== 'ok') return null;
    return { sec, dir };
  }

  /** Finder's rules: within a server a drag moves (⌥/Ctrl copies); onto another server it copies (Shift moves). */
  dropEffect(e, t, own) {
    if (!own) return 'copy';
    const items = this.dragging ? this.dragging.items : null;
    if (!items) return 'copy';  // from another window
    const host = t.sec.root.host;
    if (items.some(i => i.host === host && isUnder(t.dir, i.path))) return 'none';  // into itself
    const sameHost = items.every(i => i.host === host);
    const copyKey = isMac ? e.altKey : e.ctrlKey || e.altKey;
    const effect = sameHost ? (copyKey ? 'copy' : 'move') : (e.shiftKey ? 'move' : 'copy');
    if (effect === 'move' && items.every(i => i.host === host && dirname(i.path) === t.dir)) return 'none';  // already there
    return effect;
  }

  setDrop(t, effect, own) {
    const sig = t ? `${t.sec.root.id}:${t.dir}:${effect}` : '';
    if (this.dropSig === sig) return;
    this.dropSig = sig;
    for (const r of this.tree.querySelectorAll('.drop')) { r.classList.remove('drop'); delete r.dataset.effect; }
    for (const s of this.secs) s.el.classList.remove('drop-root');
    if (!t) { clearTimeout(this.springTimer); this.springKey = null; return; }
    const label = !own ? 'Upload' : effect === 'move' ? 'Move' : 'Copy';
    if (t.dir === t.sec.root.path) {
      t.sec.el.classList.add('drop-root');
      t.sec.head.classList.add('drop');
      t.sec.head.dataset.effect = label;
    } else {
      const r = this.rowEl(t.sec, t.dir);
      if (r) { r.classList.add('drop'); r.dataset.effect = label; }
    }
  }

  /** Hovering a closed folder (or a folded section) while dragging opens it, like Finder. */
  springLoad(el, t) {
    const row = el.closest && el.closest('.row.dir[data-k], .root-head');
    const key = row ? row.dataset.k : null;
    if (key === this.springKey) return;
    this.springKey = key;
    clearTimeout(this.springTimer);
    if (!key || !t) return;
    const it = this.item(key);
    if (!it) return;
    if (it.isRoot ? !it.sec.folded : it.sec.expanded.has(it.path)) return;
    this.springTimer = setTimeout(() => {
      if (it.isRoot) this.fold(it.sec, false);
      else this.toggle(it.sec, it.path, true);
    }, SPRING_MS);
  }

  onKey(e) {
    if (e.target.closest('input')) return;
    const k = keyName(e);
    const rows = this.rows;
    let i = rows.indexOf(this.focusKey);
    const focusAt = (j, extend) => {
      if (!rows.length) return;
      j = Math.max(0, Math.min(rows.length - 1, j));
      const key = rows[j];
      if (extend && this.anchor) {
        const a = rows.indexOf(this.anchor);
        this.sel = new Set(rows.slice(Math.min(a, j), Math.max(a, j) + 1));
      } else {
        this.sel = new Set([key]);
        this.anchor = key;
      }
      this.focusKey = key;
      this.render();
      const it = this.item(key);
      const el = it && this.rowEl(it.sec, it.path);
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const it = this.focusKey && this.info.has(this.focusKey) ? this.item(this.focusKey) : null;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    switch (k) {
      case 'ArrowDown': handled(); focusAt(i < 0 ? 0 : i + 1); return;
      case 'ArrowUp': handled(); focusAt(i < 0 ? rows.length - 1 : i - 1); return;
      case 'Shift+ArrowDown': handled(); focusAt(i + 1, true); return;
      case 'Shift+ArrowUp': handled(); focusAt(i - 1, true); return;
      case 'Home': handled(); focusAt(0); return;
      case 'End': handled(); focusAt(rows.length - 1); return;
      case 'ArrowRight':
        handled();
        if (!it || !it.isDir) return;
        if (it.isRoot) { if (it.sec.folded) this.fold(it.sec, false); else focusAt(i + 1); }
        else if (!it.sec.expanded.has(it.path)) this.toggle(it.sec, it.path, true);
        else focusAt(i + 1);
        return;
      case 'ArrowLeft':
        handled();
        if (!it) return;
        if (it.isRoot) { if (this.secs.length > 1) this.fold(it.sec, true); }
        else if (it.isDir && it.sec.expanded.has(it.path)) this.toggle(it.sec, it.path, false);
        else focusAt(rows.indexOf(K(it.sec, dirname(it.path))));
        return;
      case 'Enter':
        if (!it) return;
        handled();
        if (it.isRoot) { if (this.secs.length > 1) this.fold(it.sec); }
        else if (this.folderMode) { if (it.isDir) this.ws.folders.go(it.host, it.path); else this.quickLook(it); }
        else if (isMac) this.startRename(this.focusKey);
        else if (it.isDir) this.toggle(it.sec, it.path);
        else this.ws.editor.open(it.path, { host: it.host, preview: false, focus: true });
        return;
      case 'Mod+ArrowDown':
        if (!it) return;
        handled();
        if (it.isDir) { if (!it.isRoot) this.ws.setRootPath(it.sec.root, it.path); }
        else this.ws.editor.open(it.path, { host: it.host, preview: false, focus: true });
        return;
      case 'Mod+ArrowUp': handled(); this.goUp(it ? it.sec.root : undefined); return;
      case 'Space':
        if (it && !it.isDir) {
          handled();
          if (this.folderMode) this.quickLook(it);
          else this.ws.editor.open(it.path, { host: it.host, preview: true, focus: false });
        }
        return;
      case 'F2': if (it && !it.isRoot) { handled(); this.startRename(this.focusKey); } return;
      case 'Delete': case 'Mod+Backspace':
        if (this.selected().length) { handled(); this.remove(this.selected()); }
        return;
      case 'Mod+C': if (this.selected().length) { handled(); this.setClip('copy', this.selected()); } return;
      case 'Mod+X': if (this.selected().length) { handled(); this.setClip('cut', this.selected()); } return;
      case 'Mod+V': if (this.clip) { handled(); this.paste(this.targetDir()); } return;
      case 'Escape': if (this.clip) { handled(); this.clip = null; this.render(); } return;
      default:
        // Type to jump, like Finder.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && rows.length) {
          const now = Date.now();
          this.typeahead.text = (now - this.typeahead.at < 800 ? this.typeahead.text : '') + e.key.toLowerCase();
          this.typeahead.at = now;
          const t = this.typeahead.text;
          const start = t.length === 1 ? i + 1 : Math.max(0, i);
          const order = [...rows.slice(start), ...rows.slice(0, start)];
          const hit = order.find(r => { const x = this.info.get(r); return x && !x.isRoot && basename(x.path).toLowerCase().startsWith(t); });
          if (hit) { handled(); focusAt(rows.indexOf(hit)); }
        }
    }
  }
}

/** Files and folders (recursively, empty ones too) from a drop on the page. */
export async function collectDrop(dt) {
  const entries = [...dt.items].map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files].map(f => ({ file: f, rel: f.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel: prefix + entry.name });
      return;
    }
    const reader = entry.createReader();
    let batch, any = false;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) { any = true; await walk(child, prefix + entry.name + '/'); }
    } while (batch.length);
    if (!any) out.push({ rel: prefix + entry.name, dir: true });
  };
  for (const en of entries) await walk(en, '');
  return out;
}
