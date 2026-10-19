// The slide viewer for .pptx files: thumbnails down the side, the slides in
// one scrolling column (with their speaker notes), and Play for full screen.
// Slides are drawn only while they're on (or near) the screen.
import { Presentation } from './render.js';
import { icons } from '../icons.js';
import { esc, h, store, kbd } from '../util.js';
import { spinner } from '../ui.js';

let cssLink;
function loadCss() {
  if (cssLink) return cssLink;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/css/slides.css';
  cssLink = new Promise(resolve => { l.onload = l.onerror = resolve; });
  document.head.append(l);
  return cssLink;
}

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
const THUMB = 132;  // thumbnail width, px
const TOP = 52;     // a slide brought into view sits this far down, clear of the toolbar

/** Show the deck at `url` inside `el`. Returns the view (call dispose() when done). */
export function openSlides(el, opts) {
  const v = new SlidesView(el, opts);
  v.load();
  return v;
}

class SlidesView {
  constructor(el, { url, name, onDownload }) {
    this.el = el;
    this.url = url;
    this.name = name;
    this.onDownload = onDownload;
    this.prefs = { nav: true, notes: false, ...store.get('slides', {}) };
    this.zoom = 1;
    this.current = 0;
    this.frac = null;           // where in the current slide the view is (null: the very top)
    this.abort = new AbortController();
    this.mounted = new Map();   // holder → rendered slide (main column and thumbnails)
    el.innerHTML = `<div class="sv">
      <aside class="sv-nav" aria-label="Slides"></aside>
      <div class="sv-main" tabindex="-1"><div class="sv-list"></div></div>
      <div class="sv-bar" hidden>
        <button class="ib sm" data-sv="nav" title="Show Slide Thumbnails">${icons.sidebar}</button>
        <span class="sv-count"></span>
        <span class="sv-sep"></span>
        <button class="ib sm" data-sv="out" title="Zoom Out (${kbd('Mod+-')})">${icons.minus}</button>
        <button class="sv-zoom" data-sv="fit" title="Fit Slides to the Window (${kbd('Mod+0')})">100%</button>
        <button class="ib sm" data-sv="in" title="Zoom In (${kbd('Mod+=')})">${icons.plus}</button>
        <span class="sv-sep"></span>
        <button class="ib sm" data-sv="notes" title="Show Speaker Notes">${icons.notes}</button>
        <button class="ib sm" data-sv="download" title="Download">${icons.download}</button>
        <button class="sv-play" data-sv="play" title="Play from This Slide (${kbd('Mod+Enter')})">${icons.play}<span>Play</span></button>
      </div>
      <div class="sv-state">${spinner(22)}</div>
    </div>`;
    this.root = el.firstElementChild;
    this.nav = this.root.querySelector('.sv-nav');
    this.main = this.root.querySelector('.sv-main');
    this.list = this.root.querySelector('.sv-list');
    this.bar = this.root.querySelector('.sv-bar');
    this.state = this.root.querySelector('.sv-state');
    this.countEl = this.root.querySelector('.sv-count');
    this.zoomEl = this.root.querySelector('.sv-zoom');
    this.root.addEventListener('click', e => this.onClick(e));
    this.main.addEventListener('keydown', e => this.onKey(e));
    this.main.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.main.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.applyPrefs();
  }

