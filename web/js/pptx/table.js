// Tables: cell fills, borders and text come from the table's style (its
// definition in tableStyles.xml, or one of PowerPoint's built-in styles),
// then from each cell's own properties.
import { kid, kids, attr, num, bool, px, parseXml, color, css, readFill, fillEl, readLine, themeLine, themeFill } from './ooxml.js';
import { levelStyles, bodyProps } from './text.js';

// --- built-in styles ---------------------------------------------------------------------
// Files only carry the id of a built-in style unless it was customised.
// These follow the look of Office's 11 families × (no accent, accents 1–6).

const IDS = {
  themed1: '2D5ABB26-0587-4C30-8999-92F81FD0307C 3C2FFA5D-87B4-456A-9821-1D502468CF0F 284E427A-3D55-4303-BF80-6455036E1DE7 69C7853C-536D-4A76-A0AE-DD22124D55A5 775DCB02-9BB8-47FD-8907-85C794F793BA 35758FB7-9AC5-4552-8A53-C91805E547FA 08FB837D-C827-4EFA-A057-4D05807E0F7C',
  themed2: '5940675A-B579-460E-94D1-54222C63F5DA D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7 18603FDC-E32A-4AB5-989C-0864C3EAD2B8 306799F8-075E-4A3A-A7F6-7FBC6576F1A4 E269D01E-BC32-4049-B463-5C60D7B0CCD2 327F97BB-C833-4FB7-BDE5-3F7075034690 638B1855-1B75-4FBE-930C-398BA8C253C6',
  light1: '9D7B26C5-4107-4FEC-AEDC-1716B250A1EF 3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5 0E3FDE45-AF77-4B5C-9715-49D594BDF05E C083E6E3-FA7D-4D7B-A595-EF9225AFEA82 D27102A9-8310-4765-A935-A1911B00CA55 5FD0F851-EC5A-4D38-B0AD-8093EC10F338 68D230F3-CF80-4859-8CE7-A43EE81993B5',
  light2: '7E9639D4-E3E2-4D34-9284-5A2195B3D0D7 69012ECD-51FC-41F1-AA8D-1B2483CD663E 72833802-FEF1-4C79-8D5D-14CF1EAF98D9 F2DE63D5-997A-4646-A377-4702673A728D 17292A2E-F333-43FB-9621-5CBBE7FDCDCB 5A111915-BE36-4E01-A7E5-04B1672EAD32 912C8C85-51F0-491E-9774-3900AFEF0FD7',
  light3: '616DA210-FB5B-4158-B5E0-FEB733F419BA BC89EF96-8CEA-46FF-86C4-4CE0E7609802 5DA37D80-6434-44D0-A028-1B22A696006F 8799B23B-EC83-4686-B30A-512413B5E67A ED083AE6-46FA-4A59-8FB0-9F97EB10719F BDBED569-4797-4DF1-A0F4-6AAB3CD982D8 E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3',
  medium1: '793D81CF-94F2-401A-BA57-92F5A7B2D0C5 B301B821-A1FF-4177-AEE7-76D212191A09 9DCAF9ED-07DC-4A11-8D7F-57B35C25682E 1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90 1E171933-4619-4E11-9A3F-F7608DF75F80 FABFCF23-3B69-468F-B69F-88F6DE6A72F2 10A1B5D5-9B99-4C35-A422-299274C87663',
  medium2: '073A0DAA-6AF3-43AB-8588-CEC1D06C72B9 5C22544A-7EE6-4342-B048-85BDC9FD1C3A 21E4AEA4-8DFA-4A89-87EB-49C32662AFE0 F5AB1C69-6EDB-4FF4-983F-18BD219EF322 00A15C55-8517-42AA-B614-E9B94910E393 7DF18680-E054-41AD-8BC1-D1AEF772440D 93296810-A885-4BE3-A3E7-6D5BEEA58F35',
  medium3: '8EC20E35-A176-4012-BC5E-935CFFF8708E 6E25E649-3F16-4E02-A733-19D2CDBF48F0 85BE263C-DBD7-4A20-BB59-AAB30ACAA65A EB344D84-9AFB-497E-A393-DC336BA19D2E EB9631B5-78F2-41C9-869B-9F39066F8104 74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6 2A488322-F2BA-4B5B-9748-0D474271808F',
  medium4: 'D7AC3CCA-C797-4891-BE02-D94E43425B78 69CF1AB2-1976-4502-BF36-3FF5EA218861 8A107856-5554-42FB-B03E-39F5DBC370BA 0505E3EF-67EA-436B-97B2-0124C06EBD24 C4B1156A-380E-4F78-BDF5-A606A8083BF9 22838BEF-8BB2-4498-84A7-C5851F593DF1 16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4',
  dark1: 'E8034E78-7F5D-4C2E-B375-FC64B27BC917 125E5076-3810-47DD-B79F-674D7AD40C01 37CE84F3-28C3-443E-9E96-99CF82512B78 D03447BB-5D67-496B-8E87-E561075AD55C E929F9F4-4A8F-4326-A1B4-22849713DDAB 8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B AF606853-7671-496A-8E4F-DF71F8EC918B',
  dark2: '5202B0CA-FC54-4496-8BCA-5EF66A818D29 0660B408-B3CF-4A94-85FC-2B1E0A45F4A2 - 91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28 - 46F890A9-2807-4EBB-B81D-B2AA78EC7F39 -',
};
const BUILTIN = {};
for (const [fam, ids] of Object.entries(IDS)) ids.split(' ').forEach((id, n) => { if (id !== '-') BUILTIN[id] = [fam, n]; });

