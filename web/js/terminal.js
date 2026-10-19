// Terminals: xterm.js talking to `ssh -tt host` on the server over a
// WebSocket, arranged in groups that you split and rearrange by dragging
// their tabs: onto another group's tabs to join it, onto an edge of a group to
// split beside it. They survive page reloads (the server keeps them for a
// while and replays recent output), come back in the same arrangement, and
// reconnect by themselves after a hiccup.
import { esc, h, debounce, isMac, copyText, store, basename, reconcile } from './util.js';
import { api } from './api.js';
import { icons } from './icons.js';
import { contextMenu, toast, prompt } from './ui.js';
import { onTheme, terminalTheme } from './theme.js';
import { codeFont } from './editor.js';
import { settings, hostColor, hostLabel, TAG_COLORS } from './settings.js';
import { DRAG_TYPE } from './explorer.js';

const TERM_TYPE = 'application/x-sshcode-term';

// The WebGL renderer draws output on the GPU, far cheaper than one DOM node
// per run of text when a build or log scrolls by. Checked once.
let webgl = null;
function webglOk() {
  if (webgl === null) {
    try { webgl = !!(window.WebglAddon && document.createElement('canvas').getContext('webgl2')); } catch { webgl = false; }
  }
  return webgl;
}

let seq = 0;
const newStack = (terms = []) => ({ type: 'stack', id: 's' + ++seq, terms, active: terms[terms.length - 1] || null, el: null, cache: new Map() });
const newSplit = (dir, kids, sizes) => ({ type: 'split', dir, kids, sizes: sizes || kids.map(() => 1 / kids.length), el: null, divs: [] });
const quote = p => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

export class TerminalPanel {
  constructor(ws) {
    this.ws = ws;
    this.terms = [];
    this.root = null;        // layout: split {dir: 'row' | 'col', kids, sizes} or stack {terms, active}
    this.active = null;      // the terminal you're typing in (or last were)
    this.n = 0;
    this.armedUntil = 0;
    this.el = h(`<section class="pane rim term-pane"><div class="term-body"></div></section>`);
    this.body = this.el.querySelector('.term-body');
    this.acts = h(`<span class="term-acts">
      <button class="ib sm" data-a="new">${icons.plus}</button>
      <button class="ib sm" data-a="hosts">${icons.chevronDown}</button>
      <button class="ib sm" data-a="split">${icons.split}</button>
      <button class="ib sm" data-a="kill">${icons.trash}</button>
      <button class="ib sm" data-a="max">${icons.chevronUp}</button>
      <button class="ib sm" data-a="hide">${icons.chevronDown}</button>
    </span>`);
    this.hint = h('<div class="dock-hint"><span></span></div>');
    this.caret = h('<div class="dock-caret"></div>');
    this.refreshExplorer = debounce(() => this.ws.explorer.refresh(undefined, { bg: true }), 1200);
    this.saveLayout = debounce(() => this.persist(), 300);
    this.fitQueue = new Set();
    this.ro = new ResizeObserver(entries => {
      for (const en of entries) this.fitQueue.add(en.target);
      this.fitSoon();
    });
    this.fitSoon = debounce(() => {
      for (const el of this.fitQueue) { const st = this.stacks().find(s => s.bodyEl === el); if (st && st.active) st.active.fit(); }
      this.fitQueue.clear();
    }, 30);
    this.subs = [
      onTheme(() => { for (const t of this.terms) t.x.options.theme = terminalTheme(); }),
      settings.on('*', (v, k) => this.onSetting(k)),
    ];
    this.bind();
  }

  onSetting(k) {
    const map = {
      'terminal.fontSize': 'fontSize', 'terminal.lineHeight': 'lineHeight', 'terminal.cursorStyle': 'cursorStyle',
      'terminal.cursorBlink': 'cursorBlink', 'terminal.scrollback': 'scrollback',
    };
    if (map[k]) for (const t of this.terms) t.x.options[map[k]] = settings.get(k);
    else if (k === 'editor.font' || k === 'editor.fontCustom') for (const t of this.terms) t.x.options.fontFamily = codeFont();
    else if (k === 'terminal.webgl') for (const t of this.terms) t.setWebgl(settings.get(k));
    else return;
    requestAnimationFrame(() => this.fitAll());
  }

  get storeKey() { return `terms:${this.ws.wsKey}`; }

  // --- the layout tree --------------------------------------------------------------
  stacks(node = this.root, out = []) {
    if (!node) return out;
    if (node.type === 'stack') out.push(node);
    else node.kids.forEach(k => this.stacks(k, out));
    return out;
  }

  stackOf(t) { return this.stacks().find(s => s.terms.includes(t)) || null; }
  activeStack() { return (this.active && this.stackOf(this.active)) || this.stacks()[0] || null; }
  byUid(uid) { return this.terms.find(t => String(t.uid) === String(uid)) || null; }

  parentOf(node, cur = this.root) {
    if (!cur || cur.type !== 'split') return null;
    if (cur.kids.includes(node)) return cur;
    for (const k of cur.kids) { const p = this.parentOf(node, k); if (p) return p; }
    return null;
  }

