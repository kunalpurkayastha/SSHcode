// Quick Look for the folder view: a big preview of the selected file, like
// Finder's. Space opens and closes it, the arrow keys go through the folder,
// and the editor is one click (or ⌘/Ctrl+Enter) away.
import { esc, h, fmtSize, kbd } from './util.js';
import { icons, mediaKind, isImage, previewKind } from './icons.js';
import { spinner } from './ui.js';
import { fileUrl, download } from './api.js';
import { renderMarkdown, renderNotebook, renderSvg } from './preview.js';
import { languageFor } from './editor.js';
import { kindOf, fmtDate, bigFolder, bigDoc } from './fileinfo.js';

const TEXT_HEAD = 1 << 20;       // Quick Look reads the first 1 MB of a text file
const COLOR_MAX = 300 << 10;     // and colours the code in the first 300 KB

/** A head read decodes anything, so binary is told apart here, the way the server does for whole
 *  files: a NUL near the start (sent as ␀) or bytes that aren't UTF-8 (sent as U+FFFD). */
function looksBinary(text, truncated) {
  if (text.slice(0, 8192).includes('\u2400')) return true;
  return (truncated ? text.slice(0, -3) : text).includes('\uFFFD');  // the head may end mid-character
}

export class QuickLook {
  constructor(fv) {
    this.fv = fv;
    this.ws = fv.ws;
    this.wrap = null;
    this.name = null;
    this.cleanup = null;
    this.token = 0;
  }

  get isOpen() { return !!this.wrap; }

  open(name) {
    if (!this.wrap) this.build();
    this.show(name);
  }

