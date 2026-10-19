// DrawingML basics shared by the slide, table and chart renderers: XML
// helpers that see through mc:AlternateContent, colours (theme colours,
// colour maps, and transforms like lumMod or tint), fills and outlines.

export const EMU = 9525;  // EMUs per CSS pixel (96 per inch)
export const px = v => (+v || 0) / EMU;
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// --- XML ---------------------------------------------------------------------------
// Names are matched without their prefix: files use the standard ones anyway,
// and nothing here mixes two namespaces with the same local names.

/** What mc:AlternateContent stands for: its fallback (pictures of equations,
 *  ink and new chart types), or else its first choice. */
function pick(ac) {
  let choice = null;
  for (let c = ac.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'Fallback') return c;
    if (c.localName === 'Choice' && !choice) choice = c;
  }
  return choice;
}

/** Child elements, with mc:AlternateContent replaced by what it stands for. */
export function children(el) {
  const out = [];
  for (let c = el && el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'AlternateContent') {
      const p = pick(c);
      if (p) out.push(...children(p));
    } else out.push(c);
  }
  return out;
}

export function kid(el, name) {
  for (let c = el && el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === name) return c;
    if (c.localName === 'AlternateContent') {
      const p = pick(c);
      const k = p && kid(p, name);
      if (k) return k;
    }
  }
  return null;
}

export const kids = (el, name) => children(el).filter(c => c.localName === name);

/** Walk down: find(sp, 'spPr', 'xfrm', 'off'). */
export function find(el, ...names) {
  for (const n of names) {
    el = kid(el, n);
    if (!el) return null;
  }
  return el;
}