  replaceNode(old, next) {
    const p = this.parentOf(old);
    if (p) p.kids[p.kids.indexOf(old)] = next;
    else this.root = next;
  }

  /** Put stack `ns` beside `target` (zone: left right top bottom). */
  splitAt(target, ns, zone) {
    const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const before = zone === 'left' || zone === 'top';
    const p = this.parentOf(target);
    if (p && p.dir === dir) {
      const i = p.kids.indexOf(target);
      const share = p.sizes[i] / 2;
      p.sizes[i] = share;
      p.kids.splice(before ? i : i + 1, 0, ns);
      p.sizes.splice(before ? i : i + 1, 0, share);
    } else {
      this.replaceNode(target, newSplit(dir, before ? [ns, target] : [target, ns], [0.5, 0.5]));
    }
  }

  /** Drop empty groups and splits left with one side; merge nested splits going the same way. */
  prune() {
    const clean = node => {
      if (node.type === 'stack') {
        if (!node.terms.includes(node.active)) node.active = node.terms[node.terms.length - 1] || null;
        return node.terms.length ? node : null;
      }
      const kids = [], sizes = [];
      node.kids.forEach((k, i) => { const c = clean(k); if (c) { kids.push(c); sizes.push(node.sizes[i]); } });
      if (!kids.length) return null;
      if (kids.length === 1) return kids[0];
      const fk = [], fs = [];
      kids.forEach((k, i) => {
        if (k.type === 'split' && k.dir === node.dir) k.kids.forEach((kk, j) => { fk.push(kk); fs.push(sizes[i] * k.sizes[j]); });
        else { fk.push(k); fs.push(sizes[i]); }
      });
      const total = fs.reduce((a, b) => a + b, 0) || 1;
      node.kids = fk;
      node.sizes = fs.map(x => x / total);
      return node;
    };
    const before = this.stacks();
    this.root = this.root ? clean(this.root) : null;
    const after = new Set(this.stacks());
    for (const s of before) if (!after.has(s) && s.bodyEl) this.ro.unobserve(s.bodyEl);
  }

  // --- rendering ---------------------------------------------------------------------
  render() {
    if (!this.root) {
      this.body.replaceChildren(h('<div class="term-empty">No terminal</div>'));
      this.body.firstChild.appendChild(this.acts);
      this.renderActs();
      return;
    }
    const el = this.build(this.root);
    el.style.flex = '1 1 0px';
    if (this.body.childNodes.length !== 1 || this.body.firstChild !== el) this.body.replaceChildren(el);
    this.placeActs();
    for (const st of this.stacks()) this.renderTabs(st);
    this.renderActs();
    requestAnimationFrame(() => {
      for (const t of this.terms) if (!t.el.hidden) t.repaint();
      this.fitAll();
    });
  }

  build(node) {
    if (node.type === 'stack') {
      if (!node.el) {
        node.el = h('<div class="tstack"><div class="tstrip"><div class="ttabs" role="tablist"></div></div><div class="tbody"></div></div>');
        node.strip = node.el.querySelector('.tstrip');
        node.tabsEl = node.el.querySelector('.ttabs');
        node.bodyEl = node.el.querySelector('.tbody');
        node.el.dataset.s = node.id;
        this.ro.observe(node.bodyEl);
      }
      for (const t of node.terms) if (t.el.parentNode !== node.bodyEl) node.bodyEl.appendChild(t.el);
      for (const t of node.terms) t.el.hidden = t !== node.active;
      return node.el;
    }
    if (!node.el) node.el = h('<div class="tsplit"></div>');
    // (not "row": that's a file-tree row)
    node.el.className = `tsplit dir-${node.dir}`;
    const kids = [];
    node.kids.forEach((k, i) => {
      if (i) {
        if (!node.divs[i]) node.divs[i] = this.divider(node);
        node.divs[i].className = `tdiv dir-${node.dir}`;
        node.divs[i].dataset.i = i;
        kids.push(node.divs[i]);
      }
      const c = this.build(k);
      c.style.flex = `${node.sizes[i]} 1 0px`;
      kids.push(c);
    });
    node.divs.length = node.kids.length;
    const same = node.el.children.length === kids.length && kids.every((k, i) => node.el.children[i] === k);
    if (!same) node.el.replaceChildren(...kids);
    return node.el;
  }

  /** The panel's own buttons sit in the top-right group's tab strip. */
  placeActs() {
    let n = this.root;
    while (n && n.type === 'split') n = n.dir === 'row' ? n.kids[n.kids.length - 1] : n.kids[0];
    if (n && this.acts.parentNode !== n.strip) n.strip.appendChild(this.acts);
  }

