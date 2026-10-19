// A workspace: folders from one or more servers in the sidebar (files and
// search), the editor, the terminal panel, transfers between them, commands
// and shortcuts. The first folder's server is the workspace's own (it is in
// the URL); everything else is restored on reload.
import { esc, h, store, tabStore, debounce, basename, dirname, isUnder, tildify, untildify, keyName, kbd, copyText } from './util.js';
import { icons } from './icons.js';
import { api, connect, connectQuiet, needsAuth } from './api.js';
import { confirm, toast, toastError, contextMenu, modalOpen, spinner, closePopover } from './ui.js';
import { Explorer } from './explorer.js';
import { Editor, fontsReady, loadMonaco } from './editor.js';
import { TerminalPanel } from './terminal.js';
import { Palette } from './palette.js';
import { SearchView } from './search.js';
import { Transfers } from './transfers.js';
import { FolderView } from './folders.js';
import { setThemePref, themePref } from './theme.js';
import { settings, hostColor, hostLabel } from './settings.js';
import { COMMANDS, keysOf, buildKeymap } from './commands.js';
import { openSettings } from './settings-ui.js';
import { noteRecentWorkspace } from './home.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Returns at once; connecting carries on in the background (and stops if disposed). */
export function openWorkspace(app, host, rootHint) {
  const ws = new Workspace(app, host, rootHint);
  ws.start();
  return ws;
}

/** One server: its sign-in state, home folder and API calls. */
class Conn {
  constructor(ws, host) {
    this.ws = ws;
    this.host = host;
    this.home = null;
    this.state = 'idle';   // idle | busy | ok | auth (needs a password) | off
    this.why = '';
    this.authing = null;
  }

  /** Sign in, asking for passwords and host keys when `ask`. -> home folder, or null */
  async open(ask = true) {
    this.set('busy');
    try {
      const home = ask ? await connect(this.host) : await connectQuiet(this.host);
      if (home == null) { this.set(ask ? 'off' : 'auth', ask ? 'Not signed in.' : ''); return null; }
      this.home = home;
      this.set('ok');
      return home;
    } catch (e) {
      this.set('off', e.message);
      throw e;
    }
  }

  /** api() with this host filled in, sign-in on demand and connection status. */
  async call(path, opts = {}) {
    const o = { ...opts };
    if (o.body !== undefined) o.body = { host: this.host, ...o.body };
    else o.query = { host: this.host, ...(o.query || {}) };
    try {
      const r = await api(path, o);
      if (this.state !== 'ok' && this.home) this.set('ok');
      return r;
    } catch (e) {
      if (needsAuth(e)) {
        if (await this.reconnect()) return api(path, o);
        throw e;
      }
      if (e.status === 0 || (e.data && e.data.disconnected)) this.set('off', e.message);
      throw e;
    }
  }

  /** Signed in already, or sign in (once, however many callers ask at the same time). */
  ensure(ask = false) {
    if (this.state === 'ok' && this.home) return Promise.resolve(this.home);
    if (!this.opening) this.opening = this.open(ask).finally(() => { this.opening = null; });
    return this.opening;
  }

  reconnect() {
    if (!this.authing) {
      this.authing = (async () => {
        try { return !!(await this.open(true)); } catch { return false; } finally { this.authing = null; }
      })();
      this.authing.then(ok => { if (ok) this.ws.onReconnected(this); });
    }
    return this.authing;
  }

  set(state, why = '') {
    this.state = state;
    this.why = why;
    this.ws.onConnState(this);
  }
}

class Workspace {
  constructor(app, host, rootHint) {
    this.kind = 'ws';
    this.id = Math.random().toString(36).slice(2);
    this.app = app;
    this.host = host;
    this.rootHint = rootHint;
    this.conns = new Map();
    this.roots = [];
    this.rootSeq = 0;
    this.termMax = false;
    this.mode = 'ide';            // ide (editor and terminal) | files (the folder view in the editor's place)
    this.layout = {
      side: store.get('layout.side', true),
      sideW: store.get('layout.sideW', 268),
      termH: store.get('layout.termH', 300),
      termW: store.get('layout.termW', 560),
      term: false,
      view: 'explorer',
    };
    this.cleanup = [];
    this.saveSession = debounce(() => this.writeSession(), 400);
  }

  get primary() { return this.conn(this.host); }
  get home() { return this.primary.home; }
  get root() { return this.roots[0] ? this.roots[0].path : null; }
  /** Terminals left running by this workspace come back to it after a reload. */
  get wsKey() { return `w:${this.host}`; }

  conn(host) {
    let c = this.conns.get(host);
    if (!c) { c = new Conn(this, host); this.conns.set(host, c); }
    return c;
  }