export const attr = (el, name, def = null) => (el && el.hasAttribute(name) ? el.getAttribute(name) : def);
export function num(el, name, def = null) {
  const v = attr(el, name);
  if (v == null || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
export function bool(el, name, def = false) {
  const v = attr(el, name);
  return v == null ? def : v === '1' || v === 'true' || v === 'on';
}
/** A relationship id attribute (r:id, r:embed, r:link…). */
export const rid = (el, name = 'id') => (el ? el.getAttributeNS(NS_R, name) || el.getAttribute('r:' + name) || null : null);

/** Percentages are stored in thousandths of a percent, as "50000" or "50%". */
export function pct(el, name, def = null) {
  const v = attr(el, name);
  if (v == null) return def;
  return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 100000;
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('damaged XML');
  return doc;
}

// --- colours -------------------------------------------------------------------------
// A colour is {r, g, b, a}: sRGB channels 0–255 and alpha 0–1.

const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr']);
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hex(v) {
  if (!v || !/^[0-9a-f]{6}$/i.test(v)) return null;
  const n = parseInt(v, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

let probe;
const presetCache = new Map();
/** Preset colours are the CSS named colours, some spelled "dkBlue" or "ltGray". */
function preset(name) {
  if (!name) return null;
  if (!presetCache.has(name)) {
    const css = name.replace(/^dk/, 'dark').replace(/^lt/, 'light').replace(/^med/, 'medium').toLowerCase();
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000001';
    probe.fillStyle = css;
    presetCache.set(name, probe.fillStyle === '#000001' ? null : hex(probe.fillStyle.slice(1)));
  }
  const c = presetCache.get(name);
  return c && { ...c };
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h, s, l, a) {
  h = ((h % 360) + 360) % 360 / 360;
  if (!s) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a };
}

/** Apply the transform children of a colour element (lumMod, tint, alpha…). */
function transform(c, el) {
  for (let t = el.firstElementChild; t; t = t.nextElementSibling) {
    const n = t.localName;
    const v = n.startsWith('hue') && n !== 'hueMod' ? num(t, 'val', 0) / 60000 : pct(t, 'val', 0);
    switch (n) {
      case 'alpha': c.a = clamp(v); break;
      case 'alphaMod': c.a = clamp(c.a * v); break;
      case 'alphaOff': c.a = clamp(c.a + v); break;
      case 'lumMod': case 'lumOff': case 'lum': case 'satMod': case 'satOff': case 'sat': case 'hue': case 'hueMod': case 'hueOff': {
        let [h, s, l] = toHsl(c);
        if (n === 'lumMod') l *= v; else if (n === 'lumOff') l += v; else if (n === 'lum') l = v;
        else if (n === 'satMod') s *= v; else if (n === 'satOff') s += v; else if (n === 'sat') s = v;
        else if (n === 'hue') h = v; else if (n === 'hueMod') h *= v; else h += v;
        c = fromHsl(h, clamp(s), clamp(l), c.a);
        break;
      }
      case 'tint': case 'shade':
        // In linear RGB, like Office (Office 2007's "D0D8E8" table rows come out exactly).
        c = tintShade(c, n, clamp(v));
        break;
      case 'comp': { const [h, s, l] = toHsl(c); c = fromHsl(h + 180, s, l, c.a); break; }
      case 'inv': c = { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a }; break;
      case 'gray': { const y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; c = { r: y, g: y, b: y, a: c.a }; break; }
      case 'red': c.r = clamp(v) * 255; break;
      case 'green': c.g = clamp(v) * 255; break;
      case 'blue': c.b = clamp(v) * 255; break;
      case 'redMod': c.r = clamp(c.r * v, 0, 255); break;
      case 'greenMod': c.g = clamp(c.g * v, 0, 255); break;
      case 'blueMod': c.b = clamp(c.b * v, 0, 255); break;
      case 'redOff': c.r = clamp(c.r + v * 255, 0, 255); break;
      case 'greenOff': c.g = clamp(c.g + v * 255, 0, 255); break;
      case 'blueOff': c.b = clamp(c.b + v * 255, 0, 255); break;
      default: break;  // gamma, invGamma: no visible difference worth the code
    }
  }
  return c;
}

const DEFAULT_MAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

/**
 * The colour in `el` (a colour element, or an element holding one).
 * `cx` = {scheme: {dk1: colour…}, map: clrMap, ph: the colour that replaces phClr}.
 */
export function color(el, cx) {
  if (!el) return null;
  let c = COLOR_TAGS.has(el.localName) ? el : null;
  if (!c) for (let k = el.firstElementChild; k; k = k.nextElementSibling) if (COLOR_TAGS.has(k.localName)) { c = k; break; }
  if (!c) return null;
  let base = null;
  switch (c.localName) {
    case 'srgbClr': base = hex(attr(c, 'val')); break;
    case 'schemeClr': {
      const v = attr(c, 'val');
      if (v === 'phClr') base = cx.ph ? { ...cx.ph } : null;
      else {
        const name = (cx.map && cx.map[v]) || DEFAULT_MAP[v] || v;
        const s = cx.scheme && cx.scheme[name];
        base = s ? { ...s } : null;
      }
      break;
    }
    case 'sysClr': base = hex(attr(c, 'lastClr')) || (attr(c, 'val') === 'window' ? hex('FFFFFF') : hex('000000')); break;
    case 'prstClr': base = preset(attr(c, 'val')); break;
    case 'scrgbClr': base = { r: toSrgb(clamp(pct(c, 'r', 0))) * 255, g: toSrgb(clamp(pct(c, 'g', 0))) * 255, b: toSrgb(clamp(pct(c, 'b', 0))) * 255, a: 1 }; break;
    case 'hslClr': base = fromHsl(num(c, 'hue', 0) / 60000, clamp(pct(c, 'sat', 0)), clamp(pct(c, 'lum', 0)), 1); break;
  }
  return base && transform(base, c);
}

export const css = c => (c ? `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+c.a.toFixed(3)})` : 'transparent');
export const opaque = c => !!c && c.a > 0;
export const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });

/** Office's tint (towards white) and shade (towards black), in linear RGB. */
export function tintShade(c, kind, k) {
  const out = { ...c };
  for (const ch of ['r', 'g', 'b']) {
    const lin = toLinear(c[ch] / 255);
    out[ch] = toSrgb(kind === 'tint' ? 1 - (1 - lin) * k : lin * k) * 255;
  }
  return out;
}

/** Darken / lighten for the shaded faces of shapes like "can" or "cube". */
export function shadeFor(c, mode) {
  if (!c) return c;
  const k = { darken: 0.6, darkenLess: 0.8, lighten: 0.6, lightenLess: 0.8 }[mode];
  if (!k) return c;
  if (mode.startsWith('darken')) return { r: c.r * k, g: c.g * k, b: c.b * k, a: c.a };
  return { r: 255 - (255 - c.r) * k, g: 255 - (255 - c.g) * k, b: 255 - (255 - c.b) * k, a: c.a };
}

/** A theme's colours, fonts and style lists. */
export function readTheme(doc) {
  const t = { scheme: {}, fonts: { major: {}, minor: {} }, fills: [], bgFills: [], lines: [], effects: [] };
  if (!doc) return t;
  const el = doc.documentElement;
  const elements = find(el, 'themeElements');
  const scheme = kid(elements, 'clrScheme');
  for (const c of children(scheme)) t.scheme[c.localName] = color(c, {}) || hex('000000');
  const fonts = kid(elements, 'fontScheme');
  for (const [key, tag] of [['major', 'majorFont'], ['minor', 'minorFont']]) {
    const f = kid(fonts, tag);
    for (const k of ['latin', 'ea', 'cs']) t.fonts[key][k] = attr(kid(f, k), 'typeface') || '';
  }
  const fmt = kid(elements, 'fmtScheme');
  t.fills = children(kid(fmt, 'fillStyleLst'));
  t.bgFills = children(kid(fmt, 'bgFillStyleLst'));
  t.lines = children(kid(fmt, 'lnStyleLst'));
  t.effects = children(kid(fmt, 'effectStyleLst'));
  return t;
}

// --- fills ---------------------------------------------------------------------------

const FILL_TAGS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);
export function fillEl(parent) {
  for (const c of children(parent)) if (FILL_TAGS.has(c.localName)) return c;
  return null;
}

