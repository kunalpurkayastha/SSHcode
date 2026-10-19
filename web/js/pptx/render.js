// Draws the slides of a .pptx. Reads the package (presentation, slides,
// layouts, masters, themes), then builds each slide as positioned HTML and
// SVG at 96 dpi (1 px = 9525 EMU); the viewer scales the result. Text stays
// text, so it's sharp at any zoom and can be selected and copied.
import { Zip } from './zip.js';
import {
  EMU, px, kid, kids, find, children, attr, num, bool, rid, parseXml, pct,
  color, css, readTheme, fillEl, readFill, themeFill, fillColor, readLine, themeLine, readShadow, themeEffect, shadeFor,
} from './ooxml.js';
import { geometry, isLineShape } from './geometry.js';
import { renderText, levelStyles, bodyProps, fontStack } from './text.js';
import { renderTable } from './table.js';
import { renderChart } from './chart.js';
import { metafileToSvg } from './metafile.js';

const SVG = 'http://www.w3.org/2000/svg';
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', oga: 'audio/ogg',
};
export const ext = p => (/\.([a-z0-9]+)$/i.exec(p || '') || [])[1]?.toLowerCase() || '';
const relType = t => (t || '').slice((t || '').lastIndexOf('/') + 1);

let uid = 0;
const nextId = () => `pp${(++uid).toString(36)}`;

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, typeof v === 'number' ? +v.toFixed(2) : v);
  return el;
}

function div(cls, parent) {
  const d = document.createElement('div');
  d.className = cls;
  if (parent) parent.append(d);
  return d;
}

/** Position an element at a box {x, y, w, h, rot} (px, degrees). */
function place(el, b) {
  const s = el.style;
  s.left = `${+b.x.toFixed(2)}px`;
  s.top = `${+b.y.toFixed(2)}px`;
  s.width = `${+Math.max(0, b.w).toFixed(2)}px`;
  s.height = `${+Math.max(0, b.h).toFixed(2)}px`;
  if (b.rot) s.transform = `rotate(${+b.rot.toFixed(3)}deg)`;
  return el;
}

function readXfrm(x) {
  const off = kid(x, 'off'), e = kid(x, 'ext');
  return { x: num(off, 'x', 0), y: num(off, 'y', 0), w: num(e, 'cx', 0), h: num(e, 'cy', 0), rot: num(x, 'rot', 0) / 60000, flipH: bool(x, 'flipH'), flipV: bool(x, 'flipV') };
}
const topMap = b => ({ ...b, x: b.x / EMU, y: b.y / EMU, w: b.w / EMU, h: b.h / EMU });

/** Resolve a relationship target against the part that holds it. */
function resolve(base, target) {
  if (/^[a-z][\w+.-]*:/i.test(target)) return target;
  let t = target;
  try { t = decodeURIComponent(target); } catch { /* keep as is */ }
  const parts = t.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const s of t.split('/')) {
    if (s === '..') parts.pop();
    else if (s && s !== '.') parts.push(s);
  }
  return parts.join('/');
}

// --- the package ----------------------------------------------------------------------

class Package {
  constructor(zip) {
    this.zip = zip;
    this.docs = new Map();
    this.relsCache = new Map();
    this.urls = new Map();
    this.pathOf = new WeakMap();  // XML document → its part name
  }

  has(path) { return this.zip.has(path); }

  xml(path) {
    if (!this.docs.has(path)) {
      this.docs.set(path, this.zip.text(path).then(t => {
        const doc = parseXml(t);
        this.pathOf.set(doc, path);
        return doc;
      }));
    }
    return this.docs.get(path);
  }

  /** The relationships of a part: id → {type, target, external}. */
  rels(path) {
    if (!this.relsCache.has(path)) {
      const i = path.lastIndexOf('/');
      const relsPath = `${path.slice(0, i + 1)}_rels/${path.slice(i + 1)}.rels`;
      this.relsCache.set(path, (async () => {
        const map = new Map();
        if (!this.zip.has(relsPath)) return map;
        const doc = await this.xml(relsPath);
        for (const r of doc.documentElement.children) {
          const external = attr(r, 'TargetMode') === 'External';
          const target = attr(r, 'Target') || '';
          map.set(attr(r, 'Id'), { type: relType(attr(r, 'Type')), target: external ? target : resolve(path, target), external });
        }
        return map;
      })());
    }
    return this.relsCache.get(path);
  }

  /** An EMF/WMF picture redrawn as SVG: a blob: URL, or null (cached). */
  metafile(path) {
    if (!this.urls.has(path)) {
      this.urls.set(path, this.zip.bytes(path).then(b => {
        const svg = metafileToSvg(b);
        return svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : null;
      }));
    }
    return this.urls.get(path);
  }

  /** A blob: URL for a media part (cached). */
  url(path) {
    if (!this.urls.has(path)) {
      this.urls.set(path, this.zip.bytes(path).then(b => URL.createObjectURL(new Blob([b], { type: MIME[ext(path)] || 'application/octet-stream' }))));
    }
    return this.urls.get(path);
  }

  dispose() {
    for (const p of this.urls.values()) p.then(u => u && URL.revokeObjectURL(u), () => {});
    this.urls.clear();
  }
}

// --- the presentation -----------------------------------------------------------------------

const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const OTHER_TYPES = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
const masterType = t => (t === 'ctrTitle' ? 'title' : TITLE_TYPES.has(t) || OTHER_TYPES.has(t) ? t : 'body');

function placeholders(tree) {
  const byIdx = new Map(), byType = new Map();
  for (const el of children(tree)) {
    const nv = kid(el, 'nvSpPr') || kid(el, 'nvPicPr') || kid(el, 'nvGraphicFramePr') || kid(el, 'nvCxnSpPr');
    const ph = find(nv, 'nvPr', 'ph');
    if (!ph) continue;
    const idx = attr(ph, 'idx'), type = attr(ph, 'type') || 'obj';
    if (idx != null && !byIdx.has(idx)) byIdx.set(idx, el);
    if (!byType.has(type)) byType.set(type, el);
  }
  return { byIdx, byType };
}

