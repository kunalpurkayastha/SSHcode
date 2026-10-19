// Charts, drawn from the values PowerPoint caches inside the chart part:
// column and bar, line, area, pie and doughnut, scatter, bubble and radar,
// with axes, gridlines, legend, titles and data labels.
import { kid, kids, find, attr, num, bool, children, color, css, readFill, fillEl, readLine, tintShade } from './ooxml.js';
import { fontStack, themeFont } from './text.js';

const SVG = 'http://www.w3.org/2000/svg';
const PT = 4 / 3;
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const GRID = { r: 134, g: 134, b: 134, a: 1 };
const AXIS = { r: 134, g: 134, b: 134, a: 1 };

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, typeof v === 'number' ? +v.toFixed(2) : v);
  if (parent) parent.append(e);
  return e;
}

let measurer;
function measure(text, t) {
  measurer = measurer || document.createElement('canvas').getContext('2d');
  measurer.font = fontOf(t);
  return measurer.measureText(text).width;
}
const fontOf = t => `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : ''}${t.size * PT}px ${t.family}`;

function text(parent, s, x, y, t, { anchor = 'middle', baseline = 'central', rotate = 0 } = {}) {
  const e = el('text', {
    x, y, fill: css(t.color), 'font-size': t.size * PT, 'text-anchor': anchor, 'dominant-baseline': baseline,
    'font-weight': t.bold ? 700 : null, 'font-style': t.italic ? 'italic' : null,
  }, parent);
  e.style.fontFamily = t.family;
  if (rotate) e.setAttribute('transform', `rotate(${rotate} ${+x.toFixed(2)} ${+y.toFixed(2)})`);
  e.textContent = s;
  return e;
}

// --- reading -------------------------------------------------------------------------------

/** Text properties from a c:txPr (or the first run of c:rich) over `base`. */
function textProps(holder, base, env) {
  const t = { ...base };
  if (!holder) return t;
  const p = kid(holder, 'p');
  const props = [find(p, 'pPr', 'defRPr'), find(p, 'r', 'rPr')];
  for (const r of props) {
    if (!r) continue;
    if (r.hasAttribute('sz')) t.size = num(r, 'sz', 1000) / 100;
    if (r.hasAttribute('b')) t.bold = bool(r, 'b');
    if (r.hasAttribute('i')) t.italic = bool(r, 'i');
    const f = fillEl(r);
    if (f) { const fill = readFill(f, env.cx); if (fill && fill.type === 'solid') t.color = fill.color; }
    const latin = attr(kid(r, 'latin'), 'typeface');
    if (latin) t.family = fontStack(themeFont(latin, env.theme) || latin);
  }
  const bodyPr = kid(holder, 'bodyPr');
  if (bodyPr && bodyPr.hasAttribute('rot')) t.rot = num(bodyPr, 'rot', 0) / 60000;
  return t;
}

/** Text of a c:tx (rich text or a reference to a cell). */
function txText(tx) {
  if (!tx) return '';
  const rich = kid(tx, 'rich');
  if (rich) return kids(rich, 'p').map(p => [...p.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join('')).join('\n');
  const cache = find(tx, 'strRef', 'strCache');
  if (cache) return kids(cache, 'pt').map(p => (kid(p, 'v') || {}).textContent || '').join(' ');
  return (kid(tx, 'v') || {}).textContent || '';
}

function cacheOf(ref) {
  if (!ref) return null;
  return kid(ref, 'numCache') || kid(ref, 'strCache') || find(ref, 'numRef', 'numCache') || find(ref, 'strRef', 'strCache')
    || find(ref, 'numLit') || find(ref, 'strLit') || kid(ref, 'numLit') || kid(ref, 'strLit')
    || find(ref, 'multiLvlStrRef', 'multiLvlStrCache');
}

/** Values of a c:val / c:cat / c:xVal… as an array (null where a point is missing). */
function values(ref, numeric) {
  const c = cacheOf(ref);
  if (!c) return { list: [], format: null };
  let pts = kids(c, 'pt');
  if (c.localName === 'multiLvlStrCache') pts = kids(kid(c, 'lvl'), 'pt');
  const count = Math.max(num(kid(c, 'ptCount'), 'val', 0), ...pts.map(p => num(p, 'idx', 0) + 1), 0);
  const list = new Array(count).fill(null);
  for (const p of pts) {
    const v = (kid(p, 'v') || {}).textContent;
    if (v == null) continue;
    list[num(p, 'idx', 0)] = numeric ? (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null) : v;
  }
  return { list, format: (kid(c, 'formatCode') || {}).textContent || null };
}

const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
/**
 * Office's automatic colour for series (or point) `i` of `count`. The chart
 * style (c:style 1–48) picks the palette: its column of 8 is greys, the six
 * accents, or shades of one accent.
 */
function autoColor(i, env, count = 1) {
  const col = ((env.style || 2) - 1) % 8;
  const spread = count > 1 ? i / (count - 1) : 0.5;
  if (col === 0) return tintShade({ r: 64, g: 64, b: 64, a: 1 }, 'tint', 1 - 0.8 * spread);
  if (col >= 2) {
    // Dark to light around the accent.
    const base = env.cx.scheme[ACCENTS[col - 2]] || BLACK;
    const f = spread * 2 - 1;
    return f < 0 ? tintShade(base, 'shade', 1 + f * 0.5) : tintShade(base, 'tint', 1 - f * 0.55);
  }
  const base = env.cx.scheme[ACCENTS[i % 6]] || BLACK;
  const round = Math.floor(i / 6) % 4;
  return [base, tintShade(base, 'shade', 0.6), tintShade(base, 'tint', 0.6), tintShade(base, 'shade', 0.8)][round];
}

function seriesLook(spPr, env, auto, kind) {
  const f = readFill(fillEl(spPr), env.cx);
  const ln = kid(spPr, 'ln');
  const line = ln ? readLine(ln, env.cx, { width: kind === 'line' ? 2.25 * PT : 0.75 * PT, color: auto, dash: null, cap: 'round', join: 'round', none: false }) : null;
  return {
    fill: f ? (f.type === 'solid' ? f.color : f.type === 'grad' ? f.stops[0].color : f.type === 'none' ? null : auto) : auto,
    noFill: !!f && f.type === 'none',
    line: line && !line.none ? line : null,
    noLine: !!line && line.none,
    lineSet: !!ln,
  };
}

function readSeries(ser, env, n, kind, vary, count) {
  const auto = autoColor(n, env, count);
  const s = {
    idx: num(kid(ser, 'idx'), 'val', n), name: txText(kid(ser, 'tx')) || `Series ${n + 1}`,
    cats: values(kid(ser, 'cat'), false), vals: values(kid(ser, 'val'), true),
    xs: values(kid(ser, 'xVal'), true), ys: values(kid(ser, 'yVal'), true), sizes: values(kid(ser, 'bubbleSize'), true),
    look: seriesLook(kid(ser, 'spPr'), env, auto, kind), points: new Map(),
    smooth: bool(kid(ser, 'smooth'), 'val', false), explosion: num(kid(ser, 'explosion'), 'val', 0),
    labels: kid(ser, 'dLbls'), auto,
  };
  if (!s.vals.list.length && s.ys.list.length) s.vals = s.ys;
  const cats = s.cats.list.length ? s.cats : s.xs;
  s.cats = cats;
  for (const d of kids(ser, 'dPt')) {
    const i = num(kid(d, 'idx'), 'val', 0);
    s.points.set(i, seriesLook(kid(d, 'spPr'), env, vary ? autoColor(i, env, s.vals.list.length) : auto, kind));
  }
  const m = kid(ser, 'marker');
  s.marker = {
    symbol: m ? attr(kid(m, 'symbol'), 'val', 'auto') : 'auto', size: num(kid(m, 'size'), 'val', 5), n,
    look: seriesLook(kid(m, 'spPr'), env, auto, 'marker'),
  };
  return s;
}

// --- numbers -------------------------------------------------------------------------------

function excelDate(serial, code) {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return code.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, t => {
    switch (t) {
      case 'yyyy': return d.getUTCFullYear();
      case 'yy': return String(d.getUTCFullYear()).slice(2);
      case 'mmmm': return d.toLocaleString('en', { month: 'long', timeZone: 'UTC' });
      case 'mmm': return M[d.getUTCMonth()];
      case 'mm': return String(d.getUTCMonth() + 1).padStart(2, '0');
      case 'm': return d.getUTCMonth() + 1;
      case 'dd': return String(d.getUTCDate()).padStart(2, '0');
      default: return d.getUTCDate();
    }
  });
}