  renderActs() {
    const a = this.acts;
    const max = a.querySelector('[data-a=max]');
    const right = settings.get('panelSide') === 'right';
    max.innerHTML = this.ws.termMax ? icons.minimize : icons.maximize;
    max.title = this.ws.termMax ? 'Restore Panel' : 'Maximize Panel';
    const hide = a.querySelector('[data-a=hide]');
    hide.innerHTML = right ? icons.chevronRight : icons.chevronDown;
    hide.title = `Hide Panel (${this.keys('view.terminal')})`;
    a.querySelector('[data-a=new]').title = `New Terminal (${this.keys('term.new')})`;
    a.querySelector('[data-a=split]').title = `Split Terminal (${this.keys('term.split')})`;
    a.querySelector('[data-a=kill]').title = 'Kill Terminal';
    const hosts = a.querySelector('[data-a=hosts]');
    hosts.hidden = this.ws.conns.size < 2;
    hosts.title = 'New Terminal on…';
  }

  keys(id) { return this.ws.keysFor(id) || 'no shortcut'; }

  renderTabs(st) {
    if (!st.tabsEl) return;
    const multi = this.ws.multiHost();
    const several = this.stacks().length > 1;
    reconcile(st.tabsEl, st.terms.map(t => {
      const cls = ['ttab'];
      if (t === st.active) cls.push('on');
      if (several && t === this.active) cls.push('focus');
      if (t.exited) cls.push('dead');
      const chip = multi && t.host !== this.ws.host ? `<span class="hchip" style="--hc:var(--${hostColor(t.host)})">${esc(hostLabel(t.host))}</span>` : '';
      return {
        key: t.uid,
        cls: cls.join(' '),
        attrs: { 'data-t': String(t.uid), draggable: 'true', role: 'tab', title: t.tooltip(), style: t.color ? `--tc:var(--${t.color})` : null },
        html: `<span class="tic">${icons.terminal}</span><span class="nm">${esc(t.label())}</span>${chip}<button class="x" data-x aria-label="Kill">${icons.xmark}</button>`,
      };
    }), st.cache);
  }

  renderAll() {
    for (const st of this.stacks()) this.renderTabs(st);
    this.renderActs();
  }

  // --- terminals -----------------------------------------------------------------------
  /** Where a new terminal opens: on the server and folder you're working in. */
  origin(host) {
    const inTerm = this.hasFocus() && this.active;
    const root = this.ws.activeRoot();
    host = host || (inTerm ? this.active.host : root.host);
    if (settings.get('terminal.cwd') === 'home') return { host, cwd: '' };
    if (inTerm && this.active.host === host) return { host, cwd: this.active.cwd };
    const r = root.host === host ? root : this.ws.roots.find(x => x.host === host);
    return { host, cwd: r ? r.path : '' };
  }

  async restore() {
    let list = [];
    try { list = (await api('/api/terms', { query: { ws: this.ws.wsKey } })).terms; } catch { return 0; }
    const saved = store.get(this.storeKey, null) || {};
    const meta = saved.meta || {};
    const byId = new Map();
    for (const info of list) {
      const t = new Term(this, { id: info.id, host: info.host || this.ws.host, cwd: info.cwd });
      if (meta[info.id]) { t.name = meta[info.id].name || null; t.color = meta[info.id].color || null; }
      this.terms.push(t);
      byId.set(info.id, t);
    }
    if (!this.terms.length) return 0;
    // The saved arrangement, with whichever terminals are still alive.
    const build = n => {
      if (!n) return null;
      if (n.s) {
        const terms = n.s.map(id => byId.get(id)).filter(Boolean);
        terms.forEach(t => byId.delete(t.id));
        if (!terms.length) return null;
        const st = newStack(terms);
        st.active = terms.find(t => t.id === n.a) || terms[terms.length - 1];
        return st;
      }
      const kids = [], sizes = [];
      (n.k || []).forEach((k, i) => { const c = build(k); if (c) { kids.push(c); sizes.push((n.z || [])[i] || 1); } });
      if (!kids.length) return null;
      if (kids.length === 1) return kids[0];
      const total = sizes.reduce((a, b) => a + b, 0);
      return newSplit(n.d === 'col' ? 'col' : 'row', kids, sizes.map(x => x / total));
    };
    this.root = build(saved.layout);
    const rest = [...byId.values()];
    if (rest.length) {
      if (this.root) { const first = this.stacks()[0]; first.terms.push(...rest); }
      else this.root = newStack(rest);
    }
    this.active = this.terms.find(t => t.id === saved.focus) || this.stacks()[0].active;
    this.render();
    return this.terms.length;
  }

  newTerminal({ host, cwd, focus = true, stack = null } = {}) {
    this.ws.setTerminalVisible(true, { create: false });
    const o = this.origin(host);
    const t = new Term(this, { host: o.host, cwd: cwd != null ? cwd : o.cwd });
    this.terms.push(t);
    if (!this.root) this.root = newStack([t]);
    else {
      const st = stack || this.activeStack();
      st.terms.push(t);
      st.active = t;
    }
    this.active = t;
    this.render();
    this.focusTerm(t, focus);
    this.saveLayout();
    return t;
  }

  /** A new terminal beside the one you're in (dir 'row': to the right, 'col': below). */
  split(dir = 'row') {
    const cur = this.active && this.stackOf(this.active) ? this.active : null;
    if (!cur) { this.newTerminal(); return; }
    const t = new Term(this, { host: cur.host, cwd: cur.cwd });
    this.terms.push(t);
    this.splitAt(this.stackOf(cur), newStack([t]), dir === 'row' ? 'right' : 'bottom');
    this.active = t;
    this.render();
    this.focusTerm(t, true);
    this.saveLayout();
  }

