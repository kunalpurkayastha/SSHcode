// Transfers: uploads from this computer, and copies and moves between
// folders and between servers (the sshcode server runs those, see
// server/jobs.py). One entry per drop, paste or upload, with progress, speed
// and cancel, listed in a Safari-style popover behind the toolbar button.
import { esc, h, basename, fmtSize, join, tildify } from './util.js';
import { icons } from './icons.js';
import { api, needsAuth, uploadFile } from './api.js';
import { dialog, popover, closePopover, toast } from './ui.js';
import { hostLabel } from './settings.js';

const ACTIVE = new Set(['queued', 'running']);
const RING = 2 * Math.PI * 13;
const isDirType = t => t === 'dir' || t === 'linkdir';

export function fmtDuration(s) {
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** “name copy.ext”, “name copy 2.ext”… (the server uses the same rule). */
export function freeName(name, taken, isDir = false) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 && !isDir ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const cand = `${stem} copy${i > 1 ? ' ' + i : ''}${ext}`;
    if (!taken.has(cand)) return cand;
  }
}

/** Finder's question when names collide. -> 'replace' | 'rename' | 'skip' | null (stop) */
export async function askConflict({ names, dir, folders = false }) {
  const one = names.length === 1;
  const where = dir === '/' ? '/' : basename(dir);
  const r = await dialog({
    icon: 'warning',
    title: one ? `“${names[0]}” already exists in “${where}”` : `${names.length} items already exist in “${where}”`,
    message: `Replace ${one ? 'it' : 'them'}, or keep both?` + (folders ? ' Replacing a folder merges the two: files with the same name are overwritten, the rest are kept.' : ''),
    buttons: [
      { label: 'Keep Both', value: 'rename', kind: 'primary' },
      { label: 'Replace', value: 'replace', kind: 'danger' },
      { label: 'Skip', value: 'skip' },
      { label: 'Stop', value: null, kind: 'cancel' },
    ],
  });
  return r ? r.value : null;
}

export class Transfers {
  constructor(ws) {
    this.ws = ws;
    this.items = [];
    this.seq = 0;
    this.pollTimer = null;
    this.pop = null;
    this.paintQueued = false;
    this.button = h(`<button class="ib tx-btn" hidden><svg class="ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="trk" cx="16" cy="16" r="13"/><circle class="val" cx="16" cy="16" r="13"/></svg>${icons.transfer}</button>`);
    this.button.title = 'Transfers';
    this.button.addEventListener('click', () => (this.pop ? closePopover() : this.open()));
  }

  // --- bookkeeping -------------------------------------------------------------------
  add(it) {
    Object.assign(it, { id: ++this.seq, started: Date.now(), done: it.done || 0, samples: [], rate: 0 });
    it.finished = new Promise(res => { it.resolve = res; });
    this.items.push(it);
    this.paint();
    return it;
  }

  progress(it) {
    const now = performance.now();
    const s = it.samples;
    if (!s.length || now - s[s.length - 1][0] > 250) {
      s.push([now, it.done]);
      while (s.length > 2 && now - s[0][0] > 4000) s.shift();
      if (s.length > 1) it.rate = (s[s.length - 1][1] - s[0][1]) / ((s[s.length - 1][0] - s[0][0]) / 1000);
    }
    this.paintSoon();
  }

  finish(it, state, extra = {}) {
    Object.assign(it, extra, { state, ended: Date.now() });
    it.cancel = null;
    const noun = it.verb === 'Uploading' ? 'Upload' : it.verb === 'Moving' ? 'Move' : 'Copy';
    if (state === 'failed') {
      toast({ kind: 'error', title: `${noun} of ${it.what} failed`, message: it.error || '', actions: [{ label: 'Show', run: () => this.open() }] });
    } else if (state === 'done' && it.kind === 'upload' && it.error) {
      toast({ kind: 'error', title: `${noun} of ${it.what}: ${it.warning}`, message: it.error, actions: [{ label: 'Show', run: () => this.open() }] });
    }
    this.paint();
    it.resolve(it);
  }

  get active() { return this.items.filter(it => ACTIVE.has(it.state)); }

  dismiss(it) {
    this.items = this.items.filter(x => x !== it);
    if (it.job) api('/api/jobs/dismiss', { body: { ids: [it.job] } }).catch(() => {});
    this.paint();
  }

  clear() {
    const gone = this.items.filter(it => !ACTIVE.has(it.state));
    this.items = this.items.filter(it => ACTIVE.has(it.state));
    const ids = gone.filter(it => it.job).map(it => it.job);
    if (ids.length) api('/api/jobs/dismiss', { body: { ids } }).catch(() => {});
    this.paint();
    if (!this.items.length) closePopover();
  }