  async load() {
    await loadCss();
    try {
      this.pres = await Presentation.open(this.url, { signal: this.abort.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      this.fail(e);
      return;
    }
    if (this.disposed) { this.pres.dispose(); return; }
    if (!this.pres.count) { this.fail(new Error('This presentation has no slides.')); return; }
    this.build();
  }

  fail(e) {
    const ole = e && e.message === 'ole';
    const title = ole ? 'Can’t show this presentation' : 'Couldn’t open the presentation';
    const msg = ole
      ? 'It’s password-protected or in the old PowerPoint format (.ppt). Download it to open it in PowerPoint or Keynote.'
      : e && /not a zip|damaged|not a presentation/.test(e.message) ? `“${this.name}” isn’t a PowerPoint file sshcode can read.` : (e && e.message) || String(e);
    this.state.innerHTML = `<div class="note"><div class="big">${icons.slides}</div><h3>${esc(title)}</h3><div>${esc(msg)}</div>
      <div class="btns"><button class="btn primary" data-sv="download">Download</button></div></div>`;
    this.state.hidden = false;
  }

  build() {
    const { pres } = this;
    this.state.hidden = true;
    this.bar.hidden = false;
    this.root.style.setProperty('--ratio', String(pres.height / pres.width));
    this.root.style.setProperty('--tk', String(THUMB / pres.width));
    const thumbs = [], slides = [];
    let section = null;
    pres.slides.forEach((s, i) => {
      if (s.section != null && s.section !== section) {
        section = s.section;
        thumbs.push(`<div class="sv-section">${esc(section)}</div>`);
      }
      thumbs.push(`<button class="sv-thumb${s.hidden ? ' hidden-slide' : ''}" data-i="${i}" title="Slide ${i + 1}${s.hidden ? ' (hidden)' : ''}"><span class="n">${i + 1}</span><span class="sv-frame" data-i="${i}"></span></button>`);
      slides.push(`<div class="sv-item${s.hidden ? ' hidden-slide' : ''}" data-i="${i}"><div class="sv-slide" data-i="${i}"></div><div class="sv-notes" hidden></div></div>`);
    });
    this.nav.innerHTML = thumbs.join('');
    this.list.innerHTML = slides.join('');
    this.items = [...this.list.querySelectorAll('.sv-item')];
    this.frames = [...this.nav.querySelectorAll('.sv-frame')];
    this.thumbs = [...this.nav.querySelectorAll('.sv-thumb')];
    // Draw what's near the screen; let go of what's far away.
    const watch = (root, margin) => new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) this.mount(e.target);
        else this.unmount(e.target);
      }
    }, { root, rootMargin: margin });
    this.mainIo = watch(this.main, '120% 0px');
    this.navIo = watch(this.nav, '150% 0px');
    for (const it of this.items) this.mainIo.observe(it.querySelector('.sv-slide'));
    for (const f of this.frames) this.navIo.observe(f);
    // Switching editor tabs takes the view out of the page, which forgets its
    // scroll position; the current slide (and where in it) brings it back.
    this.ro = new ResizeObserver(() => {
      if (!this.main.clientWidth) { this.detached = true; return; }
      this.detached = false;
      this.layout();
    });
    this.ro.observe(this.main);
    this.layout();
    this.setCurrent(0);
  }

  applyPrefs() {
    this.root.classList.toggle('no-nav', !this.prefs.nav);
    this.root.classList.toggle('with-notes', !!this.prefs.notes);
    this.bar.querySelector('[data-sv="nav"]').classList.toggle('on', !!this.prefs.nav);
    this.bar.querySelector('[data-sv="notes"]').classList.toggle('on', !!this.prefs.notes);
    if (this.items) for (const [holder] of this.mounted) if (holder.classList.contains('sv-slide')) this.loadNotes(holder);
  }

  savePrefs() { store.set('slides', { nav: this.prefs.nav, notes: this.prefs.notes }); }

  /** Size every slide to fit the window (times the zoom), keeping the current one in view. */
  layout() {
    if (!this.pres) return;
    const { width: W, height: H } = this.pres;
    const r = this.main.getBoundingClientRect();
    if (!r.width) return;
    const padX = 28, padY = 56;
    const fit = Math.max(0.05, Math.min((r.width - padX * 2) / W, (r.height - padY - 24) / H));
    const k = fit * this.zoom;
    const anchor = this.items[this.current];
    this.k = k;
    this.root.style.setProperty('--k', String(k));
    this.root.style.setProperty('--sw', `${W * k}px`);
    this.root.style.setProperty('--sh', `${H * k}px`);
    this.zoomEl.textContent = `${Math.round(this.zoom * 100)}%`;
    if (anchor) this.main.scrollTop = this.frac == null ? 0 : anchor.offsetTop + this.frac * anchor.offsetHeight;
  }

  async mount(holder) {
    if (this.mounted.has(holder) || !this.pres) return;
    const i = +holder.dataset.i;
    const token = {};
    this.mounted.set(holder, token);
    let el;
    try {
      el = await this.pres.render(i, { onJump: t => this.jump(t) });
    } catch (e) {
      el = document.createElement('div');
      el.className = 'sv-error';
      el.textContent = `Slide ${i + 1} couldn’t be drawn: ${e.message || e}`;
    }
    if (this.mounted.get(holder) !== token) return;  // scrolled away meanwhile
    holder.replaceChildren(el);
    if (holder.classList.contains('sv-slide')) this.loadNotes(holder);
  }

  unmount(holder) {
    if (!this.mounted.has(holder)) return;
    this.mounted.delete(holder);
    holder.replaceChildren();
  }

  async loadNotes(holder) {
    const box = holder.nextElementSibling;
    if (!this.prefs.notes) { box.hidden = true; return; }
    const i = +holder.dataset.i;
    if (!box.dataset.loaded) {
      box.dataset.loaded = '1';
      const notes = await this.pres.notes(i).catch(() => null);
      if (notes) box.innerHTML = notes.map(n => `<p class="lv${Math.min(n.level, 4)}">${esc(n.text) || '&nbsp;'}</p>`).join('');
      else box.innerHTML = '';
    }
    box.hidden = !box.innerHTML;
  }

  onScroll() {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (!this.items || this.detached || !this.main.clientWidth) return;
      // The current slide is the one crossing the upper third of the window.
      const line = this.main.scrollTop + this.main.clientHeight / 3;
      let i = 0;
      for (let k = 0; k < this.items.length; k++) {
        if (this.items[k].offsetTop <= line) i = k;
        else break;
      }
      const it = this.items[i];
      this.frac = it.offsetHeight ? (this.main.scrollTop - it.offsetTop) / it.offsetHeight : 0;
      if (i !== this.current) this.setCurrent(i, { scrollNav: true });
    });
  }

  setCurrent(i, { scrollNav = true } = {}) {
    this.current = i;
    this.countEl.textContent = `${i + 1} of ${this.pres.count}`;
    for (const t of this.thumbs) t.classList.toggle('on', +t.dataset.i === i);
    if (scrollNav && this.prefs.nav) {
      const t = this.thumbs[i];
      const n = this.nav;
      if (t && (t.offsetTop < n.scrollTop || t.offsetTop + t.offsetHeight > n.scrollTop + n.clientHeight)) {
        n.scrollTop = t.offsetTop - n.clientHeight / 2 + t.offsetHeight / 2;
      }
    }
  }

  go(i, { smooth = false } = {}) {
    if (!this.items) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    const it = this.items[i];
    const top = it.offsetTop - TOP;
    this.frac = it.offsetHeight ? -TOP / it.offsetHeight : 0;
    this.main.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    this.setCurrent(i);
  }

  /** A link inside a slide: a slide number, or nextslide / previousslide / firstslide / lastslide. */
  jump(t, from = this.current) {
    const n = this.pres.count;
    const target = /^\d+$/.test(t) ? +t : t === 'nextslide' ? from + 1 : t === 'previousslide' ? from - 1 : t === 'firstslide' ? 0 : t === 'lastslide' ? n - 1 : null;
    if (target == null) return;
    if (this.show) this.show.go(target);
    else this.go(target, { smooth: true });
  }

  setZoom(z) {
    this.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    this.layout();
  }

  step(dir) {
    const next = dir > 0 ? ZOOMS.find(z => z > this.zoom + 1e-3) : [...ZOOMS].reverse().find(z => z < this.zoom - 1e-3);
    if (next) this.setZoom(next);
  }

  onWheel(e) {
    if (!(e.ctrlKey || e.metaKey) || !this.pres) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY / 300));
  }

  onKey(e) {
    if (!this.pres || e.target.closest('input, textarea, video, audio')) return;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && (e.key === '=' || e.key === '+')) this.step(1);
    else if (mod && e.key === '-') this.step(-1);
    else if (mod && e.key === '0') this.setZoom(1);
    else if (mod && e.key === 'Enter') this.play(e.shiftKey ? 0 : this.current);
    else if (mod || e.altKey) handled = false;
    else if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) this.go(this.current + 1);
    else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) this.go(this.current - 1);
    else if (e.key === 'Home') this.go(0);
    else if (e.key === 'End') this.go(this.pres.count - 1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  onClick(e) {
    const b = e.target.closest('[data-sv]');
    const thumb = e.target.closest('.sv-thumb');
    if (thumb) { this.go(+thumb.dataset.i); this.main.focus({ preventScroll: true }); return; }
    if (!b) {
      if (e.target.closest('.sv-main') && !e.target.closest('a, button, video, audio')) this.main.focus({ preventScroll: true });
      return;
    }
    switch (b.dataset.sv) {
      case 'nav': this.prefs.nav = !this.prefs.nav; this.applyPrefs(); this.savePrefs(); requestAnimationFrame(() => this.layout()); break;
      case 'notes': this.prefs.notes = !this.prefs.notes; this.applyPrefs(); this.savePrefs(); break;
      case 'in': this.step(1); break;
      case 'out': this.step(-1); break;
      case 'fit': this.setZoom(1); break;
      case 'play': this.play(this.current); break;
      case 'download': if (this.onDownload) this.onDownload(); break;
    }
  }

  focus() { this.main.focus({ preventScroll: true }); }

  // --- presenting ----------------------------------------------------------------------

  play(from) {
    if (!this.pres || this.show) return;
    this.show = new Show(this, from);
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    if (this.show) this.show.close();
    if (this.mainIo) this.mainIo.disconnect();
    if (this.navIo) this.navIo.disconnect();
    if (this.ro) this.ro.disconnect();
    if (this.pres) this.pres.dispose();
    this.mounted.clear();
  }
}