  /** More than one server in play: label things with their server. */
  multiHost() {
    const hosts = new Set(this.roots.map(r => r.host));
    if (this.editor) for (const d of this.editor.docs) hosts.add(d.host);
    if (this.terminal) for (const t of this.terminal.terms) hosts.add(t.host);
    return hosts.size > 1;
  }

  newRoot(host, path) { return { id: 'r' + this.rootSeq++, host, path }; }

  // --- lifecycle --------------------------------------------------------------------
  async start() {
    this.showConnecting();
    loadMonaco().catch(() => {});
    fontsReady();
    let home;
    try {
      home = await this.primary.open(true);
    } catch (e) {
      if (!this.disposed) this.showFailure(e);
      return;
    }
    if (this.disposed) return;
    if (home == null) { location.hash = ''; return; }
    const session = store.get(`session:${this.host}`, {});
    let root = untildify(this.rootHint || session.root || home, home);
    try {
      root = (await this.primary.call('/api/ls', { query: { path: root } })).path;
    } catch (e) {
      toast({ kind: 'error', title: `Couldn’t open ${tildify(root, home)}`, message: `${e.message}. Opened your home folder instead.` });
      root = home;
    }
    if (this.disposed) return;
    this.roots = [this.newRoot(this.host, root)];
    for (const x of Array.isArray(session.extra) ? session.extra.slice(0, 12) : []) {
      if (x && typeof x.host === 'string' && typeof x.path === 'string' && !this.roots.some(r => r.host === x.host && r.path === x.path)) {
        this.roots.push(this.newRoot(x.host, x.path));
      }
    }
    this.build();
    try {
      await this.editor.init();
    } catch (e) {
      toastError('The editor failed to load', e);
    }
    if (this.disposed) return;
    this.explorer.setRoots();
    this.editor.restore(session);
    if (session.view === 'search') this.showView('search');
    const restored = await this.terminal.restore();
    if (this.disposed) return;
    if (restored || session.term) this.setTerminalVisible(true);
    this.sessionFolder = session.folder;
    // The view belongs to the browser tab: a reload keeps it, a new tab starts where Settings says.
    const start = tabStore.get(`mode:${this.host}`) || (settings.get('files.startView') === 'folders' ? 'files' : 'ide');
    if (start === 'files') this.setMode('files');
    this.updateUrl();
    this.updateTitle();
    noteRecentWorkspace(this.host, this.root, home);
    this.installGlobalHandlers();
    this.transfers.adopt();
  }

  showConnecting() {
    document.title = `${this.host} — sshcode`;
    this.app.innerHTML = '';
    this.splash = h(`<div class="home"><div class="home-inner" style="margin-top:14vh;text-align:center">
      <div class="hrow" style="justify-content:center;min-height:0"><span class="tile ${hostColor(this.host)}" style="width:56px;height:56px;border-radius:15px">${icons.server}</span></div>
      <h1 style="margin-top:18px">${esc(hostLabel(this.host))}</h1>
      <p class="lede" style="display:flex;gap:10px;justify-content:center;align-items:center">${spinner(16)} Connecting…</p>
      <button class="btn" data-a="cancel">Cancel</button>
    </div></div>`);
    this.splash.querySelector('[data-a=cancel]').onclick = () => { location.hash = ''; };
    this.app.appendChild(this.splash);
  }

  showFailure(e) {
    this.app.innerHTML = '';
    const el = h(`<div class="home"><div class="home-inner" style="margin-top:12vh">
      <div class="dialog" style="width:auto;margin:0 auto;max-width:520px;position:relative;background:var(--pop);border-radius:24px;box-shadow:var(--shadow-pane)">
        <div class="d-icon"><span class="sym warning">${icons.warning}</span></div>
        <h2>Couldn’t connect to ${esc(this.host)}</h2>
        <p>ssh said:</p>
        <pre class="detail">${esc(e.message || String(e))}</pre>
        <div class="btns"><button class="btn" data-a="back">All Hosts</button><button class="btn primary" data-a="retry">Try Again</button></div>
      </div></div></div>`);
    el.querySelector('[data-a=back]').onclick = () => { location.hash = ''; };
    el.querySelector('[data-a=retry]').onclick = () => this.start();
    this.app.appendChild(el);
  }

  async dispose() {
    if (this.editor && this.editor.dirtyDocs().length) {
      const n = this.editor.dirtyDocs().length;
      const ok = await confirm(`Leave ${this.host} with unsaved changes?`,
        `${n} file${n > 1 ? 's have' : ' has'} unsaved changes. They’re kept in this browser and come back when you reopen ${this.host}.`,
        { ok: 'Leave', danger: true });
      if (!ok) return false;
      this.editor.writeBackups();
    }
    this.disposed = true;
    this.writeSession();
    for (const f of this.cleanup) f();
    closePopover();
    if (this.palette) this.palette.close();
    if (this.transfers) this.transfers.dispose();
    if (this.terminal) this.terminal.dispose();
    if (this.folders) this.folders.dispose();
    if (this.explorer) this.explorer.dispose();
    if (this.editor) this.editor.dispose();
    this.app.innerHTML = '';
    return true;
  }

