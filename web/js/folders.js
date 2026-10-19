// The folder view: a Finder-style window onto one folder at a time, shown in
// place of the editor (the sidebar and terminals stay). Icons with picture
// thumbnails, or a sortable list; back and forward; the path menu; Quick Look
// on Space; drag and drop with the sidebar and the desktop; the same file
// operations as the sidebar. Only what's on screen is drawn, so folders with
// tens of thousands of files scroll smoothly.
import { esc, h, store, basename, dirname, join, tildify, untildify, byName, copyText, isMac, keyName, kbd, fmtSize } from './util.js';
import { icons, fileIcon, folderIcon, mediaKind, isImage } from './icons.js';
import { contextMenu, toastError, spinner, dialog } from './ui.js';
import { fileUrl } from './api.js';
import { settings, hostColor, hostLabel } from './settings.js';
import { DRAG_TYPE, collectDrop } from './explorer.js';
import { QuickLook } from './quicklook.js';
import { isDirType, kindOf, fmtDate, bigFolder, bigDoc } from './fileinfo.js';
const SPRING_MS = 650;
const THUMB_MAX = 8 << 20;   // pictures bigger than this keep their icon
const LIST_COLS = [['name', 'Name'], ['mtime', 'Date Modified'], ['size', 'Size'], ['kind', 'Kind']];

// --- picture thumbnails -----------------------------------------------------------------------------

/** Thumbnails are drawn small once and kept (as tiny blobs), so scrolling back is free. */
class Thumbs {
  constructor() {
    this.done = new Map();     // key -> object URL ('' = couldn't)
    this.queue = [];
    this.running = 0;
    this.generation = 0;
  }

  key(host, path, e) { return `${host}\n${path}\n${e.size}\n${e.mtime}`; }

  /** The thumbnail if ready; otherwise starts making it and calls back. */
  get(host, path, e, px, ready) {
    const k = this.key(host, path, e);
    if (this.done.has(k)) return this.done.get(k);
    if (!this.queue.some(j => j.k === k)) this.queue.push({ k, host, path, px, ready, gen: this.generation });
    this.pump();
    return null;
  }

  /** Forget what was asked for in the folder we left. */
  reset() { this.generation++; this.queue = []; }

  pump() {
    while (this.running < 4 && this.queue.length) {
      const job = this.queue.shift();
      if (job.gen !== this.generation) continue;
      this.running++;
      this.make(job).finally(() => { this.running--; this.pump(); });
    }
  }

  async make({ k, host, path, px, ready, gen }) {
    let url = '';
    try {
      const r = await fetch(fileUrl(host, path, true));
      if (!r.ok) throw new Error(r.statusText);
      const blob = await r.blob();
      if (/\.svg$/i.test(path)) url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }));
      else {
        const bmp = await createImageBitmap(blob);
        const k2 = Math.min(1, px / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * k2));
        c.height = Math.max(1, Math.round(bmp.height * k2));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        const small = await new Promise(res => c.toBlob(res, 'image/webp', 0.86));
        url = small ? URL.createObjectURL(small) : '';
      }
    } catch { url = ''; }
    this.done.set(k, url);
    // Keep a few hundred.
    if (this.done.size > 600) {
      for (const [key, u] of this.done) {
        if (this.done.size <= 450) break;
        if (u) URL.revokeObjectURL(u);
        this.done.delete(key);
      }
    }
    if (gen === this.generation && url) ready(url);
  }

  dispose() {
    this.reset();
    for (const u of this.done.values()) if (u) URL.revokeObjectURL(u);
    this.done.clear();
  }
}

// --- the view ------------------------------------------------------------------------------------------

export class FolderView {
  constructor(ws) {
    this.ws = ws;
    this.loc = null;            // {host, path}
    this.history = [];
    this.forward = [];
    this.all = [];              // entries as listed
    this.entries = [];          // shown: filtered and sorted
    this.state = 'idle';        // idle | loading | ok | error
    this.error = '';
    this.sel = new Set();       // names
    this.focusName = null;
    this.anchor = null;
    this.filter = '';
    this.sort = store.get('folders.sort', { key: 'name', dir: 1 });
    this.items = new Map();     // name -> element on screen
    this.thumbs = new Thumbs();
    this.typeahead = { text: '', at: 0 };
    this.el = h(`<section class="pane rim folder-pane" aria-label="Folder">
      <div class="fv-bar">
        <button class="ib side-toggle" data-a="sidebar" hidden>${icons.sidebar}</button>
        <div class="fv-nav">
          <button class="ib" data-a="back">${icons.chevronLeft}</button>
          <button class="ib" data-a="fwd">${icons.chevronRight}</button>
        </div>
        <button class="fv-title" data-a="loc"><span class="fv-loc-ic">${icons.folderLine}</span><span class="nm"></span><span class="fv-host"></span><span class="chev">${icons.chevronDown}</span></button>
        <span class="sp"></span>
        <div class="view-seg fv-mode" role="group" aria-label="Show as">
          <button class="ib sm" data-mode="icons" title="Icons">${icons.grid}</button>
          <button class="ib sm" data-mode="list" title="List">${icons.list}</button>
        </div>
        <label class="fv-filter">${icons.search}<input placeholder="Filter" spellcheck="false" autocomplete="off" aria-label="Filter this folder"></label>
        <button class="ib" data-a="newFolder">${icons.newFolder}</button>
        <button class="ib" data-a="upload">${icons.upload}</button>
        <button class="ib" data-a="terminal">${icons.terminal}</button>
        <button class="ib" data-a="more">${icons.ellipsis}</button>
        <button class="ib on" data-a="ide">${icons.code}</button>
      </div>
      <div class="fv-head" hidden><span></span>${LIST_COLS.map(([k, t]) => `<button class="fv-col c-${k}" data-sort="${k}">${t}<span class="arrow"></span></button>`).join('')}</div>
      <div class="fv-scroll" tabindex="0" role="grid" aria-multiselectable="true">
        <div class="fv-canvas"></div>
        <div class="fv-band" hidden></div>
      </div>
      <div class="fv-msg" hidden></div>
      <div class="fv-status"><span class="fv-path"></span><span class="sp"></span><span class="fv-count"></span><input class="fv-size" type="range" min="40" max="128" step="8" aria-label="Icon size" title="Icon size"></div>
      <input type="file" multiple hidden data-up="files">
      <input type="file" multiple hidden webkitdirectory data-up="dir">
    </section>`);
    this.scroller = this.el.querySelector('.fv-scroll');
    this.canvas = this.el.querySelector('.fv-canvas');
    this.band = this.el.querySelector('.fv-band');
    this.msg = this.el.querySelector('.fv-msg');
    this.head = this.el.querySelector('.fv-head');
    this.filterInput = this.el.querySelector('.fv-filter input');
    this.sizeInput = this.el.querySelector('.fv-size');
    this.ql = new QuickLook(this);
    const tip = (a, t, k) => { this.el.querySelector(`[data-a=${a}]`).title = k ? `${t} (${kbd(k)})` : t; };
    tip('sidebar', 'Show Sidebar', 'Mod+B');
    tip('back', 'Back', 'Mod+[');
    tip('fwd', 'Forward', 'Mod+]');
    tip('loc', 'Where this folder is, and other places');
    tip('newFolder', 'New Folder');
    tip('upload', 'Upload Files');
    tip('terminal', 'Open a Terminal Here');
    tip('more', 'More');
    tip('ide', 'Back to the Editor', 'Mod+Alt+F');
    this.subs = [
      settings.on('files.folderView', () => { this.layoutChanged(); }),
      settings.on('files.iconSize', () => { this.sizeInput.value = settings.get('files.iconSize'); this.layoutChanged(); }),
      settings.on('files.thumbnails', () => this.paint(true)),
      ...['files.hidden', 'files.exclude', 'files.foldersFirst'].map(k => settings.on(k, () => this.apply())),
      settings.on('hosts', () => this.renderBar()),
    ];
    this.sizeInput.value = settings.get('files.iconSize');
    this.bind();
    this.ro = new ResizeObserver(() => this.layoutChanged());
    this.ro.observe(this.scroller);
  }

