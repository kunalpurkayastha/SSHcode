// Shape outlines as SVG path data. Preset shapes (rectangles, arrows,
// callouts, stars… 187 of them) and custom geometry are both written in
// DrawingML's little formula language; this evaluates it.
import SHAPES from './shapes.js';
import { attr, kid, kids, children } from './ooxml.js';

const DEG = 60000;              // angles are in 60000ths of a degree
const RAD = Math.PI / 180 / DEG;

function builtins(w, h) {
  const ss = Math.min(w, h), ls = Math.max(w, h);
  const v = { w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, ss, ls, cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000 };
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    v['wd' + d] = w / d;
    v['hd' + d] = h / d;
    v['ssd' + d] = ss / d;
  }
  return v;
}

function calc(op, x, y, z) {
  switch (op) {
    case '*/': return z ? x * y / z : 0;
    case '+-': return x + y - z;
    case '+/': return z ? (x + y) / z : 0;
    case '?:': return x > 0 ? y : z;
    case 'abs': return Math.abs(x);
    case 'at2': return Math.atan2(y, x) / RAD;
    case 'cat2': return x * Math.cos(Math.atan2(z, y));
    case 'cos': return x * Math.cos(y * RAD);
    case 'max': return Math.max(x, y);
    case 'min': return Math.min(x, y);
    case 'mod': return Math.sqrt(x * x + y * y + z * z);
    case 'pin': return y < x ? x : y > z ? z : y;
    case 'sat2': return x * Math.sin(Math.atan2(z, y));
    case 'sin': return x * Math.sin(y * RAD);
    case 'sqrt': return Math.sqrt(Math.max(0, x));
    case 'tan': return x * Math.tan(y * RAD);
    default: return x;  // val
  }
}

/** Custom geometry from the file, in the same form as the presets. */
function fromXml(g) {
  const fmla = list => kids(list, 'gd').map(d => `${attr(d, 'name')} ${(attr(d, 'fmla') || 'val 0').trim()}`);
  const pt = c => kids(c, 'pt').map(p => `${attr(p, 'x')} ${attr(p, 'y')}`).join(' ');
  const rect = kid(g, 'rect');
  const def = { gd: [...fmla(kid(g, 'avLst')), ...fmla(kid(g, 'gdLst'))], paths: [] };
  if (rect) def.rect = ['l', 't', 'r', 'b'].map(k => attr(rect, k));
  for (const p of kids(kid(g, 'pathLst'), 'path')) {
    const d = [];
    for (const c of children(p)) {
      const n = c.localName;
      if (n === 'moveTo') d.push('M ' + pt(c));
      else if (n === 'lnTo') d.push('L ' + pt(c));
      else if (n === 'arcTo') d.push(`A ${attr(c, 'wR')} ${attr(c, 'hR')} ${attr(c, 'stAng')} ${attr(c, 'swAng')}`);
      else if (n === 'quadBezTo') d.push('Q ' + pt(c));
      else if (n === 'cubicBezTo') d.push('C ' + pt(c));
      else if (n === 'close') d.push('Z');
    }
    def.paths.push({
      d: d.join(';'), w: +attr(p, 'w') || 0, h: +attr(p, 'h') || 0,
      fill: attr(p, 'fill') === 'norm' ? undefined : attr(p, 'fill') || undefined,
      stroke: !['false', '0'].includes(attr(p, 'stroke')),
    });
  }
  return def;
}

const RECT = { paths: [{ d: 'M l t;L r t;L r b;L l b;Z' }] };
const f2 = n => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(2));

/**
 * The paths of a shape `w`×`h` px from its prstGeom / custGeom element
 * (null means a rectangle): {paths: [{d, fill, stroke}], text: {l, t, r, b}}.
 * `fill` is undefined (normal), "none", or a shading like "darken".
 */
