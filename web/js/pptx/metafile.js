// Windows metafiles, EMF and the older WMF: the vector pictures Office uses
// for clip art, pasted charts and diagrams, and equations (MathType, Equation
// 3.0). Browsers can't show them, so they're replayed here into an SVG.
// EMF+ records (GDI+) are skipped: Office writes them alongside plain GDI ones.

// Text for the SVG: escaped, and without the control characters XML forbids.
const enc = s => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f2 = n => +(+n).toFixed(2);
const rgb = c => `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;

// The Symbol font's code points, as Unicode (Greek letters, maths, brackets).
const SYMBOL = {};
'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'.split('').forEach((c, i) => { SYMBOL[0x41 + i] = c; });
'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'.split('').forEach((c, i) => { SYMBOL[0x61 + i] = c; });
Object.assign(SYMBOL, {
  0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−', 0x40: '≅', 0x5c: '∴', 0x5e: '⊥', 0x60: '‾', 0x7e: '∼',
  0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠',
  0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×',
  0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbd: '⏐', 0xbe: '⎯',
  0xbf: '↵', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘', 0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪',
  0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉', 0xd0: '∠', 0xd1: '∇', 0xd2: '®',
  0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐',
  0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe0: '◊', 0xe1: '〈', 0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xe6: '⎛',
  0xe7: '⎜', 0xe8: '⎝', 0xe9: '⎡', 0xea: '⎢', 0xeb: '⎣', 0xec: '⎧', 0xed: '⎨', 0xee: '⎩', 0xef: '⎪', 0xf1: '〉',
  0xf2: '∫', 0xf3: '⌠', 0xf4: '⎮', 0xf5: '⌡', 0xf6: '⎞', 0xf7: '⎟', 0xf8: '⎠', 0xf9: '⎤', 0xfa: '⎥', 0xfb: '⎦',
  0xfc: '⎫', 0xfd: '⎬', 0xfe: '⎭',
});
const symbolText = s => [...s].map(ch => { let c = ch.codePointAt(0); if (c >= 0xf000 && c <= 0xf0ff) c -= 0xf000; return SYMBOL[c] || String.fromCharCode(c); }).join('');

const FONTS = {
  'times new roman': '"Times New Roman", "Liberation Serif", Tinos, serif', arial: 'Arial, "Liberation Sans", Arimo, sans-serif',
  'courier new': '"Courier New", "Liberation Mono", monospace', calibri: 'Calibri, Carlito, sans-serif', cambria: 'Cambria, Caladea, serif',
  'cambria math': '"Cambria Math", Caladea, serif', symbol: '"Times New Roman", "Liberation Serif", serif', 'mt extra': '"Times New Roman", serif',
};
const fontFamily = face => FONTS[(face || '').toLowerCase()] || `"${(face || 'Arial').replace(/["\\<>&]/g, '')}", sans-serif`;

// Windows code pages by font charset, for 8-bit text.
const CHARSETS = { 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };
// DEFAULT_CHARSET means "the system's": a CJK font name tells which system that was.
const FACE_CP = [[/yahei|simsun|simhei|kaiti|fangsong|dengxian|宋体|黑体/i, 'gbk'], [/jhenghei|mingliu|細明/i, 'big5'],
  [/gothic|mincho|meiryo|yu gothic|ｍｓ|游/i, 'shift_jis'], [/malgun|gulim|dotum|batang|굴림|바탕/i, 'euc-kr']];
const decoders = new Map();
function decode8(bytes, charset, face = '') {
  let label = CHARSETS[charset];
  if (!label && charset === 1) label = (FACE_CP.find(([re]) => re.test(face)) || [])[1];
  label = label || 'windows-1252';
  if (!decoders.has(label)) { try { decoders.set(label, new TextDecoder(label)); } catch { decoders.set(label, new TextDecoder('windows-1252')); } }
  return decoders.get(label).decode(bytes);
}