  dispose() {
    this.subs.forEach(f => f());
    this.ro.disconnect();
    this.ql.close();
    this.thumbs.dispose();
  }

  get mode() { return settings.get('files.folderView') === 'list' ? 'list' : 'icons'; }
  get conn() { return this.ws.conn(this.loc.host); }

  focus() { this.scroller.focus({ preventScroll: true }); }

  // --- where we are ----------------------------------------------------------------------------------
  /** Go to `path` on `host` (select: names to select once it's listed). */
  async go(host, path, { push = true, select = null, keepScroll = false } = {}) {
    const conn = this.ws.conn(host);
    if (conn.state !== 'ok') {
      try { if ((await conn.ensure(true)) == null) return; } catch (e) { toastError(`Couldn’t connect to ${host}`, e); return; }
    }
    path = untildify(path || conn.home, conn.home);
    if (push && this.loc && !(this.loc.host === host && this.loc.path === path)) {
      this.history.push({ ...this.loc, top: this.scroller.scrollTop });
      if (this.history.length > 100) this.history.shift();
      this.forward = [];
    }
    const same = this.loc && this.loc.host === host && this.loc.path === path;
    this.loc = { host, path };
    if (!same) {
      this.thumbs.reset();
      this.sel = new Set(select || []);
      this.focusName = select && select.length ? select[0] : null;
      this.anchor = this.focusName;
      this.filter = '';
      this.filterInput.value = '';
      this.all = [];
      this.entries = [];
      this.clearItems();
      if (!keepScroll) this.scroller.scrollTop = 0;
    }
    this.renderBar();
    await this.load({ select });
    this.ws.onFolderChanged(this.loc);
  }

  async load({ bg = false, select = null } = {}) {
    const { host, path } = this.loc;
    const want = this.loc;
    if (!bg) { this.state = 'loading'; this.showMsg(); if (!this.all.length) this.renderStatus(); }
    try {
      const r = await this.ws.conn(host).call('/api/ls', { query: bg ? { path, bg: '1' } : { path } });
      if (this.loc !== want) return;
      if (r.path !== path) this.loc = { host, path: r.path };
      this.all = r.entries;
      this.state = 'ok';
      this.error = '';
    } catch (e) {
      if (this.loc !== want) return;
      if (bg && this.state === 'ok') return;
      this.state = 'error';
      this.error = e.message;
      this.all = [];
    }
    if (select) { this.sel = new Set(select); this.focusName = select[0] || null; this.anchor = this.focusName; }
    this.apply();
    if (select && select.length) this.scrollToName(select[0]);
    this.renderBar();
  }

  /** Something changed in `dir` on `host` (a copy landed, a rename…). */
  refreshDir(host, dir) {
    if (this.loc && this.loc.host === host && this.loc.path === dir) this.load({ bg: true });
  }

  refresh(opts = {}) { if (this.loc) return this.load(opts); }

  back() {
    const prev = this.history.pop();
    if (!prev) return;
    this.forward.push({ ...this.loc, top: this.scroller.scrollTop });
    this.go(prev.host, prev.path, { push: false }).then(() => { this.scroller.scrollTop = prev.top || 0; this.paint(); });
  }

  fwd() {
    const next = this.forward.pop();
    if (!next) return;
    this.history.push({ ...this.loc, top: this.scroller.scrollTop });
    this.go(next.host, next.path, { push: false }).then(() => { this.scroller.scrollTop = next.top || 0; this.paint(); });
  }

  up() {
    if (!this.loc || this.loc.path === '/') return;
    const from = basename(this.loc.path);
    this.go(this.loc.host, dirname(this.loc.path), { select: [from] });
  }

  /** Show the folder `path` is in, with it selected. */
  reveal(host, path) { return this.go(host, dirname(path), { select: [basename(path)] }); }