  /** Full destination, for tooltips. */
  where(host, dir) {
    const c = this.ws.conns.get(host);
    const path = tildify(dir, c && c.home);
    return this.ws.multiHost() ? `${hostLabel(host)}:${path}` : path;
  }

  /** Short destination: “other” on web1. */
  short(host, dir) {
    const c = this.ws.conns.get(host);
    const name = dir === '/' ? '/' : c && dir === c.home ? '~' : basename(dir);
    return `“${name}”${this.ws.multiHost() ? ` on ${hostLabel(host)}` : ''}`;
  }

  // --- uploads -----------------------------------------------------------------------
  /** entries: [{file, rel}] and [{rel, dir: true}] for (empty) folders. */
  async upload(host, dir, entries) {
    if (!entries.length) return null;
    const conn = this.ws.conn(host);
    let there;
    try {
      there = new Map((await conn.call('/api/ls', { query: { path: dir } })).entries.map(e => [e.name, e.type]));
    } catch (e) {
      toast({ kind: 'error', title: `Couldn’t upload to ${this.where(host, dir)}`, message: e.message });
      return null;
    }
    const tops = new Map();  // first path segment -> is a folder
    for (const en of entries) {
      const [top] = en.rel.split('/');
      tops.set(top, !!tops.get(top) || en.dir || en.rel.includes('/'));
    }
    const clash = [...tops.keys()].filter(n => there.has(n));
    let policy = null;
    if (clash.length) {
      policy = await askConflict({ names: clash, dir, folders: clash.some(n => tops.get(n) && isDirType(there.get(n))) });
      if (!policy) return null;
    }
    const rename = new Map();
    if (policy === 'rename') {
      const taken = new Set([...there.keys(), ...tops.keys()]);
      for (const n of clash) { const nn = freeName(n, taken, tops.get(n)); taken.add(nn); rename.set(n, nn); }
    }
    let list = policy === 'skip' ? entries.filter(en => !clash.includes(en.rel.split('/')[0])) : entries;
    list = list.map(en => {
      const parts = en.rel.split('/');
      if (rename.has(parts[0])) parts[0] = rename.get(parts[0]);
      return { ...en, rel: parts.join('/') };
    });
    if (!list.length) return null;
    const files = list.filter(en => !en.dir);
    const folders = list.filter(en => en.dir);
    const names = [...new Set(list.map(en => en.rel.split('/')[0]))];
    const it = this.add({
      kind: 'upload', verb: 'Uploading', state: 'running', dst: { host, dir }, what: names.length === 1 ? `“${names[0]}”` : `${names.length} items`,
      targets: names, total: files.reduce((a, en) => a + en.file.size, 0), files: files.length, filesDone: 0,
    });
    const ctrl = new AbortController();
    it.cancel = () => ctrl.abort();
    this.open(true);
    const failed = [];
    for (const f of folders) {
      try { await conn.call('/api/create', { body: { path: join(dir, f.rel), dir: true, parents: true } }); } catch { /* exists already */ }
    }
    const loaded = new Array(files.length).fill(0);
    const sum = () => loaded.reduce((a, b) => a + b, 0);
    let next = 0;
    const overwrite = policy === 'replace';
    const worker = async () => {
      while (next < files.length && !ctrl.signal.aborted) {
        const i = next++;
        const en = files[i];
        try {
          await uploadFile(host, join(dir, en.rel), en.file, { overwrite, mkdirs: en.rel.includes('/'), signal: ctrl.signal },
            n => { loaded[i] = n; it.done = sum(); this.progress(it); });
          loaded[i] = en.file.size;
          it.filesDone++;
        } catch (e) {
          if (e.name === 'AbortError') return;
          failed.push(`${en.rel}: ${e.status === 409 ? 'already exists' : e.message}`);
        }
        it.done = sum();
        this.progress(it);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (ctrl.signal.aborted) this.finish(it, 'canceled');
    else if (failed.length) {
      this.finish(it, failed.length === files.length ? 'failed' : 'done', {
        error: failed.slice(0, 5).join('\n') + (failed.length > 5 ? `\n…and ${failed.length - 5} more` : ''),
        warning: failed.length < files.length ? `${failed.length} of ${files.length} files failed` : null,
      });
    } else this.finish(it, 'done');
    this.ws.explorer.refreshDir(host, dir);
    this.ws.editor.checkExternal();
    return it;
  }

  // --- copies and moves (server jobs) ------------------------------------------------
  /**
   * src: {host, dir, names, folders: Set of names that are folders}, dst: {host, dir},
   * mode 'copy' | 'move'. Asks about name clashes, then runs on the server.
   * Resolves to the finished entry, or null if nothing was started.
   */
  async run({ src, dst, mode }) {
    let policy = 'ask';
    let r;
    const body = () => ({ src: { host: src.host, dir: src.dir, names: src.names }, dst, mode, conflict: policy });
    for (;;) {
      try {
        r = await api('/api/transfer', { body: body() });
      } catch (e) {
        if (needsAuth(e) && e.data.host && this.ws.conns.has(e.data.host)) {
          if (await this.ws.conn(e.data.host).reconnect()) continue;
          return null;
        }
        toast({ kind: 'error', title: `Couldn’t ${mode} ${src.names.length === 1 ? `“${src.names[0]}”` : `${src.names.length} items`}`, message: e.message });
        return null;
      }
      if (!r.conflicts) break;
      policy = await askConflict({ names: r.conflicts.map(c => c.name), dir: dst.dir,
        folders: r.conflicts.some(c => c.dir && (!src.folders || src.folders.has(c.name))) });
      if (!policy) return null;
    }
    const j = r.job;
    const it = this.add({
      kind: 'job', job: j.id, relay: j.relay, verb: mode === 'move' ? 'Moving' : 'Copying', state: j.state,
      src, dst, mode, what: src.names.length === 1 ? `“${src.names[0]}”` : `${src.names.length} items`,
      total: null, items: src.names.length, itemsDone: 0, targets: [],
    });
    it.cancel = () => api('/api/jobs/cancel', { body: { id: j.id } }).catch(() => {});
    this.apply(it, j);
    // Same-host moves are near-instant; anything that streams gets the list.
    if (j.relay) this.open(true);
    this.poll(120);
    return it.finished;
  }

  /** Jobs still running from before a reload. */
  async adopt() {
    let jobs;
    try { jobs = (await api('/api/jobs')).jobs; } catch { return; }
    const mine = h => this.ws.conns.has(h);
    for (const j of jobs) {
      if (!ACTIVE.has(j.state) || !(mine(j.src.host) || mine(j.dst.host)) || this.items.some(x => x.job === j.id)) continue;
      const it = this.add({
        kind: 'job', job: j.id, relay: j.relay, verb: j.mode === 'move' ? 'Moving' : 'Copying', state: j.state,
        src: { ...j.src }, dst: j.dst, mode: j.mode, what: j.src.names.length === 1 ? `“${j.src.names[0]}”` : `${j.src.names.length} items`,
        total: null, items: j.items, itemsDone: 0, targets: [],
      });
      it.cancel = () => api('/api/jobs/cancel', { body: { id: j.id } }).catch(() => {});
      this.apply(it, j);
    }
    if (this.active.length) this.poll(300);
  }

  apply(it, j) {
    it.done = j.done;
    it.total = j.total;
    it.itemsDone = j.itemsDone;
    it.serverRate = j.rate;
    it.warning = j.warning;
    if (ACTIVE.has(j.state)) { it.state = j.state; this.paintSoon(); return; }
    if (!ACTIVE.has(it.state)) return;
    it.targets = j.targets;
    this.finish(it, j.state === 'done' ? 'done' : j.state, { error: j.error });
    this.landed(it);
  }

  /** After a job: refresh both ends and keep open editors pointing at the right files. */
  landed(it) {
    const { src, dst, mode } = it;
    if (it.state === 'done' && mode === 'move' && src.host === dst.host) {
      src.names.forEach((n, i) => {
        const t = it.targets[i];
        if (t) this.ws.onMoved(src.host, join(src.dir, n), join(dst.dir, t));
      });
    } else if (it.state === 'done' && mode === 'move') {
      this.ws.editor.onDeleted(src.host, src.names.map(n => join(src.dir, n)));
    }
    this.ws.explorer.refreshDir(dst.host, dst.dir);
    if (mode === 'move') this.ws.explorer.refreshDir(src.host, src.dir);
  }

  poll(delay = 400) {
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(async () => {
      let jobs = null;
      try { jobs = (await api('/api/jobs')).jobs; } catch { /* server restarting */ }
      this.pollTimer = null;
      if (jobs) {
        for (const it of this.items) {
          if (it.kind !== 'job' || !ACTIVE.has(it.state)) continue;
          const j = jobs.find(x => x.id === it.job);
          if (j) this.apply(it, j);
          else this.finish(it, 'failed', { error: 'The sshcode server restarted during the copy.' });
        }
      }
      if (this.items.some(it => it.kind === 'job' && ACTIVE.has(it.state))) this.poll(400);
    }, delay);
  }

  dispose() {
    clearTimeout(this.pollTimer);
    closePopover();
  }

  // --- view -----------------------------------------------------------------------------
  open(auto = false) {
    if (this.pop && this.pop.el.isConnected) { this.paint(); return; }
    if (auto && document.querySelector('.overlays .menu, .overlays .scrim, .palette-wrap')) return;
    const b = this.button;
    const anchor = b.offsetParent ? b : { left: innerWidth - 16, right: innerWidth - 16, top: innerHeight - 16, bottom: 56 };
    const body = h('<div class="tx-pop"><div class="tx-head"><b>Transfers</b><button class="btn small" data-a="clear">Clear</button></div><div class="tx-list"></div></div>');
    body.addEventListener('click', e => this.onClick(e));
    this.pop = popover(anchor, body, { onClose: () => { this.pop = null; } });
    this.paint();
  }

  onClick(e) {
    if (e.target.closest('[data-a=clear]')) { this.clear(); return; }
    const row = e.target.closest('.tx-item');
    if (!row) return;
    const it = this.items.find(x => x.id === +row.dataset.id);
    if (!it) return;
    if (e.target.closest('[data-x]')) {
      if (it.cancel) it.cancel(); else this.dismiss(it);
      return;
    }
    if (it.state === 'done' && it.dst) {
      closePopover();
      this.ws.explorer.revealIn(it.dst.host, it.dst.dir, it.targets);
    }
  }

  paintSoon() {
    if (this.paintQueued) return;
    this.paintQueued = true;
    setTimeout(() => { this.paintQueued = false; this.paint(); }, 200);
  }

  paint() {
    const active = this.active;
    const b = this.button;
    b.hidden = !this.items.length;
    b.classList.toggle('busy', active.length > 0);
    let p = 1;
    const sized = active.filter(it => it.total);
    if (sized.length) p = Math.min(0.99, sized.reduce((a, it) => a + it.done, 0) / sized.reduce((a, it) => a + it.total, 0));
    else if (active.length) p = 0.08;
    b.querySelector('.val').style.strokeDashoffset = String(RING * (1 - p));
    b.title = active.length ? `${active.length} transfer${active.length > 1 ? 's' : ''} in progress` : 'Transfers';
    if (!this.pop || !this.pop.el.isConnected) return;
    const list = this.pop.el.querySelector('.tx-list');
    list.innerHTML = this.items.length ? [...this.items].reverse().map(it => this.row(it)).join('') : '<div class="tx-none">No transfers</div>';
    this.pop.el.querySelector('[data-a=clear]').disabled = !this.items.some(it => !ACTIVE.has(it.state));
  }

  row(it) {
    const running = ACTIVE.has(it.state);
    const to = it.dst ? this.short(it.dst.host, it.dst.dir) : '';
    const full = it.dst ? this.where(it.dst.host, it.dst.dir) : '';
    const past = { Uploading: 'Uploaded', Copying: 'Copied', Moving: 'Moved' }[it.verb];
    const title = running ? `${it.verb} ${it.what}` : `${it.state === 'done' ? past : it.verb.replace('ing', '')} ${it.what}`;
    let status = '';
    let pct = null;
    const rate = it.kind === 'job' ? it.serverRate || 0 : it.rate;
    if (it.state === 'queued') status = 'Waiting for another transfer to finish…';
    else if (running) {
      if (it.kind === 'job' && !it.relay) status = `${it.itemsDone} of ${it.items} item${it.items === 1 ? '' : 's'} · on ${hostLabel(it.dst.host)}`;
      else if (it.total) {
        pct = Math.min(0.99, it.done / it.total);
        const left = rate > 1 ? fmtDuration((it.total - it.done) / rate) : '';
        status = `${fmtSize(it.done)} of ${it.kind === 'job' ? '~' : ''}${fmtSize(it.total)}${rate > 1 ? ` — ${fmtSize(rate)}/s` : ''}${left ? `, ${left} left` : ''}`;
        if (it.files > 1) status += ` · ${it.filesDone} of ${it.files} files`;
      } else {
        status = `${fmtSize(it.done)}${rate > 1 ? ` — ${fmtSize(rate)}/s` : ''}`;
      }
    } else if (it.state === 'done') status = it.warning ? it.warning : `to ${to}`;
    else if (it.state === 'canceled') status = 'Cancelled';
    else status = it.error || 'Failed';
    const ic = it.kind === 'upload' ? icons.upload : it.mode === 'move' ? icons.arrowRight : icons.copy;
    const bar = running ? `<div class="bar${pct == null ? ' indet' : ''}"><i style="width:${pct == null ? 30 : (pct * 100).toFixed(1)}%"></i></div>` : '';
    return `<div class="tx-item ${it.state}" data-id="${it.id}" title="${esc(`${running ? it.verb : past} to ${full}${it.state === 'done' ? ' — click to show it in the sidebar' : ''}`)}">
      <span class="tx-ic">${ic}</span>
      <div class="tx-main"><div class="tx-t">${esc(title)}${running && to ? ` <span class="tx-to">to ${esc(to)}</span>` : ''}</div>${bar}<div class="tx-s">${esc(status)}</div></div>
      <button class="ib sm" data-x title="${running ? 'Cancel' : 'Remove from List'}">${running ? icons.stop : icons.xmark}</button></div>`;
  }
}