/**
 * A fill element as {type: 'none'} | {type: 'solid', color} |
 * {type: 'grad', stops, angle, scaled, path, focus} | {type: 'blip', el} |
 * {type: 'patt', prst, fg, bg} | {type: 'grp'}.
 */
export function readFill(f, cx) {
  if (!f) return null;
  switch (f.localName) {
    case 'noFill': return { type: 'none' };
    case 'solidFill': return { type: 'solid', color: color(f, cx) || { r: 0, g: 0, b: 0, a: 1 } };
    case 'gradFill': {
      const stops = kids(kid(f, 'gsLst'), 'gs').map(g => ({ pos: clamp(pct(g, 'pos', 0)), color: color(g, cx) || { r: 0, g: 0, b: 0, a: 1 } }))
        .sort((a, b) => a.pos - b.pos);
      if (!stops.length) return { type: 'none' };
      const lin = kid(f, 'lin'), path = kid(f, 'path');
      const ftr = kid(path, 'fillToRect');
      return {
        type: 'grad', stops,
        angle: lin ? num(lin, 'ang', 0) / 60000 : path ? null : 90,
        scaled: bool(lin, 'scaled', false),
        path: path ? attr(path, 'path', 'circle') : null,
        focus: ftr ? { l: pct(ftr, 'l', 0), t: pct(ftr, 't', 0), r: pct(ftr, 'r', 0), b: pct(ftr, 'b', 0) } : { l: 0.5, t: 0.5, r: 0.5, b: 0.5 },
        rotate: bool(f, 'rotWithShape', true),
      };
    }
    case 'blipFill': return { type: 'blip', el: f, cx };
    case 'pattFill': return {
      type: 'patt', prst: attr(f, 'prst', 'pct50'),
      fg: color(kid(f, 'fgClr'), cx) || { r: 0, g: 0, b: 0, a: 1 },
      bg: color(kid(f, 'bgClr'), cx) || { r: 255, g: 255, b: 255, a: 1 },
    };
    case 'grpFill': return { type: 'grp' };
    default: return null;
  }
}