export class Presentation {
  constructor(pkg) {
    this.pkg = pkg;
    this.parts = new Map();
    this.themes = new Map();
    this.infos = new Map();
    this.slides = [];
  }

  /** Open the .pptx served at `url`. */
  static async open(url, { signal } = {}) {
    const zip = await Zip.open(url, { signal });
    const p = new Presentation(new Package(zip));
    await p.load();
    return p;
  }

  async load() {
    const { pkg } = this;
    const root = await pkg.rels('');
    const main = [...root.values()].find(r => r.type === 'officeDocument');
    this.main = main ? main.target : 'ppt/presentation.xml';
    if (!pkg.has(this.main)) throw new Error('not a presentation');
    // Over Range requests, fetch every XML part up front in a few big requests.
    await pkg.zip.prefetch([...pkg.zip.entries.keys()].filter(n => /\.(xml|rels)$/i.test(n)));
    const doc = await pkg.xml(this.main);
    const pres = doc.documentElement;
    const sz = kid(pres, 'sldSz');
    this.width = px(attr(sz, 'cx', 9144000)) || 960;
    this.height = px(attr(sz, 'cy', 6858000)) || 720;
    this.defaultTextStyle = kid(pres, 'defaultTextStyle');
    this.firstNum = num(pres, 'firstSlideNum', 1);
    const rels = await pkg.rels(this.main);
    const ids = new Map();
    for (const s of kids(kid(pres, 'sldIdLst'), 'sldId')) {
      const r = rels.get(rid(s));
      if (r && pkg.has(r.target)) {
        ids.set(attr(s, 'id'), this.slides.length);
        this.slides.push({ path: r.target, hidden: false, section: null });
      }
    }
    // Sections (PowerPoint 2010+), kept in an extension.
    for (const sec of doc.getElementsByTagNameNS('*', 'section')) {
      for (const s of sec.getElementsByTagNameNS('*', 'sldId')) {
        const i = ids.get(attr(s, 'id'));
        if (i != null && this.slides[i].section == null) this.slides[i].section = attr(sec, 'name') || '';
      }
    }
    const ts = [...rels.values()].find(r => r.type === 'tableStyles');
    this.tableStyles = ts && pkg.has(ts.target) ? (await pkg.xml(ts.target)).documentElement : null;
    // Read every slide now: the list needs to know which are hidden.
    await Promise.all(this.slides.map(async s => {
      try {
        const d = await pkg.xml(s.path);
        s.hidden = attr(d.documentElement, 'show') === '0';
      } catch { /* drawn as an error later */ }
    }));
  }

  get count() { return this.slides.length; }

  async part(path) {
    if (!this.parts.has(path)) {
      this.parts.set(path, (async () => {
        const [doc, rels] = await Promise.all([this.pkg.xml(path), this.pkg.rels(path)]);
        const rel = type => { for (const r of rels.values()) if (r.type === type && !r.external) return r.target; return null; };
        return { path, doc, root: doc.documentElement, rels, rel };
      })());
    }
    return this.parts.get(path);
  }

  async theme(path) {
    if (!this.themes.has(path)) this.themes.set(path, path && this.pkg.has(path) ? this.part(path).then(p => readTheme(p.doc)) : Promise.resolve(readTheme(null)));
    return this.themes.get(path);
  }

  /** The slide with its layout, master, theme and colour map. */
  info(i) {
    if (!this.infos.has(i)) {
      this.infos.set(i, (async () => {
        const slide = await this.part(this.slides[i].path);
        const layoutPath = slide.rel('slideLayout');
        const layout = layoutPath ? await this.part(layoutPath) : null;
        const masterPath = layout && layout.rel('slideMaster');
        const master = masterPath ? await this.part(masterPath) : null;
        const theme = await this.theme(master && master.rel('theme'));
        const map = {};
        const clrMap = master && kid(master.root, 'clrMap');
        if (clrMap) for (const a of clrMap.attributes) map[a.name] = a.value;
        for (const p of [layout, slide]) {
          const o = p && find(p.root, 'clrMapOvr', 'overrideClrMapping');
          if (o) for (const a of o.attributes) map[a.name] = a.value;
        }
        const tree = p => p && find(p.root, 'cSld', 'spTree');
        return {
          index: i, slide, layout, master, theme,
          cx: { scheme: theme.scheme, map },
          layoutPh: placeholders(tree(layout)), masterPh: placeholders(tree(master)),
        };
      })());
    }
    return this.infos.get(i);
  }

  /** Placeholders a slide placeholder inherits from: [layout's, master's]. */
  inherited(ph, info) {
    const type = attr(ph, 'type'), idx = attr(ph, 'idx');
    let lay = null;
    if (idx != null) lay = info.layoutPh.byIdx.get(idx) || null;
    if (!lay) lay = info.layoutPh.byType.get(type || 'obj') || (type === 'ctrTitle' ? info.layoutPh.byType.get('title') : null) || null;
    const layPh = lay && find(kid(lay, 'nvSpPr') || kid(lay, 'nvPicPr') || kid(lay, 'nvGraphicFramePr'), 'nvPr', 'ph');
    const t = type || attr(layPh, 'type') || 'body';
    const mas = info.masterPh.byType.get(masterType(t)) || (t === 'ctrTitle' ? info.masterPh.byType.get('title') : null) || null;
    return { list: [lay, mas].filter(Boolean), type: t };
  }

  /** Inherited placeholders for a layout placeholder: just the master's. */
  inheritedFromMaster(ph, info) {
    const t = attr(ph, 'type') || 'body';
    const mas = info.masterPh.byType.get(masterType(t));
    return { list: mas ? [mas] : [], type: t };
  }