  /** Move `t` out of its group into a new one beside it. */
  moveOut(t, zone) {
    const from = this.stackOf(t);
    if (!from || from.terms.length < 2) return;
    from.terms.splice(from.terms.indexOf(t), 1);
    this.splitAt(from, newStack([t]), zone);
    this.prune();
    this.active = t;
    this.render();
    this.focusTerm(t, true);
    this.saveLayout();
  }

  joinAll() {
    const order = this.stacks().flatMap(s => s.terms);
    if (this.stacks().length < 2) return;
    for (const s of this.stacks()) if (s.bodyEl) this.ro.unobserve(s.bodyEl);
    this.root = newStack(order);
    this.root.active = this.active && order.includes(this.active) ? this.active : order[order.length - 1];
    this.render();
    this.focusTerm(this.root.active, true);
    this.saveLayout();
  }

  /** Make `t` the visible tab of its group (and focus it). */
  activate(t, focus = true) {
    const st = this.stackOf(t);
    if (!st) return;
    st.active = t;
    this.active = t;
    for (const x of st.terms) x.el.hidden = x !== t;
    this.renderTabs(st);
    for (const s of this.stacks()) if (s !== st) this.renderTabs(s);
    this.focusTerm(t, focus);
    this.saveLayout();
  }

  focusTerm(t, focus = true) {
    requestAnimationFrame(() => {
      t.fit();
      if (focus) t.x.focus();
    });
  }

  /** Called when a terminal gets the keyboard. */
  onFocus(t) {
    if (this.active === t) return;
    this.active = t;
    for (const s of this.stacks()) this.renderTabs(s);
  }

  focusStep(d) {
    const shown = this.stacks().map(s => s.active).filter(Boolean);
    if (!shown.length) return;
    const i = shown.indexOf(this.active);
    const t = shown[(i + d + shown.length) % shown.length];
    this.activate(t);
  }

  focus() {
    if (!this.terms.length) { this.newTerminal(); return; }
    const t = this.active || this.stacks()[0].active;
    if (t) { t.fit(); t.x.focus(); }
  }

  hasFocus() { return this.el.contains(document.activeElement); }

  fitAll() { for (const st of this.stacks()) if (st.active) st.active.fit(); }

  kill(t = this.active) {
    if (!t) return;
    t.dispose(true);
    this.terms.splice(this.terms.indexOf(t), 1);
    const st = this.stackOf(t);
    const next = st ? st.terms[st.terms.indexOf(t) + 1] || st.terms[st.terms.indexOf(t) - 1] : null;
    if (st) st.terms.splice(st.terms.indexOf(t), 1);
    this.prune();
    if (this.active === t) this.active = next || (this.stacks()[0] && this.stacks()[0].active) || null;
    this.render();
    this.saveLayout();
    if (!this.terms.length) this.ws.setTerminalVisible(false);
    else if (this.active) this.activate(this.active);
  }

  killAll() {
    for (const t of this.terms) t.dispose(true);
    this.terms = [];
    this.root = null;
    this.active = null;
    this.persist();
    this.render();
  }

  killHost(host) {
    for (const t of this.terms.filter(x => x.host === host)) this.kill(t);
  }

  async rename(t = this.active) {
    if (!t) return;
    const v = await prompt('Rename Terminal', { value: t.name || t.label(), placeholder: t.autoLabel(), ok: 'Rename', icon: 'terminal' });
    if (v === null) return;
    t.name = v.trim() || null;
    this.renderTabs(this.stackOf(t));
    this.persist();
  }

  setColor(t, c) {
    t.color = c;
    this.renderTabs(this.stackOf(t));
    this.persist();
  }

  persist() {
    const ser = n => (n.type === 'stack'
      ? { s: n.terms.map(t => t.id).filter(Boolean), a: n.active && n.active.id }
      : { d: n.dir, k: n.kids.map(ser), z: n.sizes.map(x => +x.toFixed(4)) });
    const meta = {};
    for (const t of this.terms) if (t.id && (t.name || t.color)) meta[t.id] = { name: t.name || undefined, color: t.color || undefined };
    store.set(this.storeKey, { layout: this.root ? ser(this.root) : null, meta, focus: this.active && this.active.id });
  }

  onInput(data) {
    if (data.includes('\r')) this.armedUntil = Date.now() + 15000;
  }

  /** Commands typed in a terminal often change files: refresh the tree after. */
  onOutput() {
    if (Date.now() < this.armedUntil) this.refreshExplorer();
  }

  flash(t) {
    const st = this.stackOf(t);
    if (!st || !st.bodyEl) return;
    st.bodyEl.classList.remove('bell');
    void st.bodyEl.offsetWidth;
    st.bodyEl.classList.add('bell');
  }

