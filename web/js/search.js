// Find in Files: ripgrep on the server when it's installed, grep otherwise.
import { esc, h, debounce, basename, join, relPath } from './util.js';
import { icons, fileIcon } from './icons.js';
import { spinner, contextMenu } from './ui.js';
import { hostColor, hostLabel } from './settings.js';

export class SearchView {
  constructor(ws) {
    this.ws = ws;
    this.opts = { case: false, word: false, regex: false };
    this.folder = null;
    this.rootId = null;  // which sidebar folder (when there are several)
    this.seq = 0;
    this.collapsed = new Set();
    this.el = h(`<div class="view search" hidden>
      <div class="search-box">
        <button class="scope" hidden></button>
        <div class="search-field">
          <input class="field" placeholder="Search" spellcheck="false" autocomplete="off">
          <div class="opts">
            <button class="opt" data-o="case" title="Match Case">Aa</button>
            <button class="opt" data-o="word" title="Match Whole Word"><u>ab</u></button>
            <button class="opt" data-o="regex" title="Use Regular Expression">.*</button>
          </div>
        </div>
      </div>
      <div class="search-meta"></div>
      <div class="results"></div>
    </div>`);
    this.input = this.el.querySelector('input');
    this.meta = this.el.querySelector('.search-meta');
    this.results = this.el.querySelector('.results');
    this.runSoon = debounce(() => this.run(), 450);
    this.input.addEventListener('input', () => this.runSoon());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.runSoon.cancel(); this.run(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSel(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSel(-1); }
    });
    this.el.querySelector('.opts').addEventListener('click', e => {
      const b = e.target.closest('[data-o]');
      if (!b) return;
      this.opts[b.dataset.o] = !this.opts[b.dataset.o];
      b.classList.toggle('on', this.opts[b.dataset.o]);
      this.run();
    });
    this.results.addEventListener('click', e => {
      const f = e.target.closest('.res-file');
      if (f) {
        const p = f.dataset.p;
        if (this.collapsed.has(p)) this.collapsed.delete(p); else this.collapsed.add(p);
        this.render();
        return;
      }
      const l = e.target.closest('.res-line');
      if (l) this.openMatch(+l.dataset.i, e.detail > 1);
    });
    this.meta.addEventListener('click', e => {
      if (e.target.closest('[data-clear-folder]')) { this.folder = null; this.run(); }
    });
    this.scopeBtn = this.el.querySelector('.scope');
    this.scopeBtn.addEventListener('click', () => {
      const r = this.scopeBtn.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { header: 'Search In' },
        ...this.ws.roots.map(root => ({
          label: this.label(root), icon: 'folder', current: root === this.scopeRoot,
          action: () => { this.rootId = root.id; this.folder = null; this.renderScope(); this.run(); },
        })),
      ]);
    });
  }

  get scopeRoot() { return this.ws.roots.find(r => r.id === this.rootId) || this.ws.roots[0]; }

  label(root) { return `${this.ws.rootName(root)}${this.ws.multiHost() ? ` · ${hostLabel(root.host)}` : ''}`; }

  renderScope() {
    if (!this.ws.roots.length) return;
    if (!this.ws.roots.some(r => r.id === this.rootId)) this.rootId = null;
    const many = this.ws.roots.length > 1;
    this.scopeBtn.hidden = !many;
    if (many) {
      const r = this.scopeRoot;
      this.scopeBtn.innerHTML = `<i class="hdot" style="--hc:var(--${hostColor(r.host)})"></i><span>${esc(this.label(r))}</span>${icons.chevronDown}`;
      this.scopeBtn.title = 'Search in which sidebar folder';
    }
  }

  focus({ folder, query, root } = {}) {
    const prev = this.rootId;
    if (root) this.rootId = root.id;
    else if (folder === undefined && this.ws.roots.length > 1) this.rootId = this.ws.activeRoot().id;
    if (this.rootId !== prev) this.folder = null;
    if (folder !== undefined) this.folder = folder || null;
    this.renderScope();
    if (query) this.input.value = query;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run();
    else this.renderMeta();
  }

  get root() { return this.folder || this.scopeRoot.path; }

  async run() {
    const query = this.input.value;
    const id = ++this.seq;
    this.matches = [];
    this.sel = -1;
    if (!query) { this.render(); return; }
    this.busy = true;
    this.renderMeta();
    const root = this.root;
    const host = this.scopeRoot.host;
    try {
      const r = await this.ws.conn(host).call('/api/search', { body: { root, query, ...this.opts } });
      if (id !== this.seq) return;
      this.matches = r.matches.map(m => ({ ...m, host, abs: join(root, m.path) }));
      this.truncated = r.truncated;
      this.error = null;
    } catch (e) {
      if (id !== this.seq) return;
      this.error = e.message;
    }
    this.busy = false;
    this.render();
  }

  matcher() {
    const q = this.input.value;
    try {
      const src = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(this.opts.word ? `\\b(?:${src})\\b` : src, this.opts.case ? 'g' : 'gi');
    } catch { return null; }
  }

  highlight(text) {
    const re = this.matcher();
    if (!re) return esc(text);
    let out = '', last = 0, m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 50) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  renderMeta() {
    const scope = this.folder ? ` in <b>${esc(relPath(this.scopeRoot.path, this.folder) || basename(this.folder))}</b> <button class="ib sm" data-clear-folder title="Search the whole workspace" style="width:18px;height:18px">${icons.xmark}</button>` : '';
    if (this.busy) { this.meta.innerHTML = `${spinner(12)} Searching${scope}`; return; }
    if (this.error) { this.meta.innerHTML = `<span style="color:var(--red)">${esc(this.error)}</span>`; return; }
    if (!this.input.value) { this.meta.innerHTML = scope ? `Search${scope}` : ''; return; }
    const files = new Set((this.matches || []).map(m => m.path)).size;
    const n = (this.matches || []).length;
    this.meta.innerHTML = n
      ? `${n.toLocaleString()}${this.truncated ? '+' : ''} result${n === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}${scope}`
      : `No results${scope}`;
  }

  render() {
    this.renderMeta();
    const groups = new Map();
    (this.matches || []).forEach((m, i) => {
      if (!groups.has(m.path)) groups.set(m.path, []);
      groups.get(m.path).push(i);
    });
    let html = '';
    for (const [path, idx] of groups) {
      const open = !this.collapsed.has(path);
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      html += `<div class="res-file${open ? ' open' : ''}" data-p="${esc(path)}" title="${esc(path)}"><span class="tw">${icons.chevronRight}</span>${fileIcon(basename(path))}<span class="nm">${esc(basename(path))}</span><span class="dir">${esc(dir)}</span><span class="count">${idx.length}</span></div>`;
      if (open) {
        for (const i of idx) {
          const m = this.matches[i];
          html += `<div class="res-line${i === this.sel ? ' sel' : ''}" data-i="${i}"><span class="ln">${m.line}</span><span class="tx">${this.highlight(m.text.trimStart())}</span></div>`;
        }
      }
    }
    this.results.innerHTML = html;
  }

  moveSel(d) {
    if (!this.matches || !this.matches.length) return;
    this.sel = Math.max(0, Math.min(this.matches.length - 1, (this.sel ?? -1) + d));
    this.render();
    const el = this.results.querySelector('.res-line.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
    this.openMatch(this.sel, false, false);
  }

  openMatch(i, pin, focus = true) {
    const m = this.matches[i];
    if (!m) return;
    this.sel = i;
    this.results.querySelectorAll('.res-line.sel').forEach(n => n.classList.remove('sel'));
    const el = this.results.querySelector(`.res-line[data-i="${i}"]`);
    if (el) el.classList.add('sel');
    this.ws.editor.open(m.abs, {
      host: m.host, preview: !pin, focus, line: m.line,
      query: { text: this.input.value, regex: this.opts.regex, case: this.opts.case, word: this.opts.word },
    }).then(() => { if (!focus) this.input.focus(); });
  }
}