  async preload(info) {
    // Charts and diagrams live in their own parts: load them before drawing.
    const jobs = [];
    for (const p of [info.slide, info.layout, info.master]) {
      if (!p) continue;
      for (const r of p.rels.values()) {
        if (r.external || !this.pkg.has(r.target)) continue;
        if (r.type === 'chart' || r.type === 'diagramDrawing' || r.type === 'diagramData') jobs.push(this.part(r.target).catch(() => null));
      }
    }
    await Promise.all(jobs);
  }

  /** Charts measure their labels: the theme's fonts have to be in before that. */
  fonts(theme) {
    const faces = [theme.fonts.minor.latin, theme.fonts.major.latin].filter(Boolean);
    const key = faces.join('|');
    this.fontLoads = this.fontLoads || new Map();
    if (!this.fontLoads.has(key)) {
      this.fontLoads.set(key, Promise.all(faces.flatMap(f => ['400', '700'].map(w => document.fonts.load(`${w} 16px ${fontStack(f)}`).catch(() => null)))));
    }
    return this.fontLoads.get(key);
  }

  /** Draw slide `i`: a div of width × height px. Pictures arrive a moment later. */
  async render(i, { onJump } = {}) {
    const info = await this.info(i);
    await Promise.all([this.preload(info), this.fonts(info.theme)]);
    const el = document.createElement('div');
    el.className = 'pptx-slide';
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    el.style.fontFamily = fontStack(info.theme.fonts.minor.latin || 'Calibri');
    const ctx = {
      pres: this, info, theme: info.theme, cx: info.cx, slideNum: this.firstNum + i, onJump,
      part: info.slide, inherit: ph => this.inherited(ph, info),
    };
    this.background(el, info, ctx);
    const show = p => !p || attr(p.root, 'showMasterSp') !== '0';
    const tree = p => find(p.root, 'cSld', 'spTree');
    if (info.master && show(info.slide) && show(info.layout)) this.tree(tree(info.master), { ...ctx, part: info.master, inherit: null, decor: true }, el, topMap);
    if (info.layout && show(info.slide)) this.tree(tree(info.layout), { ...ctx, part: info.layout, inherit: ph => this.inheritedFromMaster(ph, info), decor: true }, el, topMap);
    this.tree(tree(info.slide), ctx, el, topMap);
    return el;
  }

  dispose() { this.pkg.dispose(); }

  // --- media ------------------------------------------------------------------------

  /** The part a relationship id in `el`'s document points at. */
  async target(el, id) {
    if (!id) return null;
    const path = this.pkg.pathOf.get(el.ownerDocument);
    if (path == null) return null;
    const r = (await this.pkg.rels(path)).get(id);
    return r || null;
  }

  /** Set an image (blob: URL) on `node` once it's read: a:blip → node.href / node.src. */
  blip(blip, node, onMissing) {
    if (!blip) return;
    const svgBlip = [...blip.getElementsByTagNameNS('*', 'svgBlip')][0];
    const id = rid(svgBlip, 'embed') || rid(blip, 'embed');
    const set = url => {
      if (node.namespaceURI === SVG) node.setAttribute('href', url);
      else node.src = url;
    };
    this.target(blip, id).then(r => {
      if (!r || r.external || !this.pkg.has(r.target)) { if (onMissing) onMissing(r && ext(r.target)); return; }
      const e = ext(r.target);
      if (e === 'emf' || e === 'wmf') return this.pkg.metafile(r.target).then(url => (url ? set(url) : onMissing && onMissing(e)));
      if (!MIME[e] || !MIME[e].startsWith('image/')) { if (onMissing) onMissing(e); return; }
      return this.pkg.url(r.target).then(set);
    }).catch(() => onMissing && onMissing(null));
  }

  async mediaUrl(el, id) {
    const r = await this.target(el, id);
    if (!r || r.external || !this.pkg.has(r.target)) return null;
    return { url: await this.pkg.url(r.target), type: MIME[ext(r.target)] || '' };
  }

  async link(el, id) {
    const r = await this.target(el, id);
    if (!r) return null;
    if (r.external) return /^(https?|mailto|ftp):/i.test(r.target) ? { href: r.target } : null;
    const n = this.slides.findIndex(s => s.path === r.target);
    return n >= 0 ? { slide: n } : null;
  }

  // --- background -------------------------------------------------------------------

  background(el, info, ctx) {
    let bg = null;
    for (const p of [info.slide, info.layout, info.master]) {
      bg = p && find(p.root, 'cSld', 'bg');
      if (bg) break;
    }
    let fill = { type: 'solid', color: info.theme.scheme[ctx.cx.map.bg1 || 'lt1'] || { r: 255, g: 255, b: 255, a: 1 } };
    const bgPr = kid(bg, 'bgPr'), ref = kid(bg, 'bgRef');
    if (bgPr) fill = readFill(fillEl(bgPr), ctx.cx) || fill;
    else if (ref) fill = themeFill(info.theme, attr(ref, 'idx'), color(ref, ctx.cx), ctx.cx) || fill;
    el.style.background = '#fff';
    if (fill.type === 'none') return;
    const box = { x: 0, y: 0, w: this.width, h: this.height };
    const s = svg('svg', { width: box.w, height: box.h, class: 'p-bg' });
    const defs = svg('defs');
    s.append(defs, svg('rect', { width: box.w, height: box.h, fill: this.paint(fill, defs, box) }));
    el.append(s);
  }

  // --- paint ------------------------------------------------------------------------

  /** An SVG fill value for `fill` over `box`, adding gradients and patterns to `defs`. */
  paint(fill, defs, box, shade) {
    if (!fill || fill.type === 'none' || fill.type === 'grp') return 'none';
    if (fill.type === 'solid' || fill.type === 'patt') return css(shadeFor(fillColor(fill), shade));
    if (fill.type === 'grad') return `url(#${this.gradient(fill, defs, box, shade)})`;
    if (fill.type === 'blip') return `url(#${this.imagePattern(fill, defs, box)})`;
    return 'none';
  }