  // --- menus -------------------------------------------------------------------------------
  hostMenu(x, y) {
    const hosts = [...new Set([...this.ws.roots.map(r => r.host), ...this.ws.conns.keys()])];
    contextMenu(x, y, [
      { header: 'New Terminal on' },
      ...hosts.map(hh => ({ label: hostLabel(hh), icon: 'terminal', action: () => this.ws.terminalOn(hh) })),
      '-',
      { label: 'Another Server…', icon: 'serverPlus', action: () => this.ws.run('term.newOn') },
    ]);
  }

  tabMenu(x, y, t) {
    const st = this.stackOf(t);
    const many = st && st.terms.length > 1;
    contextMenu(x, y, [
      { label: 'Rename…', icon: 'pencil', action: () => this.rename(t) },
      { swatches: TAG_COLORS, value: t.color, pick: c => this.setColor(t, c) },
      '-',
      { label: 'Split Right', icon: 'split', keys: this.ws.keysFor('term.split'), action: () => { this.activate(t, false); this.split('row'); } },
      { label: 'Split Down', icon: 'splitDown', action: () => { this.activate(t, false); this.split('col'); } },
      ...(many ? [
        { label: 'Move to the Right', icon: 'arrowRight', action: () => this.moveOut(t, 'right') },
        { label: 'Move Down', action: () => this.moveOut(t, 'bottom') },
      ] : []),
      ...(this.stacks().length > 1 ? [{ label: 'Join All Panes', icon: 'collapse', action: () => this.joinAll() }] : []),
      '-',
      { label: 'Kill Terminal', icon: 'trash', danger: true, action: () => this.kill(t) },
    ]);
  }

  menu(x, y, t) {
    const sel = t.x.getSelection();
    contextMenu(x, y, [
      { label: 'Copy', icon: 'copy', keys: isMac ? 'Mod+C' : 'Ctrl+Shift+C', disabled: !sel, action: () => copyText(sel) },
      { label: 'Paste', icon: 'clipboard', keys: isMac ? 'Mod+V' : 'Ctrl+Shift+V', action: () => t.pasteFromClipboard() },
      { label: 'Select All', action: () => t.x.selectAll() },
      '-',
      { label: 'Clear', action: () => t.x.clear() },
      { label: 'Rename…', icon: 'pencil', action: () => this.rename(t) },
      '-',
      { label: 'New Terminal', icon: 'plus', keys: this.ws.keysFor('term.new'), action: () => this.newTerminal() },
      { label: 'Split Right', icon: 'split', keys: this.ws.keysFor('term.split'), action: () => { this.activate(t, false); this.split('row'); } },
      { label: 'Split Down', icon: 'splitDown', action: () => { this.activate(t, false); this.split('col'); } },
      '-',
      { label: 'Kill Terminal', icon: 'trash', danger: true, action: () => this.kill(t) },
    ]);
  }

  // --- events ------------------------------------------------------------------------------
  bind() {
    const body = this.body;
    const termOf = el => { const tab = el.closest('.ttab'); return tab ? this.byUid(tab.dataset.t) : null; };
    const stackAt = el => { const s = el.closest && el.closest('.tstack'); return s ? this.stacks().find(x => x.el === s) : null; };
    body.addEventListener('click', e => {
      const t = termOf(e.target);
      if (t) {
        if (e.target.closest('[data-x]')) { e.stopPropagation(); this.kill(t); return; }
        this.activate(t);
      }
    });
    body.addEventListener('mousedown', e => { if (e.button === 1 && e.target.closest('.ttab')) e.preventDefault(); });
    body.addEventListener('auxclick', e => {
      const t = termOf(e.target);
      if (t && e.button === 1) { e.preventDefault(); this.kill(t); }
    });
    body.addEventListener('dblclick', e => {
      const t = termOf(e.target);
      if (t && !e.target.closest('[data-x]')) { this.rename(t); return; }
      if (e.target.closest('.tstrip') && !e.target.closest('button')) this.ws.toggleTermMax();
    });
    body.addEventListener('wheel', e => {
      const tabs = e.target.closest('.ttabs');
      if (tabs && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabs.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    body.addEventListener('contextmenu', e => {
      const t = termOf(e.target);
      if (t) { e.preventDefault(); this.tabMenu(e.clientX, e.clientY, t); return; }
      const st = stackAt(e.target);
      if (!st || !st.active || !e.target.closest('.tbody')) return;
      e.preventDefault();
      if (settings.get('terminal.rightClick') === 'paste') st.active.pasteFromClipboard();
      else this.menu(e.clientX, e.clientY, st.active);
    });
    this.acts.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'new') this.newTerminal();
      else if (a === 'hosts') { const r = b.getBoundingClientRect(); this.hostMenu(r.left, r.bottom + 4); }
      else if (a === 'split') this.split('row');
      else if (a === 'kill') this.kill();
      else if (a === 'max') this.ws.toggleTermMax();
      else if (a === 'hide') this.ws.setTerminalVisible(false);
    });
    this.bindDrag(stackAt);
  }