  // --- what's shown -----------------------------------------------------------------------------------
  /** Filter and sort the listing, keep the selection to what still exists, redraw. */
  apply() {
    const hidden = settings.get('files.hidden');
    const ex = this.ws.explorer.exclude;
    const f = this.filter.toLowerCase();
    let list = this.all.filter(e => (hidden || !e.name.startsWith('.')) && !(ex && ex.test(e.name)) && (!f || e.name.toLowerCase().includes(f)));
    const { key, dir } = this.sort;
    const foldersFirst = settings.get('files.foldersFirst');
    const cmp = {
      name: (a, b) => byName(a.name, b.name),
      mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0) || byName(a.name, b.name),
      size: (a, b) => (isDirType(a.type) ? -1 : a.size || 0) - (isDirType(b.type) ? -1 : b.size || 0) || byName(a.name, b.name),
      kind: (a, b) => kindOf(a).localeCompare(kindOf(b)) || byName(a.name, b.name),
    }[key] || ((a, b) => byName(a.name, b.name));
    list = list.sort((a, b) => (foldersFirst ? isDirType(b.type) - isDirType(a.type) : 0) || cmp(a, b) * dir);
    this.entries = list;
    this.index = new Map(list.map((e, i) => [e.name, i]));
    for (const n of [...this.sel]) if (!this.index.has(n)) this.sel.delete(n);
    if (this.focusName && !this.index.has(this.focusName)) this.focusName = null;
    this.layoutChanged();
    this.showMsg();
    this.renderStatus();
  }

  showMsg() {
    const m = this.msg;
    if (this.state === 'loading' && !this.all.length) { m.innerHTML = spinner(20); m.hidden = false; return; }
    if (this.state === 'error') {
      m.innerHTML = `<div class="note"><div class="big">${icons.warning}</div><h3>Couldn’t open this folder</h3><div>${esc(this.error)}</div><div class="btns"><button class="btn" data-a="retry">Try Again</button><button class="btn" data-a="up">Enclosing Folder</button></div></div>`;
      m.hidden = false;
      return;
    }
    if (this.state === 'ok' && !this.entries.length) {
      m.innerHTML = `<div class="fv-empty">${this.filter ? `Nothing here matches “${esc(this.filter)}”` : this.all.length ? 'Only hidden files here' : 'This folder is empty'}</div>`;
      m.hidden = false;
      return;
    }
    m.hidden = true;
  }

  renderBar() {
    const bar = this.el.querySelector('.fv-bar');
    const loc = this.loc;
    const home = loc ? this.ws.conn(loc.host).home : null;
    bar.querySelector('.nm').textContent = !loc ? '' : loc.path === '/' ? '/' : loc.path === home ? '~' : basename(loc.path);
    const hostEl = bar.querySelector('.fv-host');
    const multi = loc && this.ws.multiHost();
    hostEl.hidden = !multi;
    if (multi) { hostEl.textContent = hostLabel(loc.host); hostEl.style.setProperty('--hc', `var(--${hostColor(loc.host)})`); }
    bar.querySelector('[data-a=back]').disabled = !this.history.length;
    bar.querySelector('[data-a=fwd]').disabled = !this.forward.length;
    bar.querySelector('.fv-loc-ic').innerHTML = loc && loc.path === home ? icons.home : loc && loc.path === '/' ? icons.server : icons.folderLine;
    for (const b of bar.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === this.mode);
    this.el.querySelector('.fv-path').innerHTML = loc ? `<bdi>${esc(tildify(loc.path, home))}</bdi>` : '';
    this.el.querySelector('.fv-path').title = loc ? `${hostLabel(loc.host)}:${loc.path}` : '';
    bar.querySelector('.side-toggle').hidden = this.ws.layout.side;
    this.head.hidden = this.mode !== 'list';
    for (const b of this.head.querySelectorAll('[data-sort]')) {
      const on = b.dataset.sort === this.sort.key;
      b.classList.toggle('on', on);
      b.querySelector('.arrow').textContent = on ? (this.sort.dir > 0 ? '▲' : '▼') : '';
    }
    this.el.querySelector('.fv-size').hidden = this.mode !== 'icons';
  }

  renderStatus() {
    const count = this.el.querySelector('.fv-count');
    if (this.state !== 'ok') { count.textContent = ''; return; }
    const n = this.entries.length;
    const s = this.sel.size;
    const bytes = [...this.sel].reduce((a, name) => { const e = this.entry(name); return a + (e && !isDirType(e.type) ? e.size || 0 : 0); }, 0);
    count.textContent = `${n} item${n === 1 ? '' : 's'}${s ? ` · ${s} selected${bytes ? ` (${fmtSize(bytes)})` : ''}` : ''}`;
  }

  // --- layout and drawing (only what's on screen) ------------------------------------------------------
  geometry() {
    const w = this.scroller.clientWidth;
    if (this.mode === 'list') {
      const rh = { compact: 24, roomy: 32 }[settings.get('files.density')] || 28;
      return { list: true, cols: 1, cw: w, rh, pad: 4, top: 4 };
    }
    const icon = settings.get('files.iconSize');
    const tw = Math.max(92, icon + 44), th = icon + 50;
    const pad = 14;
    const cols = Math.max(1, Math.floor((w - pad * 2) / tw));
    return { list: false, cols, cw: (w - pad * 2) / cols, rh: th, pad, top: 12, icon };
  }

  layoutChanged() {
    this.geo = this.geometry();
    const rows = Math.ceil(this.entries.length / this.geo.cols);
    this.canvas.style.height = `${rows * this.geo.rh + this.geo.top * 2}px`;
    this.canvas.classList.toggle('list', this.geo.list);
    this.el.classList.toggle('list', this.geo.list);
    const w = this.scroller.clientWidth;
    this.el.classList.toggle('fv-narrow', w < 640);
    this.el.classList.toggle('fv-tiny', w < 460);
    this.el.style.setProperty('--fv-icon', `${this.geo.icon || 64}px`);
    this.el.style.setProperty('--fv-rh', `${this.geo.list ? this.geo.rh - 2 : 28}px`);
    this.el.style.setProperty('--fv-sb', `${this.scroller.offsetWidth - this.scroller.clientWidth}px`);
    this.renderBar();
    this.paint();
  }

  clearItems() {
    for (const el of this.items.values()) el.remove();
    this.items.clear();
  }

  rect(i) {
    const g = this.geo;
    const r = Math.floor(i / g.cols), c = i % g.cols;
    return { x: g.pad + c * g.cw, y: g.top + r * g.rh, w: g.cw, h: g.rh };
  }

  /** Draw the items in (and near) view; drop the rest. */
  paint(force = false) {
    if (!this.geo) return;
    const g = this.geo;
    const top = this.scroller.scrollTop, height = this.scroller.clientHeight || 600;
    const r0 = Math.max(0, Math.floor((top - g.top) / g.rh) - 2);
    const r1 = Math.ceil((top + height - g.top) / g.rh) + 2;
    const from = r0 * g.cols, to = Math.min(this.entries.length, r1 * g.cols);
    const keep = new Set();
    for (let i = from; i < to; i++) {
      const e = this.entries[i];
      keep.add(e.name);
      let el = this.items.get(e.name);
      const sig = `${e.type}|${e.size}|${e.mtime}|${g.list}|${g.icon}`;
      if (!el || el.sig !== sig || force) {
        const fresh = this.itemEl(e);
        fresh.sig = sig;
        if (el) el.replaceWith(fresh); else this.canvas.appendChild(fresh);
        el = fresh;
        this.items.set(e.name, el);
      }
      const r = this.rect(i);
      el.style.transform = `translate(${r.x.toFixed(1)}px, ${r.y}px)`;
      el.style.width = `${g.list ? g.cw - g.pad * 2 : r.w}px`;
      el.dataset.i = i;
      el.classList.toggle('odd', g.list && i % 2 === 1);
      this.decorate(el, e.name);
    }
    for (const [name, el] of this.items) if (!keep.has(name)) { el.remove(); this.items.delete(name); }
  }

  decorate(el, name) {
    el.classList.toggle('sel', this.sel.has(name));
    el.classList.toggle('focus', this.focusName === name);
    const clip = this.ws.explorer.clip;
    el.classList.toggle('cut', !!clip && clip.mode === 'cut' && clip.items.some(i => i.host === this.loc.host && i.path === join(this.loc.path, name)));
    el.setAttribute('aria-selected', String(this.sel.has(name)));
  }

  /** Repaint selection marks on what's drawn (cheap). */
  marks() {
    for (const [name, el] of this.items) this.decorate(el, name);
    this.renderStatus();
  }

  itemEl(e) {
    const dir = isDirType(e.type);
    const el = document.createElement('div');
    el.className = `fv-item${dir ? ' dir' : ''}${this.geo.list ? ' row' : ''}${e.name.startsWith('.') ? ' hidden-file' : ''}`;
    el.draggable = true;
    el.setAttribute('role', 'gridcell');
    el.dataset.name = e.name;
    const path = join(this.loc.path, e.name);
    if (this.geo.list) {
      el.innerHTML = `<span class="fv-ic">${dir ? folderIcon() : fileIcon(e.name)}</span><span class="fv-nm"></span>
        <span class="fv-date">${esc(fmtDate(e.mtime))}</span><span class="fv-sz">${dir ? '—' : esc(fmtSize(e.size))}</span><span class="fv-kind">${esc(kindOf(e))}</span>`;
    } else {
      let icon = dir ? bigFolder(e.type === 'linkdir') : bigDoc(e.name);
      if (!dir && settings.get('files.thumbnails') && isImage(e.name) && (e.size || 0) <= THUMB_MAX) {
        const px = Math.round(this.geo.icon * Math.min(2, devicePixelRatio || 1));
        const url = this.thumbs.get(this.loc.host, path, e, px, u => {
          const live = this.items.get(e.name);
          if (live) { const box = live.querySelector('.fv-iconbox'); if (box) box.innerHTML = `<img class="fv-thumb" alt="" src="${u}">`; }
        });
        if (url) icon = `<img class="fv-thumb" alt="" src="${url}">`;
      }
      el.innerHTML = `<div class="fv-iconbox">${icon}</div><div class="fv-nm"></div>`;
    }
    el.querySelector('.fv-nm').textContent = e.name;
    el.title = e.type === 'link' || e.type === 'linkdir' ? `${e.name} → ${e.target || ''}` : e.name;
    return el;
  }

  scrollToName(name) {
    const i = this.index ? this.index.get(name) : undefined;
    if (i == null || !this.geo) return;
    const r = this.rect(i);
    const s = this.scroller;
    if (r.y < s.scrollTop) s.scrollTop = r.y - this.geo.top;
    else if (r.y + r.h > s.scrollTop + s.clientHeight) s.scrollTop = r.y + r.h - s.clientHeight + this.geo.top;
    this.paint();
  }

  // --- selection --------------------------------------------------------------------------------------
  entry(name) { const i = this.index && this.index.get(name); return i == null ? null : this.entries[i]; }

  itemOf(name) {
    const e = this.entry(name);
    return e && { host: this.loc.host, path: join(this.loc.path, name), isDir: isDirType(e.type), name, e, sec: null };
  }

  selected() { return this.entries.filter(e => this.sel.has(e.name)).map(e => this.itemOf(e.name)); }

  selectOnly(name) {
    this.sel = new Set(name ? [name] : []);
    this.focusName = this.anchor = name;
    this.marks();
  }

  /** Move the focus to item i (extend: from the anchor, like Shift). */
  focusAt(i, extend = false) {
    if (!this.entries.length) return;
    i = Math.max(0, Math.min(this.entries.length - 1, i));
    const name = this.entries[i].name;
    if (extend && this.anchor && this.index.has(this.anchor)) {
      const a = this.index.get(this.anchor);
      this.sel = new Set(this.entries.slice(Math.min(a, i), Math.max(a, i) + 1).map(e => e.name));
    } else {
      this.sel = new Set([name]);
      this.anchor = name;
    }
    this.focusName = name;
    this.scrollToName(name);
    this.marks();
    if (this.ql.isOpen) this.ql.show(name);
  }

  // --- opening -----------------------------------------------------------------------------------------
  /** Folders open in place; files open in Quick Look (the editor is a click away there). */
  open(name, { editor = false } = {}) {
    const it = this.itemOf(name);
    if (!it) return;
    if (it.isDir) { this.go(it.host, it.path); return; }
    if (editor) { this.openInEditor(it); return; }
    this.ql.open(name);
  }

  openInEditor(it, opts = {}) {
    this.ql.close();
    this.ws.editor.open(it.path, { host: it.host, preview: false, ...opts });
  }

  // --- operations ---------------------------------------------------------------------------------------
  target() { return { host: this.loc.host, dir: this.loc.path, sec: { root: { host: this.loc.host, path: this.loc.path, id: '' } } }; }

  async newEntry(isDir) {
    if (!this.loc) return;
    const base = isDir ? 'untitled folder' : 'untitled.txt';
    const names = new Set(this.all.map(e => e.name));
    let name = base;
    for (let n = 2; names.has(name); n++) name = isDir ? `${base} ${n}` : `untitled ${n}.txt`;
    try {
      await this.conn.call('/api/create', { body: { path: join(this.loc.path, name), dir: isDir } });
    } catch (e) {
      toastError(`Couldn’t create “${name}”`, e);
      return;
    }
    this.ws.explorer.refreshDir(this.loc.host, this.loc.path);
    await this.load({ select: [name] });
    this.rename(name);
  }

  /** Rename in place: the name turns into a field (Enter keeps it, Esc puts it back). */
  rename(name) {
    const e = this.entry(name);
    if (!e) return;
    this.scrollToName(name);
    const el = this.items.get(name);
    const nm = el && el.querySelector('.fv-nm');
    if (!nm) return;
    const input = document.createElement('input');
    input.className = 'fv-rename';
    input.value = name;
    input.spellcheck = false;
    nm.replaceChildren(input);
    el.draggable = false;
    const dot = !isDirType(e.type) ? name.lastIndexOf('.') : -1;
    input.focus();
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
    let done = false;
    const finish = async keep => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (!keep || !value || value === name) { this.paint(true); this.focus(); return; }
      const err = value.includes('/') ? 'Names can’t contain “/”.' : value === '.' || value === '..' ? '“.” and “..” aren’t valid names.'
        : this.all.some(x => x.name === value) ? `“${value}” already exists here.` : null;
      if (err) { toastError(`Couldn’t rename “${name}”`, new Error(err)); this.paint(true); this.focus(); return; }
      const src = join(this.loc.path, name), dst = join(this.loc.path, value);
      try {
        await this.conn.call('/api/rename', { body: { src, dst } });
      } catch (ex) {
        toastError(`Couldn’t rename “${name}”`, ex);
        this.paint(true);
        return;
      }
      this.ws.onMoved(this.loc.host, src, dst);
      this.ws.explorer.refreshDir(this.loc.host, this.loc.path);
      await this.load({ select: [value] });
      this.focus();
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    for (const ev of ['click', 'dblclick', 'pointerdown']) input.addEventListener(ev, x => x.stopPropagation());
  }

  remove(items = this.selected()) { if (items.length) this.ws.explorer.remove(items); }

  duplicate(item) { return this.ws.explorer.transfer([item], this.target(), 'copy'); }

  copy(mode, items = this.selected()) {
    if (!items.length) return;
    this.ws.explorer.setClip(mode, items);
    this.marks();
  }

  paste(into = null) {
    const ex = this.ws.explorer;
    if (!ex.clip || !this.loc) return;
    const { mode, items } = ex.clip;
    if (mode === 'cut') ex.clip = null;
    const t = into ? { ...this.target(), dir: into } : this.target();
    ex.transfer(items, t, mode === 'cut' ? 'move' : 'copy').then(() => { ex.render(); this.marks(); });
  }

  download(items = this.selected()) { if (items.length) this.ws.explorer.download(items); }

  pickUpload(folder = false) {
    if (this.loc) this.el.querySelector(`input[data-up="${folder ? 'dir' : 'files'}"]`).click();
  }

  terminalHere(dir = this.loc && this.loc.path) {
    if (!dir) return;
    this.ws.terminal.newTerminal({ host: this.loc.host, cwd: dir });
  }

  async info(item) {
    const e = item.e;
    const perm = e.perm != null ? e.perm & 0o7777 : null;
    const rwx = perm == null ? '' : [6, 3, 0].map(s => ['r', 'w', 'x'].map((c, i) => (perm >> (s + 2 - i)) & 1 ? c : '-').join('')).join('');
    const rows = [
      ['Kind', kindOf(e)],
      ...(item.isDir ? [] : [['Size', `${fmtSize(e.size)}${e.size >= 1000 ? ` (${(e.size || 0).toLocaleString()} bytes)` : ''}`]]),
      ['Where', `${hostLabel(item.host)}:${dirname(item.path)}`],
      ['Modified', e.mtime ? new Date(e.mtime * 1000).toLocaleString() : '—'],
      ...(perm != null ? [['Permissions', `${rwx}  (${perm.toString(8).padStart(3, '0')})`]] : []),
      ...(e.target ? [['Points to', e.target]] : []),
    ];
    const w = Math.max(...rows.map(r => r[0].length));
    await dialog({ icon: 'info', title: item.name, detail: rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n'), wide: true, buttons: [{ label: 'Done', value: true, kind: 'primary' }] });
  }

  // --- menus ---------------------------------------------------------------------------------------------
  itemMenu(x, y) {
    const items = this.selected();
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    const ex = this.ws.explorer;
    const others = this.ws.roots.filter(r => !(r.host === this.loc.host && r.path === this.loc.path));
    const label = r => `${this.ws.multiHost() ? hostLabel(r.host) + ' · ' : ''}${tildify(r.path, this.ws.conn(r.host).home)}`;
    contextMenu(x, y, [
      ...(one && one.isDir ? [
        { label: 'Open', icon: 'folderOpen', action: () => this.open(one.name) },
        { label: 'Add to Sidebar', icon: 'newFolder', action: () => this.ws.addRoot(one.host, one.path) },
      ] : []),
      ...(one && !one.isDir ? [
        { label: 'Quick Look', icon: 'eye', keys: 'Space', action: () => this.ql.open(one.name) },
        { label: 'Open in Editor', icon: 'code', keys: 'Mod+Enter', action: () => this.openInEditor(one) },
        ...(mediaKind(one.name) ? [{ label: 'Open as Text', action: () => this.openInEditor(one, { asText: 'lossy' }) }] : []),
      ] : []),
      ...(one ? ['-'] : []),
      { label: 'Open in Terminal', icon: 'terminal', action: () => this.terminalHere(one && one.isDir ? one.path : this.loc.path) },
      '-',
      { label: 'Cut', icon: 'scissors', keys: 'Mod+X', action: () => this.copy('cut', items) },
      { label: 'Copy', icon: 'copy', keys: 'Mod+C', action: () => this.copy('copy', items) },
      { label: one && one.isDir ? 'Paste into Folder' : 'Paste', icon: 'clipboard', keys: 'Mod+V', disabled: !ex.clip, action: () => this.paste(one && one.isDir ? one.path : null) },
      ...(one ? [{ label: 'Duplicate', action: () => this.duplicate(one) }] : []),
      ...(others.length ? [{ header: 'Copy To' }, ...others.slice(0, 6).map(r => ({ label: label(r), icon: 'arrowRight', action: () => ex.transfer(items, { host: r.host, dir: r.path, sec: { root: r } }, 'copy') }))] : []),
      '-',
      { label: 'Copy Path', action: () => copyText(items.map(i => i.path).join('\n')) },
      { label: items.length > 1 ? `Download ${items.length} Items` : one.isDir ? 'Download as .tar.gz' : 'Download', icon: 'download', action: () => this.download(items) },
      '-',
      ...(one ? [
        { label: 'Get Info', icon: 'info', action: () => this.info(one) },
        { label: 'Rename…', icon: 'pencil', keys: 'F2', action: () => this.rename(one.name) },
      ] : []),
      { label: items.length > 1 ? `Delete ${items.length} Items` : 'Delete', icon: 'trash', keys: isMac ? 'Mod+Backspace' : 'Delete', danger: true, action: () => this.remove(items) },
    ]);
  }

  folderMenu(x, y) {
    const ex = this.ws.explorer;
    const check = on => (on ? 'check' : undefined);
    const sortBy = k => ({ label: { name: 'Name', mtime: 'Date Modified', size: 'Size', kind: 'Kind' }[k], icon: check(this.sort.key === k), action: () => this.setSort(k) });
    contextMenu(x, y, [
      { label: 'New Folder', icon: 'newFolder', action: () => this.newEntry(true) },
      { label: 'New File', icon: 'newFile', action: () => this.newEntry(false) },
      '-',
      { label: 'Upload Files…', icon: 'upload', action: () => this.pickUpload() },
      { label: 'Upload Folder…', icon: 'upload', action: () => this.pickUpload(true) },
      { label: 'Paste', icon: 'clipboard', keys: 'Mod+V', disabled: !ex.clip, action: () => this.paste() },
      '-',
      { label: 'Open in Terminal', icon: 'terminal', action: () => this.terminalHere() },
      { label: 'Add to Sidebar', icon: 'newFolder', action: () => this.ws.addRoot(this.loc.host, this.loc.path) },
      { label: 'Go to Folder…', icon: 'folderOpen', keys: this.ws.keysFor('file.openFolder'), action: () => this.goToFolder() },
      '-',
      { label: 'as Icons', icon: check(this.mode === 'icons'), action: () => settings.set('files.folderView', 'icons') },
      { label: 'as List', icon: check(this.mode === 'list'), action: () => settings.set('files.folderView', 'list') },
      { header: 'Sort By' },
      sortBy('name'), sortBy('mtime'), sortBy('size'), sortBy('kind'),
      '-',
      { label: settings.get('files.hidden') ? 'Hide Hidden Files' : 'Show Hidden Files', icon: 'eye', keys: 'Mod+Shift+.', action: () => settings.set('files.hidden', !settings.get('files.hidden')) },
      { label: 'Refresh', icon: 'refresh', action: () => this.refresh() },
    ]);
  }

  /** Finder's path menu: the folders above this one, home, the sidebar's folders, recents. */
  locationMenu(x, y) {
    const { host, path } = this.loc;
    const home = this.ws.conn(host).home;
    const chain = [];
    for (let p = path; ; p = dirname(p)) { chain.push(p); if (p === '/') break; }
    const shown = new Set(chain);
    const icon = p => (p === '/' ? 'server' : p === home ? 'home' : 'folderLine');
    const roots = this.ws.roots.filter(r => !(r.host === host && shown.has(r.path)));
    const recent = this.ws.recentFolders(host).filter(p => !shown.has(p) && p !== home).slice(0, 5);
    const multi = this.ws.multiHost();
    contextMenu(x, y, [
      ...chain.map(p => ({ label: p === '/' ? '/' : basename(p), icon: icon(p), current: p === path, action: () => this.go(host, p) })),
      '-',
      ...(shown.has(home) ? [] : [{ label: 'Home', icon: 'home', action: () => this.go(host, home) }]),
      ...(roots.length ? [{ header: 'Sidebar' }, ...roots.map(r => ({ label: `${multi ? hostLabel(r.host) + ' · ' : ''}${tildify(r.path, this.ws.conn(r.host).home)}`, icon: 'folderLine', action: () => this.go(r.host, r.path) }))] : []),
      ...(recent.length ? [{ header: 'Recent Folders' }, ...recent.map(p => ({ label: tildify(p, home), icon: 'clock', action: () => this.go(host, p) }))] : []),
      '-',
      { label: 'Go to Folder…', icon: 'folderOpen', keys: this.ws.keysFor('file.openFolder'), action: () => this.goToFolder() },
    ]);
  }

  goToFolder() {
    if (!this.loc) return;
    this.ws.palette.openFolder({ host: this.loc.host, path: this.loc.path, id: '' }, { pick: (host, p) => this.go(host, p) });
  }

  setSort(key) {
    this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: key === 'mtime' || key === 'size' ? -1 : 1 };
    store.set('folders.sort', this.sort);
    this.apply();
  }

  // --- events ---------------------------------------------------------------------------------------------
  bind() {
    const s = this.scroller;
    s.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; this.paint(); });
    }, { passive: true });
    this.el.querySelector('.fv-bar').addEventListener('click', e => {
      const b = e.target.closest('[data-a], [data-mode]');
      if (!b) return;
      if (b.dataset.mode) { settings.set('files.folderView', b.dataset.mode); return; }
      const r = b.getBoundingClientRect();
      switch (b.dataset.a) {
        case 'sidebar': this.ws.run('view.sidebar'); break;
        case 'back': this.back(); break;
        case 'fwd': this.fwd(); break;
        case 'loc': this.locationMenu(r.left, r.bottom + 6); break;
        case 'newFolder': this.newEntry(true); break;
        case 'upload': this.pickUpload(); break;
        case 'terminal': this.terminalHere(); break;
        case 'more': this.folderMenu(r.right - 230, r.bottom + 6); break;
        case 'ide': this.ws.setMode('ide'); break;
      }
    });
    this.head.addEventListener('click', e => { const b = e.target.closest('[data-sort]'); if (b) this.setSort(b.dataset.sort); });
    this.msg.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (b && b.dataset.a === 'retry') this.refresh();
      else if (b && b.dataset.a === 'up') this.up();
    });
    this.filterInput.addEventListener('input', () => { this.filter = this.filterInput.value; this.apply(); });
    this.filterInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.filterInput.value = ''; this.filter = ''; this.apply(); this.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.focus(); if (this.entries.length) this.focusAt(0); }
    });
    this.sizeInput.addEventListener('input', () => settings.set('files.iconSize', +this.sizeInput.value));
    for (const input of this.el.querySelectorAll('input[type=file]')) {
      input.addEventListener('change', () => {
        const entries = [...input.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
        input.value = '';
        if (this.loc && entries.length) this.ws.transfers.upload(this.loc.host, this.loc.path, entries);
      });
    }

    // Clicks, double-clicks and the rubber band.
    s.addEventListener('pointerdown', e => this.onPointerDown(e));
    s.addEventListener('dblclick', e => {
      const it = e.target.closest('.fv-item');
      if (it) this.open(it.dataset.name, { editor: e.altKey });
    });
    s.addEventListener('contextmenu', e => {
      e.preventDefault();
      const it = e.target.closest('.fv-item');
      if (it) {
        if (!this.sel.has(it.dataset.name)) this.selectOnly(it.dataset.name);
        this.itemMenu(e.clientX, e.clientY);
      } else {
        this.selectOnly(null);
        this.folderMenu(e.clientX, e.clientY);
      }
    });
    s.addEventListener('keydown', e => this.onKey(e));
    this.bindDrag();
  }

  onPointerDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.target.closest('input')) return;
    this.focus();
    const it = e.target.closest('.fv-item');
    const multi = isMac ? e.metaKey : e.ctrlKey;
    if (it) {
      const name = it.dataset.name;
      if (e.button === 2) return;
      if (e.shiftKey && this.anchor && this.index.has(this.anchor)) {
        const a = this.index.get(this.anchor), b = this.index.get(name);
        this.sel = new Set(this.entries.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.name));
        this.focusName = name;
      } else if (multi) {
        if (this.sel.has(name)) this.sel.delete(name); else this.sel.add(name);
        this.focusName = this.anchor = name;
      } else if (!this.sel.has(name)) {
        this.sel = new Set([name]);
        this.focusName = this.anchor = name;
      } else {
        this.focusName = name;
        // A plain click on one of several selected keeps them (to drag); on release it narrows.
        const narrow = () => { if (this.sel.size > 1 && !this.dragged) this.selectOnly(name); };
        this.dragged = false;
        it.addEventListener('pointerup', narrow, { once: true });
      }
      this.marks();
      if (this.ql.isOpen) this.ql.show(name);
      return;
    }
    if (e.button !== 0 || e.target.closest('.fv-msg')) return;
    // Empty space: a rubber band selects what it touches.
    const base = multi || e.shiftKey ? new Set(this.sel) : new Set();
    if (!multi && !e.shiftKey) this.selectOnly(null);
    const box = this.canvas.getBoundingClientRect();
    const x0 = e.clientX - box.left, y0 = e.clientY - box.top;
    const s = this.scroller;
    s.setPointerCapture(e.pointerId);
    let moved = false;
    const move = ev => {
      const b = this.canvas.getBoundingClientRect();
      const x1 = ev.clientX - b.left, y1 = ev.clientY - b.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      moved = true;
      const r = { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
      Object.assign(this.band.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
      this.band.hidden = false;
      this.sel = new Set(base);
      for (const i of this.hits(r)) this.sel.add(this.entries[i].name);
      this.marks();
      // Scroll when the band reaches the edge.
      const sr = s.getBoundingClientRect();
      if (ev.clientY > sr.bottom - 24) s.scrollTop += 18;
      else if (ev.clientY < sr.top + 24) s.scrollTop -= 18;
    };
    const up = () => {
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', up);
      s.removeEventListener('pointercancel', up);
      this.band.hidden = true;
      if (moved && this.sel.size) {
        const first = this.entries.find(x => this.sel.has(x.name));
        this.focusName = this.anchor = first ? first.name : null;
        this.marks();
      }
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
  }

  /** Items whose box meets the rectangle r (canvas coordinates), from the layout alone. */
  hits(r) {
    const g = this.geo, out = [];
    const row0 = Math.max(0, Math.floor((r.t - g.top) / g.rh)), row1 = Math.floor((r.b - g.top) / g.rh);
    for (let row = row0; row <= row1; row++) {
      for (let c = 0; c < g.cols; c++) {
        const i = row * g.cols + c;
        if (i >= this.entries.length) break;
        const b = this.rect(i);
        // Icons: only the icon and name count, not the gaps around them.
        const inset = g.list ? 0 : Math.max(0, (b.w - (g.icon + 30)) / 2);
        if (b.x + inset < r.r && b.x + b.w - inset > r.l && b.y < r.b && b.y + b.h > r.t) out.push(i);
      }
    }
    return out;
  }

  onKey(e) {
    if (e.target !== this.scroller) return;
    const k = keyName(e);
    const n = this.entries.length;
    const i = this.focusName && this.index.has(this.focusName) ? this.index.get(this.focusName) : -1;
    const cols = this.geo ? this.geo.cols : 1;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const sel = this.selected();
    switch (k) {
      case 'ArrowRight': if (this.mode === 'icons') { handled(); this.focusAt(i < 0 ? 0 : i + 1); } return;
      case 'ArrowLeft': if (this.mode === 'icons') { handled(); this.focusAt(i < 0 ? 0 : i - 1); } return;
      case 'ArrowDown': handled(); this.focusAt(i < 0 ? 0 : i + cols); return;
      case 'ArrowUp': handled(); this.focusAt(i < 0 ? n - 1 : i - cols); return;
      case 'Shift+ArrowRight': if (this.mode === 'icons') { handled(); this.focusAt(i + 1, true); } return;
      case 'Shift+ArrowLeft': if (this.mode === 'icons') { handled(); this.focusAt(i - 1, true); } return;
      case 'Shift+ArrowDown': handled(); this.focusAt(i + cols, true); return;
      case 'Shift+ArrowUp': handled(); this.focusAt(i - cols, true); return;
      case 'Home': handled(); this.focusAt(0); return;
      case 'End': handled(); this.focusAt(n - 1); return;
      case 'PageDown': handled(); this.focusAt(i + cols * Math.max(1, Math.floor(this.scroller.clientHeight / this.geo.rh) - 1)); return;
      case 'PageUp': handled(); this.focusAt(i - cols * Math.max(1, Math.floor(this.scroller.clientHeight / this.geo.rh) - 1)); return;
      case 'Mod+A': handled(); this.sel = new Set(this.entries.map(x => x.name)); this.marks(); return;
      case 'Enter': case 'Mod+ArrowDown': if (this.focusName) { handled(); this.open(this.focusName); } return;
      case 'Mod+Enter': if (sel.length === 1 && !sel[0].isDir) { handled(); this.openInEditor(sel[0]); } return;
      case 'Space': if (this.focusName) { handled(); if (this.ql.isOpen) this.ql.close(); else this.ql.open(this.focusName); } return;
      case 'Backspace': case 'Mod+ArrowUp': case 'Alt+ArrowUp': handled(); this.up(); return;
      case 'Mod+[': case 'Alt+ArrowLeft': handled(); this.back(); return;
      case 'Mod+]': case 'Alt+ArrowRight': handled(); this.fwd(); return;
      case 'F2': if (sel.length === 1) { handled(); this.rename(sel[0].name); } return;
      case 'Delete': case 'Mod+Backspace': if (sel.length) { handled(); this.remove(sel); } return;
      case 'Mod+C': if (sel.length) { handled(); this.copy('copy', sel); } return;
      case 'Mod+X': if (sel.length) { handled(); this.copy('cut', sel); } return;
      case 'Mod+V': if (this.ws.explorer.clip) { handled(); this.paste(); } return;
      case 'Mod+F': handled(); this.filterInput.focus(); this.filterInput.select(); return;
      case 'Mod+Shift+.': handled(); settings.set('files.hidden', !settings.get('files.hidden')); return;
      case 'Escape':
        if (this.ws.explorer.clip) { handled(); this.ws.explorer.clip = null; this.ws.explorer.render(); this.marks(); }
        else if (this.sel.size) { handled(); this.selectOnly(null); }
        return;
      default:
        // Type to jump, like Finder.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && n) {
          const now = Date.now();
          this.typeahead.text = (now - this.typeahead.at < 800 ? this.typeahead.text : '') + e.key.toLowerCase();
          this.typeahead.at = now;
          const t = this.typeahead.text;
          const start = t.length === 1 ? i + 1 : Math.max(0, i);
          const order = [...this.entries.slice(start), ...this.entries.slice(0, start)];
          const hit = order.find(x => x.name.toLowerCase().startsWith(t));
          if (hit) { handled(); this.focusAt(this.index.get(hit.name)); }
        }
    }
  }

  // --- drag and drop: with the sidebar, between servers, from and to the desktop ----------------------------
  bindDrag() {
    const s = this.scroller;
    const ex = this.ws.explorer;
    s.addEventListener('dragstart', e => {
      const it = e.target.closest('.fv-item');
      if (!it) return;
      this.dragged = true;
      const name = it.dataset.name;
      if (!this.sel.has(name)) this.selectOnly(name);
      const items = this.selected();
      ex.dragging = { items };
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ws: this.ws.id, items: items.map(i => ({ host: i.host, path: i.path, isDir: i.isDir })) }));
      e.dataTransfer.setData('text/plain', items.map(i => i.path).join('\n'));
      if (items.length === 1 && !items[0].isDir) {
        e.dataTransfer.setData('DownloadURL', `application/octet-stream:${items[0].name}:${location.origin}${fileUrl(items[0].host, items[0].path)}`);
      }
      e.dataTransfer.effectAllowed = 'copyMove';
      // A drag image that says how many.
      if (items.length > 1) {
        const ghost = h(`<div class="fv-ghost">${items.length} items</div>`);
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 20, 14);
        setTimeout(() => ghost.remove(), 0);
      }
    });
    s.addEventListener('dragend', () => { ex.dragging = null; this.setDrop(null); });
    s.addEventListener('dragenter', e => {
      const ty = e.dataTransfer.types;
      if (ty.includes(DRAG_TYPE) || ty.includes('Files')) e.preventDefault();
    });
    s.addEventListener('dragover', e => {
      const types = e.dataTransfer.types;
      const own = types.includes(DRAG_TYPE), files = types.includes('Files');
      if (!own && !files) return;
      e.preventDefault();
      const t = this.dropTarget(e.target);
      const effect = t ? ex.dropEffect(e, t, own) : 'none';
      e.dataTransfer.dropEffect = effect;
      this.setDrop(effect === 'none' ? null : t, effect, own);
    });
    s.addEventListener('dragleave', e => { if (!s.contains(e.relatedTarget)) this.setDrop(null); });
    s.addEventListener('drop', async e => {
      e.preventDefault();
      const t = this.dropTarget(e.target);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      const effect = t ? ex.dropEffect(e, t, !!raw) : 'none';
      this.setDrop(null);
      ex.dragging = null;
      if (!t || effect === 'none') return;
      if (raw) {
        let p;
        try { p = JSON.parse(raw); } catch { return; }
        const items = (p.items || []).map(i => ({ ...i, name: basename(i.path), sec: null }));
        ex.dropItems(items, t, effect);
        return;
      }
      const entries = await collectDrop(e.dataTransfer);
      this.ws.transfers.upload(t.host, t.dir, entries);
    });
  }

  /** Onto a folder: into it; anywhere else: into the folder shown. */
  dropTarget(el) {
    if (!this.loc || this.ws.conn(this.loc.host).state !== 'ok') return null;
    const it = el.closest && el.closest('.fv-item.dir');
    const dir = it ? join(this.loc.path, it.dataset.name) : this.loc.path;
    return { host: this.loc.host, dir, sec: { root: { host: this.loc.host, path: dir, id: '' } }, item: it ? it.dataset.name : null };
  }

  setDrop(t, effect, own) {
    const sig = t ? `${t.dir}:${effect}` : '';
    if (this.dropSig === sig) return;
    this.dropSig = sig;
    for (const el of this.canvas.querySelectorAll('.drop')) { el.classList.remove('drop'); delete el.dataset.effect; }
    this.scroller.classList.remove('drop-here');
    clearTimeout(this.springTimer);
    if (!t) return;
    const label = !own ? 'Upload' : effect === 'move' ? 'Move' : 'Copy';
    if (t.item) {
      const el = this.items.get(t.item);
      if (el) { el.classList.add('drop'); el.dataset.effect = label; }
      // Hovering a folder opens it, like Finder.
      this.springTimer = setTimeout(() => this.go(t.host, t.dir), SPRING_MS);
    } else {
      this.scroller.classList.add('drop-here');
      this.scroller.dataset.effect = label;
    }
  }
}