/** Full-screen presenting: one slide at a time, hidden slides skipped. */
class Show {
  constructor(view, from) {
    this.view = view;
    this.pres = view.pres;
    this.el = h(`<div class="sv-show" tabindex="-1">
      <div class="sv-stage"></div>
      <div class="sv-ctl">
        <button class="ib sm" data-k="prev" title="Previous Slide">${icons.chevronLeft}</button>
        <span class="sv-pos"></span>
        <button class="ib sm" data-k="next" title="Next Slide">${icons.chevronRight}</button>
        <span class="sv-sep"></span>
        <button class="ib sm" data-k="exit" title="End Show (Esc)">${icons.xmark}</button>
      </div>
    </div>`);
    this.stage = this.el.querySelector('.sv-stage');
    this.pos = this.el.querySelector('.sv-pos');
    this.cache = new Map();
    this.typed = '';
    document.body.append(this.el);
    this.onKey = e => this.key(e);
    this.onResize = () => this.fit();
    this.onFs = () => { if (!document.fullscreenElement && this.wasFull) this.close(); };
    this.el.addEventListener('keydown', this.onKey);
    this.el.addEventListener('click', e => this.click(e));
    this.el.addEventListener('mousemove', () => this.wake());
    window.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onFs);
    if (this.el.requestFullscreen) {
      this.el.requestFullscreen().then(() => { this.wasFull = true; }, () => {});
    }
    this.el.focus();
    const start = this.visible(from, 1) ?? this.visible(from, -1) ?? from;
    this.go(start);
    this.wake();
  }

  /** The nearest slide that isn't hidden, from `i` in direction `dir`. */
  visible(i, dir) {
    for (let k = i; k >= 0 && k < this.pres.count; k += dir) if (!this.pres.slides[k].hidden) return k;
    return null;
  }

  render(i) {
    if (!this.cache.has(i)) this.cache.set(i, this.pres.render(i, { onJump: t => this.view.jump(t, this.i) }));
    // Keep a few slides around: the ones next to the current one come back instantly.
    for (const k of this.cache.keys()) if (Math.abs(k - i) > 2) this.cache.delete(k);
    return this.cache.get(i);
  }

  async go(i) {
    if (i == null || i < 0 || i >= this.pres.count) return;
    this.i = i;
    this.pos.textContent = `${i + 1} of ${this.pres.count}`;
    const el = await this.render(i);
    if (this.i !== i || this.closed) return;
    this.stage.replaceChildren(el);
    this.fit();
    const next = this.visible(i + 1, 1);
    if (next != null) this.render(next);
  }

  fit() {
    const { width: W, height: H } = this.pres;
    const k = Math.min(window.innerWidth / W, window.innerHeight / H);
    this.stage.style.width = `${W * k}px`;
    this.stage.style.height = `${H * k}px`;
    this.stage.style.setProperty('--k', String(k));
  }

  next() { const n = this.visible(this.i + 1, 1); if (n != null) this.go(n); else this.close(); }
  prev() { const p = this.visible(this.i - 1, -1); if (p != null) this.go(p); }

  key(e) {
    const k = e.key;
    let handled = true;
    if (/^\d$/.test(k)) { this.typed += k; }
    else if (k === 'Enter' && this.typed) { this.go(Math.min(this.pres.count, +this.typed) - 1); this.typed = ''; }
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) this.next();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) this.prev();
    else if (k === 'Home') this.go(this.visible(0, 1));
    else if (k === 'End') this.go(this.visible(this.pres.count - 1, -1));
    else if (k === 'Escape') this.close();
    else handled = false;
    if (!/^\d$/.test(k) && k !== 'Enter') this.typed = '';
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  click(e) {
    const b = e.target.closest('[data-k]');
    if (b) {
      e.stopPropagation();
      if (b.dataset.k === 'prev') this.prev();
      else if (b.dataset.k === 'next') this.next();
      else this.close();
      return;
    }
    if (e.target.closest('a, button, video, audio')) return;
    this.next();
  }

  wake() {
    this.el.classList.add('awake');
    clearTimeout(this.sleepT);
    this.sleepT = setTimeout(() => this.el.classList.remove('awake'), 1800);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.sleepT);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('fullscreenchange', this.onFs);
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    this.el.remove();
    this.view.show = null;
    this.view.go(this.i);
    this.view.focus();
  }
}