  // Drag a tab: onto a tab strip to move it there, onto a group's edge to split.
  bindDrag(stackAt) {
    const body = this.body;
    body.addEventListener('dragstart', e => {
      const tab = e.target.closest('.ttab');
      const t = tab && this.byUid(tab.dataset.t);
      if (!t) return;
      this.dragTerm = t;
      e.dataTransfer.setData(TERM_TYPE, String(t.uid));
      e.dataTransfer.setData('text/plain', t.label());
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => this.el.classList.add('dnd'));
    });
    body.addEventListener('dragend', () => this.endDrag());
    // Accepting dragenter too, or Chromium never sends the dragovers.
    body.addEventListener('dragenter', e => {
      const ty = e.dataTransfer.types;
      if ((ty.includes(TERM_TYPE) && this.dragTerm) || ty.includes(DRAG_TYPE)) e.preventDefault();
    });
    body.addEventListener('dragover', e => {
      const ty = e.dataTransfer.types;
      if (ty.includes(TERM_TYPE) && this.dragTerm) {
        const at = this.dropAt(e, stackAt);
        if (!at) { this.hideDock(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.showDock(at);
      } else if (ty.includes(DRAG_TYPE)) {
        const st = stackAt(e.target);
        if (!st || !st.active || !e.target.closest('.tbody')) { this.hideDock(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.showDock({ kind: 'zone', st, zone: 'center', label: 'Insert path' });
      }
    });
    this.el.addEventListener('dragleave', e => {
      if (!this.el.contains(e.relatedTarget)) this.hideDock();
    });
    body.addEventListener('drop', e => {
      const ty = e.dataTransfer.types;
      if (ty.includes(TERM_TYPE) && this.dragTerm) {
        e.preventDefault();
        const at = this.dropAt(e, stackAt);
        const t = this.dragTerm;
        this.endDrag();
        if (at) this.place(t, at);
      } else if (ty.includes(DRAG_TYPE)) {
        e.preventDefault();
        const st = stackAt(e.target);
        this.endDrag();
        let p;
        try { p = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
        if (st && st.active && p.items) {
          st.active.x.paste(p.items.map(i => quote(i.path)).join(' ') + ' ');
          this.activate(st.active);
        }
      }
    });
  }

  /** Where a dragged tab would land: {kind: 'tab', st, index} or {kind: 'zone', st, zone}. */
  dropAt(e, stackAt) {
    const t = this.dragTerm;
    const st = stackAt(e.target);
    if (!st) return null;
    const from = this.stackOf(t);
    if (e.target.closest('.tstrip')) {
      const tabs = [...st.tabsEl.querySelectorAll('.ttab')];
      let index = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { index = i; break; }
      }
      return { kind: 'tab', st, index, from };
    }
    const b = st.bodyEl.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    const edges = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]].sort((p, q) => p[1] - q[1]);
    const zone = edges[0][1] < 0.3 ? edges[0][0] : 'center';
    if (st === from && (zone === 'center' || st.terms.length < 2)) return null;  // nothing would change
    return { kind: 'zone', st, zone, from };
  }

  showDock(at) {
    if (at.kind === 'tab') {
      this.hint.remove();
      const tabs = [...at.st.tabsEl.querySelectorAll('.ttab')];
      const strip = at.st.strip.getBoundingClientRect();
      const ref = tabs[at.index];
      const last = tabs[tabs.length - 1];
      const x = ref ? ref.getBoundingClientRect().left - 2 : last ? last.getBoundingClientRect().right + 1 : strip.left + 8;
      this.caret.style.left = (x - strip.left) + 'px';
      if (this.caret.parentNode !== at.st.strip) at.st.strip.appendChild(this.caret);
      return;
    }
    this.caret.remove();
    const z = at.zone;
    const s = this.hint.style;
    s.left = z === 'right' ? '50%' : '0';
    s.top = z === 'bottom' ? '50%' : '0';
    s.width = z === 'left' || z === 'right' ? '50%' : '100%';
    s.height = z === 'top' || z === 'bottom' ? '50%' : '100%';
    this.hint.firstChild.textContent = at.label || (z === 'center' ? 'Move here' : 'Split');
    if (this.hint.parentNode !== at.st.bodyEl) at.st.bodyEl.appendChild(this.hint);
  }

  hideDock() {
    this.hint.remove();
    this.caret.remove();
  }

  endDrag() {
    this.dragTerm = null;
    this.hideDock();
    this.el.classList.remove('dnd');
  }

  /** Apply a drop. */
  place(t, at) {
    const from = this.stackOf(t);
    if (!from) return;
    if (at.kind === 'tab') {
      const i = from.terms.indexOf(t);
      let index = at.index;
      if (from === at.st && i < index) index--;
      from.terms.splice(i, 1);
      at.st.terms.splice(index, 0, t);
      at.st.active = t;
    } else if (at.zone === 'center') {
      from.terms.splice(from.terms.indexOf(t), 1);
      at.st.terms.push(t);
      at.st.active = t;
    } else {
      from.terms.splice(from.terms.indexOf(t), 1);
      this.splitAt(at.st, newStack([t]), at.zone);
    }
    this.prune();
    this.active = t;
    this.render();
    this.focusTerm(t, true);
    this.saveLayout();
  }

  divider(sp) {
    const d = h('<div class="tdiv"></div>');
    d.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const i = +d.dataset.i;
      const row = sp.dir === 'row';
      const total = row ? sp.el.clientWidth : sp.el.clientHeight;
      const startPos = row ? e.clientX : e.clientY;
      const a0 = sp.sizes[i - 1], b0 = sp.sizes[i];
      const min = Math.min(0.45, 80 / Math.max(1, total));
      d.setPointerCapture(e.pointerId);
      d.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.style.cursor = row ? 'col-resize' : 'row-resize';
      const move = ev => {
        let delta = ((row ? ev.clientX : ev.clientY) - startPos) / total;
        delta = Math.max(min - a0, Math.min(b0 - min, delta));
        sp.sizes[i - 1] = a0 + delta;
        sp.sizes[i] = b0 - delta;
        sp.kids[i - 1].el.style.flex = `${sp.sizes[i - 1]} 1 0px`;
        sp.kids[i].el.style.flex = `${sp.sizes[i]} 1 0px`;
      };
      const up = () => {
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        d.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
        this.fitAll();
        this.saveLayout();
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', () => {
      const i = +d.dataset.i;
      const even = (sp.sizes[i - 1] + sp.sizes[i]) / 2;
      sp.sizes[i - 1] = sp.sizes[i] = even;
      this.render();
      this.saveLayout();
    });
    return d;
  }

