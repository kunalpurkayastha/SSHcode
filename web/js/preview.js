// Rendered views of text files: Markdown, Jupyter notebooks and SVG.
// marked and DOMPurify load (through Monaco's AMD loader) the first time a
// preview is opened, so they cost nothing until then.
import { esc, join } from './util.js';
import { fileUrl } from './api.js';

let libs;
function loadLibs() {
  if (!libs) {
    libs = new Promise((resolve, reject) => {
      const base = new URL('/vendor/markdown/', location.href).href;
      window.require.config({ paths: { marked: base + 'marked', purify: base + 'purify' } });
      window.require(['marked', 'purify'], (m, purify) => {
        const marked = m.marked || m;
        marked.setOptions({ gfm: true, breaks: false });
        const lexer = m.lexer || marked.lexer, parser = m.parser || marked.parser;
        resolve({
          md: s => marked.parse(s),
          clean: html => purify.sanitize(html, { USE_PROFILES: { html: true } }),
          blocks: s => blocks(s, lexer, parser),
        });
      }, err => { libs = null; reject(err); });
    });
  }
  return libs;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const text = v => (Array.isArray(v) ? v.join('') : v || '');

/** Resolve a link or image path written inside a file in `dir`. */
function resolveIn(dir, ref) {
  const clean = ref.split('#')[0].split('?')[0];
  const abs = clean.startsWith('/') ? clean : join(dir, clean);
  const out = [];
  for (const part of abs.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

/** Point relative images at the host and route relative links back into the app. */
function wire(root, { host, dir, open }) {
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|blob:)/i.test(src)) img.src = fileUrl(host, resolveIn(dir, decodeURIComponent(src)), true);
    img.loading = 'lazy';
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (/^[a-z][\w+.-]*:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.addEventListener('click', e => { e.preventDefault(); open(resolveIn(dir, decodeURIComponent(href))); });
    }
  }
}

/** "python", "py", "bash", "js"… → a Monaco language id (by id, alias or extension). */
const fenceCache = new Map();
function fenceLanguage(name) {
  const n = (name || '').toLowerCase();
  if (!n || !window.monaco) return null;
  if (!fenceCache.has(n)) {
    let id = null;
    for (const l of window.monaco.languages.getLanguages()) {
      if (l.id === n || (l.aliases || []).some(a => a.toLowerCase() === n) || (l.extensions || []).includes('.' + n)) { id = l.id; break; }
    }
    if (!id && /^(bash|zsh|console|shell-session|sh)$/.test(n)) id = 'shell';
    fenceCache.set(n, id);
  }
  return fenceCache.get(n);
}