/** A bitmap (BITMAPINFO + pixels) as {url (data:), w, h, up (stored bottom-up)} for the SVG. */
function dibUrl(bytes, bmiOff, bmiLen, bitsOff, bitsLen, alpha = false) {
  if (!bmiLen || !bitsLen || bmiOff + bmiLen > bytes.length || bitsOff + bitsLen > bytes.length) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  const compression = v.getUint32(bmiOff + 16, true);
  const bw = v.getInt32(bmiOff + 4, true), bh = v.getInt32(bmiOff + 8, true);
  let out;
  let type = 'image/bmp';
  if (compression === 4 || compression === 5) {
    // JPEG or PNG inside: the bits are the file itself.
    out = bytes.subarray(bitsOff, bitsOff + bitsLen);
    type = compression === 4 ? 'image/jpeg' : 'image/png';
  } else if (alpha && v.getUint16(bmiOff + 14, true) === 32 && compression === 0) {
    // 32-bit with alpha (AlphaBlend): browsers only honour the alpha with a V5 header and masks.
    out = new Uint8Array(14 + 124 + bitsLen);
    const h = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d;
    h.setUint32(2, out.length, true);
    h.setUint32(10, 14 + 124, true);
    out.set(bytes.subarray(bmiOff, bmiOff + 40), 14);
    h.setUint32(14, 124, true);
    h.setUint32(14 + 16, 3, true);                 // BI_BITFIELDS
    h.setUint32(14 + 40, 0x00ff0000, true);        // red, green, blue, alpha masks
    h.setUint32(14 + 44, 0x0000ff00, true);
    h.setUint32(14 + 48, 0x000000ff, true);
    h.setUint32(14 + 52, 0xff000000, true);
    h.setUint32(14 + 56, 0x73524742, true);        // 'sRGB'
    out.set(bytes.subarray(bitsOff, bitsOff + bitsLen), 14 + 124);
  } else {
    out = new Uint8Array(14 + bmiLen + bitsLen);
    const h = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d;
    h.setUint32(2, out.length, true);
    h.setUint32(10, 14 + bmiLen, true);
    out.set(bytes.subarray(bmiOff, bmiOff + bmiLen), 14);
    out.set(bytes.subarray(bitsOff, bitsOff + bitsLen), 14 + bmiLen);
  }
  const b64 = a => {
    let s = '';
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(s)}`;
  };
  const bpp = v.getUint16(bmiOff + 14, true);
  const res = { url: b64(out), w: Math.abs(bw), h: Math.abs(bh), up: bh > 0, bpp };
  if (bpp === 1 && type === 'image/bmp' && bmiLen >= 48) {
    // A 1-bit AND mask, inverted (swap its two colours), to use as an SVG luminance mask.
    const inv = out.slice();
    inv.set(out.subarray(14 + 44, 14 + 48), 14 + 40);
    inv.set(out.subarray(14 + 40, 14 + 44), 14 + 44);
    res.inverted = b64(inv);
  }
  return res;
}

/** Shared drawing state and SVG output for both formats. */
class Canvas {
  constructor() {
    this.out = [];
    this.defs = [];
    this.objects = [];
    this.stack = [];
    this.ids = 0;
    this.s = {
      pen: { style: 0, width: 1, color: 0 }, brush: { style: 0, color: 0xffffff }, font: null,
      text: 0, bk: 0xffffff, bkMode: 2, align: 0, fillRule: 'evenodd', pos: [0, 0],
      wOrg: [0, 0], wExt: null, vOrg: [0, 0], vExt: null, mapMode: 1, xf: [1, 0, 0, 1, 0, 0], clip: null,
    };
    this.path = null;
    this.clipShown = null;
  }

  save() { this.stack.push(JSON.parse(JSON.stringify(this.s))); }
  restore(n = -1) {
    const i = n < 0 ? this.stack.length + n : n;
    if (i < 0 || i >= this.stack.length) return;
    this.s = this.stack[i];
    this.stack.length = i;
  }

  /** Logical → device: world transform, then window → viewport. */
  pt(x, y) {
    const [a, b, c, d, e, f] = this.s.xf;
    let X = a * x + c * y + e, Y = b * x + d * y + f;
    const s = this.s;
    if (s.mapMode !== 1 && s.wExt && s.vExt && s.wExt[0] && s.wExt[1]) {
      X = (X - s.wOrg[0]) * s.vExt[0] / s.wExt[0] + s.vOrg[0];
      Y = (Y - s.wOrg[1]) * s.vExt[1] / s.wExt[1] + s.vOrg[1];
    } else {
      X = X - s.wOrg[0] + s.vOrg[0];
      Y = Y - s.wOrg[1] + s.vOrg[1];
    }
    return [X, Y];
  }

  /** How long a logical length is on the device (for pen widths and font sizes). */
  len(v, axis = 1) {
    const [a, b, c, d] = this.s.xf;
    const s = this.s;
    let k = axis ? Math.hypot(c, d) : Math.hypot(a, b);
    if (s.mapMode !== 1 && s.wExt && s.vExt && s.wExt[0] && s.wExt[1]) k *= Math.abs(axis ? s.vExt[1] / s.wExt[1] : s.vExt[0] / s.wExt[0]);
    return Math.abs(v * k);
  }

  stroke() {
    const p = this.s.pen;
    if (!p || p.style === 5) return 'stroke="none"';
    const dev = this.len(p.width || 0, 0);
    const hair = dev < 1;
    const w = hair ? 1 : dev;
    const dash = { 1: [4, 2], 2: [1, 1], 3: [4, 1, 1, 1], 4: [4, 1, 1, 1, 1, 1] }[p.style & 15];
    const cap = { 0: 'round', 0x100: 'square', 0x200: 'butt' }[p.style & 0xf00] || 'round';
    const join = { 0: 'round', 0x1000: 'bevel', 0x2000: 'miter' }[p.style & 0xf000] || 'round';
    return `stroke="${rgb(p.color)}" stroke-width="${f2(w)}"${hair ? ' vector-effect="non-scaling-stroke"' : ''} stroke-linecap="${cap}" stroke-linejoin="${join}"${dash ? ` stroke-dasharray="${dash.map(x => f2(x * w)).join(' ')}"` : ''}`;
  }

  fill() {
    const b = this.s.brush;
    if (!b || b.style === 1) return 'fill="none"';
    if (b.style === 2) return `fill="${rgb(b.color)}" fill-opacity=".5"`;  // a hatch, drawn as a tint
    return `fill="${rgb(b.color)}" fill-rule="${this.s.fillRule}"`;
  }

  emit(el) {
    const c = this.s.clip;
    const key = c ? c.join(',') : null;
    if (key !== this.clipShown) {
      if (this.clipShown != null) this.out.push('</g>');
      if (c) {
        const id = `c${++this.ids}`;
        this.defs.push(`<clipPath id="${id}"><rect x="${f2(c[0])}" y="${f2(c[1])}" width="${f2(c[2] - c[0])}" height="${f2(c[3] - c[1])}"/></clipPath>`);
        this.out.push(`<g clip-path="url(#${id})">`);
      }
      this.clipShown = key;
    }
    this.out.push(el);
  }

  clipRect(x1, y1, x2, y2) {
    const [a, b] = this.pt(x1, y1), [c, d] = this.pt(x2, y2);
    const r = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    const cur = this.s.clip;
    this.s.clip = cur ? [Math.max(r[0], cur[0]), Math.max(r[1], cur[1]), Math.min(r[2], cur[2]), Math.min(r[3], cur[3])] : r;
  }

  /** Points (logical) → "x,y x,y". */
  pts(list) { return list.map(([x, y]) => this.pt(x, y).map(f2).join(',')).join(' '); }

  poly(list, closed, { fill = closed, stroke = true } = {}) {
    if (list.length < 2) return;
    if (this.path) { this.pathAdd(list, closed); return; }
    const tag = closed ? 'polygon' : 'polyline';
    this.emit(`<${tag} points="${this.pts(list)}" ${fill ? this.fill() : 'fill="none"'} ${stroke ? this.stroke() : 'stroke="none"'}/>`);
  }

  polyPoly(polys, closed) {
    if (this.path) { for (const p of polys) this.pathAdd(p, closed); return; }
    const d = polys.filter(p => p.length > 1).map(p => `M${this.pts(p).replace(/ /g, 'L')}${closed ? 'Z' : ''}`).join('');
    if (d) this.emit(`<path d="${d}" ${closed ? this.fill() : 'fill="none"'} ${this.stroke()}/>`);
  }

  beziers(start, list, moveFirst = true) {
    // list: control, control, end, …
    const p0 = this.pt(...start).map(f2);
    let d = moveFirst ? `M${p0}` : '';
    for (let i = 0; i + 2 < list.length; i += 3) d += `C${this.pt(...list[i]).map(f2)} ${this.pt(...list[i + 1]).map(f2)} ${this.pt(...list[i + 2]).map(f2)}`;
    return d;
  }

  pathAdd(list, closed) {
    this.path.push(`M${this.pts(list).replace(/ /g, 'L')}${closed ? 'Z' : ''}`);
  }

  ellipse(l, t, r, b) {
    const [x1, y1] = this.pt(l, t), [x2, y2] = this.pt(r, b);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    if (this.path) { this.path.push(`M${f2(cx - rx)},${f2(cy)}A${f2(rx)},${f2(ry)} 0 1 0 ${f2(cx + rx)},${f2(cy)}A${f2(rx)},${f2(ry)} 0 1 0 ${f2(cx - rx)},${f2(cy)}Z`); return; }
    this.emit(`<ellipse cx="${f2(cx)}" cy="${f2(cy)}" rx="${f2(rx)}" ry="${f2(ry)}" ${this.fill()} ${this.stroke()}/>`);
  }

  rect(l, t, r, b, rw = 0, rh = 0) {
    if (this.path) { this.pathAdd([[l, t], [r, t], [r, b], [l, b]], true); return; }
    const [x1, y1] = this.pt(l, t), [x2, y2] = this.pt(r, b);
    const round = rw ? ` rx="${f2(this.len(rw / 2, 0))}" ry="${f2(this.len(rh / 2))}"` : '';
    this.emit(`<rect x="${f2(Math.min(x1, x2))}" y="${f2(Math.min(y1, y2))}" width="${f2(Math.abs(x2 - x1))}" height="${f2(Math.abs(y2 - y1))}"${round} ${this.fill()} ${this.stroke()}/>`);
  }

  /** Arc, chord or pie inside a bounding box, from the start radial to the end radial (counter-clockwise). */
  arc(kind, l, t, r, b, xs, ys, xe, ye) {
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = Math.abs(r - l) / 2, ry = Math.abs(b - t) / 2;
    if (!rx || !ry) return;
    const a0 = Math.atan2((ys - cy) / ry, (xs - cx) / rx), a1 = Math.atan2((ye - cy) / ry, (xe - cx) / rx);
    let sweep = a0 - a1;
    if (sweep <= 0) sweep += Math.PI * 2;
    const n = Math.max(8, Math.ceil(sweep / (Math.PI / 24)));
    const ptsL = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 - sweep * i / n;
      ptsL.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    if (kind === 'pie') ptsL.push([cx, cy]);
    this.poly(ptsL, kind !== 'arc', { fill: kind !== 'arc' });
  }

  text(x, y, str, dx) {
    const f = this.s.font || { height: -12, weight: 400, italic: false, face: 'Arial', escapement: 0, charset: 0 };
    if (!str) return;
    if (f.charset === 2 || /^symbol$/i.test(f.face)) str = symbolText(str);
    const s = this.s;
    let [X, Y] = this.pt(x, y);
    if (s.align & 1) [X, Y] = this.pt(...s.pos);
    const size = Math.max(1, this.len(Math.abs(f.height) * (f.height > 0 ? 0.82 : 1)));
    const anchor = (s.align & 6) === 6 ? 'middle' : (s.align & 6) === 2 ? 'end' : 'start';
    const vert = (s.align & 24) === 24 ? 'alphabetic' : (s.align & 24) === 8 ? 'text-after-edge' : 'text-before-edge';
    let xs = '';
    if (dx && dx.length && anchor === 'start' && !f.escapement) {
      const k = this.len(1, 0);
      let acc = X;
      const list = [];
      for (let i = 0; i < str.length && i < dx.length; i++) { list.push(f2(acc)); acc += dx[i] * k; }
      if (list.length === [...str].length) xs = list.join(' ');
    }
    const rot = f.escapement ? ` transform="rotate(${f2(-f.escapement / 10)} ${f2(X)} ${f2(Y)})"` : '';
    this.emit(`<text x="${xs || f2(X)}" y="${f2(Y)}" font-family='${enc(fontFamily(f.face))}' font-size="${f2(size)}"${f.weight >= 600 ? ' font-weight="700"' : ''}${f.italic ? ' font-style="italic"' : ''}${f.underline ? ' text-decoration="underline"' : ''} fill="${rgb(s.text)}" text-anchor="${anchor}" dominant-baseline="${vert}" xml:space="preserve"${rot}>${enc(str)}</text>`);
    if (s.align & 1) s.pos = [x, y];
  }

  /**
   * A bitmap into a box. `rop` (the raster operation) decides how it combines
   * with what's below; `src` = [x, y, w, h, dib] picks part of the bitmap
   * (dib: y counts from the bottom, as for bottom-up device-independent bitmaps).
   */
  image(bmp, l, t, r, b, rop = 0xcc0020, src = null, mask = null) {
    if (!bmp) return;
    const blend = { 0x8800c6: 'multiply', 0xee0086: 'lighten', 0x660046: 'difference' }[rop];
    const [x1, y1] = this.pt(l, t), [x2, y2] = this.pt(r, b);
    const fx = x2 < x1, fy = y2 < y1;
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    const flip = fx || fy ? ` transform="translate(${f2(fx ? 2 * x + w : 0)} ${f2(fy ? 2 * y + h : 0)}) scale(${fx ? -1 : 1} ${fy ? -1 : 1})"` : '';
    const style = blend ? ` style="mix-blend-mode:${blend}"` : '';
    // Part of a bitmap: a nested viewport onto it.
    const view = (bm, sr, url) => {
      let [sx, sy, sw, sh, dib] = sr || [0, 0, bm.w, bm.h, false];
      if (!sw || !sh) [sx, sy, sw, sh] = [0, 0, bm.w, bm.h];
      if (dib && bm.up) sy = bm.h - sy - sh;
      if (sx === 0 && sy === 0 && sw === bm.w && sh === bm.h) return `<image x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" preserveAspectRatio="none" href="${url}"/>`;
      return `<svg x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" viewBox="${sx} ${sy} ${sw} ${sh}" preserveAspectRatio="none"><image width="${bm.w}" height="${bm.h}" preserveAspectRatio="none" href="${url}"/></svg>`;
    };
    let masked = '';
    if (mask && mask.bmp.inverted) {
      const id = `m${++this.ids}`;
      this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}">${view(mask.bmp, mask.src, mask.bmp.inverted)}</mask>`);
      masked = ` mask="url(#${id})"`;
    }
    this.emit(`<g${flip}${style}${masked}>${view(bmp, src, bmp.url)}</g>`);
  }

  /** Blits: an AND mask followed by the picture at the same place is a cut-out (icons). */
  blit(bmp, l, t, r, b, rop, src) {
    const box = [l, t, r, b].join();
    if (rop === 0x8800c6 && bmp && bmp.bpp === 1) { this.pending = { bmp, src, box }; return; }
    const mask = this.pending && this.pending.box === box && (rop === 0x660046 || rop === 0xee0086) ? this.pending : null;
    this.pending = null;
    this.image(bmp, l, t, r, b, mask ? 0xcc0020 : rop, src, mask);
  }

  /** A blit without a bitmap paints the brush (or white, or black) — or nothing. */
  patBlt(rop, l, t, r, b) {
    const paint = { 0xf00021: null, 0xff0062: { style: 0, color: 0xffffff }, 0x000042: { style: 0, color: 0 } };
    if (!(rop in paint)) return;
    const save = [this.s.pen, this.s.brush];
    this.s.pen = { style: 5 };
    if (paint[rop]) this.s.brush = paint[rop];
    this.rect(l, t, r, b);
    [this.s.pen, this.s.brush] = save;
  }

  finish(x, y, w, h) {
    if (this.clipShown != null) this.out.push('</g>');
    if (!(w > 0) || !(h > 0)) return null;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)}" width="${f2(w)}" height="${f2(h)}" preserveAspectRatio="none"><defs>${this.defs.join('')}</defs>${this.out.join('')}</svg>`;
  }
}