const sc = (c, mod = '') => `<a:schemeClr val="${c}">${mod}</a:schemeClr>`;
const tint = v => `<a:tint val="${v}"/>`, shade = v => `<a:shade val="${v}"/>`, alpha = v => `<a:alpha val="${v}"/>`;
const ln = (c, w = 12700) => `<a:ln w="${w}"><a:solidFill>${c}</a:solidFill></a:ln>`;

/** One table style part: {text, bold, fill, b: {left, right, top, bottom, insideH, insideV}}. */
function part(name, p) {
  const txt = p.text || p.bold ? `<a:tcTxStyle${p.bold ? ' b="on"' : ''}>${p.text || ''}</a:tcTxStyle>` : '';
  const bdr = p.b ? `<a:tcBdr>${Object.entries(p.b).map(([k, v]) => `<a:${k}>${v}</a:${k}>`).join('')}</a:tcBdr>` : '';
  const fill = p.fill ? `<a:fill><a:solidFill>${p.fill}</a:solidFill></a:fill>` : '';
  return `<a:${name}>${txt}<a:tcStyle>${bdr}${fill}</a:tcStyle></a:${name}>`;
}
const all = l => ({ left: l, right: l, top: l, bottom: l, insideH: l, insideV: l });
const outer = l => ({ left: l, right: l, top: l, bottom: l });