/** Colour fenced code with Monaco's tokenizers (same colours as the editor). */
function colorize(root, fallbackLang) {
  const monaco = window.monaco;
  if (!monaco) return;
  for (const code of root.querySelectorAll('pre > code, pre.nb-src')) {
    const m = (code.className || '').match(/language-([\w+#-]+)/);
    const lang = m ? fenceLanguage(m[1]) : code.dataset.lang || fallbackLang;
    if (!lang || lang === 'plaintext') continue;
    // marked ends the code with a newline, which colorize would draw as an empty last line
    monaco.editor.colorize(code.textContent.replace(/\n$/, ''), lang, { tabSize: 4 }).then(html => { code.innerHTML = html; }, () => {});
  }
}

const newlines = (s, from = 0, to = s.length) => {
  let n = 0;
  for (let i = s.indexOf('\n', from); i >= 0 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

/** Top-level Markdown blocks: their HTML and the source lines they came from. */
function blocks(source, lexer, parser) {
  source = source.replace(/\r\n?/g, '\n');  // as marked sees it, so each block's text is found again below
  const tokens = lexer(source);
  const out = [];
  let pos = 0, line = 0;
  for (const t of tokens) {
    const raw = t.raw || '';
    const at = raw ? source.indexOf(raw, pos) : -1;
    if (at >= 0) { line += newlines(source, pos, at); pos = at; }
    const start = line;
    pos += raw.length;
    line += newlines(raw);
    if (t.type === 'space' || t.type === 'def') continue;
    const one = [t];
    one.links = tokens.links;
    const html = parser(one);
    if (html.trim()) out.push({ html, line: start + 1, lines: newlines(raw.replace(/\n+$/, '')) + 1 });
  }
  return out;
}

/**
 * Markdown into `el`. Blocks that didn't change since the last call keep
 * their elements (so pictures don't reload while you type), and each block
 * says which source lines it came from (data-line, data-lines), for scrolling
 * the side-by-side view in step.
 */
export async function renderMarkdown(el, source, opts) {
  const { blocks: split, clean } = await loadLibs();
  let article = el.firstElementChild;
  if (!article || !article.matches('article.md')) {
    el.innerHTML = '<article class="md"></article>';
    article = el.firstElementChild;
    article.blockCache = new Map();
  }
  const old = article.blockCache, next = new Map(), nodes = [];
  // Sanitising is most of the cost and most blocks didn't change, so it's kept per block.
  const cleaned = article.cleanCache || new Map(), keep = new Map();
  for (const b of split(source)) {
    const html = cleaned.get(b.html) ?? clean(b.html);
    keep.set(b.html, html);
    let node = old.has(html) ? old.get(html).shift() : null;
    if (!node) {
      node = document.createElement('div');
      node.className = 'mdb';
      node.innerHTML = html;
      wire(node, opts);
      colorize(node, null);
    }
    node.dataset.line = b.line;
    node.dataset.lines = b.lines;
    if (!next.has(html)) next.set(html, []);
    next.get(html).push(node);
    nodes.push(node);
  }
  article.replaceChildren(...nodes);
  article.blockCache = next;
  article.cleanCache = keep;
}

export async function renderNotebook(el, source, opts) {
  let nb;
  try {
    nb = JSON.parse(source);
  } catch (e) {
    el.innerHTML = `<div class="note"><h3>Not a valid notebook</h3><div>${esc(e.message)}</div></div>`;
    return;
  }
  const { md, clean } = await loadLibs();
  const meta = nb.metadata || {};
  const lang = fenceLanguage((meta.language_info && meta.language_info.name) || (meta.kernelspec && meta.kernelspec.language) || 'python') || 'python';
  const cells = nb.cells || (nb.worksheets && nb.worksheets[0] && nb.worksheets[0].cells) || [];
  const out = cells.map(cell => {
    const src = text(cell.source || cell.input);
    if (cell.cell_type === 'markdown') return `<section class="nb-cell nb-md md">${clean(md(src))}</section>`;
    if (cell.cell_type !== 'code') return `<section class="nb-cell"><pre class="nb-raw">${esc(src)}</pre></section>`;
    const n = cell.execution_count ?? cell.prompt_number;
    return `<section class="nb-cell nb-code"><div class="nb-in"><span class="nb-n">[${n == null ? ' ' : n}]</span><pre class="nb-src" data-lang="${lang}">${esc(src)}</pre></div>${outputs(cell.outputs || [], md, clean)}</section>`;
  });
  el.innerHTML = `<div class="nb">${out.join('') || '<div class="note"><h3>Empty notebook</h3></div>'}</div>`;
  wire(el, opts);
  colorize(el, lang);
}

function outputs(list, md, clean) {
  if (!list.length) return '';
  const parts = list.map(o => {
    if (o.output_type === 'stream') return `<pre class="nb-out${o.name === 'stderr' ? ' err' : ''}">${esc(text(o.text).replace(ANSI, ''))}</pre>`;
    if (o.output_type === 'error' || o.output_type === 'pyerr') {
      const tb = text((o.traceback || []).join('\n')) || `${o.ename}: ${o.evalue}`;
      return `<pre class="nb-out err">${esc(tb.replace(ANSI, ''))}</pre>`;
    }
    const d = o.data || o;
    const b64 = v => text(v).replace(/\s+/g, '');
    if (d['image/png']) return `<div class="nb-img"><img alt="" src="data:image/png;base64,${b64(d['image/png'])}"></div>`;
    if (d['image/jpeg']) return `<div class="nb-img"><img alt="" src="data:image/jpeg;base64,${b64(d['image/jpeg'])}"></div>`;
    if (d['image/svg+xml']) return `<div class="nb-img"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text(d['image/svg+xml']))}"></div>`;
    if (d['text/html']) return `<div class="nb-html">${clean(text(d['text/html']))}</div>`;
    if (d['text/markdown']) return `<div class="nb-html md">${clean(md(text(d['text/markdown'])))}</div>`;
    if (d['application/json']) return `<pre class="nb-out">${esc(JSON.stringify(d['application/json'], null, 2))}</pre>`;
    if (d['text/plain'] || d.text) return `<pre class="nb-out">${esc(text(d['text/plain'] || d.text).replace(ANSI, ''))}</pre>`;
    return '';
  });
  return `<div class="nb-outs">${parts.join('')}</div>`;
}

/** SVG drawn as an image (scripts inside never run in an <img>). */
export function renderSvg(el, source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  el.innerHTML = `<div class="viewer-center"><img class="checker" alt="" src="${url}"></div>`;
  return () => URL.revokeObjectURL(url);
}