// --- EMF ---------------------------------------------------------------------------------

const STOCK = {
  0: { brush: { style: 0, color: 0xffffff } }, 1: { brush: { style: 0, color: 0xc0c0c0 } }, 2: { brush: { style: 0, color: 0x808080 } },
  3: { brush: { style: 0, color: 0x404040 } }, 4: { brush: { style: 0, color: 0 } }, 5: { brush: { style: 1, color: 0 } },
  6: { pen: { style: 0, width: 0, color: 0xffffff } }, 7: { pen: { style: 0, width: 0, color: 0 } }, 8: { pen: { style: 5, width: 0, color: 0 } },
  10: { font: { height: -12, weight: 400, face: 'Courier New' } }, 11: { font: { height: -12, weight: 400, face: 'Courier New' } },
  12: { font: { height: -12, weight: 400, face: 'Arial' } }, 13: { font: { height: -16, weight: 700, face: 'Arial' } },
  17: { font: { height: -11, weight: 400, face: 'Arial' } },
};

function select(cv, obj) {
  if (!obj) return;
  if (obj.pen) cv.s.pen = obj.pen;
  if (obj.brush) cv.s.brush = obj.brush;
  if (obj.font) cv.s.font = obj.font;
}

function utf16(bytes, off, chars) {
  let s = '';
  for (let i = 0; i < chars; i++) {
    const c = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function emf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i32 = o => v.getInt32(o, true), u32 = o => v.getUint32(o, true), i16 = o => v.getInt16(o, true);
  const cv = new Canvas();
  cv.s.mapMode = 1;
  // Header: the frame (0.01 mm) and the reference device, to place the picture.
  const frame = [i32(24), i32(28), i32(32), i32(36)];
  const dev = [i32(72), i32(76)], mm = [i32(80), i32(84)];
  const lpts = (o, n, short) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(short ? [i16(o + i * 4), i16(o + i * 4 + 2)] : [i32(o + i * 8), i32(o + i * 8 + 4)]);
    return out;
  };
  let p = 0;
  for (let guard = 0; p + 8 <= bytes.length && guard < 500000; guard++) {
    const type = u32(p), size = u32(p + 4);
    if (size < 8 || p + size > bytes.length) break;
    const o = p + 8;
    switch (type) {
      case 14: p = bytes.length; continue;  // EOF
      case 2: case 85: { // POLYBEZIER(16)
        const short = type === 85, n = u32(o + 16), list = lpts(o + 20, n, short);
        if (list.length > 3) {
          const d = cv.beziers(list[0], list.slice(1));
          if (cv.path) cv.path.push(d); else cv.emit(`<path d="${d}" fill="none" ${cv.stroke()}/>`);
        }
        break;
      }
      case 3: case 86: { const short = type === 86; cv.poly(lpts(o + 20, u32(o + 16), short), true); break; }   // POLYGON(16)
      case 4: case 87: { const short = type === 87; cv.poly(lpts(o + 20, u32(o + 16), short), false); break; }  // POLYLINE(16)
      case 5: case 88: { // POLYBEZIERTO(16)
        const short = type === 88, list = lpts(o + 20, u32(o + 16), short);
        if (cv.path) { cv.path.push(cv.beziers(cv.s.pos, list, !cv.pathOpen)); cv.pathOpen = true; }
        else if (list.length >= 3) cv.emit(`<path d="${cv.beziers(cv.s.pos, list)}" fill="none" ${cv.stroke()}/>`);
        if (list.length) cv.s.pos = list[list.length - 1];
        break;
      }
      case 6: case 89: { // POLYLINETO(16)
        const short = type === 89, list = lpts(o + 20, u32(o + 16), short);
        if (cv.path) { cv.path.push((cv.pathOpen ? '' : `M${cv.pt(...cv.s.pos).map(f2)}`) + list.map(q => `L${cv.pt(...q).map(f2)}`).join('')); cv.pathOpen = true; }
        else cv.poly([cv.s.pos, ...list], false);
        if (list.length) cv.s.pos = list[list.length - 1];
        break;
      }
      case 7: case 8: case 90: case 91: { // POLYPOLYLINE / POLYPOLYGON (16)
        const short = type >= 90, closed = type === 8 || type === 91;
        const nPolys = u32(o + 16);
        let q = o + 24 + nPolys * 4;
        const polys = [];
        for (let i = 0; i < nPolys; i++) {
          const n = u32(o + 24 + i * 4);
          polys.push(lpts(q, n, short));
          q += n * (short ? 4 : 8);
        }
        cv.polyPoly(polys, closed);
        break;
      }
      case 9: cv.s.wExt = [i32(o), i32(o + 4)]; break;      // SETWINDOWEXTEX
      case 10: cv.s.wOrg = [i32(o), i32(o + 4)]; break;     // SETWINDOWORGEX
      case 11: cv.s.vExt = [i32(o), i32(o + 4)]; break;     // SETVIEWPORTEXTEX
      case 12: cv.s.vOrg = [i32(o), i32(o + 4)]; break;     // SETVIEWPORTORGEX
      case 17: cv.s.mapMode = u32(o); break;
      case 18: cv.s.bkMode = u32(o); break;
      case 19: cv.s.fillRule = u32(o) === 2 ? 'nonzero' : 'evenodd'; break;
      case 22: cv.s.align = u32(o); break;
      case 24: cv.s.text = u32(o); break;
      case 25: cv.s.bk = u32(o); break;
      case 27: cv.s.pos = [i32(o), i32(o + 4)]; if (cv.path) cv.pathOpen = false; break;  // MOVETOEX
      case 30: cv.clipRect(i32(o), i32(o + 4), i32(o + 8), i32(o + 12)); break;  // INTERSECTCLIPRECT
      case 28: cv.s.clip = null; break;  // SETMETARGN
      case 33: cv.save(); break;
      case 34: cv.restore(i32(o)); break;
      case 35: cv.s.xf = [0, 4, 8, 12, 16, 20].map(k => v.getFloat32(o + k, true)); break;  // SETWORLDTRANSFORM
      case 36: { // MODIFYWORLDTRANSFORM
        const m = [0, 4, 8, 12, 16, 20].map(k => v.getFloat32(o + k, true)), mode = u32(o + 24);
        const [a, b, c, d, e, f] = cv.s.xf;
        if (mode === 1) cv.s.xf = [1, 0, 0, 1, 0, 0];
        else if (mode === 2) cv.s.xf = [m[0] * a + m[1] * c, m[0] * b + m[1] * d, m[2] * a + m[3] * c, m[2] * b + m[3] * d, m[4] * a + m[5] * c + e, m[4] * b + m[5] * d + f];
        else if (mode === 3) cv.s.xf = [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3], e * m[0] + f * m[2] + m[4], e * m[1] + f * m[3] + m[5]];
        else if (mode === 4) cv.s.xf = m;
        break;
      }
      case 37: { const id = u32(o); select(cv, id & 0x80000000 ? STOCK[id & 0x7fffffff] : cv.objects[id]); break; }  // SELECTOBJECT
      case 38: cv.objects[u32(o)] = { pen: { style: u32(o + 4), width: i32(o + 8), color: u32(o + 16) } }; break;  // CREATEPEN
      case 95: cv.objects[u32(o)] = { pen: { style: u32(o + 20), width: u32(o + 24), color: u32(o + 32) } }; break;  // EXTCREATEPEN
      case 39: cv.objects[u32(o)] = { brush: { style: u32(o + 4), color: u32(o + 8) } }; break;  // CREATEBRUSHINDIRECT
      case 93: case 94: cv.objects[u32(o)] = { brush: { style: 0, color: 0x808080 } }; break;   // pattern brushes: grey
      case 40: delete cv.objects[u32(o)]; break;
      case 42: cv.ellipse(i32(o), i32(o + 4), i32(o + 8), i32(o + 12)); break;
      case 43: cv.rect(i32(o), i32(o + 4), i32(o + 8), i32(o + 12)); break;
      case 44: cv.rect(i32(o), i32(o + 4), i32(o + 8), i32(o + 12), i32(o + 16), i32(o + 20)); break;
      case 45: case 46: case 47: case 55: // ARC, CHORD, PIE, ARCTO
        cv.arc(type === 46 ? 'chord' : type === 47 ? 'pie' : 'arc', i32(o), i32(o + 4), i32(o + 8), i32(o + 12), i32(o + 16), i32(o + 20), i32(o + 24), i32(o + 28));
        break;
      case 54: { // LINETO
        const q = [i32(o), i32(o + 4)];
        if (cv.path) { cv.path.push(`${cv.pathOpen ? '' : `M${cv.pt(...cv.s.pos).map(f2)}`}L${cv.pt(...q).map(f2)}`); cv.pathOpen = true; }
        else cv.poly([cv.s.pos, q], false);
        cv.s.pos = q;
        break;
      }
      case 59: cv.path = []; cv.pathOpen = false; break;   // BEGINPATH
      case 60: cv.donePath = cv.path; cv.path = null; break; // ENDPATH
      case 61: if (cv.path) cv.path.push('Z'); cv.pathOpen = false; break;  // CLOSEFIGURE
      case 62: case 63: case 64: { // FILLPATH, STROKEANDFILLPATH, STROKEPATH
        const d = (cv.donePath || []).join('');
        if (d) cv.emit(`<path d="${d}" ${type === 64 ? 'fill="none"' : cv.fill()} ${type === 62 ? 'stroke="none"' : cv.stroke()}/>`);
        cv.donePath = null;
        break;
      }
      case 67: cv.donePath = null; break;  // SELECTCLIPPATH: not supported, drop the path
      case 75: if (u32(o + 4) === 5 || u32(o) === 0) cv.s.clip = null; break;  // EXTSELECTCLIPRGN: reset
      case 76: case 77: case 114: { // BITBLT, STRETCHBLT, ALPHABLEND: dest box, then the source bitmap
        const x = i32(o + 16), y = i32(o + 20), w = i32(o + 24), h = i32(o + 28);
        const bmiO = u32(o + 76), bmiL = u32(o + 80), bitsO = u32(o + 84), bitsL = u32(o + 88);
        const rop = type === 114 ? 0xcc0020 : u32(o + 32);
        const src = [i32(o + 36), i32(o + 40), type === 76 ? w : i32(o + 92), type === 76 ? h : i32(o + 96), false];
        if (bmiL && bitsL) cv.blit(dibUrl(bytes, p + bmiO, bmiL, p + bitsO, bitsL, type === 114), x, y, x + w, y + h, rop, src);
        else if (type === 76) cv.patBlt(rop, x, y, x + w, y + h);
        break;
      }
      case 80: { // SETDIBITSTODEVICE
        const x = i32(o + 16), y = i32(o + 20), w = i32(o + 32), h = i32(o + 36);
        cv.image(dibUrl(bytes, p + u32(o + 40), u32(o + 44), p + u32(o + 48), u32(o + 52)), x, y, x + w, y + h, 0xcc0020, [i32(o + 24), i32(o + 28), w, h, true]);
        break;
      }
      case 81: { // STRETCHDIBITS
        const x = i32(o + 16), y = i32(o + 20), w = i32(o + 64), h = i32(o + 68), rop = u32(o + 60);
        if (rop === 0xaa0029) break;
        if (u32(o + 52)) cv.blit(dibUrl(bytes, p + u32(o + 40), u32(o + 44), p + u32(o + 48), u32(o + 52)), x, y, x + w, y + h, rop, [i32(o + 24), i32(o + 28), i32(o + 32), i32(o + 36), true]);
        else cv.patBlt(rop, x, y, x + w, y + h);
        break;
      }
      case 82: { // EXTCREATEFONTINDIRECTW
        const q = o + 4;
        cv.objects[u32(o)] = { font: { height: i32(q), escapement: i32(q + 8), weight: i32(q + 16), italic: bytes[q + 20], underline: bytes[q + 21], charset: bytes[q + 23], face: utf16(bytes, q + 28, 32) } };
        break;
      }
      case 83: case 84: { // EXTTEXTOUTA / W
        const q = o + 28;  // EMRTEXT: reference, chars, string offset, options, [rectangle], dx offset
        const x = i32(q), y = i32(q + 4), n = u32(q + 8), offStr = u32(q + 12), offDx = u32(q + (u32(q + 16) & 0x100 ? 20 : 36));
        if (!n || p + offStr > bytes.length) break;
        const str = type === 84 ? utf16(bytes, p + offStr, n) : decode8(bytes.subarray(p + offStr, p + offStr + n), cv.s.font && cv.s.font.charset, cv.s.font && cv.s.font.face);
        const dx = offDx && p + offDx + n * 4 <= bytes.length ? Array.from({ length: n }, (_, i) => i32(p + offDx + i * 4)) : null;
        cv.text(x, y, str, dx);
        break;
      }
      default: break;  // EMR_COMMENT (EMF+), palettes, ICM, stretch modes…
    }
    p += size;
  }
  // The picture's area: the header frame, on the reference device.
  const kx = mm[0] ? dev[0] / (mm[0] * 100) : 1, ky = mm[1] ? dev[1] / (mm[1] * 100) : 1;
  const x = frame[0] * kx, y = frame[1] * ky, w = (frame[2] - frame[0]) * kx, h = (frame[3] - frame[1]) * ky;
  return cv.finish(x, y, w, h);
}