  dispose() {
    this.persist();
    for (const t of this.terms) t.dispose(false);
    this.terms = [];
    this.root = null;
    this.ro.disconnect();
    this.subs.forEach(f => f());
  }
}

let uidSeq = 0;

class Term {
  constructor(panel, { id = null, host, cwd = '' }) {
    this.uid = ++uidSeq;
    this.panel = panel;
    this.ws = panel.ws;
    this.id = id;
    this.host = host;
    this.cwd = cwd;
    this.offset = null;
    this.title = '';
    this.name = null;
    this.color = null;
    this.n = ++panel.n;
    this.exited = false;
    this.gone = false;
    this.retries = 0;
    this.el = h('<div class="term-host" hidden></div>');
    panel.el.appendChild(this.el);  // measured in the page, then moved into its group
    this.x = new window.Terminal({
      fontFamily: codeFont(),
      fontSize: settings.get('terminal.fontSize'),
      lineHeight: settings.get('terminal.lineHeight'),
      fontWeight: 400,
      fontWeightBold: 600,
      cursorBlink: settings.get('terminal.cursorBlink'),
      cursorStyle: settings.get('terminal.cursorStyle'),
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      allowTransparency: false,
      allowProposedApi: true,
      drawBoldTextInBrightColors: false,
      scrollback: settings.get('terminal.scrollback'),
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      theme: terminalTheme(),
    });
    this.fitter = new window.FitAddon.FitAddon();
    this.x.loadAddon(this.fitter);
    this.x.loadAddon(new window.WebLinksAddon.WebLinksAddon((ev, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    try {
      this.x.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      this.x.unicode.activeVersion = '11';
    } catch { /* optional */ }
    this.x.open(this.el);
    this.el.xterm = this.x;  // handy from devtools: the rows may be on a canvas
    this.setWebgl(settings.get('terminal.webgl'));
    this.x.onData(d => {
      if (this.exited) { if (d === '\r') this.restart(); return; }
      this.panel.onInput(d);
      this.send({ t: 'i', d });
    });
    this.x.onBinary(d => {
      if (this.sock && this.sock.readyState === 1) this.sock.send(Uint8Array.from(d, c => c.charCodeAt(0) & 255));
    });
    this.x.onResize(({ cols, rows }) => { if (!this.replaying) this.send({ t: 'r', c: cols, r: rows }); });
    this.x.onTitleChange(t => { this.title = t; const st = this.panel.stackOf(this); if (st) this.panel.renderTabs(st); });
    this.x.onBell(() => { if (settings.get('terminal.bell') === 'visual') this.panel.flash(this); });
    this.x.attachCustomKeyEventHandler(e => this.onKey(e));
    if (this.x.textarea) this.x.textarea.addEventListener('focus', () => this.panel.onFocus(this));
    this.el.addEventListener('mouseup', () => {
      if (settings.get('terminal.copyOnSelect') && this.x.hasSelection()) copyText(this.x.getSelection());
    });
    this.connect();
  }

  setWebgl(on) {
    if (on && !this.gl && webglOk()) {
      try {
        const gl = new window.WebglAddon.WebglAddon();
        gl.onContextLoss(() => { gl.dispose(); if (this.gl === gl) this.gl = null; });  // back to the DOM renderer
        this.x.loadAddon(gl);
        this.gl = gl;
      } catch { this.gl = null; }
    } else if (!on && this.gl) {
      this.gl.dispose();
      this.gl = null;
    }
  }

  autoLabel() {
    const t = this.title.trim();
    const m = t.match(/^[^@\s]+@[^:\s]+:\s*(.+)$/);
    if (m) return m[1] === '~' ? '~' : basename(m[1]);
    return t || `Terminal ${this.n}`;
  }

  label() { return this.name || this.autoLabel(); }

  tooltip() { return `${hostLabel(this.host)} — ${this.title || this.cwd || '~'}${this.name ? ` (${this.autoLabel()})` : ''}`; }

  dims() {
    try {
      const d = this.fitter.proposeDimensions();
      if (d && d.cols > 1 && d.rows > 1) return { cols: d.cols, rows: d.rows };
    } catch { /* not visible yet */ }
    const a = this.panel.active;
    if (a && a !== this && a.x.cols > 1) return { cols: a.x.cols, rows: a.x.rows };
    return { cols: this.x.cols, rows: this.x.rows };
  }

  fit() {
    if (this.replaying || this.el.hidden || !this.el.offsetParent) return;
    try { this.fitter.fit(); } catch { /* not measurable */ }
  }

  /** After being moved to another group: redraw what's on screen. */
  repaint() {
    try { this.x.refresh(0, this.x.rows - 1); } catch { /* disposed */ }
  }

  connect() {
    const { cols, rows } = this.dims();
    const q = this.id
      ? { id: this.id, ...(this.offset != null ? { offset: this.offset } : {}) }
      : { host: this.host, cwd: this.cwd, cols, rows, ws: this.ws.wsKey };
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?${new URLSearchParams(q)}`);
    sock.binaryType = 'arraybuffer';
    this.sock = sock;
    sock.onopen = () => { this.retries = 0; };
    sock.onmessage = ev => {
      if (typeof ev.data === 'string') { this.onControl(JSON.parse(ev.data)); return; }
      const data = new Uint8Array(ev.data);
      this.x.write(data);
      this.offset = (this.offset || 0) + data.byteLength;
      this.panel.onOutput(this);
    };
    sock.onclose = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      if (!this.exited && !this.gone && !this.disposed) this.reconnect();
    };
  }

  onControl(m) {
    // Replayed output is drawn at the size it was written for; resizes are
    // queued behind the data (an empty write's callback runs in order).
    if (m.t === 'hello') {
      const fresh = !this.id;
      this.id = m.id;
      if (fresh) this.panel.saveLayout();
      if (m.reset && this.offset) this.x.reset();
      this.offset = m.at;
      this.replaying = true;
      if (m.cols && m.rows) this.x.write('', () => this.x.resize(m.cols, m.rows));
    } else if (m.t === 'size') {
      this.x.write('', () => this.x.resize(m.c, m.r));
    } else if (m.t === 'live') {
      this.x.write('', () => {
        this.replaying = false;
        this.fit();
        const { cols, rows } = this.dims();
        this.send({ t: 'r', c: cols, r: rows });
      });
    } else if (m.t === 'exit') {
      this.markExited(m.code ? `Process exited with code ${m.code}` : 'Process completed');
    } else if (m.t === 'gone') {
      this.gone = true;
      this.markExited('Session ended');
    } else if (m.t === 'taken') {
      this.gone = true;
      this.markExited('Opened in another window');
    } else if (m.t === 'error') {
      this.gone = true;
      this.x.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
      this.markExited('Couldn’t start the terminal');
      if (m.auth) this.ws.conn(this.host).reconnect();
    }
  }

  markExited(why) {
    if (this.exited) return;
    this.exited = true;
    this.x.write(`\r\n\x1b[2m[${why} — press Return to start a new shell]\x1b[0m\r\n`);
    const st = this.panel.stackOf(this);
    if (st) this.panel.renderTabs(st);
  }

  restart() {
    this.exited = this.gone = false;
    this.id = null;
    this.offset = null;
    this.x.write('\r\n');
    this.connect();
    const st = this.panel.stackOf(this);
    if (st) this.panel.renderTabs(st);
  }

  reconnect() {
    if (this.retries >= 8 || !this.id) { this.gone = true; this.markExited('Disconnected'); return; }
    const delay = Math.min(8000, 400 * 2 ** this.retries++);
    setTimeout(() => { if (!this.disposed && !this.sock && !this.exited) this.connect(); }, delay);
  }

  send(obj) {
    if (this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify(obj));
  }

  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.x.paste(text);
    } catch {
      toast({ title: 'Paste with the keyboard', message: `The browser blocked clipboard access. Use ${isMac ? '⌘V' : 'Ctrl+Shift+V'} instead.` });
    }
    this.x.focus();
  }

  onKey(e) {
    if (e.type !== 'keydown') return true;
    const copyPaste = isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && e.shiftKey && !e.altKey;
    if (copyPaste && e.code === 'KeyC') {
      const s = this.x.getSelection();
      if (s) copyText(s);
      e.preventDefault();
      return false;
    }
    // Let the browser's own paste happen; xterm picks up the paste event.
    if (copyPaste && e.code === 'KeyV') return false;
    return true;
  }

  dispose(kill) {
    this.disposed = true;
    if (kill) this.send({ t: 'kill' });
    const sock = this.sock;
    this.sock = null;
    if (sock) setTimeout(() => sock.close(), kill ? 50 : 0);
    this.x.dispose();
    this.el.remove();
  }
}