export function geometry(el, w, h) {
  let def = RECT;
  const adj = {};
  if (el && el.localName === 'prstGeom') {
    def = SHAPES[attr(el, 'prst')] || RECT;
    for (const g of kids(kid(el, 'avLst'), 'gd')) {
      const m = /^val\s+(-?[\d.]+)/.exec(attr(g, 'fmla') || '');
      if (m) adj[attr(g, 'name')] = +m[1];
    }
  } else if (el && el.localName === 'custGeom') {
    def = fromXml(el);
    if (!def.paths.length) def = RECT;
  }
  const v = builtins(w, h);
  for (const [k, d] of Object.entries(def.av || {})) v[k] = k in adj ? adj[k] : d;
  // Presets name their first adjust value "adj"; older files sometimes say "adj1".
  if (def.av && !('adj' in adj) && 'adj1' in adj && 'adj' in def.av && !('adj1' in def.av)) v.adj = adj.adj1;
  const val = a => (a in v ? v[a] : parseFloat(a) || 0);
  for (const g of def.gd || []) {
    const [name, op, x, y, z] = g.trim().split(/\s+/);
    v[name] = calc(op, val(x), val(y), val(z));
  }
  const paths = def.paths.map(p => ({ d: pathData(p, val, w, h), fill: p.fill, stroke: p.stroke !== false }));
  const r = def.rect ? def.rect.map(val) : [0, 0, w, h];
  return { paths, text: { l: r[0], t: r[1], r: r[2], b: r[3] } };
}

/** An ellipse's parametric angle for the visual angle `deg`, kept on the same turn. */
function param(deg, rx, ry) {
  const a = deg * Math.PI / 180;
  const t = Math.atan2(rx * Math.sin(a), ry * Math.cos(a));
  return t + 2 * Math.PI * Math.round((a - t) / (2 * Math.PI));
}

function pathData(p, val, w, h) {
  const sx = p.w ? w / p.w : 1, sy = p.h ? h / p.h : 1;
  let x = 0, y = 0, x0 = 0, y0 = 0;
  const out = [];
  for (const cmd of p.d.split(';')) {
    const [op, ...args] = cmd.trim().split(/\s+/);
    const n = args.map(val);
    if (op === 'M' || op === 'L') {
      x = n[0] * sx; y = n[1] * sy;
      if (op === 'M') { x0 = x; y0 = y; }
      out.push(`${op}${f2(x)} ${f2(y)}`);
    } else if (op === 'Q') {
      out.push(`Q${f2(n[0] * sx)} ${f2(n[1] * sy)} ${f2(x = n[2] * sx)} ${f2(y = n[3] * sy)}`);
    } else if (op === 'C') {
      out.push(`C${f2(n[0] * sx)} ${f2(n[1] * sy)} ${f2(n[2] * sx)} ${f2(n[3] * sy)} ${f2(x = n[4] * sx)} ${f2(y = n[5] * sy)}`);
    } else if (op === 'A') {
      const rx = Math.abs(n[0] * sx), ry = Math.abs(n[1] * sy), st = n[2] / DEG, sw = n[3] / DEG;
      if (!rx || !ry || !sw) continue;
      const t0 = param(st, rx, ry), t1 = param(st + sw, rx, ry);
      const cx = x - rx * Math.cos(t0), cy = y - ry * Math.sin(t0);
      // A whole turn can't be one SVG arc: draw it in two halves.
      const steps = Math.abs(t1 - t0) > 2 * Math.PI - 1e-3 ? 2 : 1;
      for (let i = 1; i <= steps; i++) {
        const t = t0 + (t1 - t0) * i / steps;
        x = cx + rx * Math.cos(t); y = cy + ry * Math.sin(t);
        out.push(`A${f2(rx)} ${f2(ry)} 0 ${Math.abs(t1 - t0) / steps > Math.PI ? 1 : 0} ${t1 > t0 ? 1 : 0} ${f2(x)} ${f2(y)}`);
      }
    } else if (op === 'Z') {
      out.push('Z');
      x = x0; y = y0;
    }
  }
  return out.join('');
}

/** Line and connector presets: shapes that are only an outline. */
export const isLineShape = prst => /^(line|lineInv|straightConnector1|bentConnector[2-5]|curvedConnector[2-5])$/.test(prst || '');