const FAMILIES = {
  // Without an accent, the first two are "No Style, No Grid" and "No Style, Table Grid".
  themed1: (A, n) => n ? [
    part('wholeTbl', { text: sc('dk1'), b: all(ln(sc(A))) }),
    part('band1H', { fill: sc(A, alpha(40000)) }), part('band1V', { fill: sc(A, alpha(40000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc(A), b: { bottom: ln(sc('lt1')) } }),
    part('lastRow', { bold: 1, b: { top: ln(sc(A), 25400) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ] : [part('wholeTbl', { text: sc('tx1') })],
  themed2: (A, n) => n ? [
    part('wholeTbl', { text: sc('lt1'), fill: sc(A), b: outer(ln(sc(A, tint(50000)))) }),
    part('band1H', { fill: sc('lt1', alpha(20000)) }), part('band1V', { fill: sc('lt1', alpha(20000)) }),
    part('firstRow', { bold: 1, b: { bottom: ln(sc('lt1'), 25400) } }), part('lastRow', { bold: 1, b: { top: ln(sc('lt1'), 25400) } }),
    part('firstCol', { bold: 1, b: { right: ln(sc('lt1')) } }), part('lastCol', { bold: 1, b: { left: ln(sc('lt1')) } }),
  ] : [part('wholeTbl', { text: sc('tx1'), b: all(ln(sc('tx1'))) })],
  light1: A => [
    part('wholeTbl', { text: sc('tx1'), b: { top: ln(sc(A)), bottom: ln(sc(A)) } }),
    part('band1H', { fill: sc(A, alpha(20000)) }), part('band1V', { fill: sc(A, alpha(20000)) }),
    part('firstRow', { bold: 1, b: { bottom: ln(sc(A)) } }), part('lastRow', { bold: 1, b: { top: ln(sc(A)) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
  light2: A => [
    part('wholeTbl', { text: sc('tx1'), b: outer(ln(sc(A))) }),
    part('band1H', { b: { top: ln(sc(A)), bottom: ln(sc(A)) } }), part('band1V', { b: { left: ln(sc(A)), right: ln(sc(A)) } }),
    part('band2V', { b: { left: ln(sc(A)), right: ln(sc(A)) } }),
    part('firstRow', { text: sc('bg1'), bold: 1, fill: sc(A) }), part('lastRow', { bold: 1, b: { top: ln(sc(A), 38100) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
  light3: A => [
    part('wholeTbl', { text: sc('tx1'), b: all(ln(sc(A))) }),
    part('band1H', { fill: sc(A, alpha(20000)) }), part('band1V', { fill: sc(A, alpha(20000)) }),
    part('firstRow', { text: sc(A), bold: 1, b: { bottom: ln(sc(A), 25400) } }), part('lastRow', { bold: 1, b: { top: ln(sc(A), 25400) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
  medium1: A => [
    part('wholeTbl', { text: sc('dk1'), fill: sc('lt1'), b: { ...outer(ln(sc(A))), insideH: ln(sc(A)) } }),
    part('band1H', { fill: sc(A, tint(20000)) }), part('band1V', { fill: sc(A, tint(20000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc(A) }), part('lastRow', { bold: 1, fill: sc('lt1'), b: { top: ln(sc(A), 50800) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
  medium2: A => [
    part('wholeTbl', { text: sc('dk1'), fill: sc(A, tint(20000)), b: all(ln(sc('lt1'))) }),
    part('band1H', { fill: sc(A, tint(40000)) }), part('band1V', { fill: sc(A, tint(40000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc(A), b: { bottom: ln(sc('lt1'), 38100) } }),
    part('lastRow', { text: sc('lt1'), bold: 1, fill: sc(A), b: { top: ln(sc('lt1'), 38100) } }),
    part('firstCol', { text: sc('lt1'), bold: 1, fill: sc(A) }), part('lastCol', { text: sc('lt1'), bold: 1, fill: sc(A) }),
  ],
  medium3: A => [
    part('wholeTbl', { text: sc('dk1'), fill: sc('lt1'), b: { top: ln(sc('dk1'), 25400), bottom: ln(sc('dk1'), 25400) } }),
    part('band1H', { fill: sc('dk1', tint(20000)) }), part('band1V', { fill: sc('dk1', tint(20000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc(A), b: { bottom: ln(sc('dk1'), 25400) } }),
    part('lastRow', { bold: 1, fill: sc('lt1'), b: { top: ln(sc('dk1'), 25400) } }),
    part('firstCol', { text: sc('lt1'), bold: 1, fill: sc(A) }), part('lastCol', { text: sc('lt1'), bold: 1, fill: sc(A) }),
  ],
  medium4: A => [
    part('wholeTbl', { text: sc('dk1'), fill: sc(A, tint(20000)), b: all(ln(sc(A))) }),
    part('band1H', { fill: sc(A, tint(40000)) }), part('band1V', { fill: sc(A, tint(40000)) }),
    part('firstRow', { text: sc(A), bold: 1, fill: sc(A, tint(20000)) }),
    part('lastRow', { bold: 1, fill: sc('dk1', tint(20000)), b: { top: ln(sc('dk1'), 25400) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
  dark1: (A, n) => [
    part('wholeTbl', { text: sc('lt1'), fill: n ? sc(A, shade(60000)) : sc('dk1', tint(80000)) }),
    part('band1H', { fill: n ? sc(A, shade(40000)) : sc('dk1', tint(60000)) }), part('band1V', { fill: n ? sc(A, shade(40000)) : sc('dk1', tint(60000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc('dk1'), b: { bottom: ln(sc('lt1'), 38100) } }),
    part('lastRow', { bold: 1, fill: n ? sc(A, shade(60000)) : sc('dk1', tint(80000)), b: { top: ln(sc('lt1'), 38100) } }),
    part('firstCol', { bold: 1, fill: n ? sc(A, shade(40000)) : sc('dk1', tint(60000)), b: { right: ln(sc('lt1'), 38100) } }),
    part('lastCol', { bold: 1, fill: n ? sc(A, shade(40000)) : sc('dk1', tint(60000)), b: { left: ln(sc('lt1'), 38100) } }),
  ],
  dark2: (A, n) => [
    part('wholeTbl', { text: sc('dk1'), fill: sc(A, tint(20000)) }),
    part('band1H', { fill: sc(A, tint(40000)) }), part('band1V', { fill: sc(A, tint(40000)) }),
    part('firstRow', { text: sc('lt1'), bold: 1, fill: sc(n ? `accent${n + 1}` : 'dk1') }),
    part('lastRow', { bold: 1, fill: sc(A, tint(20000)), b: { top: ln(sc('dk1'), 38100) } }),
    part('firstCol', { bold: 1 }), part('lastCol', { bold: 1 }),
  ],
};

const builtinCache = new Map();
function builtin(id) {
  const key = (id || '').replace(/[{}]/g, '').toUpperCase();
  if (!builtinCache.has(key)) {
    const m = BUILTIN[key];
    let el = null;
    if (m) {
      const [fam, n] = m;
      const A = n ? `accent${n}` : fam.startsWith('medium') || fam.startsWith('dark') ? 'dk1' : 'tx1';
      const xml = FAMILIES[fam](A, n).join('');
      el = parseXml(`<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</a:tblStyle>`).documentElement;
    }
    builtinCache.set(key, el);
  }
  return builtinCache.get(key);
}

function findStyle(tblPr, env) {
  const inline = kid(tblPr, 'tableStyle');
  if (inline) return inline;
  const id = (kid(tblPr, 'tableStyleId') || {}).textContent;
  if (!id) return null;
  if (env.styles) {
    for (const s of kids(env.styles, 'tblStyle')) if (attr(s, 'styleId') === id.trim()) return s;
  }
  return builtin(id.trim());
}

// --- drawing ----------------------------------------------------------------------------

const ROW_PARTS = new Set(['firstRow', 'lastRow', 'band1H', 'band2H']);
const COL_PARTS = new Set(['firstCol', 'lastCol', 'band1V', 'band2V']);

function border(el, env) {
  if (!el) return undefined;
  const l = kid(el, 'ln');
  if (l) return readLine(l, env.cx);
  const ref = kid(el, 'lnRef');
  if (ref) return themeLine(env.theme, attr(ref, 'idx'), color(ref, env.cx), env.cx);
  return undefined;
}

/** A style part's fill, borders and text overrides. */
function partLook(p, env) {
  const s = kid(p, 'tcStyle');
  const bdr = kid(s, 'tcBdr');
  const b = {};
  for (const side of ['left', 'right', 'top', 'bottom', 'insideH', 'insideV']) b[side] = border(kid(bdr, side), env);
  let fill;
  const f = kid(s, 'fill'), ref = kid(s, 'fillRef');
  if (f) fill = readFill(fillEl(f), env.cx);
  else if (ref) fill = themeFill(env.theme, attr(ref, 'idx'), color(ref, env.cx), env.cx);
  const t = kid(p, 'tcTxStyle');
  const run = {};
  if (t) {
    if (t.hasAttribute('b')) run.b = attr(t, 'b') === 'on';
    if (t.hasAttribute('i')) run.i = attr(t, 'i') === 'on';
    const fr = kid(t, 'fontRef');
    if (fr) run.latin = attr(fr, 'idx') === 'major' ? '+mj-lt' : '+mn-lt';
    const font = kid(kid(t, 'font'), 'latin');
    if (font) run.latin = attr(font, 'typeface') || run.latin;
    const c = color(t, env.cx);
    if (c) run.fill = { type: 'solid', color: c };
  }
  return { b, fill, run };
}

function cssBorder(l) {
  if (!l || l.none || !l.color || !l.color.a) return 'none';
  const w = Math.max(0.75, l.width);
  return `${+w.toFixed(2)}px ${l.dash ? (l.dash[0] <= 1 ? 'dotted' : 'dashed') : 'solid'} ${css(l.color)}`;
}

function cssFill(f) {
  if (!f || f.type === 'none') return null;
  if (f.type === 'solid' || f.type === 'patt') return css(f.type === 'solid' ? f.color : f.fg);
  if (f.type === 'grad') {
    const ang = f.angle == null ? 180 : f.angle + 90;
    return `linear-gradient(${ang}deg, ${f.stops.map(s => `${css(s.color)} ${+(s.pos * 100).toFixed(1)}%`).join(', ')})`;
  }
  return null;
}

/** `tbl` (a:tbl) → a <table>; rows grow to fit their text, as in PowerPoint. */
export function renderTable(tbl, env) {
  const tblPr = kid(tbl, 'tblPr');
  const flags = {};
  for (const f of ['firstRow', 'firstCol', 'lastRow', 'lastCol', 'bandRow', 'bandCol']) flags[f] = bool(tblPr, f);
  const style = findStyle(tblPr, env);
  const looks = new Map();
  const look = name => {
    if (!looks.has(name)) { const p = style && kid(style, name); looks.set(name, p ? partLook(p, env) : null); }
    return looks.get(name);
  };
  const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(c => px(attr(c, 'w', 0)));
  const rows = kids(tbl, 'tr');
  const R = rows.length, C = grid.length;
  const table = document.createElement('table');
  table.className = 'ptbl';
  table.style.width = `${grid.reduce((a, b) => a + b, 0)}px`;
  const cg = document.createElement('colgroup');
  for (const w of grid) { const c = document.createElement('col'); c.style.width = `${w}px`; cg.append(c); }
  table.append(cg);
  const bg = cssFill(readFill(fillEl(tblPr), env.cx)) || (style && cssFill((() => {
    const b = kid(style, 'tblBg');
    const f = kid(b, 'fill') || b;
    return f ? readFill(fillEl(f), env.cx) : null;
  })()));
  if (bg) table.style.background = bg;
  const base = [env.defaultTextStyle, env.otherStyle];
  rows.forEach((tr, r) => {
    const row = document.createElement('tr');
    const h = px(attr(tr, 'h', 0));
    if (h) row.style.height = `${h}px`;
    let c = 0;
    for (const tc of kids(tr, 'tc')) {
      const col = c;
      c += 1;
      if (bool(tc, 'hMerge') || bool(tc, 'vMerge')) continue;
      const cs = Math.max(1, num(tc, 'gridSpan', 1)), rs = Math.max(1, num(tc, 'rowSpan', 1));
      if (cs > 1) c += cs - 1;
      const parts = ['wholeTbl'];
      const bodyRow = !(flags.firstRow && r === 0) && !(flags.lastRow && r === R - 1);
      const bodyCol = !(flags.firstCol && col === 0) && !(flags.lastCol && col === C - 1);
      if (flags.bandCol && bodyCol) parts.push((col - (flags.firstCol ? 1 : 0)) % 2 ? 'band2V' : 'band1V');
      if (flags.bandRow && bodyRow) parts.push((r - (flags.firstRow ? 1 : 0)) % 2 ? 'band2H' : 'band1H');
      if (flags.lastCol && col + cs - 1 === C - 1) parts.push('lastCol');
      if (flags.firstCol && col === 0) parts.push('firstCol');
      if (flags.lastRow && r + rs - 1 === R - 1) parts.push('lastRow');
      if (flags.firstRow && r === 0) parts.push('firstRow');
      const cell = { fill: null, left: undefined, right: undefined, top: undefined, bottom: undefined, run: {} };
      for (const name of parts) {
        const p = look(name);
        if (!p) continue;
        if (p.fill) cell.fill = p.fill;
        Object.assign(cell.run, p.run);
        const rowPart = ROW_PARTS.has(name), colPart = COL_PARTS.has(name);
        const leftEdge = colPart || col === 0, rightEdge = colPart || col + cs - 1 === C - 1;
        const topEdge = rowPart || r === 0, bottomEdge = rowPart || r + rs - 1 === R - 1;
        const pickB = (edge, outerSide, inner) => (edge ? p.b[outerSide] : p.b[inner]);
        for (const [k, v] of [['left', pickB(leftEdge, 'left', 'insideV')], ['right', pickB(rightEdge, 'right', 'insideV')],
          ['top', pickB(topEdge, 'top', 'insideH')], ['bottom', pickB(bottomEdge, 'bottom', 'insideH')]]) {
          if (v !== undefined) cell[k] = v;
        }
      }
      const tcPr = kid(tc, 'tcPr');
      const own = fillEl(tcPr);
      if (own) cell.fill = readFill(own, env.cx);
      for (const [k, tag] of [['left', 'lnL'], ['right', 'lnR'], ['top', 'lnT'], ['bottom', 'lnB']]) {
        const l = kid(tcPr, tag);
        if (l) cell[k] = readLine(l, env.cx);
      }
      const td = document.createElement('td');
      if (cs > 1) td.colSpan = cs;
      if (rs > 1) td.rowSpan = rs;
      const s = td.style;
      const fill = cssFill(cell.fill);
      if (fill) s.background = fill;
      s.borderLeft = cssBorder(cell.left);
      s.borderRight = cssBorder(cell.right);
      s.borderTop = cssBorder(cell.top);
      s.borderBottom = cssBorder(cell.bottom);
      s.padding = ['marT', 'marR', 'marB', 'marL'].map((m, i) => `${px(attr(tcPr, m, i % 2 ? 91440 : 45720))}px`).join(' ');
      s.verticalAlign = { ctr: 'middle', b: 'bottom' }[attr(tcPr, 'anchor')] || 'top';
      const vert = attr(tcPr, 'vert');
      const txBody = kid(tc, 'txBody');
      if (txBody) {
        const chain = [...base, { run: cell.run }, kid(txBody, 'lstStyle')];
        const block = env.text({ txBody, levels: levelStyles(chain, env.cx), body: bodyProps([kid(txBody, 'bodyPr')]) });
        if (block) {
          if (vert && vert !== 'horz') { block.style.writingMode = 'vertical-rl'; if (vert === 'vert270') block.style.transform = 'rotate(180deg)'; }
          td.append(block);
        }
      }
      row.append(td);
    }
    table.append(row);
  });
  return table;
}