const literal = s => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1').replace(/_./g, ' ').replace(/\*./g, '');

/** Format a number with an Excel format code (the common cases). */
export function formatNumber(v, code) {
  if (v == null || !Number.isFinite(v)) return '';
  const sections = (code || 'General').split(';');
  let fmt = sections[0];
  const own = v < 0 && sections.length > 1 && sections[1].trim() !== '';
  if (own) fmt = sections[1];
  else if (v === 0 && sections.length > 2 && sections[2].trim() !== '') fmt = sections[2];
  fmt = fmt.replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, '"$1"').replace(/\[[^\]]*\]/g, '');
  const bare = fmt.replace(/"[^"]*"|\\./g, '');
  if (!bare.trim() || /^general$/i.test(bare.trim())) {
    if (v !== 0 && (Math.abs(v) >= 1e11 || Math.abs(v) < 1e-9)) return v.toExponential(2).replace('e+', 'E+').replace('e-', 'E-');
    return String(+v.toPrecision(10));
  }
  if (/[ymd]/i.test(bare) && !/[0#?]/.test(bare)) return excelDate(v, literal(fmt));
  const first = bare.search(/[#0?]/);
  if (first < 0) return literal(fmt);
  // Split the format around its digits (positions in `fmt`, skipping quoted text).
  let i0 = -1, i1 = -1, q = false;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '"') q = !q;
    else if (!q && fmt[i - 1] !== '\\' && /[#0?]/.test(c)) { if (i0 < 0) i0 = i; i1 = i; }
  }
  const core = fmt.slice(i0, i1 + 1);
  const prefix = literal(fmt.slice(0, i0)), suffix = literal(fmt.slice(i1 + 1));
  const x = Math.abs(v) * (bare.includes('%') ? 100 : 1);
  const dot = core.indexOf('.');
  const decimals = dot >= 0 ? (core.slice(dot + 1).match(/[0#?]/g) || []).length : 0;
  const needed = dot >= 0 ? (core.slice(dot + 1).match(/0/g) || []).length : 0;
  let s = x.toFixed(decimals);
  if (decimals > needed) s = s.replace(new RegExp(`0{1,${decimals - needed}}$`), '').replace(/\.$/, '');
  if (core.includes(',')) { const [a, b] = s.split('.'); s = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : ''); }
  return (v < 0 && !own ? '-' : '') + prefix + s + suffix;
}

/** Axis bounds and step, rounded the way Excel does it. */
function scale(lo, hi, opts = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (opts.zero !== false) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { if (hi === 0) hi = 1; else if (hi > 0) lo = 0; else hi = 0; }
  if (opts.min != null) lo = opts.min;
  if (opts.max != null) hi = opts.max;
  let step = opts.step;
  if (!step) {
    const rough = (hi - lo) / (opts.ticks || 8);
    const mag = 10 ** Math.floor(Math.log10(rough));
    const n = rough / mag;
    step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  const min = opts.min != null ? opts.min : Math.floor(lo / step + 1e-9) * step;
  let max = opts.max != null ? opts.max : Math.ceil(hi / step - 1e-9) * step;
  if (max <= min) max = min + step;
  const ticks = [];
  for (let v = min, i = 0; v <= max + step * 1e-6 && i < 200; v = min + step * ++i) ticks.push(+v.toPrecision(12));
  return { min, max, step, ticks };
}

function axisInfo(ax, env, base) {
  const scaling = kid(ax, 'scaling');
  return {
    el: ax, id: attr(kid(ax, 'axId'), 'val'), kind: ax.localName,
    deleted: bool(kid(ax, 'delete'), 'val', false), pos: attr(kid(ax, 'axPos'), 'val', 'b'),
    reverse: attr(kid(scaling, 'orientation'), 'val') === 'maxMin',
    min: kid(scaling, 'min') ? num(kid(scaling, 'min'), 'val') : null,
    max: kid(scaling, 'max') ? num(kid(scaling, 'max'), 'val') : null,
    log: kid(scaling, 'logBase') ? num(kid(scaling, 'logBase'), 'val', 10) : null,
    step: kid(ax, 'majorUnit') ? num(kid(ax, 'majorUnit'), 'val') : null,
    grid: kid(ax, 'majorGridlines'), format: attr(kid(ax, 'numFmt'), 'formatCode'),
    linked: attr(kid(ax, 'numFmt'), 'sourceLinked') !== '0',
    labels: attr(kid(ax, 'tickLblPos'), 'val', 'nextTo') !== 'none',
    text: textProps(kid(ax, 'txPr'), base, env), title: kid(ax, 'title'),
    line: lnOf(ax, env),
    crossBetween: attr(kid(ax, 'crossBetween'), 'val'), crosses: attr(kid(ax, 'crosses'), 'val', 'autoZero'),
  };
}

/** The a:ln inside an element's c:spPr, read; null when there's none (use the default). */
const lnOf = (holder, env) => {
  const ln = find(holder, 'spPr', 'ln');
  return ln ? readLine(ln, env.cx, null) : null;
};

function strokeOf(l, fallback, w = 0.75) {
  if (l && l.none) return null;
  if (l && l.color) return { color: l.color, width: Math.max(0.5, l.width || w), dash: l.dash };
  return fallback ? { color: fallback, width: w } : null;
}

function line(parent, x1, y1, x2, y2, st) {
  if (!st) return;
  el('line', { x1, y1, x2, y2, stroke: css(st.color), 'stroke-width': st.width, 'stroke-dasharray': st.dash ? st.dash.map(d => d * st.width).join(' ') : null }, parent);
}

// --- drawing ----------------------------------------------------------------------------------

/** Chart part document → an <svg> of box.w × box.h. */
export function renderChart(doc, box, env) {
  const W = Math.max(1, box.w), H = Math.max(1, box.h);
  const root = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'p-chart' });
  try {
    draw(root, doc.documentElement, W, H, env);
  } catch (e) {
    console.warn('pptx: chart', e);
  }
  return root;
}

function draw(root, cs, W, H, env) {
  const chart = kid(cs, 'chart');
  const family = fontStack(env.theme.fonts.minor.latin || 'Calibri');
  // Charts from Office 2013 on spell out their (grey) text; older ones rely on black.
  const base = textProps(kid(cs, 'txPr'), { size: 10, bold: false, italic: false, color: BLACK, family }, env);
  // Background and border of the whole chart.
  const spPr = kid(cs, 'spPr');
  const bgFill = readFill(fillEl(spPr), env.cx);
  const bgLine = readLine(kid(spPr, 'ln'), env.cx, null);
  if (bgFill && bgFill.type === 'solid') el('rect', { width: W, height: H, fill: css(bgFill.color) }, root);
  if (bgLine && !bgLine.none && bgLine.color) el('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, fill: 'none', stroke: css(bgLine.color), 'stroke-width': bgLine.width }, root);

  const area = { x: 8, y: 8, w: W - 16, h: H - 16 };
  const plot = kid(chart, 'plotArea');
  const groups = children(plot).filter(c => /Chart$/.test(c.localName));
  if (!groups.length) return;
  const isPie = /^(pie|pie3D|doughnut|ofPie)Chart$/.test(groups[0].localName);
  const allSeries = [];
  const style = kid(cs, 'style');
  env = { ...env, style: style ? num(style, 'val', 2) : 2 };
  const total = groups.reduce((a, g) => a + kids(g, 'ser').length, 0);
  let n = 0;
  for (const g of groups) {
    const kind = g.localName.replace(/3D/, '').replace(/Chart$/, '');
    const vary = bool(kid(g, 'varyColors'), 'val', false) && (isPie || kids(g, 'ser').length === 1);
    for (const ser of kids(g, 'ser')) allSeries.push({ ...readSeries(ser, env, n++, kind === 'line' || kind === 'scatter' || kind === 'radar' ? 'line' : 'fill', vary || isPie, total), group: g, kind, vary: vary || isPie });
  }

  // Title: the chart's own, or the series name when there's one series.
  const titleEl = kid(chart, 'title');
  const autoDeleted = bool(kid(chart, 'autoTitleDeleted'), 'val', false);
  let title = titleEl ? txText(kid(titleEl, 'tx')) : '';
  if (titleEl && !title && allSeries.length === 1) title = allSeries[0].name;
  if (!titleEl && !autoDeleted && allSeries.length === 1 && isPie) title = allSeries[0].name;
  if (title) {
    const t = textProps(kid(kid(titleEl, 'tx'), 'rich') || kid(titleEl, 'txPr'), { ...base, size: base.size * 1.2, bold: true }, env);
    const lines = title.split('\n');
    lines.forEach((l, i) => text(root, l, W / 2, area.y + t.size * PT * (0.6 + i * 1.2), t));
    if (!bool(kid(titleEl, 'overlay'), 'val', false)) { const used = t.size * PT * (lines.length * 1.2 + 0.4); area.y += used; area.h -= used; }
  }

  // Legend.
  const legendEl = kid(chart, 'legend');
  if (legendEl) {
    const gone = new Set(kids(legendEl, 'legendEntry').filter(e => bool(kid(e, 'delete'), 'val')).map(e => num(kid(e, 'idx'), 'val')));
    const entries = [];
    if (isPie || (allSeries.length === 1 && allSeries[0].vary)) {
      const s = allSeries[0];
      (s.cats.list.length ? s.cats.list : s.vals.list.map((_, i) => String(i + 1))).forEach((c, i) => {
        const n = s.vals.list.length;
        const look = s.points.get(i) || { fill: autoColor(i, env, n) };
        entries.push({ label: c == null ? '' : typeof c === 'number' ? formatNumber(c, s.cats.format) : c, color: look.fill || autoColor(i, env, n), kind: 'fill', i });
      });
    } else {
      allSeries.forEach((s, i) => entries.push({ label: s.name, color: s.kind === 'line' || s.kind === 'scatter' || s.kind === 'radar' ? (s.look.line ? s.look.line.color : s.auto) : s.look.fill || s.auto, kind: s.kind, marker: s.marker, s, i }));
    }
    const list = entries.filter(e => !gone.has(e.i));
    const pos = attr(kid(legendEl, 'legendPos'), 'val', 'r');
    const lt = textProps(kid(legendEl, 'txPr'), base, env);
    const overlay = bool(kid(legendEl, 'overlay'), 'val', false);
    drawLegend(root, list, pos, lt, area, overlay);
  }

  if (isPie) drawPie(root, groups[0], allSeries.filter(s => s.group === groups[0]), area, base, env);
  else drawCartesian(root, plot, groups, allSeries, area, base, env);
}

function drawLegend(root, list, pos, t, area, overlay) {
  if (!list.length) return;
  const fs = t.size * PT, sw = fs * 0.7, gap = fs * 0.5, rowH = fs * 1.35;
  const widths = list.map(e => measure(e.label, t) + sw + gap);
  const g = el('g', {}, root);
  const swatch = (e, x, y) => {
    if (e.kind === 'line' || e.kind === 'scatter' || e.kind === 'radar') {
      if (!e.s || e.s.look.line || !e.s.look.noLine) el('line', { x1: x, y1: y, x2: x + sw * 1.6, y2: y, stroke: css(e.color), 'stroke-width': 2 }, g);
      if (e.marker && e.marker.symbol !== 'none') marker(g, x + sw * 0.8, y, e.marker, e.color, 5);
      return sw * 1.6;
    }
    el('rect', { x, y: y - sw / 2, width: sw, height: sw, fill: css(e.color) }, g);
    return sw;
  };
  if (pos === 'r' || pos === 'l' || pos === 'tr') {
    const w = Math.min(area.w * 0.4, Math.max(...widths) + sw);
    const h = list.length * rowH;
    const x = pos === 'l' ? area.x : area.x + area.w - w;
    let y = pos === 'tr' ? area.y : area.y + Math.max(0, (area.h - h) / 2);
    for (const e of list) {
      const used = swatch(e, x, y + rowH / 2);
      text(g, e.label, x + used + gap, y + rowH / 2, t, { anchor: 'start' });
      y += rowH;
    }
    if (!overlay) { if (pos === 'l') { area.x += w + gap; } area.w -= w + gap; }
  } else {
    // Rows of entries, centred, at the top or the bottom.
    const rows = [[]];
    let rowW = 0;
    list.forEach((e, i) => {
      const w = widths[i] + gap * 2;
      if (rowW + w > area.w && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push([e, w]);
      rowW += w;
    });
    const h = rows.length * rowH;
    let y = pos === 't' ? area.y : area.y + area.h - h;
    for (const r of rows) {
      const total = r.reduce((a, [, w]) => a + w, 0);
      let x = area.x + (area.w - total) / 2;
      for (const [e, w] of r) {
        const used = swatch(e, x, y + rowH / 2);
        text(g, e.label, x + used + gap, y + rowH / 2, t, { anchor: 'start' });
        x += w;
      }
      y += rowH;
    }
    if (!overlay) { if (pos === 't') area.y += h + gap; area.h -= h + gap; }
  }
}

// "auto" markers take turns, series by series, as in Office.
const MARKERS = ['diamond', 'square', 'triangle', 'x', 'star', 'circle', 'plus'];
function marker(parent, x, y, m, fallback, size) {
  const s = (size || m.size || 5) * PT / 2 + 1;
  let sym = m.symbol;
  if (sym === 'auto' || !sym) sym = MARKERS[(m.n || 0) % MARKERS.length];
  if (sym === 'none') return;
  const fill = m.look && m.look.noFill ? 'none' : css((m.look && m.look.fill) || fallback);
  const stroke = m.look && m.look.line ? css(m.look.line.color) : m.look && m.look.noLine ? 'none' : css(fallback);
  const a = { fill, stroke, 'stroke-width': 0.75 };
  switch (sym) {
    case 'square': el('rect', { x: x - s, y: y - s, width: 2 * s, height: 2 * s, ...a }, parent); break;
    case 'diamond': el('path', { d: `M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`, ...a }, parent); break;
    case 'triangle': el('path', { d: `M${x} ${y - s}L${x + s} ${y + s}L${x - s} ${y + s}Z`, ...a }, parent); break;
    case 'x': el('path', { d: `M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}`, ...a, stroke: stroke === 'none' ? fill : stroke, 'stroke-width': 1.5 }, parent); break;
    case 'plus': el('path', { d: `M${x - s} ${y}L${x + s} ${y}M${x} ${y - s}L${x} ${y + s}`, ...a, stroke: stroke === 'none' ? fill : stroke, 'stroke-width': 1.5 }, parent); break;
    case 'dash': el('rect', { x: x - s, y: y - s / 4, width: 2 * s, height: s / 2, ...a }, parent); break;
    case 'dot': el('circle', { cx: x, cy: y, r: s / 2, ...a }, parent); break;
    case 'star': el('path', { d: `M${x - s} ${y}L${x + s} ${y}M${x} ${y - s}L${x} ${y + s}M${x - s * 0.7} ${y - s * 0.7}L${x + s * 0.7} ${y + s * 0.7}M${x + s * 0.7} ${y - s * 0.7}L${x - s * 0.7} ${y + s * 0.7}`, ...a, stroke: stroke === 'none' ? fill : stroke, 'stroke-width': 1.2 }, parent); break;
    default: el('circle', { cx: x, cy: y, r: s, ...a }, parent);
  }
}

/** Data labels asked for on a series (or its chart group): which parts to show. */
function labelFlags(s, i) {
  const own = s.labels;
  const pt = own && kids(own, 'dLbl').find(d => num(kid(d, 'idx'), 'val') === i);
  const src = pt && !kid(pt, 'delete') ? pt : own || kid(s.group, 'dLbls');
  if (!src || bool(kid(src, 'delete'), 'val')) return null;
  const f = k => bool(kid(src, k), 'val', false);
  const flags = { val: f('showVal'), pct: f('showPercent'), cat: f('showCatName'), ser: f('showSerName'), pos: attr(kid(src, 'dLblPos'), 'val'), el: src };
  return flags.val || flags.pct || flags.cat || flags.ser ? flags : null;
}

function labelText(flags, s, i, v, total) {
  const parts = [];
  if (flags.ser) parts.push(s.name);
  if (flags.cat) parts.push(String(s.cats.list[i] ?? ''));
  const fmt = attr(kid(flags.el, 'numFmt'), 'formatCode') || s.vals.format;
  if (flags.val) parts.push(formatNumber(v, fmt));
  if (flags.pct && total) parts.push(formatNumber(v / total, '0%'));
  return parts.join(', ');
}

function drawPie(root, g, series, area, base, env) {
  const doughnut = g.localName === 'doughnutChart';
  const hole = doughnut ? num(kid(g, 'holeSize'), 'val', 50) / 100 : 0;
  const first = num(kid(g, 'firstSliceAng'), 'val', 0);
  const list = doughnut ? series : series.slice(0, 1);
  const anyLabels = list.some(s => labelFlags(s, 0));
  const r0 = Math.max(4, Math.min(area.w, area.h) / 2 * (anyLabels ? 0.78 : 0.92));
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const ring = list.length ? (r0 * (1 - hole)) / list.length : 0;
  list.forEach((s, k) => {
    const vals = s.vals.list.map(v => Math.max(0, v || 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const outer = r0 - k * ring, inner = doughnut ? outer - ring : 0;
    let a = first * Math.PI / 180;
    vals.forEach((v, i) => {
      const sweep = v / total * Math.PI * 2;
      if (!sweep) return;
      const look = s.points.get(i) || { fill: autoColor(i, env, vals.length), line: s.look.line };
      const exp = ((s.points.get(i) && s.points.get(i).explosion) || s.explosion || 0) / 100 * outer;
      const mid = a + sweep / 2;
      const ox = Math.sin(mid) * exp, oy = -Math.cos(mid) * exp;
      const p = (r, t) => [cx + ox + Math.sin(t) * r, cy + oy - Math.cos(t) * r];
      const large = sweep > Math.PI ? 1 : 0;
      let d;
      if (sweep >= Math.PI * 2 - 1e-6) {
        d = `M${cx - outer} ${cy}A${outer} ${outer} 0 1 1 ${cx + outer} ${cy}A${outer} ${outer} 0 1 1 ${cx - outer} ${cy}Z`;
        if (inner) d += `M${cx - inner} ${cy}A${inner} ${inner} 0 1 0 ${cx + inner} ${cy}A${inner} ${inner} 0 1 0 ${cx - inner} ${cy}Z`;
      } else {
        const [x1, y1] = p(outer, a), [x2, y2] = p(outer, a + sweep);
        if (inner) {
          const [x3, y3] = p(inner, a + sweep), [x4, y4] = p(inner, a);
          d = `M${x1} ${y1}A${outer} ${outer} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${inner} ${inner} 0 ${large} 0 ${x4} ${y4}Z`;
        } else {
          d = `M${cx + ox} ${cy + oy}L${x1} ${y1}A${outer} ${outer} 0 ${large} 1 ${x2} ${y2}Z`;
        }
      }
      const st = strokeOf(look.line, null, 1);
      el('path', { d, fill: look.noFill ? 'none' : css(look.fill || autoColor(i, env, vals.length)), stroke: st ? css(st.color) : 'none', 'stroke-width': st ? st.width : 0, 'fill-rule': 'evenodd' }, root);
      const flags = labelFlags(s, i);
      if (flags) {
        const t = textProps(kid(flags.el, 'txPr'), base, env);
        const label = labelText(flags, s, i, s.vals.list[i], total);
        const outside = flags.pos === 'outEnd' || (flags.pos === 'bestFit' && sweep < 0.35);
        const rr = doughnut ? (outer + inner) / 2 : outside ? outer + t.size * PT : outer * 0.65;
        const [lx, ly] = p(rr, mid);
        text(root, label, lx, ly, t, { anchor: outside ? (Math.sin(mid) >= 0 ? 'start' : 'end') : 'middle' });
      }
      a += sweep;
    });
  });
}

function drawCartesian(root, plot, groups, series, area, base, env) {
  const axes = new Map();
  for (const ax of children(plot)) if (/Ax$/.test(ax.localName)) { const a = axisInfo(ax, env, base); axes.set(a.id, a); }
  const first = groups[0];
  const scatter = /^(scatter|bubble)Chart$/.test(first.localName);
  const radar = first.localName === 'radarChart';
  const horizontal = first.localName.startsWith('bar') && attr(kid(first, 'barDir'), 'val') === 'bar';
  const ids = g => kids(g, 'axId').map(a => attr(a, 'val'));
  const [catId, valId] = ids(first);
  const catAx = axes.get(catId) || axisInfo(null, env, base);
  const valAx = axes.get(valId) || axisInfo(null, env, base);
  const count = Math.max(1, ...series.map(s => Math.max(s.vals.list.length, s.cats.list.length)));
  const cats = (series.find(s => s.cats.list.length) || { cats: { list: [], format: null } }).cats;
  const catLabels = Array.from({ length: count }, (_, i) => {
    const c = cats.list[i];
    if (c == null) return cats.list.length ? '' : String(i + 1);
    return typeof c === 'number' ? formatNumber(c, catAx.linked ? cats.format : catAx.format || cats.format) : String(c);
  });

  // Value range for each value axis, with stacking.
  const ranges = new Map();
  const grow = (id, v) => { if (v == null || !Number.isFinite(v)) return; const r = ranges.get(id) || [Infinity, -Infinity]; r[0] = Math.min(r[0], v); r[1] = Math.max(r[1], v); ranges.set(id, r); };
  for (const g of groups) {
    const [, vId] = ids(g);
    const grouping = attr(kid(g, 'grouping'), 'val', 'clustered');
    const ss = series.filter(s => s.group === g);
    if (/^(scatter|bubble)/.test(g.localName)) {
      const [xId, yId] = ids(g);
      for (const s of ss) { s.xs.list.forEach(v => grow(xId, v)); s.vals.list.forEach(v => grow(yId, v)); }
      if (!ss.some(s => s.xs.list.length)) grow(xId, 1), grow(xId, count);
    } else if (grouping === 'percentStacked') {
      grow(vId, 0); grow(vId, 1);
      if (ss.some(s => s.vals.list.some(v => v < 0))) grow(vId, -1);
    } else if (grouping === 'stacked') {
      for (let i = 0; i < count; i++) {
        let pos = 0, neg = 0;
        for (const s of ss) { const v = s.vals.list[i] || 0; if (v >= 0) pos += v; else neg += v; }
        grow(vId, pos); grow(vId, neg);
      }
    } else for (const s of ss) s.vals.list.forEach(v => grow(vId, v));
  }
  const scales = new Map();
  for (const [id, [lo, hi]] of ranges) {
    const a = axes.get(id) || { min: null, max: null, step: null };
    const stackedPct = groups.some(g => ids(g)[1] === id && attr(kid(g, 'grouping'), 'val') === 'percentStacked');
    // Like Excel, an axis starts at zero unless the values sit in a narrow band far from it.
    const narrow = (lo > 0 && (hi - lo) / hi < 1 / 6) || (hi < 0 && (hi - lo) / -lo < 1 / 6);
    scales.set(id, scale(lo, hi + (hi > 0 && a.max == null && !stackedPct ? (hi - Math.min(lo, 0)) * 0.05 : 0), {
      min: a.min, max: a.max, step: a.step, zero: !narrow,
    }));
  }
  const vScale = scales.get(valId) || scale(0, 1);
  const fmtVal = (a, v, s) => formatNumber(v, a.linked && s ? s : a.format || s || 'General');
  const valFormat = series[0] ? series[0].vals.format : null;
  const pctAxis = groups.some(g => attr(kid(g, 'grouping'), 'val') === 'percentStacked');

  if (radar) {
    const r = ranges.get(valId) || [0, 1];
    drawRadar(root, first, series, area, catLabels, scale(r[0], r[1], { min: valAx.min, max: valAx.max, step: valAx.step, ticks: 5 }), valAx, base);
    return;
  }

  // Room for the axis labels and titles.
  const p = { x: area.x, y: area.y, w: area.w, h: area.h };
  const secondary = groups.slice(1).map(g => axes.get(ids(g)[1])).find(a => a && a.id !== valId && !a.deleted);
  const valLabels = ax => (scales.get(ax.id) || vScale).ticks.map(v => fmtVal(ax, v, pctAxis ? '0%' : valFormat));
  const lineH = t => t.size * PT * 1.25;
  if (!horizontal) {
    if (!valAx.deleted && valAx.labels) p.x += Math.max(...valLabels(valAx).map(l => measure(l, valAx.text))) + 6;
    if (secondary && secondary.labels) p.w -= Math.max(...valLabels(secondary).map(l => measure(l, secondary.text))) + 6;
  } else {
    if (!catAx.deleted && catAx.labels) p.x += Math.min(area.w * 0.35, Math.max(...catLabels.map(l => measure(l, catAx.text)))) + 6;
    if (!valAx.deleted && valAx.labels) p.h -= lineH(valAx.text) + 4;
  }
  for (const [ax, side] of [[valAx, horizontal ? 'b' : 'l'], [catAx, horizontal ? 'l' : 'b']]) {
    const t = ax.title && txText(kid(ax.title, 'tx'));
    if (!t || ax.deleted) continue;
    const tp = textProps(kid(kid(ax.title, 'tx'), 'rich') || kid(ax.title, 'txPr'), { ...base, bold: true }, env);
    if (side === 'l') { text(root, t, area.x + lineH(tp) / 2, p.y + p.h / 2, tp, { rotate: -90 }); p.x += lineH(tp); }
    else { text(root, t, p.x + (p.w - (p.x - area.x)) / 2 + (p.x - area.x) / 2, area.y + area.h - lineH(tp) / 2, tp); p.h -= lineH(tp); }
  }
  p.w -= p.x - area.x;
  // The last label along the bottom is centred on the right edge: leave it room.
  const between = catAx.crossBetween !== 'midCat' && valAx.crossBetween !== 'midCat';
  let tail = 0;
  if (horizontal && !valAx.deleted && valAx.labels) tail = measure(fmtVal(valAx, vScale.max, pctAxis ? '0%' : valFormat), valAx.text) / 2;
  else if (scatter && !catAx.deleted && catAx.labels) { const xs = scales.get(catId); if (xs) tail = measure(fmtVal(catAx, xs.max, series[0] && series[0].xs.format), catAx.text) / 2; }
  else if (!between && !catAx.deleted && catAx.labels && count > 1) tail = measure(catLabels[count - 1], catAx.text) / 2;
  if (tail && !secondary) p.w -= Math.max(0, tail + 2 - (area.x + area.w - (p.x + p.w)));
  // Category labels under the plot: wrapped onto up to three lines, or tilted when even that won't do.
  let cats2 = null;
  if (scatter && !catAx.deleted && catAx.labels) p.h -= lineH(catAx.text) + 4;
  else if (!horizontal && !catAx.deleted && catAx.labels) {
    const slot = p.w / (between ? count : Math.max(1, count - 1)) * 0.94;
    const wrapped = catLabels.map(l => wrapWords(l, slot, catAx.text));
    const lines = Math.max(1, ...wrapped.map(w => w.length));
    if (lines <= 3 && wrapped.every(w => w.every(x => measure(x, catAx.text) <= slot))) {
      cats2 = { wrapped };
      p.h -= lines * lineH(catAx.text) + 4;
    } else {
      const widest = Math.min(area.h * 0.4, Math.max(...catLabels.map(l => measure(l, catAx.text))));
      cats2 = { tilt: true };
      p.h -= widest * 0.72 + lineH(catAx.text) * 0.5 + 6;
    }
  }
  // A plot area placed by hand in PowerPoint.
  const ml = find(plot, 'layout', 'manualLayout');
  if (ml && attr(kid(ml, 'xMode'), 'val', 'factor') === 'edge' && attr(kid(ml, 'layoutTarget'), 'val') === 'inner') {
    const W = root.width.baseVal.value, H = root.height.baseVal.value;
    p.x = num(kid(ml, 'x'), 'val', 0) * W; p.y = num(kid(ml, 'y'), 'val', 0) * H;
    p.w = num(kid(ml, 'w'), 'val', 1) * W; p.h = num(kid(ml, 'h'), 'val', 1) * H;
  }
  if (p.w < 4 || p.h < 4) return;

  const plotSp = kid(plot, 'spPr');
  const pf = readFill(fillEl(plotSp), env.cx);
  if (pf && pf.type === 'solid') el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, fill: css(pf.color) }, root);

  // Value → pixel along the value axis, and category index → pixel.
  const valPos = (sc, ax) => v => {
    const t = (v - sc.min) / (sc.max - sc.min || 1);
    const tt = ax.reverse ? 1 - t : t;
    return horizontal ? p.x + tt * p.w : p.y + p.h - tt * p.h;
  };
  const band = (horizontal ? p.h : p.w) / (between ? count : Math.max(1, count - 1));
  const catPos = i => {
    const k = catAx.reverse ? count - 1 - i : i;
    const off = between ? (k + 0.5) * band : k * band;
    return horizontal ? p.y + p.h - off : p.x + off;
  };

  // Gridlines.
  const grid = el('g', {}, root);
  const vp = valPos(vScale, valAx);
  if (valAx.grid && !scatter) {
    const st = strokeOf(lnOf(valAx.grid, env), GRID);
    for (const v of vScale.ticks) { const q = vp(v); horizontal ? line(grid, q, p.y, q, p.y + p.h, st) : line(grid, p.x, q, p.x + p.w, q, st); }
  }
  if (scatter) {
    const xs = scales.get(catId) || scale(0, 1);
    const ys = vScale;
    const X = v => p.x + (catAx.reverse ? 1 - (v - xs.min) / (xs.max - xs.min) : (v - xs.min) / (xs.max - xs.min)) * p.w;
    const Y = v => p.y + p.h - (valAx.reverse ? 1 - (v - ys.min) / (ys.max - ys.min) : (v - ys.min) / (ys.max - ys.min)) * p.h;
    if (valAx.grid) { const st = strokeOf(lnOf(valAx.grid, env), GRID); for (const v of ys.ticks) line(grid, p.x, Y(v), p.x + p.w, Y(v), st); }
    if (catAx.grid) { const st = strokeOf(lnOf(catAx.grid, env), GRID); for (const v of xs.ticks) line(grid, X(v), p.y, X(v), p.y + p.h, st); }
    drawScatter(root, series, X, Y, count, Math.min(p.w, p.h));
    axisLines(root, p, catAx, valAx, X(Math.max(xs.min, Math.min(0, xs.max))), Y(Math.max(ys.min, Math.min(0, ys.max))), false);
    if (!valAx.deleted && valAx.labels) for (const v of ys.ticks) text(root, fmtVal(valAx, v, valFormat), p.x - 6, Y(v), valAx.text, { anchor: 'end' });
    const xf = series[0] ? series[0].xs.format : null;
    if (!catAx.deleted && catAx.labels) for (const v of xs.ticks) text(root, fmtVal(catAx, v, xf), X(v), p.y + p.h + 4 + lineH(catAx.text) / 2, catAx.text);
    return;
  } else if (catAx.grid) {
    const st = strokeOf(lnOf(catAx.grid, env), GRID);
    for (let i = 0; i <= count; i++) { const q = (horizontal ? p.y + p.h : p.x) + (horizontal ? -1 : 1) * i * band; horizontal ? line(grid, p.x, q, p.x + p.w, q, st) : line(grid, q, p.y, q, p.y + p.h, st); }
  }

  // Series, group by group (bars first, so lines stay on top).
  const order = [...groups].sort((a, b) => (/^bar/.test(b.localName) ? 1 : 0) - (/^bar/.test(a.localName) ? 1 : 0));
  for (const g of order) {
    const [, vId] = ids(g);
    const sc = scales.get(vId) || vScale;
    const ax = axes.get(vId) || valAx;
    const pos = valPos(sc, ax);
    const ss = series.filter(s => s.group === g);
    const grouping = attr(kid(g, 'grouping'), 'val', /^bar/.test(g.localName) ? 'clustered' : 'standard');
    if (/^bar/.test(g.localName)) drawBars(root, g, ss, grouping, count, band, catPos, pos, sc, horizontal, base, env);
    else drawLines(root, g, ss, grouping, count, catPos, pos, sc, horizontal, base, env, /^area/.test(g.localName));
  }

  const zero = vp(Math.max(vScale.min, Math.min(0, vScale.max)));
  axisLines(root, p, catAx, valAx, null, zero, horizontal);

  // Labels.
  if (!valAx.deleted && valAx.labels) {
    for (const v of vScale.ticks) {
      const q = vp(v), l = fmtVal(valAx, v, pctAxis ? '0%' : valFormat);
      if (horizontal) text(root, l, q, p.y + p.h + 4 + lineH(valAx.text) / 2, valAx.text);
      else text(root, l, p.x - 6, q, valAx.text, { anchor: 'end' });
    }
  }
  if (secondary && secondary.labels && !horizontal) {
    const sc = scales.get(secondary.id);
    const q = valPos(sc, secondary);
    for (const v of sc.ticks) text(root, fmtVal(secondary, v, null), p.x + p.w + 6, q(v), secondary.text, { anchor: 'start' });
  }
  if (!catAx.deleted && catAx.labels) {
    const every = horizontal ? Math.max(1, Math.ceil(lineH(catAx.text) / band)) : 1;
    catLabels.forEach((l, i) => {
      if (i % every) return;
      const q = catPos(i);
      if (horizontal) text(root, l, p.x - 6, q, catAx.text, { anchor: 'end' });
      else if (cats2 && cats2.tilt) text(root, l, q, p.y + p.h + 6, catAx.text, { anchor: 'end', rotate: -45, baseline: 'hanging' });
      else (cats2 ? cats2.wrapped[i] : [l]).forEach((line, k) => text(root, line, q, p.y + p.h + 4 + lineH(catAx.text) * (k + 0.5), catAx.text));
    });
  }
}

/** Break `s` into lines no wider than `width` (a word that's too long keeps its own line). */
function wrapWords(s, width, t) {
  const lines = [];
  let cur = '';
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next, t) > width) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}

function axisLines(root, p, catAx, valAx, xAt, yAt, horizontal) {
  const catSt = catAx.deleted ? null : strokeOf(catAx.line, AXIS);
  const valSt = valAx.deleted ? null : strokeOf(valAx.line, AXIS);
  if (horizontal) {
    if (catSt) line(root, yAt, p.y, yAt, p.y + p.h, catSt);
    if (valSt) line(root, p.x, p.y + p.h, p.x + p.w, p.y + p.h, valSt);
  } else {
    if (catSt) line(root, p.x, yAt, p.x + p.w, yAt, catSt);
    if (valSt) line(root, xAt == null ? p.x : xAt, p.y, xAt == null ? p.x : xAt, p.y + p.h, valSt);
  }
}

function drawBars(root, g, ss, grouping, count, band, catPos, pos, sc, horizontal, base, env) {
  const gap = num(kid(g, 'gapWidth'), 'val', 150) / 100;
  const stacked = grouping === 'stacked' || grouping === 'percentStacked';
  const overlap = stacked ? 1 : num(kid(g, 'overlap'), 'val', 0) / 100;
  const m = stacked ? 1 : ss.length || 1;
  const bw = band / (m - (m - 1) * overlap + gap);
  const zero = pos(Math.max(sc.min, Math.min(0, sc.max)));
  const totals = [];
  if (grouping === 'percentStacked') for (let i = 0; i < count; i++) totals[i] = ss.reduce((a, s) => a + Math.abs(s.vals.list[i] || 0), 0) || 1;
  const posStack = [], negStack = [];
  ss.forEach((s, k) => {
    for (let i = 0; i < count; i++) {
      let v = s.vals.list[i];
      if (v == null) continue;
      if (grouping === 'percentStacked') v /= totals[i];
      let from = 0;
      if (stacked) { const st = v >= 0 ? posStack : negStack; from = st[i] || 0; st[i] = from + v; }
      const a = stacked ? pos(from) : zero, b = pos(stacked ? from + v : v);
      const c = catPos(i);
      const off = -band / 2 + gap * bw / 2 + (stacked ? 0 : k * bw * (1 - overlap));
      const look = s.points.get(i) || (s.vary ? { fill: autoColor(i, env, count), line: s.look.line } : s.look);
      const st = strokeOf(look.line, null);
      const r = horizontal
        ? { x: Math.min(a, b), y: c - off - bw, width: Math.abs(b - a), height: bw }
        : { x: c + off, y: Math.min(a, b), width: bw, height: Math.abs(b - a) };
      el('rect', { ...r, fill: look.noFill ? 'none' : css(look.fill || s.auto), stroke: st ? css(st.color) : null, 'stroke-width': st ? st.width : null }, root);
      const flags = labelFlags(s, i);
      if (flags) {
        const t = textProps(kid(flags.el, 'txPr'), base, env);
        const label = labelText(flags, s, i, s.vals.list[i], null);
        const inside = flags.pos === 'ctr' || flags.pos === 'inEnd' || flags.pos === 'inBase' || (stacked && !flags.pos);
        if (horizontal) {
          const x = inside ? (r.x + r.width / 2) : (v >= 0 ? r.x + r.width + 3 : r.x - 3);
          text(root, label, x, r.y + r.height / 2, t, { anchor: inside ? 'middle' : v >= 0 ? 'start' : 'end' });
        } else {
          const y = inside ? r.y + r.height / 2 : v >= 0 ? r.y - t.size * PT * 0.7 : r.y + r.height + t.size * PT * 0.7;
          text(root, label, r.x + r.width / 2, y, t);
        }
      }
    }
  });
}

function smoothPath(pts) {
  if (pts.length < 3) return pts.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join('');
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

function drawLines(root, g, ss, grouping, count, catPos, pos, sc, horizontal, base, env, area) {
  const stacked = grouping === 'stacked' || grouping === 'percentStacked';
  const showMarkers = bool(kid(g, 'marker'), 'val', true);
  const totals = [];
  if (grouping === 'percentStacked') for (let i = 0; i < count; i++) totals[i] = ss.reduce((a, s) => a + Math.abs(s.vals.list[i] || 0), 0) || 1;
  const acc = new Array(count).fill(0);
  const zero = pos(Math.max(sc.min, Math.min(0, sc.max)));
  const layers = [];
  ss.forEach(s => {
    const pts = [], lows = [];
    for (let i = 0; i < count; i++) {
      let v = s.vals.list[i];
      if (v == null && !stacked) { pts.push(null); continue; }
      v = v || 0;
      if (grouping === 'percentStacked') v /= totals[i];
      const low = stacked ? acc[i] : 0;
      if (stacked) acc[i] += v;
      const top = stacked ? acc[i] : v;
      const c = catPos(i);
      pts.push(horizontal ? [pos(top), c] : [c, pos(top)]);
      lows.push(horizontal ? [pos(low), c] : [c, stacked ? pos(low) : zero]);
    }
    layers.push({ s, pts, lows });
  });
  for (const { s, pts, lows } of layers) {
    const runs = [];
    let cur = [];
    for (const q of pts) { if (q) cur.push(q); else { if (cur.length) runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);
    const color = s.look.line ? s.look.line.color : s.look.fill || s.auto;
    if (area) {
      const top = pts.filter(Boolean);
      if (!top.length) continue;
      const d = `M${top.map(q => q.join(' ')).join('L')}L${[...lows].reverse().map(q => q.join(' ')).join('L')}Z`;
      const st = strokeOf(s.look.line, null);
      el('path', { d, fill: s.look.noFill ? 'none' : css(s.look.fill || s.auto), stroke: st ? css(st.color) : null, 'stroke-width': st ? st.width : null }, root);
      continue;
    }
    if (!s.look.noLine) {
      const w = s.look.line ? Math.max(0.75, s.look.line.width) : 2.25 * PT;
      for (const r of runs) el('path', { d: s.smooth ? smoothPath(r) : r.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join(''), fill: 'none', stroke: css(color), 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.look.line && s.look.line.dash ? s.look.line.dash.map(d => d * w).join(' ') : null }, root);
    }
    if (showMarkers && (!s.marker || s.marker.symbol !== 'none')) {
      for (const q of pts) if (q) marker(root, q[0], q[1], s.marker || { symbol: 'circle', size: 5 }, color);
    }
    pts.forEach((q, i) => {
      const flags = q && labelFlags(s, i);
      if (!flags) return;
      const t = textProps(kid(flags.el, 'txPr'), base, env);
      text(root, labelText(flags, s, i, s.vals.list[i], null), q[0] + (flags.pos === 'r' ? 6 : 0), q[1] - (flags.pos === 'r' ? 0 : t.size * PT * 0.9), t, { anchor: flags.pos === 'r' ? 'start' : 'middle' });
    });
  }
}

function drawScatter(root, series, X, Y, count, room) {
  for (const s of series) {
    const xs = s.xs.list.length ? s.xs.list : Array.from({ length: count }, (_, i) => i + 1);
    const pts = s.vals.list.map((v, i) => (v == null || xs[i] == null ? null : [X(xs[i]), Y(v)]));
    const color = s.look.line ? s.look.line.color : s.look.fill || s.auto;
    const style = attr(kid(s.group, 'scatterStyle'), 'val', 'lineMarker');
    if (s.kind === 'bubble') {
      // Bubble areas follow the sizes; the biggest is a quarter of the plot across.
      const sizes = s.sizes.list;
      const maxS = Math.max(1e-9, ...series.flatMap(x => x.sizes.list).filter(Number.isFinite));
      const scaleB = num(kid(s.group, 'bubbleScale'), 'val', 100) / 100;
      const st = strokeOf(s.look.line, null);
      pts.forEach((q, i) => {
        if (q) el('circle', { cx: q[0], cy: q[1], r: Math.sqrt(Math.max(0, sizes[i] || 0) / maxS) * room / 8 * scaleB, fill: css(s.look.fill || s.auto), stroke: st ? css(st.color) : null, 'stroke-width': st ? st.width : null }, root);
      });
      continue;
    }
    const drawLine = !s.look.noLine && (s.look.lineSet || /line|smooth/i.test(style)) && style !== 'marker';
    const ok = pts.filter(Boolean);
    if (drawLine && ok.length > 1) {
      const w = s.look.line ? Math.max(0.75, s.look.line.width) : 2.25 * PT;
      el('path', { d: s.smooth || /smooth/i.test(style) ? smoothPath(ok) : ok.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join(''), fill: 'none', stroke: css(color), 'stroke-width': w }, root);
    }
    if (!s.marker || s.marker.symbol !== 'none') {
      if (style !== 'line' && style !== 'smooth') for (const q of ok) marker(root, q[0], q[1], s.marker || { symbol: 'circle', size: 5 }, s.marker && s.marker.look.fill ? s.marker.look.fill : color);
    }
  }
}

function drawRadar(root, g, series, area, cats, sc, valAx, base) {
  const n = Math.max(3, cats.length);
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const r = Math.min(area.w, area.h) / 2 * 0.8;
  const filled = attr(kid(g, 'radarStyle'), 'val') === 'filled';
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const R = v => (v - sc.min) / (sc.max - sc.min || 1) * r;
  const st = strokeOf(null, GRID);
  for (const v of sc.ticks) {
    const d = Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${cx + Math.cos(ang(i)) * R(v)} ${cy + Math.sin(ang(i)) * R(v)}`).join('') + 'Z';
    el('path', { d, fill: 'none', stroke: css(st.color), 'stroke-width': st.width }, root);
  }
  for (let i = 0; i < n; i++) {
    line(root, cx, cy, cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r, st);
    text(root, cats[i] || '', cx + Math.cos(ang(i)) * (r + 12), cy + Math.sin(ang(i)) * (r + 12), base, { anchor: Math.abs(Math.cos(ang(i))) < 0.2 ? 'middle' : Math.cos(ang(i)) > 0 ? 'start' : 'end' });
  }
  for (const s of series) {
    const pts = Array.from({ length: n }, (_, i) => [cx + Math.cos(ang(i)) * R(s.vals.list[i] || 0), cy + Math.sin(ang(i)) * R(s.vals.list[i] || 0)]);
    const color = s.look.line ? s.look.line.color : s.look.fill || s.auto;
    el('path', { d: pts.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join('') + 'Z', fill: filled ? css(s.look.fill || s.auto) : 'none', 'fill-opacity': filled ? 0.6 : null, stroke: css(color), 'stroke-width': 2 }, root);
    if (!filled && (!s.marker || s.marker.symbol !== 'none')) for (const q of pts) marker(root, q[0], q[1], s.marker || { symbol: 'circle', size: 5 }, color);
  }
  if (!valAx.deleted) for (const v of sc.ticks) text(root, formatNumber(v, valAx.format), cx + 3, cy - R(v), valAx.text, { anchor: 'start' });
}