// --- WMF ---------------------------------------------------------------------------------

function wmf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = o => v.getUint16(o, true), i16 = o => v.getInt16(o, true), u32 = o => v.getUint32(o, true);
  const cv = new Canvas();
  cv.s.mapMode = 1;
  let p = 0, box = null;
  if (u32(0) === 0x9ac6cdd7) {
    box = [i16(6), i16(8), i16(10), i16(12)];
    p = 22;
  }
  p += u16(p + 2) * 2;  // the standard header
  const slots = [];
  const add = obj => { let i = 0; while (slots[i]) i++; slots[i] = obj; };
  const color = o => u16(o) | (u16(o + 2) << 16);
  for (let guard = 0; p + 6 <= bytes.length && guard < 500000; guard++) {
    const size = u32(p) * 2, fn = u16(p + 4), o = p + 6;
    if (size < 6 || p + size > bytes.length) break;
    if (fn === 0) break;
    const pts = (q, n) => Array.from({ length: n }, (_, i) => [i16(q + i * 4), i16(q + i * 4 + 2)]);
    switch (fn) {
      case 0x020b: cv.s.wOrg = [i16(o + 2), i16(o)]; break;
      case 0x020c: cv.s.wExt = [i16(o + 2), i16(o)]; break;
      case 0x020d: cv.s.vOrg = [i16(o + 2), i16(o)]; break;
      case 0x020e: cv.s.vExt = [i16(o + 2), i16(o)]; break;
      case 0x0103: cv.s.mapMode = u16(o); break;
      case 0x0102: cv.s.bkMode = u16(o); break;
      case 0x0106: cv.s.fillRule = u16(o) === 2 ? 'nonzero' : 'evenodd'; break;
      case 0x012e: cv.s.align = u16(o); break;
      case 0x0209: cv.s.text = color(o); break;
      case 0x0201: cv.s.bk = color(o); break;
      case 0x001e: cv.save(); break;
      case 0x0127: cv.restore(i16(o)); break;
      case 0x012d: select(cv, slots[u16(o)]); break;
      case 0x01f0: slots[u16(o)] = null; break;
      case 0x02fa: add({ pen: { style: u16(o), width: i16(o + 2), color: color(o + 6) } }); break;
      case 0x02fc: add({ brush: { style: u16(o), color: color(o + 2) } }); break;
      case 0x02fb: { // CREATEFONTINDIRECT
        let face = '';
        for (let i = 0; i < 32 && bytes[o + 18 + i]; i++) face += String.fromCharCode(bytes[o + 18 + i]);
        add({ font: { height: i16(o), escapement: i16(o + 4), weight: i16(o + 8), italic: bytes[o + 10], underline: bytes[o + 11], charset: bytes[o + 13], face } });
        break;
      }
      case 0x00f7: case 0x01f9: case 0x0142: case 0x06ff: add({}); break;  // palette, pattern brushes, regions take a slot
      case 0x0214: cv.s.pos = [i16(o + 2), i16(o)]; break;  // MOVETO
      case 0x0213: { const q = [i16(o + 2), i16(o)]; cv.poly([cv.s.pos, q], false); cv.s.pos = q; break; }
      case 0x0325: cv.poly(pts(o + 2, i16(o)), false); break;  // POLYLINE
      case 0x0324: cv.poly(pts(o + 2, i16(o)), true); break;   // POLYGON
      case 0x0538: { // POLYPOLYGON
        const n = u16(o);
        let q = o + 2 + n * 2;
        const polys = [];
        for (let i = 0; i < n; i++) { const c = u16(o + 2 + i * 2); polys.push(pts(q, c)); q += c * 4; }
        cv.polyPoly(polys, true);
        break;
      }
      case 0x041b: cv.rect(i16(o + 6), i16(o + 4), i16(o + 2), i16(o)); break;  // RECTANGLE: bottom, right, top, left
      case 0x061c: cv.rect(i16(o + 10), i16(o + 8), i16(o + 6), i16(o + 4), i16(o + 2), i16(o)); break;  // ROUNDRECT
      case 0x0418: cv.ellipse(i16(o + 6), i16(o + 4), i16(o + 2), i16(o)); break;
      case 0x0817: case 0x081a: case 0x0830: // ARC, PIE, CHORD: yEnd xEnd yStart xStart bottom right top left
        cv.arc(fn === 0x081a ? 'pie' : fn === 0x0830 ? 'chord' : 'arc', i16(o + 14), i16(o + 12), i16(o + 10), i16(o + 8), i16(o + 6), i16(o + 4), i16(o + 2), i16(o));
        break;
      case 0x0416: cv.clipRect(i16(o + 6), i16(o + 4), i16(o + 2), i16(o)); break;
      case 0x061d: { // PATBLT: rop (32 bits), height, width, y, x
        const h = i16(o + 4), w = i16(o + 6), y = i16(o + 8), x = i16(o + 10);
        cv.patBlt(u32(o), x, y, x + w, y + h);
        break;
      }
      case 0x012c: cv.s.clip = null; break;  // SELECTCLIPREGION: back to no clipping
      case 0x0521: { // TEXTOUT: count, string (padded), y, x
        const n = i16(o), sl = (n + 1) & ~1;
        cv.text(i16(o + 2 + sl + 2), i16(o + 2 + sl), decode8(bytes.subarray(o + 2, o + 2 + n), cv.s.font && cv.s.font.charset, cv.s.font && cv.s.font.face));
        break;
      }
      case 0x0a32: { // EXTTEXTOUT: y, x, count, options, [rect], string, [dx]
        const y = i16(o), x = i16(o + 2), n = i16(o + 4), opts = u16(o + 6);
        let q = o + 8 + (opts & 6 ? 8 : 0);
        const str = decode8(bytes.subarray(q, q + n), cv.s.font && cv.s.font.charset, cv.s.font && cv.s.font.face);
        q += (n + 1) & ~1;
        const dx = q + n * 2 <= p + size ? Array.from({ length: n }, (_, i) => i16(q + i * 2)) : null;
        cv.text(x, y, str, dx);
        break;
      }
      case 0x0b41: case 0x0f43: { // DIBSTRETCHBLT, STRETCHDIB
        const stretchDib = fn === 0x0f43;
        const q = o + (stretchDib ? 6 : 4), rop = u32(o);
        const dh = i16(q + 8), dw = i16(q + 10), dy = i16(q + 12), dx = i16(q + 14);
        const bmi = q + 16;
        if (bmi + 40 <= p + size) {
          const hdr = u32(bmi), bits = v.getUint16(bmi + 14, true), clr = u32(bmi + 32);
          const colors = bits <= 8 ? (clr || 1 << bits) : (u32(bmi + 16) === 3 ? 3 : 0);
          const bmiLen = hdr + colors * 4;
          // DIBSTRETCHBLT counts source rows from the top, like StretchBlt; STRETCHDIB from the bottom.
          cv.blit(dibUrl(bytes, bmi, bmiLen, bmi + bmiLen, p + size - bmi - bmiLen), dx, dy, dx + dw, dy + dh, rop, [i16(q + 6), i16(q + 4), i16(q + 2), i16(q), stretchDib]);
        } else cv.patBlt(rop, dx, dy, dx + dw, dy + dh);
        break;
      }
      case 0x0940: { // DIBBITBLT
        const q = o + 4;
        const h = i16(q + 4), w = i16(q + 6), y = i16(q + 8), x = i16(q + 10);
        const bmi = q + 12;
        if (bmi + 40 <= p + size) {
          const hdr = u32(bmi), bits = v.getUint16(bmi + 14, true), clr = u32(bmi + 32);
          const colors = bits <= 8 ? (clr || 1 << bits) : 0;
          const bmiLen = hdr + colors * 4;
          cv.blit(dibUrl(bytes, bmi, bmiLen, bmi + bmiLen, p + size - bmi - bmiLen), x, y, x + w, y + h, u32(o), [i16(o + 6), i16(o + 4), w, h, false]);
        } else cv.patBlt(u32(o), x, y, x + w, y + h);
        break;
      }
      default: break;  // escapes, ROP modes, palettes…
    }
    p += size;
  }
  // The picture's area in device space: the placeable box, or the window.
  if (!box && cv.s.wExt) box = [cv.s.wOrg[0], cv.s.wOrg[1], cv.s.wOrg[0] + cv.s.wExt[0], cv.s.wOrg[1] + cv.s.wExt[1]];
  if (!box) return null;
  const s = cv.s;
  s.xf = [1, 0, 0, 1, 0, 0];
  const [x1, y1] = cv.pt(box[0], box[1]), [x2, y2] = cv.pt(box[2], box[3]);
  return cv.finish(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
}

/** EMF or WMF bytes → SVG markup, or null when it isn't one we can read. */
export function metafileToSvg(bytes) {
  try {
    if (bytes.length < 40) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) === 1 && v.getUint32(40, true) === 0x464d4520) return emf(bytes);
    if (v.getUint32(0, true) === 0x9ac6cdd7 || (v.getUint16(0, true) <= 2 && v.getUint16(2, true) === 9)) return wmf(bytes);
  } catch (e) {
    console.warn('pptx: metafile', e);
  }
  return null;
}