/** A fill from a theme style list: idx 1–999 → fill styles, 1001+ → background fills. */
export function themeFill(theme, idx, ph, cx) {
  idx = +idx || 0;
  const el = idx >= 1001 ? theme.bgFills[idx - 1001] : idx > 0 ? theme.fills[idx - 1] : null;
  if (!el) return idx ? null : { type: 'none' };
  return readFill(el, { ...cx, ph });
}

/** One colour that stands in for a fill (text, patterns, outlines with gradients). */
export function fillColor(f) {
  if (!f) return null;
  if (f.type === 'solid') return f.color;
  if (f.type === 'grad') return f.stops[0].color;
  if (f.type === 'patt') return mix(f.bg, f.fg, pattDensity(f.prst));
  return null;
}

/** How much of a pattern is foreground (patterns are drawn as a blend). */
export function pattDensity(prst) {
  const m = /^pct(\d+)$/.exec(prst || '');
  if (m) return +m[1] / 100;
  if (/^(lt|narrow|dashDn|dashUp|dashHorz|dashVert|smGrid|dotGrid|dotDmnd)/.test(prst)) return 0.25;
  if (/^(dk|wide|lg|solidDmnd|weave|plaid|divot|shingle|trellis|sphere|zigZag|wave)/.test(prst)) return 0.6;
  return 0.4;
}

// --- outlines ------------------------------------------------------------------------

const DASHES = {
  dot: [1, 3], dash: [4, 3], dashDot: [4, 3, 1, 3], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDot: [1, 1], sysDash: [3, 1], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

/**
 * An outline: {width (px), color, dash: [multiples of the width] | null, cap,
 * join, head, tail} or null for none. `ln` overrides `base` field by field
 * (a style reference gives the base).
 */
export function readLine(ln, cx, base = null) {
  const out = base ? { ...base } : { width: 0.75, color: null, dash: null, cap: 'butt', join: 'round', head: null, tail: null, none: true };
  if (!ln) return out;
  if (ln.hasAttribute('w')) out.width = px(ln.getAttribute('w'));
  const cap = attr(ln, 'cap');
  if (cap) out.cap = cap === 'rnd' ? 'round' : cap === 'sq' ? 'square' : 'butt';
  for (const c of children(ln)) {
    switch (c.localName) {
      case 'noFill': out.none = true; break;
      case 'solidFill': case 'gradFill': case 'pattFill': {
        const f = readFill(c, cx);
        out.none = false;
        out.color = fillColor(f);
        out.fill = f.type === 'grad' ? f : null;
        break;
      }
      case 'prstDash': { const v = attr(c, 'val'); out.dash = DASHES[v] || null; break; }
      case 'custDash': out.dash = kids(c, 'ds').flatMap(d => [pct(d, 'd', 1), pct(d, 'sp', 1)]); break;
      case 'round': out.join = 'round'; break;
      case 'bevel': out.join = 'bevel'; break;
      case 'miter': out.join = 'miter'; break;
      case 'headEnd': case 'tailEnd': {
        const type = attr(c, 'type', 'none');
        out[c.localName === 'headEnd' ? 'head' : 'tail'] = type === 'none' ? null : { type, w: attr(c, 'w', 'med'), len: attr(c, 'len', 'med') };
        break;
      }
    }
  }
  return out;
}

export function themeLine(theme, idx, ph, cx) {
  const el = theme.lines[(+idx || 0) - 1];
  if (!el) return null;
  return readLine(el, { ...cx, ph });
}

/** An outer shadow from an effect list: {x, y, blur, color} in px, or null. */
export function readShadow(effectLst, cx) {
  const s = kid(effectLst, 'outerShdw') || kid(effectLst, 'prstShdw');
  if (!s) return null;
  const c = color(s, cx);
  if (!c || !c.a) return null;
  const dist = px(attr(s, 'dist', 0)), dir = num(s, 'dir', 0) / 60000 * Math.PI / 180;
  return { x: dist * Math.cos(dir), y: dist * Math.sin(dir), blur: px(attr(s, 'blurRad', 0)), color: c };
}

export function themeEffect(theme, idx, ph, cx) {
  const el = theme.effects[(+idx || 0) - 1];
  if (!el) return null;
  return readShadow(kid(el, 'effectLst'), { ...cx, ph });
}