  build() {
    this.wrap = h(`<div class="ql-wrap"><div class="ql" role="dialog" aria-label="Quick Look">
      <div class="ql-bar">
        <button class="ib" data-q="close" title="Close (Space)">${icons.xmark}</button>
        <div class="ql-title"><span class="nm"></span><span class="sub"></span></div>
        <button class="ib" data-q="prev" title="Previous (←)">${icons.chevronLeft}</button>
        <button class="ib" data-q="next" title="Next (→)">${icons.chevronRight}</button>
        <button class="ib" data-q="download" title="Download">${icons.download}</button>
        <button class="btn small" data-q="editor" title="Open in Editor (${kbd('Mod+Enter')})">Open in Editor</button>
      </div>
      <div class="ql-body"></div>
    </div></div>`);
    this.body = this.wrap.querySelector('.ql-body');
    this.wrap.addEventListener('pointerdown', e => { if (e.target === this.wrap) this.close(); });
    this.wrap.querySelector('.ql-bar').addEventListener('click', e => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      const it = this.fv.itemOf(this.name);
      switch (b.dataset.q) {
        case 'close': this.close(); break;
        case 'prev': this.step(-1); break;
        case 'next': this.step(1); break;
        case 'download': if (it) this.fv.download([it]); break;
        case 'editor': if (it && !it.isDir) this.fv.openInEditor(it); else if (it) { this.close(); this.fv.open(it.name); } break;
      }
    });
    this.body.addEventListener('click', e => {
      const b = e.target.closest('[data-q]');
      const it = this.fv.itemOf(this.name);
      if (!b || !it) return;
      if (b.dataset.q === 'open') { this.close(); this.fv.open(it.name); }
      else if (b.dataset.q === 'astext') this.fv.openInEditor(it, { asText: 'lossy' });
      else if (b.dataset.q === 'download') this.fv.download([it]);
    });
    this.onKey = e => {
      const inBody = this.body.contains(e.target) && e.target !== this.body;
      const media = e.target.closest && e.target.closest('video, audio, input, textarea, .sv-main');
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (e.key === ' ' && !media) { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const it = this.fv.itemOf(this.name);
        if (it && !it.isDir) this.fv.openInEditor(it);
        return;
      }
      if (inBody && media) return;
      if (['ArrowRight', 'ArrowDown'].includes(e.key) && !e.altKey) { e.preventDefault(); e.stopPropagation(); this.step(1); }
      else if (['ArrowLeft', 'ArrowUp'].includes(e.key) && !e.altKey) { e.preventDefault(); e.stopPropagation(); this.step(-1); }
    };
    document.addEventListener('keydown', this.onKey, true);
    document.body.appendChild(this.wrap);
  }

  /** The next or previous item in the folder (the folder view's selection follows). */
  step(dir) {
    const list = this.fv.entries;
    const i = this.fv.index.get(this.name);
    if (i == null || !list.length) return;
    const j = Math.max(0, Math.min(list.length - 1, i + dir));
    if (j !== i) this.fv.focusAt(j);
  }

  stop() {
    this.token++;
    if (this.cleanup) { try { this.cleanup(); } catch { /* already gone */ } this.cleanup = null; }
    for (const m of this.body.querySelectorAll('video, audio')) m.pause();
  }

  show(name) {
    const it = this.fv.itemOf(name);
    if (!it || !this.wrap) { this.close(); return; }
    this.stop();
    this.name = name;
    const { e } = it;
    const token = this.token;
    const live = () => token === this.token && this.wrap;
    this.wrap.querySelector('.nm').textContent = name;
    this.wrap.querySelector('.sub').textContent = [kindOf(e), it.isDir ? '' : fmtSize(e.size), fmtDate(e.mtime)].filter(Boolean).join(' · ');
    const i = this.fv.index.get(name), n = this.fv.entries.length;
    this.wrap.querySelector('[data-q=prev]').disabled = i <= 0;
    this.wrap.querySelector('[data-q=next]').disabled = i >= n - 1;
    this.wrap.querySelector('[data-q=editor]').textContent = it.isDir ? 'Open Folder' : 'Open in Editor';
    this.wrap.querySelector('[data-q=download]').title = it.isDir ? 'Download as .tar.gz' : 'Download';
    const url = fileUrl(it.host, it.path, true);
    const b = this.body;
    b.className = 'ql-body';
    const card = (glyph, lines, buttons) => `<div class="ql-card"><div class="ql-glyph">${glyph}</div><h3>${esc(name)}</h3>${lines.map(l => `<div>${esc(l)}</div>`).join('')}${buttons ? `<div class="btns">${buttons}</div>` : ''}</div>`;
    if (it.isDir) {
      b.innerHTML = card(bigFolder(e.type === 'linkdir'), ['Folder'], '<button class="btn primary" data-q="open">Open</button>');
      this.ws.conn(it.host).call('/api/ls', { query: { path: it.path, bg: '1' } }).then(r => {
        if (!live()) return;
        const count = r.entries.length;
        b.querySelector('.ql-card h3 + div').textContent = `Folder · ${count} item${count === 1 ? '' : 's'}`;
      }, () => {});
      return;
    }
    const media = mediaKind(name);
    if (media === 'image' || (isImage(name) && !previewKind(name))) {
      b.innerHTML = `<div class="ql-center"><img class="checker" alt="" src="${esc(url)}"></div>`;
    } else if (media === 'pdf') {
      b.innerHTML = `<iframe class="pdf" src="${esc(url)}" title="${esc(name)}"></iframe>`;
    } else if (media === 'video') {
      b.innerHTML = `<div class="ql-center"><video controls autoplay preload="metadata" src="${esc(url)}"></video></div>`;
    } else if (media === 'audio') {
      b.innerHTML = card(bigDoc(name), [], `<audio controls autoplay preload="metadata" src="${esc(url)}"></audio>`);
    } else if (media === 'slides') {
      b.innerHTML = '';
      const host = h('<div class="media"></div>');
      b.appendChild(host);
      import('./pptx/viewer.js').then(({ openSlides }) => {
        if (!live()) return;
        const view = openSlides(host, { url, name, onDownload: () => download(fileUrl(it.host, it.path)) });
        this.cleanup = () => view.dispose();
      });
    } else {
      this.text(it, live);
    }
  }

  /** Text: Markdown and notebooks rendered, code coloured, anything else described. */
  async text(it, live) {
    const b = this.body;
    const { e, name } = it;
    b.innerHTML = `<div class="ql-center">${spinner(20)}</div>`;
    let r;
    try {
      r = await this.ws.conn(it.host).call('/api/read', { query: { path: it.path, head: String(TEXT_HEAD) } });
    } catch (err) {
      if (!live()) return;
      b.innerHTML = `<div class="ql-card"><div class="ql-glyph">${bigDoc(name)}</div><h3>Couldn’t read “${esc(name)}”</h3><div>${esc(err.message)}</div></div>`;
      return;
    }
    if (!live()) return;
    if (r.binary || r.tooLarge || looksBinary(r.text || '', r.truncated)) {
      b.innerHTML = `<div class="ql-card"><div class="ql-glyph">${bigDoc(name)}</div><h3>${esc(name)}</h3><div>${esc(kindOf(e))} · ${esc(fmtSize(e.size))}</div><div class="faint">${esc(fmtDate(e.mtime))}</div>
        <div class="btns"><button class="btn" data-q="astext">Open as Text</button><button class="btn primary" data-q="download">Download</button></div></div>`;
      return;
    }
    const kind = previewKind(name);
    const opts = { host: it.host, dir: it.path.slice(0, it.path.lastIndexOf('/')) || '/', open: p => this.fv.openInEditor({ host: it.host, path: p }) };
    if (kind === 'markdown' || kind === 'notebook') {
      const el = h('<div class="rendered"></div>');
      b.replaceChildren(el);
      try {
        if (kind === 'markdown') await renderMarkdown(el, r.text, opts);
        else await renderNotebook(el, r.text, opts);
      } catch (err) {
        el.textContent = err.message;
      }
      return;
    }
    if (kind === 'svg') {
      const el = h('<div class="rendered"></div>');
      b.replaceChildren(el);
      this.cleanup = renderSvg(el, r.text);
      return;
    }
    const pre = h('<pre class="ql-code"></pre>');
    b.replaceChildren(pre);
    if (r.truncated) b.appendChild(h(`<div class="ql-note">The first ${fmtSize(TEXT_HEAD)} of ${esc(fmtSize(e.size))} — open it in the editor for all of it.</div>`));
    const text = r.text;
    pre.textContent = text;
    const monaco = window.monaco;
    if (monaco && text.length <= COLOR_MAX) {
      const lang = languageFor(name, text);
      if (lang !== 'plaintext') {
        try {
          const html = await monaco.editor.colorize(text, lang, { tabSize: 4 });
          if (live()) pre.innerHTML = html;
        } catch { /* stays plain */ }
      }
    }
  }

  close() {
    if (!this.wrap) return;
    this.stop();
    document.removeEventListener('keydown', this.onKey, true);
    this.wrap.remove();
    this.wrap = null;
    this.name = null;
    this.fv.focus();
  }
}
