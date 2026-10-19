// Text bodies: paragraphs, runs, bullets and numbering, with their styles
// inherited down the chain master → layout → placeholder → shape → paragraph
// → run, the way PowerPoint resolves them.
import { attr, num, bool, kid, kids, children, pct, color, readFill, readLine, readShadow, css, px, rid } from './ooxml.js';

const PT = 4 / 3;  // CSS px per point

// --- fonts -----------------------------------------------------------------------------
// Free fonts with the same metrics as the Office ones keep lines breaking
// where they did in PowerPoint; Carlito and Caladea ship with sshcode.
const SUBS = {
  calibri: ['Carlito'], 'calibri light': ['Carlito'], cambria: ['Caladea'], 'cambria math': ['Caladea'],
  arial: ['Liberation Sans', 'Arimo', 'Helvetica'], helvetica: ['Liberation Sans', 'Arimo', 'Arial'],
  'helvetica neue': ['Liberation Sans', 'Arimo', 'Arial'], 'arial narrow': ['Liberation Sans Narrow'],
  'times new roman': ['Liberation Serif', 'Tinos', 'Times'], times: ['Liberation Serif', 'Tinos', 'Times New Roman'],
  'courier new': ['Liberation Mono', 'Cousine', 'Courier'], courier: ['Liberation Mono', 'Cousine'],
  consolas: ['Inconsolata', 'DejaVu Sans Mono'], 'lucida console': ['DejaVu Sans Mono'],
  'segoe ui': ['Noto Sans', 'DejaVu Sans'], 'segoe ui light': ['Noto Sans'], 'segoe ui semibold': ['Noto Sans'],
  verdana: ['DejaVu Sans'], tahoma: ['DejaVu Sans'], georgia: ['Gelasio', 'DejaVu Serif'],
  'century gothic': ['URW Gothic', 'TeX Gyre Adventor'], 'franklin gothic book': ['Libre Franklin'],
  garamond: ['EB Garamond', 'C059'], 'palatino linotype': ['P052', 'TeX Gyre Pagella', 'Palatino'],
  'book antiqua': ['P052', 'TeX Gyre Pagella'], 'bookman old style': ['URW Bookman'],
  'century schoolbook': ['C059', 'TeX Gyre Schola'], 'gill sans mt': ['Gillius ADF', 'Noto Sans'],
  aptos: ['Inter Variable', 'Noto Sans'], 'aptos display': ['Inter Variable', 'Noto Sans'],
  'aptos narrow': ['Liberation Sans Narrow'], 'trebuchet ms': ['Ubuntu', 'DejaVu Sans'],
  'yu gothic': ['Noto Sans CJK JP'], 'ms gothic': ['Noto Sans CJK JP'], 'ms mincho': ['Noto Serif CJK JP'],
  'malgun gothic': ['Noto Sans CJK KR'], 'microsoft yahei': ['Noto Sans CJK SC'], simsun: ['Noto Serif CJK SC'],
};
// Single line spacing as a multiple of the font size, from each font's metrics.
const LINE = {
  calibri: 1.22, 'calibri light': 1.22, cambria: 1.17, arial: 1.15, helvetica: 1.15, 'helvetica neue': 1.2,
  'times new roman': 1.15, times: 1.15, 'courier new': 1.13, consolas: 1.17, 'segoe ui': 1.33, verdana: 1.22,
  tahoma: 1.21, georgia: 1.14, 'century gothic': 1.23, garamond: 1.12, 'trebuchet ms': 1.16, aptos: 1.2,
  'gill sans mt': 1.15, 'franklin gothic book': 1.13, 'palatino linotype': 1.14, 'book antiqua': 1.17,
};
const SYMBOL_FONTS = /^(wingdings|wingdings 2|wingdings 3|webdings|symbol|marlett)$/i;
const clean = s => String(s || '').replace(/["'\\;{}<>]/g, '').trim();

function generic(name) {
  if (/mono|courier|consol|code/i.test(name)) return 'monospace';
  if (/serif|times|roman|garamond|cambria|georgia|palatino|antiqua|bookman|mincho|song|schoolbook|baskerville|didot/i.test(name) && !/sans/i.test(name)) return 'serif';
  return 'sans-serif';
}

const stackCache = new Map();
/** A CSS font-family list for a DrawingML typeface (and an East Asian one). */
export function fontStack(name, ea) {
  const key = name + '|' + (ea || '');
  if (!stackCache.has(key)) {
    const n = clean(name) || 'Calibri';
    const fam = [n, ...(SUBS[n.toLowerCase()] || [])];
    const e = clean(ea);
    if (e && e.toLowerCase() !== n.toLowerCase()) fam.push(e, ...(SUBS[e.toLowerCase()] || []));
    stackCache.set(key, fam.map(f => `"${f}"`).join(', ') + ', ' + generic(n));
  }
  return stackCache.get(key);
}

const lineFactor = name => LINE[clean(name).toLowerCase()] || 1.2;

/** "+mn-lt" and friends point at the theme's fonts. */
export function themeFont(face, theme) {
  if (!face || face[0] !== '+') return face;
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(face);
  if (!m || !theme) return null;
  const f = theme.fonts[m[1] === 'mj' ? 'major' : 'minor'];
  return f[m[2] === 'lt' ? 'latin' : m[2]] || null;
}

// --- styles ------------------------------------------------------------------------------

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
export const BASE_RUN = {
  sz: 1800, b: false, i: false, u: 'none', strike: 'noStrike', cap: 'none', spc: 0, baseline: 0,
  fill: { type: 'solid', color: BLACK }, latin: '+mn-lt', ea: '+mn-ea', sym: null, highlight: null, outline: null, shadow: null,
};
const BASE_PARA = {
  algn: 'l', marL: 0, marR: 0, indent: 0, defTab: 96, rtl: false,
  lnSpc: { pct: 1 }, spcBef: { pts: 0 }, spcAft: { pts: 0 },
  bu: { type: 'none' }, buColor: null, buSize: null, buFont: null, run: BASE_RUN,
};

function spacing(el) {
  const p = kid(el, 'spcPct'), s = kid(el, 'spcPts');
  if (p) return { pct: pct(p, 'val', 1) };
  if (s) return { pts: num(s, 'val', 0) / 100 };
  return null;
}

/** Overlay an a:rPr / a:defRPr / a:endParaRPr on a run style. */
export function mergeRun(base, el, cx) {
  if (!el) return base;
  const r = { ...base };
  if (el.hasAttribute('sz')) r.sz = num(el, 'sz', r.sz);
  if (el.hasAttribute('b')) r.b = bool(el, 'b');
  if (el.hasAttribute('i')) r.i = bool(el, 'i');
  if (el.hasAttribute('u')) r.u = attr(el, 'u');
  if (el.hasAttribute('strike')) r.strike = attr(el, 'strike');
  if (el.hasAttribute('cap')) r.cap = attr(el, 'cap');
  if (el.hasAttribute('spc')) r.spc = num(el, 'spc', 0);
  if (el.hasAttribute('baseline')) r.baseline = pct(el, 'baseline', 0);
  for (const c of children(el)) {
    switch (c.localName) {
      case 'noFill': case 'solidFill': case 'gradFill': case 'pattFill': r.fill = readFill(c, cx); break;
      case 'ln': r.outline = readLine(c, cx); break;
      case 'effectLst': r.shadow = readShadow(c, cx); break;
      case 'highlight': r.highlight = color(c, cx); break;
      case 'latin': r.latin = attr(c, 'typeface') || r.latin; break;
      case 'ea': r.ea = attr(c, 'typeface') || r.ea; break;
      case 'sym': r.sym = attr(c, 'typeface'); break;
    }
  }
  return r;
}

/** Overlay an a:pPr / a:lvlNpPr on a paragraph style. */
export function mergePara(base, el, cx) {
  if (!el) return base;
  const s = { ...base };
  if (el.hasAttribute('algn')) s.algn = attr(el, 'algn');
  if (el.hasAttribute('marL')) s.marL = px(attr(el, 'marL'));
  if (el.hasAttribute('marR')) s.marR = px(attr(el, 'marR'));
  if (el.hasAttribute('indent')) s.indent = px(attr(el, 'indent'));
  if (el.hasAttribute('defTabSz')) s.defTab = px(attr(el, 'defTabSz')) || s.defTab;
  if (el.hasAttribute('rtl')) s.rtl = bool(el, 'rtl');
  for (const c of children(el)) {
    switch (c.localName) {
      case 'lnSpc': s.lnSpc = spacing(c) || s.lnSpc; break;
      case 'spcBef': s.spcBef = spacing(c) || s.spcBef; break;
      case 'spcAft': s.spcAft = spacing(c) || s.spcAft; break;
      case 'buClrTx': s.buColor = null; break;
      case 'buClr': s.buColor = color(c, cx); break;
      case 'buSzTx': s.buSize = null; break;
      case 'buSzPct': s.buSize = { pct: pct(c, 'val', 1) }; break;
      case 'buSzPts': s.buSize = { pts: num(c, 'val', 1200) / 100 }; break;
      case 'buFontTx': s.buFont = null; break;
      case 'buFont': s.buFont = attr(c, 'typeface'); break;
      case 'buNone': s.bu = { type: 'none' }; break;
      case 'buChar': s.bu = { type: 'char', char: attr(c, 'char', '•') }; break;
      case 'buAutoNum': s.bu = { type: 'auto', scheme: attr(c, 'type', 'arabicPeriod'), start: num(c, 'startAt', 1) }; break;
      case 'buBlip': s.bu = { type: 'blip', el: kid(c, 'blip') }; break;
      case 'defRPr': s.run = mergeRun(s.run, c, cx); break;
    }
  }
  return s;
}

/**
 * The style of each list level, from a chain of list styles (lowest
 * priority first). Each link is an element holding a:defPPr / a:lvlNpPr
 * (a:lstStyle, p:titleStyle…) or {run: {...}} to overlay on the run style.
 */
export function levelStyles(chain, cx) {
  const cache = [];
  return lvl => {
    if (!cache[lvl]) {
      // Files without list styles (some exports) still nest their levels, half an inch each.
      let s = { ...BASE_PARA, marL: lvl * 48 };
      for (const link of chain) {
        if (!link) continue;
        if (link.run) { s = { ...s, run: { ...s.run, ...link.run } }; continue; }
        s = mergePara(s, kid(link, 'defPPr'), cx);
        s = mergePara(s, kid(link, `lvl${lvl + 1}pPr`), cx);
      }
      cache[lvl] = s;
    }
    return cache[lvl];
  };
}

/** Merge a:bodyPr elements (lowest priority first). */
export function bodyProps(list) {
  const b = { l: 96 / 10, t: 96 / 20, r: 96 / 10, b: 96 / 20, anchor: 't', anchorCtr: false, wrap: true, vert: 'horz', rot: 0, upright: false, cols: 1, colGap: 0, fit: null, fontScale: 1, lnReduce: 0 };
  for (const el of list) {
    if (!el) continue;
    for (const [k, a] of [['l', 'lIns'], ['t', 'tIns'], ['r', 'rIns'], ['b', 'bIns']]) if (el.hasAttribute(a)) b[k] = px(attr(el, a));
    if (el.hasAttribute('anchor')) b.anchor = attr(el, 'anchor');
    if (el.hasAttribute('anchorCtr')) b.anchorCtr = bool(el, 'anchorCtr');
    if (el.hasAttribute('wrap')) b.wrap = attr(el, 'wrap') !== 'none';
    if (el.hasAttribute('vert')) b.vert = attr(el, 'vert');
    if (el.hasAttribute('rot')) b.rot = num(el, 'rot', 0) / 60000;
    if (el.hasAttribute('upright')) b.upright = bool(el, 'upright');
    if (el.hasAttribute('numCol')) b.cols = Math.max(1, num(el, 'numCol', 1));
    if (el.hasAttribute('spcCol')) b.colGap = px(attr(el, 'spcCol'));
    const nf = kid(el, 'normAutofit');
    if (nf) { b.fit = 'norm'; b.fontScale = pct(nf, 'fontScale', 1); b.lnReduce = pct(nf, 'lnSpcReduction', 0); }
    else if (kid(el, 'spAutoFit')) { b.fit = 'shape'; b.fontScale = 1; b.lnReduce = 0; }
    else if (kid(el, 'noAutofit')) { b.fit = null; b.fontScale = 1; b.lnReduce = 0; }
  }
  return b;
}

// --- bullets and numbers -------------------------------------------------------------------

// Bullets drawn with symbol fonts, by character code, as Unicode.
const SYMBOL_MAP = {
  wingdings: {
    0x6c: '●', 0x6d: '❍', 0x6e: '■', 0x6f: '□', 0x70: '◻', 0x71: '❑', 0x72: '❒', 0x73: '⬧', 0x74: '⧫', 0x75: '◆',
    0x76: '❖', 0x77: '⬥', 0x78: '⌧', 0x9f: '•', 0xa1: '○', 0xa7: '▪', 0xa8: '◻', 0xab: '★', 0xd8: '➢', 0xe0: '➢',
    0xe8: '➔', 0xef: '⇦', 0xf0: '⇨', 0xf1: '⇧', 0xf2: '⇩', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
  },
  'wingdings 2': { 0x97: '•', 0x98: '◆', 0xae: '◼', 0xa1: '○', 0xa2: '◯', 0xf8: '✕', 0x50: '✓', 0x4f: '✗' },
  'wingdings 3': { 0x7d: '▶', 0x75: '▶', 0x84: '►', 0xc6: '➤', 0xd7: '▸', 0x22: '⬅', 0x5d: '▲', 0x5e: '▼' },
  symbol: { 0xb7: '•', 0xa8: '♦', 0xa7: '♣', 0xae: '→', 0xde: '⇒', 0x2d: '−', 0xd7: '·', 0xe0: '◊' },
};

function bulletChar(ch, font) {
  const f = clean(font).toLowerCase();
  if (!SYMBOL_FONTS.test(f)) return { ch, symbol: false };
  let code = ch.codePointAt(0);
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000;
  const map = SYMBOL_MAP[f] || {};
  return { ch: map[code] || (code < 0x80 && f === 'symbol' ? ch : '•'), symbol: true };
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function roman(n) {
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}
function alpha(n) {
  let s = '';
  for (n = Math.max(1, n); n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + (n - 1) % 26) + s;
  return s;
}
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** "arabicPeriod", 3 → "3."; "alphaLcParenR", 2 → "b)"; "romanUcPeriod", 4 → "IV." */
export function autoNumber(scheme, n) {
  const m = /^(alphaLc|alphaUc|arabic|romanLc|romanUc|circleNum\w*?)(ParenBoth|ParenR|Period|Plain|Minus|DbPeriod|DbPlain)?$/.exec(scheme || '') || [];
  const kind = m[1] || 'arabic';
  let v;
  if (kind === 'alphaLc') v = alpha(n);
  else if (kind === 'alphaUc') v = alpha(n).toUpperCase();
  else if (kind === 'romanLc') v = roman(n);
  else if (kind === 'romanUc') v = roman(n).toUpperCase();
  else if (kind.startsWith('circleNum')) return CIRCLED[n - 1] || String(n);
  else v = String(n);
  const suffix = m[2] || 'Period';
  if (suffix === 'ParenBoth') return `(${v})`;
  if (suffix === 'ParenR') return `${v})`;
  if (suffix === 'Plain' || suffix === 'DbPlain') return v;
  if (suffix === 'Minus') return `- ${v} -`;
  return `${v}.`;
}

// --- rendering ---------------------------------------------------------------------------

/**
 * Text body → element. `opts`:
 *   levels   (lvl) → paragraph style (from levelStyles)
 *   body     merged bodyPr (from bodyProps)
 *   cx       colour context; theme; slideNum
 *   link(rel id, element) → {href} | {slide}, for hyperlinks
 *   blip(a:blip, img) → sets the picture of a picture bullet
 * Returns null when there's no visible text.
 */
export function renderText(txBody, opts) {
  const { levels, body, cx, theme } = opts;
  const scale = body.fontScale || 1;
  const paras = kids(txBody, 'p');
  if (!paras.length) return null;
  const block = document.createElement('div');
  block.className = 'p-tb';
  let any = false;
  const counters = [], schemes = [];
  for (const p of paras) {
    const pPr = kid(p, 'pPr');
    const lvl = Math.min(8, Math.max(0, num(pPr, 'lvl', 0)));
    const ps = mergePara(levels(lvl), pPr, cx);
    const runs = [];
    for (const c of children(p)) {
      const n = c.localName;
      if (n === 'r' || n === 'fld') {
        let text = (kid(c, 't') || {}).textContent || '';
        if (n === 'fld' && attr(c, 'type') === 'slidenum' && opts.slideNum != null) text = String(opts.slideNum);
        runs.push({ text: text.replace(/\v/g, '\n'), style: mergeRun(ps.run, kid(c, 'rPr'), cx), rPr: kid(c, 'rPr') });
      } else if (n === 'br') {
        runs.push({ br: true, style: mergeRun(ps.run, kid(c, 'rPr'), cx) });
      }
    }
    const end = mergeRun(ps.run, kid(p, 'endParaRPr'), cx);
    const hasText = runs.some(r => r.text && r.text.trim());
    if (runs.some(r => r.br || r.text)) any = true;
    const first = runs.find(r => r.text) || runs[0] || { style: end };
    const pe = document.createElement('p');
    const sizePx = s => s.sz / 100 * PT * scale;
    const fs = sizePx(first.style);
    const lf = lineFactor(themeFont(first.style.latin, theme));
    pe.style.fontSize = `${fs}px`;
    pe.style.textAlign = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify', justLow: 'justify', thaiDist: 'justify' }[ps.algn] || 'left';
    if (ps.algn === 'dist') pe.style.textAlignLast = 'justify';
    if (ps.rtl) pe.dir = 'rtl';
    if (ps.marL) pe.style.paddingLeft = `${ps.marL}px`;
    if (ps.marR) pe.style.paddingRight = `${ps.marR}px`;
    if (ps.indent) pe.style.textIndent = `${ps.indent}px`;
    pe.style.tabSize = `${ps.defTab}px`;
    const line = ps.lnSpc.pct != null ? { pct: Math.max(0.1, ps.lnSpc.pct - (body.lnReduce || 0)) } : { px: ps.lnSpc.pts * PT * scale };
    const lineHeight = (factor) => (line.px != null ? `${line.px}px` : String(+(line.pct * factor).toFixed(3)));
    pe.style.lineHeight = lineHeight(lf);
    // Space before and after: a percentage of the text size, or points.
    const space = (s) => (s.pct != null ? s.pct * fs * (1 - (body.lnReduce || 0)) : s.pts * PT * scale);
    const before = space(ps.spcBef), after = space(ps.spcAft);
    if (before) pe.style.marginTop = `${before}px`;
    if (after) pe.style.marginBottom = `${after}px`;

    // Numbering continues through deeper levels and restarts after other paragraphs.
    for (let k = lvl + 1; k < 9; k++) { counters[k] = 0; schemes[k] = null; }
    let label = null;
    if (hasText && ps.bu.type === 'auto') {
      const key = `${ps.bu.scheme}/${ps.bu.start}`;
      if (schemes[lvl] !== key) { counters[lvl] = ps.bu.start - 1; schemes[lvl] = key; }
      counters[lvl]++;
      label = autoNumber(ps.bu.scheme, counters[lvl]);
    } else if (hasText) {
      counters[lvl] = 0; schemes[lvl] = null;
    }
    if (hasText && (ps.bu.type === 'char' || label || ps.bu.type === 'blip')) {
      const b = document.createElement('span');
      b.className = 'p-bu';
      const runStyle = first.style;
      const size = ps.buSize ? (ps.buSize.pct != null ? sizePx(runStyle) * ps.buSize.pct : ps.buSize.pts * PT * scale) : sizePx(runStyle);
      const face = ps.buFont || themeFont(runStyle.latin, theme) || 'Arial';
      if (ps.bu.type === 'blip') {
        const img = document.createElement('img');
        img.alt = '';
        img.style.height = `${size}px`;
        img.style.verticalAlign = 'middle';
        if (opts.blip) opts.blip(ps.bu.el, img);
        b.append(img);
      } else {
        const ch = label ? { ch: label, symbol: false } : bulletChar(ps.bu.char, face);
        b.textContent = ch.ch;
        b.style.fontFamily = fontStack(ch.symbol ? themeFont(runStyle.latin, theme) : face);
      }
      b.style.fontSize = `${size}px`;
      b.style.color = css(ps.buColor || fillToColor(runStyle.fill) || BLACK);
      b.style.lineHeight = '1';
      b.style.display = 'inline-block';
      b.style.textIndent = '0';
      if (ps.indent < 0) b.style.minWidth = `${-ps.indent}px`;
      else b.style.paddingRight = '0.35em';
      pe.append(b);
    }
    for (const r of runs) {
      if (r.br) {
        const s = document.createElement('span');
        styleRun(s, r.style, opts, scale, lineHeight);
        s.append(document.createElement('br'));
        pe.append(s);
        continue;
      }
      if (!r.text) continue;
      let el = document.createElement('span');
      el.textContent = r.text;
      styleRun(el, r.style, opts, scale, lineHeight);
      const link = linkOf(r.rPr, opts);
      if (link) {
        const a = document.createElement('a');
        if (link.href) { a.href = link.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        else { a.href = '#'; a.dataset.slide = link.slide; }
        if (cx.scheme && cx.scheme.hlink && !link.keepColor) el.style.color = css(cx.scheme.hlink);
        el.style.textDecoration = 'underline';
        a.append(el);
        el = a;
      }
      pe.append(el);
    }
    if (!runs.some(r => r.text)) {
      // An empty paragraph still takes a line, at the size its end mark has.
      const s = document.createElement('span');
      s.textContent = '\u200b';
      styleRun(s, end, opts, scale, lineHeight);
      pe.append(s);
    } else if (runs[runs.length - 1].br) {
      pe.append(document.createTextNode('\u200b'));
    }
    block.append(pe);
  }
  return any ? block : null;
}

function fillToColor(f) {
  if (!f) return null;
  if (f.type === 'solid') return f.color;
  if (f.type === 'grad') return f.stops[0].color;
  if (f.type === 'patt') return f.fg;
  return null;
}

function linkOf(rPr, opts) {
  const h = kid(rPr, 'hlinkClick');
  if (!h || !opts.link) return null;
  const action = attr(h, 'action') || '';
  const jump = /jump=(\w+)/.exec(action);
  if (jump) return { slide: jump[1] };
  const target = opts.link(rid(h), h);
  if (!target) return null;
  return { ...target, keepColor: false };
}

const UNDERLINE = { sng: 'solid', dbl: 'double', heavy: 'solid', dotted: 'dotted', dottedHeavy: 'dotted', dash: 'dashed', dashHeavy: 'dashed', dashLong: 'dashed', dashLongHeavy: 'dashed', dotDash: 'dashed', dotDashHeavy: 'dashed', dotDotDash: 'dashed', dotDotDashHeavy: 'dashed', wavy: 'wavy', wavyHeavy: 'wavy', wavyDbl: 'wavy', words: 'solid' };

function styleRun(el, r, opts, scale, lineHeight) {
  const s = el.style;
  let size = r.sz / 100 * PT * scale;
  const latin = themeFont(r.latin, opts.theme) || 'Calibri';
  s.fontFamily = fontStack(latin, themeFont(r.ea, opts.theme));
  s.lineHeight = lineHeight(lineFactor(latin));
  if (r.b) s.fontWeight = '700';
  if (r.i) s.fontStyle = 'italic';
  const deco = [];
  if (r.u && r.u !== 'none') {
    deco.push('underline');
    if (UNDERLINE[r.u] && UNDERLINE[r.u] !== 'solid') s.textDecorationStyle = UNDERLINE[r.u];
    if (/Heavy/.test(r.u)) s.textDecorationThickness = '0.1em';
  }
  if (r.strike && r.strike !== 'noStrike') deco.push('line-through');
  if (deco.length) s.textDecorationLine = deco.join(' ');
  if (r.cap === 'all') s.textTransform = 'uppercase';
  else if (r.cap === 'small') s.fontVariant = 'small-caps';
  if (r.spc) s.letterSpacing = `${r.spc / 100 * PT}px`;
  if (r.baseline) {
    s.verticalAlign = `${r.baseline * size}px`;
    size *= 0.58;
  }
  s.fontSize = `${size}px`;
  const f = r.fill;
  if (f && f.type === 'grad' && f.stops.length > 1) {
    s.backgroundImage = `linear-gradient(${(f.angle ?? 90) + 90}deg, ${f.stops.map(g => `${css(g.color)} ${g.pos * 100}%`).join(', ')})`;
    s.webkitBackgroundClip = 'text';
    s.backgroundClip = 'text';
    s.color = 'transparent';
  } else if (f && f.type === 'none') {
    s.color = 'transparent';
  } else {
    s.color = css(fillToColor(f) || BLACK);
  }
  if (r.highlight) s.backgroundColor = css(r.highlight);
  if (r.outline && !r.outline.none && r.outline.color) {
    s.webkitTextStroke = `${Math.max(0.5, r.outline.width)}px ${css(r.outline.color)}`;
    s.paintOrder = 'stroke fill';
  }
  if (r.shadow) s.textShadow = `${r.shadow.x}px ${r.shadow.y}px ${r.shadow.blur}px ${css(r.shadow.color)}`;
}