  // --- layout ---------------------------------------------------------------------------
  build() {
    this.app.innerHTML = '';
    this.el = h(`<div class="ws">
      <aside class="sidebar rim">
        <div class="side-head">
          <button class="host-btn"><span class="dot"></span><span class="hn"></span><span class="chev">${icons.chevronDown}</span></button>
          <button class="ib" data-a="add-server">${icons.serverPlus}</button>
          <button class="ib" data-a="settings">${icons.gear}</button>
          <button class="ib" data-a="hide-side">${icons.sidebar}</button>
        </div>
        <div class="conn-banner" hidden><div class="grow"><b>Connection lost</b><span class="why"></span></div><button class="btn small" data-a="reconnect">Reconnect</button></div>
        <div class="seg" role="tablist">
          <button data-v="explorer" class="on" role="tab">${icons.folderLine}Files</button>
          <button data-v="search" role="tab">${icons.search}Search</button>
        </div>
      </aside>
      <div class="vsplit" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <div class="main"></div>
    </div>`);
    this.sidebar = this.el.querySelector('.sidebar');
    this.mainEl = this.el.querySelector('.main');
    this.transfers = new Transfers(this);
    this.explorer = new Explorer(this);
    this.search = new SearchView(this);
    this.editor = new Editor(this);
    this.terminal = new TerminalPanel(this);
    this.palette = new Palette(this);
    this.sidebar.append(this.explorer.el, this.search.el);
    this.hsplit = h('<div class="hsplit" role="separator" title="Drag to resize"></div>');
    this.mainEl.append(this.editor.el, this.hsplit, this.terminal.el);
    this.editor.el.querySelector('.tab-acts').prepend(this.transfers.button);
    this.app.appendChild(this.el);

    const hb = this.el.querySelector('.host-btn');
    hb.addEventListener('click', () => { const r = hb.getBoundingClientRect(); this.hostMenu(r.left, r.bottom + 6); });
    const tip = (a, t, k) => { this.el.querySelector(`[data-a=${a}]`).title = k ? `${t} (${kbd(k)})` : t; };
    tip('hide-side', 'Hide Sidebar', 'Mod+B');
    tip('add-server', 'Add a Server or Folder');
    tip('settings', 'Settings', 'Mod+,');
    this.el.querySelector('[data-a=hide-side]').addEventListener('click', () => this.run('view.sidebar'));
    this.el.querySelector('[data-a=settings]').addEventListener('click', () => this.run('settings.open'));
    this.el.querySelector('[data-a=add-server]').addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.addMenu(r.left, r.bottom + 6);
    });
    this.el.querySelector('[data-a=reconnect]').addEventListener('click', () => this.primary.reconnect());
    this.el.querySelector('.seg').addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (b) this.showView(b.dataset.v);
    });
    this.dragSplit(this.el.querySelector('.vsplit'), 'side');
    this.dragSplit(this.hsplit, 'term');
    this.el.querySelector('.vsplit').addEventListener('dblclick', () => { this.layout.sideW = 268; this.applyLayout(); this.persistLayout(); });
    this.hsplit.addEventListener('dblclick', () => this.toggleTermMax());
    this.registerCommands();
    this.renderHostButton();
    this.applyLayout();
  }

  renderHostButton() {
    if (!this.el) return;
    const hb = this.el.querySelector('.host-btn');
    hb.querySelector('.hn').textContent = hostLabel(this.host);
    hb.style.setProperty('--hc', `var(--${hostColor(this.host)})`);
    hb.title = `${this.host} — connection menu`;
  }

  applyLayout() {
    const el = this.el;
    if (!el) return;
    const right = settings.get('panelSide') === 'right';
    el.style.setProperty('--side-w', this.layout.sideW + 'px');
    el.style.setProperty('--term-h', this.layout.termH + 'px');
    el.style.setProperty('--term-w', this.layout.termW + 'px');
    el.classList.toggle('no-side', !this.layout.side);
    el.classList.toggle('side-right', settings.get('sidebarSide') === 'right');
    el.classList.toggle('panel-right', right);
    el.classList.toggle('no-term', !this.layout.term);
    el.classList.toggle('term-max', this.layout.term && this.termMax);
    this.hsplit.setAttribute('aria-orientation', right ? 'vertical' : 'horizontal');
    this.editor.el.querySelector('.side-toggle').hidden = this.layout.side;
    if (this.folders) this.folders.renderBar();
    this.terminal.renderActs();
  }

  /** 'ide' (the editor, with the terminals) or 'files' (the folder view in the editor's place). */
  setMode(mode, { focus = true } = {}) {
    if (!this.el || mode === this.mode) return;
    if (mode === 'files' && !this.folders) {
      this.folders = new FolderView(this);
      this.mainEl.insertBefore(this.folders.el, this.hsplit);
      const start = this.folderStart();
      this.folders.go(start.host, start.path, { push: false, select: start.select || null });
    }
    this.mode = mode;
    tabStore.set(`mode:${this.host}`, mode);
    this.el.classList.toggle('files-mode', mode === 'files');
    if (mode === 'files') {
      this.folders.layoutChanged();
      if (focus) this.folders.focus();
    } else {
      if (this.folders) this.folders.ql.close();
      const d = this.editor.active;
      if (focus && d && d.kind === 'text' && d.view !== 'preview' && this.editor.ed) this.editor.ed.focus();
    }
    this.updateTitle();
    this.saveSession();
  }

  /** Where the folder view opens first: where it was last time, else where you are. */
  folderStart() {
    const saved = this.sessionFolder;
    if (saved && typeof saved.host === 'string' && typeof saved.path === 'string' && this.roots.some(r => r.host === saved.host)) return saved;
    const picked = this.explorer.selected()[0];
    if (picked) return picked.isDir ? { host: picked.host, path: picked.path } : { host: picked.host, path: dirname(picked.path), select: [picked.name] };
    const d = this.editor.active;
    if (d && this.rootOf(d.host, d.path)) return { host: d.host, path: dirname(d.path), select: [d.name] };
    const r = this.activeRoot();
    return { host: r.host, path: r.path };
  }

  onFolderChanged(loc) {
    this.sessionFolder = { host: loc.host, path: loc.path };
    this.updateTitle();
    this.saveSession();
  }

  persistLayout() {
    store.set('layout.side', this.layout.side);
    store.set('layout.sideW', this.layout.sideW);
    store.set('layout.termH', this.layout.termH);
    store.set('layout.termW', this.layout.termW);
  }

  /** which: 'side' (sidebar width) or 'term' (panel height, or width when it's on the right). */
  dragSplit(handle, which) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      const right = settings.get('panelSide') === 'right';
      const x = which === 'side' || right;
      document.body.style.cursor = x ? 'col-resize' : 'row-resize';
      const start = x ? e.clientX : e.clientY;
      const size = which === 'side' ? this.layout.sideW : right ? this.layout.termW : this.layout.termH;
      // Moving toward the pane it belongs to makes it smaller.
      const sign = which === 'side' ? (settings.get('sidebarSide') === 'right' ? -1 : 1) : -1;
      const move = ev => {
        const d = ((x ? ev.clientX : ev.clientY) - start) * sign;
        if (which === 'side') this.layout.sideW = clamp(size + d, 190, innerWidth * 0.6);
        else if (right) this.layout.termW = clamp(size + d, 220, this.mainEl.clientWidth - 260);
        else this.layout.termH = clamp(size + d, 96, this.mainEl.clientHeight - 130);
        this.applyLayout();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
        this.persistLayout();
        this.terminal.fitAll();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  showView(v) {
    this.layout.view = v;
    if (!this.layout.side) { this.layout.side = true; this.applyLayout(); this.persistLayout(); }
    this.explorer.el.hidden = v !== 'explorer';
    this.search.el.hidden = v !== 'search';
    this.el.querySelectorAll('.seg [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    this.saveSession();
  }

  showSearch(opts = {}) {
    this.showView('search');
    this.search.focus(opts);
  }

  async revealInExplorer(host, path) {
    this.showView('explorer');
    await this.explorer.reveal(host, path);
    this.explorer.tree.focus();
  }

  setTerminalVisible(on, { create = true } = {}) {
    this.layout.term = on;
    if (!on) this.termMax = false;
    this.applyLayout();
    this.saveSession();
    if (on) {
      if (create && !this.terminal.terms.length) this.terminal.newTerminal({ focus: false });
      requestAnimationFrame(() => this.terminal.fitAll());
    }
  }

  toggleTerminal() {
    if (!this.layout.term) { this.setTerminalVisible(true); this.terminal.focus(); }
    else if (this.terminal.hasFocus()) { this.setTerminalVisible(false); if (this.editor.ed) this.editor.ed.focus(); }
    else this.terminal.focus();
  }

  toggleTermMax() {
    if (!this.layout.term) this.setTerminalVisible(true);
    this.termMax = !this.termMax;
    this.applyLayout();
    requestAnimationFrame(() => this.terminal.fitAll());
  }

  // --- folders and servers -----------------------------------------------------------------
  /** Put a folder from `host` (its home if no path) in the sidebar. */
  async addRoot(host, path) {
    const conn = this.conn(host);
    try {
      if ((await conn.ensure(true)) == null) return null;
    } catch (e) {
      toastError(`Couldn’t connect to ${host}`, e);
      return null;
    }
    let real;
    try {
      real = (await conn.call('/api/ls', { query: { path: untildify(path || conn.home, conn.home) } })).path;
    } catch (e) {
      toastError(`Couldn’t open ${path || '~'} on ${host}`, e);
      return null;
    }
    this.showView('explorer');
    const dup = this.roots.find(r => r.host === host && r.path === real);
    if (dup) { this.explorer.focusRoot(dup); return dup; }
    const r = this.newRoot(host, real);
    this.roots.push(r);
    this.explorer.addRoot(r);
    this.rootsChanged();
    return r;
  }

  removeRoot(r) {
    if (r === this.roots[0]) return;
    this.roots = this.roots.filter(x => x !== r);
    this.explorer.removeRoot(r);
    this.rootsChanged();
  }

  /** Point a sidebar folder somewhere else (Go to Folder, the path menu, ↑). */
  async setRootPath(r, path) {
    const conn = this.conn(r.host);
    path = untildify(path, conn.home);
    let real;
    try {
      real = (await conn.call('/api/ls', { query: { path } })).path;
    } catch (e) {
      toastError(`Couldn’t open ${tildify(path, conn.home)}`, e);
      return;
    }
    if (real === r.path) return;
    r.path = real;
    this.palette.invalidate(r);
    if (this.search.rootId === r.id) this.search.folder = null;
    await this.explorer.rootMoved(r);
    if (r === this.roots[0]) {
      this.updateUrl();
      noteRecentWorkspace(this.host, real, this.home);
    }
    this.rootsChanged();
  }

  /** From the address bar (#host=…&root=…). */
  setRoot(path) { return this.setRootPath(this.roots[0], path); }

  rootsChanged() {
    this.updateTitle();
    this.writeSession();  // now, not debounced: a server added is worth keeping even if the tab dies
    this.search.renderScope();
    this.editor.renderTabs();
    this.terminal.renderAll();
  }

  /** The folder commands act on: the one you're in in the sidebar, else the active file's. */
  activeRoot() {
    const r = this.explorer && this.explorer.currentRoot();
    if (r) return r;
    const d = this.editor && this.editor.active;
    if (d) { const dr = this.rootOf(d.host, d.path); if (dr) return dr; }
    return this.roots[0];
  }

  rootOf(host, path) {
    let best = null;
    for (const r of this.roots) if (r.host === host && isUnder(path, r.path) && (!best || r.path.length > best.path.length)) best = r;
    return best;
  }

  /** Folders opened on `host` before, newest first. */
  recentFolders(host = this.host) {
    const home = this.conn(host).home;
    const seen = new Set();
    for (const r of store.get('recents', [])) if (r.host === host) seen.add(untildify(r.root, home));
    return [...seen];
  }

  // --- state --------------------------------------------------------------------------------
  writeSession() {
    if (!this.root || !this.editor) return;
    store.set(`session:${this.host}`, {
      root: this.root,
      extra: this.roots.slice(1).map(r => ({ host: r.host, path: r.path })),
      ...this.editor.serialize(),
      term: this.layout.term,
      view: this.layout.view,
      folder: this.sessionFolder,
    });
  }

  updateUrl() {
    const p = new URLSearchParams({ host: this.host });
    if (this.root !== this.home) p.set('root', tildify(this.root, this.home));
    history.replaceState(null, '', '#' + p.toString().replace(/%2F/g, '/').replace(/%7E/g, '~'));
  }

  rootName(r = this.roots[0]) {
    const home = this.conn(r.host).home;
    return r.path === home ? '~' : basename(r.path);
  }

  updateTitle() {
    if (!this.roots.length) return;
    if (this.mode === 'files' && this.folders && this.folders.loc) {
      const { host, path } = this.folders.loc;
      const home = this.conn(host).home;
      const t = `${path === home ? '~' : path === '/' ? '/' : basename(path)} — ${hostLabel(host)}`;
      if (document.title !== t) document.title = t;
      return;
    }
    const d = this.editor && this.editor.active;
    const dirty = d && this.editor.isDirty(d);
    const r = (d && this.rootOf(d.host, d.path)) || this.roots[0];
    const title = `${d ? `${dirty ? '● ' : ''}${d.name} — ` : ''}${this.rootName(r)} — ${hostLabel(d ? d.host : this.host)}`;
    if (document.title !== title) document.title = title;
  }

  onActiveChanged(doc) {
    this.updateTitle();
    if (doc) {
      this.palette.noteRecent(doc.host, doc.path);
      if (this.layout.side && this.layout.view === 'explorer' && this.rootOf(doc.host, doc.path)) this.explorer.reveal(doc.host, doc.path, { scroll: true });
    }
    this.saveSession();
  }

  onDirtyChanged() { this.updateTitle(); }

  /** A file or folder moved on a server: the tree, the tabs and the backups follow. */
  onMoved(host, src, dst) {
    this.explorer.moved(host, src, dst);
    this.editor.onRenamed(host, src, dst);
  }

  // --- connection ------------------------------------------------------------------------
  /** api() for the workspace's own server (most callers say which server). */
  call(path, opts = {}) { return this.primary.call(path, opts); }

  reconnect() { return this.primary.reconnect(); }

  onConnState(conn) {
    if (!this.el) return;
    if (conn.host === this.host) {
      const dot = this.el.querySelector('.host-btn .dot');
      dot.className = 'dot' + (conn.state === 'ok' ? '' : conn.state === 'busy' ? ' busy' : ' off');
      const banner = this.el.querySelector('.conn-banner');
      banner.hidden = conn.state !== 'off';
      banner.querySelector('.why').textContent = conn.why ? ` ${conn.why}` : '';
    }
    if (this.explorer) this.explorer.onConnState(conn);
  }

  onReconnected(conn) {
    if (this.explorer) this.explorer.refreshHost(conn.host);
  }

  async disconnect() {
    if (this.editor.dirtyDocs().length) {
      const ok = await confirm('Disconnect with unsaved changes?', 'Unsaved edits stay in this browser and come back when you reconnect.', { ok: 'Disconnect', danger: true });
      if (!ok) return;
      this.editor.writeBackups();
      for (const d of this.editor.docs) d.savedVersion = d.model ? d.model.getAlternativeVersionId() : d.savedVersion;
    }
    this.terminal.killAll();
    this.layout.term = false;
    this.writeSession();
    try { await api('/api/disconnect', { body: { host: this.host } }); } catch { /* already gone */ }
    location.hash = '';
  }

  /** A terminal on `host`, signing in first if needed. */
  async terminalOn(host) {
    try {
      if ((await this.conn(host).ensure(true)) == null) return;
    } catch (e) {
      toastError(`Couldn’t connect to ${host}`, e);
      return;
    }
    this.terminal.newTerminal({ host });
  }

  /** Drop a server from the sidebar and sign out of it (its terminals close). */
  async disconnectHost(host) {
    if (host === this.host) { this.disconnect(); return; }
    const dirty = this.editor.dirtyDocs().filter(d => d.host === host);
    const ok = await confirm(`Disconnect from ${hostLabel(host)}?`,
      `Its folders leave the sidebar and its terminals close.${dirty.length ? ' Unsaved edits stay in this browser.' : ''}`, { ok: 'Disconnect', danger: true });
    if (!ok) return;
    if (dirty.length) this.editor.writeBackups();
    for (const r of this.roots.filter(x => x.host === host)) this.removeRoot(r);
    this.terminal.killHost(host);
    await this.editor.closeMany(this.editor.docs.filter(d => d.host === host && !this.editor.isDirty(d)));
    try { await api('/api/disconnect', { body: { host } }); } catch { /* already gone */ }
    this.conn(host).set('idle');
    this.rootsChanged();
  }

  // --- menus -------------------------------------------------------------------------------
  hostMenu(x, y) {
    contextMenu(x, y, [
      { label: 'Add Server…', icon: 'serverPlus', action: () => this.run('workspace.addServer') },
      { label: 'Add Folder…', icon: 'newFolder', action: () => this.run('workspace.addFolder') },
      { label: 'Go to Folder…', icon: 'folderOpen', keys: this.keysFor('file.openFolder'), action: () => this.run('file.openFolder') },
      '-',
      { label: 'New Terminal', icon: 'terminal', keys: this.keysFor('term.new'), action: () => this.run('term.new') },
      { label: 'Open in New Tab', icon: 'plus', action: () => window.open(location.href, '_blank') },
      { label: 'Settings…', icon: 'gear', keys: this.keysFor('settings.open'), action: () => this.run('settings.open') },
      '-',
      { label: 'Reconnect', icon: 'refresh', action: () => this.primary.reconnect() },
      { label: 'All Hosts…', icon: 'server', action: () => { location.hash = ''; } },
      '-',
      { label: `Disconnect from ${hostLabel(this.host)}`, icon: 'power', danger: true, action: () => this.disconnect() },
    ]);
  }

  addMenu(x, y) {
    contextMenu(x, y, [
      { label: 'Add Server…', icon: 'serverPlus', action: () => this.run('workspace.addServer') },
      { label: `Add Folder from ${hostLabel(this.activeRoot().host)}…`, icon: 'newFolder', action: () => this.run('workspace.addFolder') },
    ]);
  }

  moreMenu(x, y) {
    const check = on => (on ? 'check' : undefined);
    const theme = themePref();
    contextMenu(x, y, [
      { label: 'Show All Commands', icon: 'command', keys: this.keysFor('go.command'), action: () => this.run('go.command') },
      { label: 'Go to File…', icon: 'search', keys: this.keysFor('go.file'), action: () => this.run('go.file') },
      { label: 'Find in Files', icon: 'search', keys: this.keysFor('view.search'), action: () => this.run('view.search') },
      '-',
      { label: 'Word Wrap', icon: check(this.editor.wrapFor(this.editor.active) === 'on'), keys: this.keysFor('view.wrap'), action: () => this.run('view.wrap') },
      { label: 'Minimap', icon: check(settings.get('editor.minimap')), action: () => this.run('view.minimap') },
      { label: 'Auto Save', icon: check(settings.get('editor.autoSave') !== 'off'), action: () => this.run('file.autoSave') },
      '-',
      { label: 'Appearance: Match System', icon: check(theme === 'system'), action: () => setThemePref('system') },
      { label: 'Appearance: Light', icon: check(theme === 'light'), action: () => setThemePref('light') },
      { label: 'Appearance: Dark', icon: check(theme === 'dark'), action: () => setThemePref('dark') },
      { label: 'Editor Theme…', icon: 'palette', action: () => this.run('theme.editor') },
      '-',
      { label: 'Bigger Text', action: () => this.editor.zoom(1) },
      { label: 'Smaller Text', action: () => this.editor.zoom(-1) },
      '-',
      { label: 'Settings…', icon: 'gear', keys: this.keysFor('settings.open'), action: () => this.run('settings.open') },
    ]);
  }

  // --- commands ------------------------------------------------------------------------------
  handlers() {
    const ed = () => this.editor;
    const ar = () => this.activeRoot();
    const toggle = k => settings.set(k, !settings.get(k));
    return {
      'go.file': () => this.palette.files(),
      'go.command': () => this.palette.commands(),
      'go.line': () => this.palette.line(),
      'file.openFolder': () => (this.mode === 'files' ? this.folders.goToFolder() : this.palette.openFolder(ar())),
      'go.up': () => (this.mode === 'files' ? this.folders.up() : this.explorer.goUp(ar())),
      'go.home': () => { const r = ar(); this.setRootPath(r, this.conn(r.host).home); },
      'go.slash': () => this.setRootPath(ar(), '/'),
      'file.save': () => ed().save(),
      'file.saveAll': () => ed().saveAll(),
      'file.newFile': () => { if (this.mode === 'files') { this.folders.newEntry(false); return; } this.showView('explorer'); this.explorer.newEntry(null, false); },
      'file.newFolder': () => { if (this.mode === 'files') { this.folders.newEntry(true); return; } this.showView('explorer'); this.explorer.newEntry(null, true); },
      'file.close': () => ed().close(ed().active),
      'file.closeAll': () => ed().closeMany(ed().docs),
      'file.revert': () => ed().revert(),
      'file.autoSave': () => ed().toggleAutoSave(),
      'file.upload': () => (this.mode === 'files' ? this.folders.pickUpload() : this.explorer.pickUpload()),
      'file.uploadFolder': () => (this.mode === 'files' ? this.folders.pickUpload(true) : this.explorer.pickUpload(null, true)),
      'file.download': () => { const d = ed().active; if (d) this.explorer.download([{ host: d.host, path: d.path, isDir: false }]); },
      'file.copyPath': () => { const d = ed().active; if (d) copyText(d.path); },
      'workspace.addServer': () => this.palette.addServer(),
      'workspace.addFolder': () => this.palette.openFolder(ar(), { add: true }),
      'view.transfers': () => this.transfers.open(),
      'remote.reconnect': () => this.primary.reconnect(),
      'remote.hosts': () => { location.hash = ''; },
      'remote.disconnect': () => this.disconnect(),
      'view.sidebar': () => { this.layout.side = !this.layout.side; this.applyLayout(); this.persistLayout(); },
      'view.explorer': () => { this.showView('explorer'); this.explorer.tree.focus(); },
      'view.search': () => this.showSearch({ query: this.selectedText() }),
      'view.sidebarSide': () => settings.set('sidebarSide', settings.get('sidebarSide') === 'right' ? 'left' : 'right'),
      'view.panelSide': () => settings.set('panelSide', settings.get('panelSide') === 'right' ? 'bottom' : 'right'),
      'view.wrap': () => ed().toggleWrap(),
      'view.minimap': () => toggle('editor.minimap'),
      'view.hidden': () => toggle('files.hidden'),
      'view.zoomIn': () => ed().zoom(1),
      'view.zoomOut': () => ed().zoom(-1),
      'view.zoomReset': () => ed().zoom(0),
      'editor.preview': () => ed().togglePreview(),
      'editor.previewSide': () => ed().toggleSplit(),
      'view.folders': () => this.setMode(this.mode === 'files' ? 'ide' : 'files'),
      'editor.asText': () => { const d = ed().active; if (d) ed().reopenAs(d, 'lossy'); },
      'editor.language': () => this.palette.language(),
      'explorer.refresh': () => { this.explorer.refresh(); if (this.folders) this.folders.refresh(); },
      'explorer.collapse': () => this.explorer.collapseAll(),
      'explorer.reveal': () => { const d = ed().active; if (d) this.revealInExplorer(d.host, d.path); },
      'view.terminal': () => this.toggleTerminal(),
      'term.new': () => this.terminal.newTerminal(),
      'term.newOn': () => this.palette.pickHost({ title: 'New terminal on…', pick: host => this.terminalOn(host) }),
      'term.split': () => this.terminal.split('row'),
      'term.splitDown': () => this.terminal.split('col'),
      'term.focusNext': () => this.terminal.focusStep(1),
      'term.focusPrev': () => this.terminal.focusStep(-1),
      'term.join': () => this.terminal.joinAll(),
      'term.rename': () => this.terminal.rename(),
      'term.kill': () => this.terminal.kill(),
      'term.max': () => this.toggleTermMax(),
      'settings.open': () => openSettings({ ws: this }),
      'settings.keys': () => openSettings({ ws: this, section: 'keyboard' }),
      'theme.editor': () => this.palette.themes(),
      'theme.system': () => setThemePref('system'),
      'theme.light': () => setThemePref('light'),
      'theme.dark': () => setThemePref('dark'),
    };
  }

  registerCommands() {
    const run = this.handlers();
    this.baseCommands = COMMANDS.filter(c => run[c.id]).map(c => ({ ...c, run: run[c.id] }));
    this.rebuildKeymap();
  }

  /** Shortcuts as they are now (Settings → Keyboard can change them at any time). */
  rebuildKeymap() {
    this.commands = this.baseCommands.map(c => ({ ...c, keys: keysOf(c) }));
    this.keymap = buildKeymap(this.commands);
    this.editor.renderEmpty();
  }

  keysFor(id) { const c = this.commands.find(x => x.id === id); return c ? c.keys : ''; }

  run(id, cmd) {
    const c = cmd && cmd.run ? cmd : this.commands.find(x => x.id === id);
    if (c) c.run();
  }

  selectedText() {
    const e = this.editor.ed;
    if (!e || !e.getModel()) return '';
    const s = e.getSelection();
    const t = s && !s.isEmpty() ? e.getModel().getValueInRange(s) : '';
    return t.includes('\n') ? '' : t;
  }

  // --- window ---------------------------------------------------------------------------------
  installGlobalHandlers() {
    const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); this.cleanup.push(() => target.removeEventListener(ev, fn, opts)); };
    on(window, 'keydown', e => {
      if (e.isComposing || modalOpen()) return;
      const cmd = this.keymap.get(keyName(e));
      if (!cmd) return;
      const inTerm = !!(e.target && e.target.closest && e.target.closest('.xterm'));
      if (inTerm && !cmd.inTerminal) return;
      e.preventDefault();
      e.stopPropagation();
      this.run(cmd.id);
    }, true);
    // pagehide also covers what beforeunload misses (bfcache, mobile, some reloads).
    on(window, 'pagehide', () => { this.writeSession(); this.terminal.persist(); });
    on(window, 'beforeunload', e => {
      this.writeSession();
      this.terminal.persist();
      if (this.editor.dirtyDocs().length) {
        this.editor.writeBackups();
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // Background channel: these never hold up what you click.
    const onFocus = debounce(() => {
      this.explorer.refresh(undefined, { bg: true });
      if (this.mode === 'files' && this.folders) this.folders.refresh({ bg: true });
      this.editor.checkExternal();
    }, 400);
    on(window, 'focus', onFocus);
    on(window, 'blur', () => { if (settings.get('editor.autoSave') === 'focus') this.editor.autoSaveNow(); });
    const poll = setInterval(() => {
      if (document.hasFocus() && this.primary.state === 'ok') {
        this.explorer.refresh(undefined, { bg: true });
        if (this.mode === 'files' && this.folders) this.folders.refresh({ bg: true });
        this.editor.checkExternal();
      }
    }, 45000);
    this.cleanup.push(() => clearInterval(poll));
    // A file dropped outside a drop target must not navigate the page away.
    on(window, 'dragover', e => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
    on(window, 'drop', e => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    const subs = [
      settings.on('keys', () => this.rebuildKeymap()),
      settings.on('sidebarSide', () => this.applyLayout()),
      settings.on('panelSide', () => { this.applyLayout(); requestAnimationFrame(() => this.terminal.fitAll()); }),
      settings.on('hosts', () => { this.renderHostButton(); this.explorer.render(); this.editor.renderTabs(); this.terminal.renderAll(); this.updateTitle(); }),
    ];
    this.cleanup.push(...subs);
  }
}