  gradient(f, defs, box, shade) {
    const id = nextId();
    const { w, h } = box;
    let g;
    if (f.path) {
      const cx = (f.focus.l + 1 - f.focus.r) / 2 * w, cy = (f.focus.t + 1 - f.focus.b) / 2 * h;
      const r = Math.max(1, ...[[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
      g = svg('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx, cy, r, fx: cx, fy: cy });
    } else {
      // In user space, so lines (which have no height) still get their gradient.
      // A "scaled" angle is measured in the unit square, then stretched with the box.
      const a = (f.angle || 0) * Math.PI / 180;
      let dx = Math.cos(a), dy = Math.sin(a);
      if (f.scaled) { dx /= Math.max(w, 1); dy /= Math.max(h, 1); }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const proj = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => (x - w / 2) * dx + (y - h / 2) * dy);
      const lo = Math.min(...proj), hi = Math.max(...proj, lo + 1e-3);
      g = svg('linearGradient', {
        id, gradientUnits: 'userSpaceOnUse',
        x1: w / 2 + dx * lo, y1: h / 2 + dy * lo, x2: w / 2 + dx * hi, y2: h / 2 + dy * hi,
      });
    }
    for (const s of f.stops) {
      const c = shadeFor(s.color, shade);
      g.append(svg('stop', { offset: s.pos, 'stop-color': `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`, 'stop-opacity': c.a }));
    }
    defs.append(g);
    return id;
  }

  /** A picture fill: stretched to the fill rectangle, cropped by srcRect, or tiled. */
  imagePattern(fill, defs, box) {
    const id = nextId();
    const { w, h } = box;
    const el = fill.el;
    const blip = kid(el, 'blip');
    const pat = svg('pattern', { id, patternUnits: 'userSpaceOnUse', width: Math.max(w, 0.01), height: Math.max(h, 0.01) });
    const img = svg('image', { preserveAspectRatio: 'none' });
    const src = kid(el, 'srcRect'), tile = kid(el, 'tile');
    if (tile) {
      // Tiles keep the picture's own size (at 96 dpi), scaled by sx/sy.
      const sx = pct(tile, 'sx', 1), sy = pct(tile, 'sy', 1), tx = px(attr(tile, 'tx', 0)), ty = px(attr(tile, 'ty', 0));
      const probe = new Image();
      probe.onload = () => {
        const tw = Math.max(1, probe.naturalWidth * sx), th = Math.max(1, probe.naturalHeight * sy);
        pat.setAttribute('width', tw);
        pat.setAttribute('height', th);
        pat.setAttribute('x', tx);
        pat.setAttribute('y', ty);
        img.setAttribute('width', tw);
        img.setAttribute('height', th);
      };
      this.blip(blip, img);
      this.blip(blip, probe);
    } else {
      const fr = find(el, 'stretch', 'fillRect');
      const fl = pct(fr, 'l', 0), ft = pct(fr, 't', 0), frr = pct(fr, 'r', 0), fb = pct(fr, 'b', 0);
      const l = pct(src, 'l', 0), t = pct(src, 't', 0), r = pct(src, 'r', 0), b = pct(src, 'b', 0);
      const fx = fl * w, fy = ft * h, fw = w * (1 - fl - frr), fh = h * (1 - ft - fb);
      const iw = fw / Math.max(0.001, 1 - l - r), ih = fh / Math.max(0.001, 1 - t - b);
      Object.entries({ x: fx - l * iw, y: fy - t * ih, width: iw, height: ih }).forEach(([k, v]) => img.setAttribute(k, +v.toFixed(2)));
      this.blip(blip, img, fill.onMissing);
    }
    const alpha = kid(blip, 'alphaModFix');
    if (alpha) img.setAttribute('opacity', pct(alpha, 'amt', 1));
    const duo = kid(blip, 'duotone');
    if (duo) img.setAttribute('filter', `url(#${this.duotone(duo, defs, fill.cx || {})})`);
    pat.append(img);
    defs.append(pat);
    return id;
  }

  /** Duotone recolouring: dark parts take the first colour, light parts the second. */
  duotone(duo, defs, cx) {
    const id = nextId();
    const cs = children(duo).map(c => color(c, cx)).filter(Boolean);
    const [a, b] = cs.length >= 2 ? cs : [{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }];
    const f = svg('filter', { id, 'color-interpolation-filters': 'sRGB', x: 0, y: 0, width: 1, height: 1 });
    f.append(svg('feColorMatrix', { type: 'matrix', values: '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0' }));
    const t = svg('feComponentTransfer');
    for (const [ch, k] of [['R', 'r'], ['G', 'g'], ['B', 'b']]) t.append(svg(`feFunc${ch}`, { type: 'table', tableValues: `${+(a[k] / 255).toFixed(4)} ${+(b[k] / 255).toFixed(4)}` }));
    f.append(t);
    defs.append(f);
    return id;
  }

  /** CSS filter for picture effects (greyscale, brightness/contrast…). */
  imageFilter(blip) {
    const f = [];
    for (const c of children(blip)) {
      if (c.localName === 'grayscl') f.push('grayscale(1)');
      else if (c.localName === 'biLevel') f.push('grayscale(1) contrast(8)');
      else if (c.localName === 'lum') {
        const br = pct(c, 'bright', 0), co = pct(c, 'contrast', 0);
        if (br) f.push(`brightness(${1 + br})`);
        if (co) f.push(`contrast(${1 + co})`);
      }
    }
    return f.join(' ');
  }

  // --- shapes ------------------------------------------------------------------------

  tree(tree, ctx, parent, map) {
    for (const el of children(tree)) {
      try {
        switch (el.localName) {
          case 'sp': case 'cxnSp': this.shape(el, ctx, parent, map); break;
          case 'pic': this.picture(el, ctx, parent, map); break;
          case 'grpSp': this.group(el, ctx, parent, map); break;
          case 'graphicFrame': this.frame(el, ctx, parent, map); break;
        }
      } catch (e) {
        console.warn('pptx: skipped a shape', e);
      }
    }
  }

  group(el, ctx, parent, map) {
    const gp = kid(el, 'grpSpPr');
    if (bool(find(el, 'nvGrpSpPr', 'cNvPr'), 'hidden')) return;
    const x = kid(gp, 'xfrm');
    if (!x) { this.tree(el, ctx, parent, map); return; }
    const xf = readXfrm(x);
    const box = map(xf);
    const chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
    const ox = num(chOff, 'x', xf.x), oy = num(chOff, 'y', xf.y);
    const cw = num(chExt, 'cx', xf.w) || xf.w, ch = num(chExt, 'cy', xf.h) || xf.h;
    const sx = cw ? box.w / cw : 1 / EMU, sy = ch ? box.h / ch : 1 / EMU;
    const wrap = place(div('p-sh p-grp', parent), box);
    const childMap = c => {
      let x0 = (c.x - ox) * sx, y0 = (c.y - oy) * sy, rot = c.rot, fh = c.flipH, fv = c.flipV;
      const w = c.w * sx, h = c.h * sy;
      if (box.flipH) { x0 = box.w - x0 - w; fh = !fh; rot = -rot; }
      if (box.flipV) { y0 = box.h - y0 - h; fv = !fv; rot = -rot; }
      return { x: x0, y: y0, w, h, rot, flipH: fh, flipV: fv };
    };
    const gf = readFill(fillEl(gp), ctx.cx);
    const shadow = readShadow(kid(gp, 'effectLst'), ctx.cx);
    if (shadow) wrap.style.filter = `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur / 2}px ${css(shadow.color)})`;
    this.tree(el, { ...ctx, groupFill: gf && gf.type !== 'grp' ? gf : ctx.groupFill }, wrap, childMap);
  }

  /** Shape properties down the placeholder chain: own, layout's, master's. */
  chain(el, ctx) {
    const nv = kid(el, 'nvSpPr') || kid(el, 'nvCxnSpPr') || kid(el, 'nvPicPr') || kid(el, 'nvGraphicFramePr');
    const ph = find(nv, 'nvPr', 'ph');
    const inh = ph && ctx.inherit ? ctx.inherit(ph) : { list: [], type: null };
    return { nv, ph, from: [el, ...inh.list], type: ph ? inh.type : null };
  }

  /** The fill, outline and shadow of a shape (with its style references). */
  look(from, ctx) {
    const { theme, cx } = ctx;
    const spPrs = from.map(s => kid(s, 'spPr'));
    const style = from.map(s => kid(s, 'style')).find(Boolean);
    let fill = null;
    for (const sp of spPrs) { const f = fillEl(sp); if (f) { fill = readFill(f, cx); break; } }
    const fillRef = kid(style, 'fillRef'), lnRef = kid(style, 'lnRef'), effRef = kid(style, 'effectRef');
    if (!fill && fillRef) fill = themeFill(theme, attr(fillRef, 'idx'), color(fillRef, cx), cx);
    if (fill && fill.type === 'grp') fill = ctx.groupFill || null;
    let line = lnRef ? themeLine(theme, attr(lnRef, 'idx'), color(lnRef, cx), cx) : null;
    for (const sp of [...spPrs].reverse()) {
      const ln = kid(sp, 'ln');
      if (ln) line = readLine(ln, cx, line);
    }
    let shadow = null, effects = null;
    for (const sp of spPrs) { effects = kid(sp, 'effectLst'); if (effects) break; }
    if (effects) shadow = readShadow(effects, cx);
    else if (effRef) shadow = themeEffect(theme, attr(effRef, 'idx'), color(effRef, cx), cx);
    return { fill, line, shadow, style };
  }

  shape(el, ctx, parent, map) {
    const { nv, from, type } = this.chain(el, ctx);
    if (bool(kid(nv, 'cNvPr'), 'hidden')) return;
    // Placeholders on layouts and masters are templates, not content.
    if (ctx.decor && find(nv, 'nvPr', 'ph')) return;
    const spPrs = from.map(s => kid(s, 'spPr'));
    const xfrm = spPrs.map(s => kid(s, 'xfrm')).find(Boolean);
    const txXfrm = kid(el, 'txXfrm');
    if (!xfrm) return;
    const box = map(readXfrm(xfrm));
    const geom = spPrs.map(s => kid(s, 'prstGeom') || kid(s, 'custGeom')).find(Boolean) || null;
    const look = this.look(from, ctx);
    const wrap = place(div('p-sh', parent), box);
    const g = this.drawGeometry(wrap, geom, box, look, ctx);
    const txBody = kid(el, 'txBody');
    if (!txBody) return;
    if (txXfrm) {
      // Diagram shapes keep their text in a box of its own.
      const tb = map(readXfrm(txXfrm));
      const holder = place(div('p-sh', parent), tb);
      this.text(holder, txBody, from, { ...tb, flipH: false, flipV: false }, { l: 0, t: 0, r: tb.w, b: tb.h }, ctx, type, look.style);
    } else {
      this.text(wrap, txBody, from, box, g.text, ctx, type, look.style);
    }
  }

  /** Fill and outline the shape's paths in an SVG covering `wrap`. */
  drawGeometry(wrap, geom, box, look, ctx) {
    const { w, h } = box;
    const g = geometry(geom, w, h);
    const { fill, line, shadow } = look;
    const hasFill = fill && fill.type !== 'none';
    const hasLine = !!line && !line.none && (line.fill ? line.fill.stops.some(st => st.color.a > 0) : !!line.color && line.color.a > 0);
    if (!hasFill && !hasLine) return g;
    // Lines have no width or no height; an empty SVG wouldn't be drawn at all.
    const s = svg('svg', { width: Math.max(w, 1), height: Math.max(h, 1), class: 'p-geo' });
    if (box.flipH || box.flipV) {
      s.style.transformOrigin = `${+(w / 2).toFixed(2)}px ${+(h / 2).toFixed(2)}px`;
      s.style.transform = `scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1})`;
    }
    const defs = svg('defs');
    s.append(defs);
    const lineOnly = isLineShape(attr(geom, 'prst'));
    // Every fill first, then every outline: some presets (chartPlus…) list their lines first.
    if (hasFill && !lineOnly) {
      for (const p of g.paths) if (p.fill !== 'none') s.append(svg('path', { d: p.d, fill: this.paint(fill, defs, box, p.fill) }));
    }
    const strokes = [];
    if (hasLine) {
      const lw = Math.max(line.width, 0.5);
      const paint = line.fill ? this.paint(line.fill, defs, box) : css(line.color);
      for (const p of g.paths) {
        if (!p.stroke) continue;
        const path = svg('path', {
          d: p.d, fill: 'none', stroke: paint, 'stroke-width': +lw.toFixed(2), 'stroke-linecap': line.cap, 'stroke-linejoin': line.join,
          'stroke-dasharray': line.dash ? line.dash.map(d => +(d * lw).toFixed(2)).join(' ') : null,
        });
        strokes.push(path);
        s.append(path);
      }
    }
    if (hasLine && strokes.length && (line.head || line.tail)) {
      const stops = line.fill ? line.fill.stops : null;
      if (line.head) strokes[0].setAttribute('marker-start', `url(#${this.marker(line.head, stops ? stops[0].color : line.color, line, defs, true)})`);
      if (line.tail) strokes[strokes.length - 1].setAttribute('marker-end', `url(#${this.marker(line.tail, stops ? stops[stops.length - 1].color : line.color, line, defs, false)})`);
    }
    if (shadow && shadow.color.a > 0) s.style.filter = `drop-shadow(${+shadow.x.toFixed(2)}px ${+shadow.y.toFixed(2)}px ${+(shadow.blur / 2).toFixed(2)}px ${css(shadow.color)})`;
    wrap.append(s);
    return g;
  }

  /** An arrowhead marker; sizes are multiples of the line width, as in PowerPoint. */
  marker(end, color, line, defs, start) {
    const id = nextId();
    const lw = Math.max(line.width, 0.5);
    const k = { sm: 2, med: 3, lg: 5 };
    const mw = (k[end.w] || 3) * (lw < 2 ? 1.5 : 1), ml = (k[end.len] || 3) * (lw < 2 ? 1.5 : 1);
    const m = svg('marker', { id, viewBox: `0 0 ${ml} ${mw}`, markerWidth: ml, markerHeight: mw, refX: ml, refY: mw / 2, orient: start ? 'auto-start-reverse' : 'auto', markerUnits: 'strokeWidth' });
    const c = css(color);
    let shape;
    switch (end.type) {
      case 'oval': shape = svg('ellipse', { cx: ml / 2, cy: mw / 2, rx: ml / 2, ry: mw / 2, fill: c }); m.setAttribute('refX', ml / 2); break;
      case 'diamond': shape = svg('path', { d: `M0 ${mw / 2}L${ml / 2} 0L${ml} ${mw / 2}L${ml / 2} ${mw}Z`, fill: c }); m.setAttribute('refX', ml / 2); break;
      case 'stealth': shape = svg('path', { d: `M0 0L${ml} ${mw / 2}L0 ${mw}L${ml * 0.3} ${mw / 2}Z`, fill: c }); break;
      case 'arrow': shape = svg('path', { d: `M${ml * 0.1} ${mw * 0.1}L${ml} ${mw / 2}L${ml * 0.1} ${mw * 0.9}`, fill: 'none', stroke: c, 'stroke-width': 0.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); break;
      default: shape = svg('path', { d: `M0 0L${ml} ${mw / 2}L0 ${mw}Z`, fill: c });
    }
    m.append(shape);
    defs.append(m);
    return id;
  }

  /** Lay out a text body inside `wrap` (the shape's box); `area` is the geometry's text rectangle. */
  text(wrap, txBody, from, box, area, ctx, phType, style) {
    const { cx, theme, info } = ctx;
    const body = bodyProps([...from].reverse().map(s => find(s, 'txBody', 'bodyPr')));
    const master = info.master && kid(info.master.root, 'txStyles');
    let base;
    if (!phType) base = kid(master, 'otherStyle');
    else if (TITLE_TYPES.has(phType)) base = kid(master, 'titleStyle');
    else if (OTHER_TYPES.has(phType)) base = kid(master, 'otherStyle');
    else base = kid(master, 'bodyStyle');
    const fontRef = kid(style, 'fontRef');
    let fontLink = null;
    if (fontRef) {
      const idx = attr(fontRef, 'idx');
      const c = color(fontRef, cx);
      fontLink = { run: { ...(idx === 'major' ? { latin: '+mj-lt', ea: '+mj-ea' } : idx === 'minor' ? { latin: '+mn-lt', ea: '+mn-ea' } : {}), ...(c ? { fill: { type: 'solid', color: c } } : {}) } };
    }
    const chain = [this.defaultTextStyle, base, ...[...from].slice(1).reverse().map(s => find(s, 'txBody', 'lstStyle')), fontLink, kid(txBody, 'lstStyle')];
    const block = renderText(txBody, {
      levels: levelStyles(chain, cx), body, cx, theme, slideNum: ctx.slideNum,
      link: (id, el) => this.linkSync(id, el, ctx),
      blip: (b, img) => this.blip(b, img),
    });
    if (!block) return;
    let { l, t, r, b } = area;
    if (box.flipH) [l, r] = [box.w - r, box.w - l];
    if (box.flipV) [t, b] = [box.h - b, box.h - t];
    const tx = div('p-tx', wrap);
    place(tx, { x: l + body.l, y: t + body.t, w: r - l - body.l - body.r, h: b - t - body.t - body.b });
    tx.style.justifyContent = { ctr: 'center', b: 'flex-end', just: 'center', dist: 'center' }[body.anchor] || 'flex-start';
    let rot = body.rot || 0;
    if (box.flipV) rot += 180;
    if (body.upright && box.rot) rot -= box.rot;
    if (body.vert === 'vert270') { tx.style.writingMode = 'vertical-rl'; rot += 180; }
    else if (body.vert === 'wordArtVert') { tx.style.writingMode = 'vertical-rl'; tx.style.textOrientation = 'upright'; }
    else if (body.vert && body.vert !== 'horz') tx.style.writingMode = body.vert === 'wordArtVertRtl' ? 'vertical-lr' : 'vertical-rl';
    if (rot % 360) tx.style.transform = `rotate(${rot}deg)`;
    if (!body.wrap || body.anchorCtr) {
      const first = kid(kid(txBody, 'p'), 'pPr');
      const algn = attr(first, 'algn') || (block.firstElementChild && block.firstElementChild.style.textAlign);
      tx.style.alignItems = body.anchorCtr ? 'center' : { ctr: 'center', center: 'center', r: 'flex-end', right: 'flex-end' }[algn] || 'flex-start';
      block.style.width = 'max-content';
      if (body.wrap) block.style.maxWidth = '100%';
      else { block.style.minWidth = '100%'; block.style.whiteSpace = 'pre'; }
    }
    if (body.cols > 1) {
      block.style.columnCount = body.cols;
      block.style.columnGap = `${body.colGap}px`;
      block.style.columnFill = 'auto';
      block.style.height = '100%';
    }
    tx.append(block);
    if (ctx.onJump) {
      block.addEventListener('click', e => {
        const a = e.target.closest('a[data-slide]');
        if (!a) return;
        e.preventDefault();
        ctx.onJump(a.dataset.slide);
      });
    }
  }

  /** Links are resolved while the slide is drawn, from rels loaded beforehand. */
  linkSync(id, el, ctx) {
    const path = this.pkg.pathOf.get(el.ownerDocument);
    const part = [ctx.info.slide, ctx.info.layout, ctx.info.master].find(p => p && p.path === path);
    const r = part && part.rels.get(id);
    if (!r) return null;
    if (r.external) return /^(https?|mailto|ftp):/i.test(r.target) ? { href: r.target } : null;
    const n = this.slides.findIndex(s => s.path === r.target);
    return n >= 0 ? { slide: String(n) } : null;
  }

  picture(el, ctx, parent, map, frameBox) {
    const { nv, from } = this.chain(el, ctx);
    if (bool(kid(nv, 'cNvPr'), 'hidden')) return;
    if (ctx.decor && find(nv, 'nvPr', 'ph')) return;
    const spPrs = from.map(s => kid(s, 'spPr'));
    const xfrm = spPrs.map(s => kid(s, 'xfrm')).find(Boolean);
    if (!xfrm && !frameBox) return;
    const box = frameBox || map(readXfrm(xfrm));
    const geom = spPrs.map(s => kid(s, 'prstGeom') || kid(s, 'custGeom')).find(Boolean) || null;
    const look = this.look(from, ctx);
    const blipFill = kid(el, 'blipFill');
    const blip = kid(blipFill, 'blip');
    const wrap = place(div('p-sh p-pic', parent), box);
    if (blip && rid(blip, 'embed')) {
      const onMissing = e => this.missing(wrap, e);
      this.drawGeometry(wrap, geom, box, { fill: { type: 'blip', el: blipFill, cx: ctx.cx, onMissing }, line: null, shadow: look.shadow }, ctx);
      const filter = this.imageFilter(blip);
      if (filter && wrap.lastElementChild) wrap.lastElementChild.style.filter = filter;
    }
    // The outline goes over the picture.
    if (look.line && !look.line.none) this.drawGeometry(wrap, geom, box, { fill: null, line: look.line, shadow: null }, ctx);
    const media = this.mediaOf(nv);
    if (media) this.mediaButton(wrap, media);
  }

  /** A picture that can't be shown (TIFF, linked from outside, missing) gets a quiet placeholder. */
  missing(wrap, e) {
    const n = div('p-missing', wrap);
    n.textContent = e ? e.toUpperCase() : '';
    n.title = e ? `This picture is in ${e.toUpperCase()} format, which browsers can’t show` : 'Picture not found';
  }

  mediaOf(nv) {
    const nvPr = kid(nv, 'nvPr');
    if (!nvPr) return null;
    const v = kid(nvPr, 'videoFile'), a = kid(nvPr, 'audioFile');
    const ext14 = [...nvPr.getElementsByTagNameNS('*', 'media')][0];
    if (!v && !a && !ext14) return null;
    const ids = [ext14 && rid(ext14, 'embed'), v && rid(v, 'link'), a && rid(a, 'link')].filter(Boolean);
    return { kind: a && !v ? 'audio' : 'video', ids, el: ext14 || v || a };
  }

  mediaButton(wrap, media) {
    const b = document.createElement('button');
    b.className = 'pptx-play';
    b.title = media.kind === 'audio' ? 'Play Sound' : 'Play Video';
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
    b.addEventListener('click', async e => {
      e.stopPropagation();
      b.disabled = true;
      let m = null;
      for (const id of media.ids) {
        m = await this.mediaUrl(media.el, id).catch(() => null);
        if (m) break;
      }
      if (!m) { b.disabled = false; b.title = 'This media isn’t inside the file'; b.classList.add('off'); return; }
      const v = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
      v.src = m.url;
      v.controls = true;
      v.autoplay = true;
      v.className = 'pptx-media';
      v.addEventListener('error', () => { v.remove(); b.disabled = false; b.classList.add('off'); b.title = 'The browser can’t play this format'; }, { once: true });
      wrap.append(v);
      b.remove();
    });
    wrap.append(b);
  }

  frame(el, ctx, parent, map) {
    const nv = kid(el, 'nvGraphicFramePr');
    if (bool(kid(nv, 'cNvPr'), 'hidden')) return;
    if (ctx.decor && find(nv, 'nvPr', 'ph')) return;
    const x = kid(el, 'xfrm');
    if (!x) return;
    const box = map(readXfrm(x));
    const data = find(el, 'graphic', 'graphicData');
    const uri = attr(data, 'uri') || '';
    if (uri.endsWith('/table')) {
      const wrap = place(div('p-sh p-tbl', parent), box);
      wrap.append(renderTable(kid(data, 'tbl'), this.tableEnv(ctx)));
    } else if (uri.endsWith('/chart')) {
      const r = ctx.part.rels.get(rid(kid(data, 'chart')));
      const p = r && this.parts.get(r.target);
      const wrap = place(div('p-sh p-chart', parent), box);
      if (p) p.then(part => wrap.append(renderChart(part.doc, box, this.chartEnv(ctx, part))), () => {});
    } else if (uri.endsWith('/diagram')) {
      this.diagram(data, ctx, parent, box);
    } else {
      // OLE objects and anything else: the picture stored with them.
      const ole = kid(data, 'oleObj');
      const pic = kid(ole, 'pic') || kid(data, 'pic');
      if (pic) this.picture(pic, ctx, parent, map, box);
    }
  }

  diagram(data, ctx, parent, box) {
    const relIds = kid(data, 'relIds');
    const rels = ctx.part.rels;
    const dm = rels.get(rid(relIds, 'dm'));
    let drawing = null;
    const dmPart = dm && this.parts.get(dm.target);
    const draw = async () => {
      // The data part names the drawing PowerPoint saved alongside it.
      if (dmPart) {
        const d = await dmPart;
        const ext = [...d.doc.getElementsByTagNameNS('*', 'dataModelExt')][0];
        const r = ext && rels.get(attr(ext, 'relId'));
        if (r) drawing = r.target;
      }
      if (!drawing) {
        const list = [...rels.values()].filter(r => r.type === 'diagramDrawing');
        if (list.length === 1) drawing = list[0].target;
      }
      const wrap = place(div('p-sh p-dgm', parent), box);
      if (drawing && this.parts.has(drawing)) {
        const p = await this.parts.get(drawing);
        const tree = find(p.root, 'spTree');
        const map = c => ({ ...c, x: c.x / EMU, y: c.y / EMU, w: c.w / EMU, h: c.h / EMU });
        this.tree(tree, { ...ctx, part: p, inherit: null, decor: false }, wrap, map);
      } else if (dmPart) {
        // No saved drawing: list the diagram's text.
        const d = await dmPart;
        const lines = [...d.doc.getElementsByTagNameNS('*', 'pt')].filter(pt => (attr(pt, 'type') || 'node') === 'node')
          .map(pt => [...pt.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join('')).filter(Boolean);
        const n = div('p-dgm-text', wrap);
        for (const l of lines) { const p = document.createElement('p'); p.textContent = l; n.append(p); }
      }
    };
    draw().catch(e => console.warn('pptx: diagram', e));
  }

  tableEnv(ctx) {
    return {
      cx: ctx.cx, theme: ctx.theme, styles: this.tableStyles,
      defaultTextStyle: this.defaultTextStyle,
      otherStyle: ctx.info.master && find(ctx.info.master.root, 'txStyles', 'otherStyle'),
      paint: (fill, defs, box) => this.paint(fill, defs, box),
      text: opts => renderText(opts.txBody, {
        ...opts, cx: ctx.cx, theme: ctx.theme, slideNum: ctx.slideNum,
        link: (id, el) => this.linkSync(id, el, ctx), blip: (b, img) => this.blip(b, img),
      }),
    };
  }

  chartEnv(ctx, part) {
    return { cx: ctx.cx, theme: ctx.theme, part };
  }

  /** Text of the speaker notes: [{level, text}] or null. */
  async notes(i) {
    const slide = await this.part(this.slides[i].path);
    const path = slide.rel('notesSlide');
    if (!path || !this.pkg.has(path)) return null;
    const notes = await this.part(path);
    for (const sp of notes.root.getElementsByTagNameNS('*', 'sp')) {
      const ph = find(kid(sp, 'nvSpPr'), 'nvPr', 'ph');
      if (!ph || attr(ph, 'type') !== 'body') continue;
      const out = [];
      for (const p of kids(kid(sp, 'txBody'), 'p')) {
        let text = '';
        for (const c of children(p)) {
          if (c.localName === 'r' || c.localName === 'fld') text += (kid(c, 't') || {}).textContent || '';
          else if (c.localName === 'br') text += '\n';
        }
        out.push({ level: num(kid(p, 'pPr'), 'lvl', 0), text });
      }
      while (out.length && !out[out.length - 1].text.trim()) out.pop();
      return out.length ? out : null;
    }
    return null;
  }

  /** The text of the slide's title, for tooltips and the outline. */
  async title(i) {
    const info = await this.info(i);
    for (const sp of children(find(info.slide.root, 'cSld', 'spTree'))) {
      const ph = find(kid(sp, 'nvSpPr'), 'nvPr', 'ph');
      if (ph && TITLE_TYPES.has(attr(ph, 'type'))) {
        return [...sp.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join(' ').replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  }
}
