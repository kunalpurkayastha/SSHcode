// Monaco (the editor inside VS Code) with tabs, preview tabs, dirty
// tracking, conflict-checked saves and hot exit (unsaved edits survive a
// reload in localStorage), plus viewers for everything that isn't plain
// text: images, PDF, PowerPoint slides, video, audio, Markdown/notebook/SVG
// previews, and read-only text for binary or very large files.
import { esc, h, store, debounce, basename, dirname, isUnder, tildify, keycaps, kbd, extname, reconcile } from './util.js';
import { icons, fileIcon, appIcon, mediaKind, previewKind } from './icons.js';
import { renderMarkdown, renderNotebook, renderSvg } from './preview.js';
import { dialog, contextMenu, toast, toastError, spinner } from './ui.js';
import { fileUrl, download } from './api.js';
import { onTheme, editorTheme } from './theme.js';
import { settings, hostColor, hostLabel } from './settings.js';
import { DRAG_TYPE } from './explorer.js';

const FONTS = {
  default: '"SF Mono", SFMono-Regular, "JetBrains Mono Variable", Menlo, monospace',
  jetbrains: '"JetBrains Mono Variable", "JetBrains Mono", monospace',
  system: 'ui-monospace, Menlo, "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", monospace',
};

/** The code font for the editor and the terminal (Settings → Editor). */
export function codeFont() {
  const f = settings.get('editor.font');
  if (f === 'custom') {
    const c = settings.get('editor.fontCustom').replace(/[;{}<>]/g, '').trim();
    if (c) return `${/[",]/.test(c) ? c : `"${c}"`}, ${FONTS.default}`;
  }
  return FONTS[f] || FONTS.default;
}

const VIEWS = ['source', 'split', 'preview'];
const BACKUP_MAX = 2 << 20;
const HEAD_BYTES = 5 << 20;  // "Open First 5 MB" of a file too large to edit
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

let monacoPromise;
export function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = new Promise((resolve, reject) => {
      // Absolute: language workers start from blob: URLs and can't resolve "/vendor/…".
      window.require.config({ paths: { vs: new URL('/vendor/monaco/vs', location.href).href } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    });
  }
  return monacoPromise;
}

export async function fontsReady() {
  try {
    await Promise.all([
      document.fonts.load('13px "JetBrains Mono Variable"'),
      document.fonts.load('600 13px "JetBrains Mono Variable"'),
      document.fonts.load('13px "Inter Variable"'),
    ]);
  } catch { /* fall back to whatever is there */ }
}

// --- languages -------------------------------------------------------------------
const EXTRA_EXT = {
  '.toml': 'ini', '.service': 'ini', '.timer': 'ini', '.socket': 'ini', '.desktop': 'ini', '.conf': 'ini',
  '.cfg': 'ini', '.env': 'shell', '.jsonl': 'plaintext', '.ipynb': 'json', '.cu': 'cpp', '.cuh': 'cpp',
  '.mdx': 'markdown', '.vue': 'html', '.svelte': 'html', '.zsh': 'shell', '.bash': 'shell', '.fish': 'shell',
  '.tf': 'hcl', '.tfvars': 'hcl', '.log': 'plaintext', '.jsonc': 'json', '.json5': 'json', '.mjs': 'javascript',
  '.cjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript', '.pyi': 'python', '.gyp': 'python',
};
const SHELL_FILES = new Set(['.bashrc', '.bash_profile', '.bash_aliases', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.envrc', '.xinitrc', '.xprofile']);
let byExt, byName, firstLines, langNames;

function buildLangMaps(monaco) {
  byExt = new Map(); byName = new Map(); firstLines = []; langNames = new Map();
  for (const l of monaco.languages.getLanguages()) {
    langNames.set(l.id, (l.aliases && l.aliases[0]) || l.id);
    for (const e of l.extensions || []) if (!byExt.has(e.toLowerCase())) byExt.set(e.toLowerCase(), l.id);
    for (const f of l.filenames || []) byName.set(f.toLowerCase(), l.id);
    if (l.firstLine) { try { firstLines.push([new RegExp(l.firstLine), l.id]); } catch { /* bad pattern */ } }
  }
}

export function languageFor(name, text = '') {
  const low = name.toLowerCase();
  if (byName.has(low)) return byName.get(low);
  if (SHELL_FILES.has(low) || low.startsWith('.env')) return 'shell';
  if (low === 'makefile' || low === 'gnumakefile') return 'plaintext';
  const ext = low.lastIndexOf('.') > 0 ? low.slice(low.lastIndexOf('.')) : '';
  if (EXTRA_EXT[ext]) return EXTRA_EXT[ext];
  if (ext && byExt.has(ext)) return byExt.get(ext);
  const first = text.slice(0, 300).split('\n')[0];
  if (first.startsWith('#!')) {
    if (/python/.test(first)) return 'python';
    if (/\b(ba|z|k|da|a)?sh\b/.test(first)) return 'shell';
    if (/\b(node|deno|bun)\b/.test(first)) return 'javascript';
    if (/\bperl\b/.test(first)) return 'perl';
    if (/\bruby\b/.test(first)) return 'ruby';
    if (/\bphp\b/.test(first)) return 'php';
  }
  for (const [re, id] of firstLines) if (re.test(first)) return id;
  return 'plaintext';
}

export const languageName = id => (langNames && langNames.get(id)) || id;
export const languages = () => [...langNames.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

function configureLanguages(monaco) {
  // Remote files have no project around them: keep syntax errors, drop
  // "cannot find module" noise.
  const ts = monaco.languages.typescript;
  if (ts) {
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
      d.setCompilerOptions({ target: ts.ScriptTarget.ESNext, allowJs: true, allowNonTsExtensions: true, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs });
    }
  }
  const json = monaco.languages.json;
  if (json) json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', enableSchemaRequest: false, schemas: [] });
}

// --- editor ------------------------------------------------------------------------
let seq = 0;

export class Editor {
  constructor(ws) {
    this.ws = ws;
    this.docs = [];
    this.active = null;
    this.themeSeq = 0;
    this.subs = [];
    this.el = h(`<section class="pane rim editor-pane">
      <div class="tabbar">
        <button class="ib side-toggle" data-a="sidebar" hidden>${icons.sidebar}</button>
        <div class="tabs" role="tablist"></div>
        <div class="tab-acts">
          <div class="view-seg" role="group" aria-label="Show" hidden>
            <button class="ib sm" data-view="source">${icons.code}</button>
            <button class="ib sm" data-view="split">${icons.split}</button>
            <button class="ib sm" data-view="preview">${icons.eye}</button>
          </div>
          <button class="ib" data-a="folders">${icons.grid}</button>
          <button class="ib" data-a="quick">${icons.search}</button>
          <button class="ib" data-a="terminal">${icons.terminal}</button>
          <button class="ib" data-a="more">${icons.ellipsis}</button>
        </div>
      </div>
      <div class="editor-body">
        <div class="editor-host" hidden></div>
        <div class="viewer" hidden></div>
        <div class="md-split" role="separator" aria-orientation="vertical" title="Drag to resize · double-click to centre" hidden></div>
        <div class="empty-editor"></div>
      </div>
      <div class="status">
        <span class="si path"></span><span class="sp"></span>
        <span class="si saving" hidden></span>
        <span class="si ro" hidden></span>
        <button class="si" data-s="pos" hidden></button>
        <button class="si" data-s="indent" hidden></button>
        <button class="si" data-s="enc" hidden></button>
        <button class="si" data-s="eol" hidden></button>
        <button class="si" data-s="lang" hidden></button>
      </div>
    </section>`);
    this.tabsEl = this.el.querySelector('.tabs');
    this.tabCache = new Map();
    this.hostEl = this.el.querySelector('.editor-host');
    this.viewer = this.el.querySelector('.viewer');
    this.emptyEl = this.el.querySelector('.empty-editor');
    this.status = Object.fromEntries([...this.el.querySelectorAll('.status [data-s]')].map(b => [b.dataset.s, b]));
    this.status.path = this.el.querySelector('.status .path');
    this.status.saving = this.el.querySelector('.status .saving');
    this.status.ro = this.el.querySelector('.status .ro');
    this.body = this.el.querySelector('.editor-body');
    this.viewSeg = this.el.querySelector('.view-seg');
    this.divider = this.el.querySelector('.md-split');
    this.splitAt = store.get('md.split', 50);
    this.body.style.setProperty('--split', `${this.splitAt}%`);
    const tips = { sidebar: ['Show Sidebar', 'Mod+B'], folders: ['Folder View', 'Mod+Alt+F'], quick: ['Go to File', 'Mod+P'], terminal: ['Toggle Terminal', 'Ctrl+`'], more: ['More'] };
    for (const [a, [t, k]] of Object.entries(tips)) this.el.querySelector(`[data-a="${a}"]`).title = k ? `${t} (${kbd(k)})` : t;
    this.saveBackups = debounce(() => this.writeBackups(), 700);
    this.autoSaveSoon = debounce(() => this.autoSaveNow(), 1000);
    this.dirtyBackups = new Set();
    this.bind();
  }

  conn(doc) { return this.ws.conn(doc.host); }

  /** Monaco options from Settings → Editor. */
  options() {
    const g = k => settings.get(k);
    const size = g('editor.fontSize');
    const guides = g('editor.indentGuides');
    return {
      fontFamily: codeFont(),
      fontSize: size,
      lineHeight: Math.round(size * g('editor.lineHeight')),
      fontLigatures: g('editor.ligatures'),
      minimap: { enabled: g('editor.minimap'), renderCharacters: false, scale: 1, showSlider: 'mouseover' },
      wordWrap: this.wrapFor(this.active),
      cursorStyle: g('editor.cursorStyle'),
      cursorBlinking: g('editor.cursorBlinking'),
      lineNumbers: g('editor.lineNumbers'),
      renderWhitespace: g('editor.whitespace'),
      bracketPairColorization: { enabled: g('editor.bracketColors') },
      stickyScroll: { enabled: g('editor.stickyScroll') },
      guides: { indentation: guides, highlightActiveIndentation: guides },
      renderLineHighlight: g('editor.lineHighlight') ? 'all' : 'none',
      tabSize: g('editor.tabSize'),
      insertSpaces: g('editor.insertSpaces'),
      detectIndentation: g('editor.detectIndentation'),
    };
  }

  /** Redefine the theme under a fresh name, so Monaco always repaints with it. */
  applyTheme() {
    const name = `sshcode-${++this.themeSeq % 2}`;
    this.monaco.editor.defineTheme(name, editorTheme());
    this.monaco.editor.setTheme(name);
    return name;
  }

  onSetting(k) {
    if (!this.ed || !k.startsWith('editor.') || k === 'editor.theme' || k === 'editor.scheme') return;
    this.ed.updateOptions(this.options());
    if ((k === 'editor.tabSize' || k === 'editor.insertSpaces') && !settings.get('editor.detectIndentation')) {
      for (const d of this.docs) if (d.model) d.model.updateOptions({ tabSize: settings.get('editor.tabSize'), insertSpaces: settings.get('editor.insertSpaces') });
    }
    if (k === 'editor.font' || k === 'editor.fontCustom') requestAnimationFrame(() => this.monaco.editor.remeasureFonts());
    if (k === 'editor.autoSave' && settings.get(k) !== 'off') this.autoSaveNow();
    this.statusSoon();
  }

  dispose() {
    this.subs.forEach(f => f());
    if (this.ed) {
      for (const d of this.docs) this.disposeDoc(d);
      this.ed.dispose();
    }
  }

  async init() {
    const monaco = this.monaco = await loadMonaco();
    configureLanguages(monaco);
    buildLangMaps(monaco);
    await fontsReady();
    this.ed = monaco.editor.create(this.hostEl, {
      model: null,
      theme: this.applyTheme(),
      ...this.options(),
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      roundedSelection: true,
      smoothScrolling: false,
      cursorSmoothCaretAnimation: 'off',
      cursorWidth: 2,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, useShadows: false, verticalSliderSize: 7, horizontalSliderSize: 7 },
      showFoldingControls: 'mouseover',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 12,
      glyphMargin: false,
      fixedOverflowWidgets: true,
      mouseWheelZoom: true,
      unicodeHighlight: { ambiguousCharacters: false },
      'semanticHighlighting.enabled': false,
    });
    this.subs.push(onTheme(() => this.applyTheme()), settings.on('*', (v, k) => this.onSetting(k)), settings.on('hosts', () => this.renderTabs()));
    this.ed.onDidChangeCursorSelection(() => this.statusSoon());
    this.ed.onDidScrollChange(e => { if (e.scrollTopChanged && this.active && this.active.view === 'split') this.syncPreview(); });
    this.ed.onDidChangeModelOptions(() => this.statusSoon());
    this.ed.onDidChangeModelLanguage(() => this.statusSoon());
    document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
    this.renderEmpty();
    this.renderTabs();
    this.updateStatus();
  }

  // --- documents ------------------------------------------------------------------
  get activePath() { return this.active ? this.active.path : null; }
  isDirty(d) { return !!(d && d.model && d.model.getAlternativeVersionId() !== d.savedVersion); }
  dirtyDocs() { return this.docs.filter(d => this.isDirty(d)); }
  find(host, path) { return this.docs.find(d => d.host === host && d.path === path); }

  /** opts: {host, preview, focus, line, col, endLine, endCol, query, asText: 'lossy'} */
  async open(path, opts = {}) {
    if (this.ws.mode === 'files') this.ws.setMode('ide', { focus: false });
    const host = opts.host || this.ws.host;
    const preview = opts.preview !== false && settings.get('editor.previewTabs');
    let doc = this.find(host, path);
    if (doc && opts.asText && doc.kind !== 'text') {
      this.reopenAs(doc, opts.asText);
    } else if (!doc) {
      doc = { host, path, name: basename(path), kind: 'pending', preview, asText: opts.asText || null };
      const old = preview ? this.docs.find(d => d.preview && !this.isDirty(d)) : null;
      if (old) {
        this.docs.splice(this.docs.indexOf(old), 1, doc);
        this.disposeDoc(old);
      } else {
        const at = this.active ? this.docs.indexOf(this.active) + 1 : this.docs.length;
        this.docs.splice(at, 0, doc);
      }
    } else if (!preview) {
      doc.preview = false;
    }
    this.activate(doc, { focus: opts.focus !== false });
    if (doc.loading) await doc.loading;
    if (opts.line && this.active === doc) this.revealAt(doc, opts);
    else if (opts.focus !== false && this.active === doc && doc.kind === 'text') this.ed.focus();
    this.ws.saveSession();
    return doc;
  }

  load(doc) {
    if (doc.loading) return doc.loading;
    const media = mediaKind(doc.name);
    if (media && !doc.asText) {
      doc.kind = 'media';
      doc.media = media;
      doc.loading = Promise.resolve();
      return doc.loading;
    }
    doc.kind = 'loading';
    doc.loading = (async () => {
      try {
        const query = { path: doc.path };
        if (doc.asText === 'lossy') query.lossy = '1';
        if (doc.asText === 'head') query.head = String(HEAD_BYTES);
        const r = await this.conn(doc).call('/api/read', { query });
        doc.size = r.size;
        if (r.tooLarge) doc.kind = 'large';
        else if (r.binary) doc.kind = 'binary';
        else {
          doc.kind = 'text';
          doc.mtime = r.mtime;
          doc.bom = !!r.bom;
          doc.readonly = !!r.readonly;
          doc.truncated = !!r.truncated;
          const uri = this.monaco.Uri.from({ scheme: 'sshcode', path: `/${++seq}${doc.path}` });
          doc.model = this.monaco.editor.createModel(r.text, languageFor(doc.name, r.text), uri);
          doc.savedVersion = doc.model.getAlternativeVersionId();
          doc.model.onDidChangeContent(() => this.onEdit(doc));
          doc.previewKind = doc.readonly ? null : previewKind(doc.name);
          // Markdown opens side by side (Settings → Editor); notebooks and SVGs rendered.
          const first = doc.previewKind === 'markdown' ? settings.get('editor.markdownView') : doc.previewKind ? 'preview' : 'source';
          doc.view = doc.previewKind && VIEWS.includes(doc.savedView) ? doc.savedView : first;
          if (!doc.readonly) this.restoreBackup(doc, r);
        }
      } catch (e) {
        doc.kind = 'error';
        doc.error = e.message;
        doc.loading = null;
      }
      if (this.active === doc) this.show(doc);
      this.renderTabs();
    })();
    return doc.loading;
  }

  activate(doc, { focus = true } = {}) {
    if (this.active && this.active !== doc && this.active.kind === 'text' && this.ed.getModel() === this.active.model) {
      this.active.viewState = this.ed.saveViewState();
    }
    if (this.active && this.active !== doc && settings.get('editor.autoSave') === 'focus' && this.isDirty(this.active) && !this.active.readonly) {
      this.save(this.active);
    }
    this.active = doc;
    if (doc && doc.kind === 'pending') this.load(doc);
    this.show(doc);
    this.renderTabs();
    this.ws.onActiveChanged(doc);
    if (focus && doc && doc.kind === 'text' && doc.view !== 'preview') this.ed.focus();
  }

  /** What a text file shows: 'source', 'split' (source and preview side by side) or 'preview'. */
  viewOf(doc) { return doc && doc.kind === 'text' ? (doc.previewKind ? doc.view : 'source') : null; }

  show(doc) {
    const mode = this.viewOf(doc);
    const source = mode === 'source' || mode === 'split';
    this.emptyEl.hidden = !!doc;
    this.hostEl.hidden = !source;
    this.viewer.hidden = !doc || mode === 'source';
    this.body.classList.toggle('split', mode === 'split');
    this.divider.hidden = mode !== 'split';
    if (source) {
      if (this.ed.getModel() !== doc.model) {
        this.ed.setModel(doc.model);
        if (doc.viewState) this.ed.restoreViewState(doc.viewState);
      }
      this.ed.updateOptions({ readOnly: !!doc.readonly, wordWrap: this.wrapFor(doc) });
      if (mode === 'split') this.renderPreview(doc);
    } else {
      if (this.ed && this.ed.getModel()) this.ed.setModel(null);
      if (doc && doc.kind === 'text') this.renderPreview(doc);
      else if (doc) this.renderViewer(doc);
    }
    this.updateViewSeg();
    this.statusSoon();
  }

  /** Images, PDF, slides, video, audio, and the notes for binary / too-large / failed files. */
  renderViewer(doc) {
    const v = this.viewer;
    v.className = 'viewer';
    v.onclick = null;
    const full = doc.media === 'pdf' || doc.media === 'slides';
    if (doc.kind === 'media' && doc.viewEl) { v.classList.toggle('full', full); v.replaceChildren(doc.viewEl); return; }
    const url = fileUrl(doc.host, doc.path, true);
    const note = (icon, title, text, buttons = '') => `<div class="note"><div class="big">${icons[icon]}</div><h3>${esc(title)}</h3><div>${esc(text)}</div>${buttons ? `<div class="btns">${buttons}</div>` : ''}</div>`;
    const dl = `<button class="btn primary" data-v="download">Download</button>`;
    const bar = `<div class="media-bar"><button class="ib" data-v="newtab" title="Open in a New Browser Tab">${icons.alias}</button><button class="ib" data-v="download" title="Download">${icons.download}</button></div>`;
    let html;
    if (doc.kind === 'media' && doc.media === 'slides') {
      // PowerPoint: drawn in the browser (the renderer loads on first use).
      v.classList.add('full');
      const el = h('<div class="media"></div>');
      doc.viewEl = el;
      v.replaceChildren(el);
      import('./pptx/viewer.js').then(({ openSlides }) => {
        if (doc.viewEl !== el) return;
        const view = openSlides(el, { url, name: doc.name, onDownload: () => download(fileUrl(doc.host, doc.path)) });
        doc.viewCleanup = () => view.dispose();
        if (this.active === doc) view.focus();
      }, e => { el.innerHTML = note('warning', 'Couldn’t load the slide viewer', e.message || String(e)); });
      return;
    }
    if (doc.kind === 'media') {
      if (doc.media === 'pdf') {
        v.classList.add('full');
        html = `<iframe class="pdf" src="${esc(url)}" title="${esc(doc.name)}"></iframe>`;
      } else if (doc.media === 'image') {
        html = `<div class="viewer-center"><img class="checker" alt="${esc(doc.name)}" src="${esc(url)}"></div>${bar}`;
      } else if (doc.media === 'video') {
        html = `<div class="viewer-center"><video controls preload="metadata" src="${esc(url)}"></video></div>${bar}`;
      } else {
        html = `<div class="note audio"><div class="big">${icons.music}</div><h3>${esc(doc.name)}</h3><audio controls preload="metadata" src="${esc(url)}"></audio></div>${bar}`;
      }
      // Kept per tab, so switching tabs doesn't restart a video or a PDF.
      doc.viewEl = h(`<div class="media">${html}</div>`);
      doc.viewEl.addEventListener('click', e => this.viewerAction(e, doc));
      v.replaceChildren(doc.viewEl);
      return;
    }
    if (doc.kind === 'loading' || doc.kind === 'pending') html = spinner(22);
    else if (doc.kind === 'binary') html = note('file', 'Binary file', `“${doc.name}” isn’t UTF-8 text. You can still look inside it, read-only.`, `<button class="btn" data-v="astext">Open as Text</button>${dl}`);
    else if (doc.kind === 'large') html = note('file', 'Large file', `“${doc.name}” is ${(doc.size / 1e6).toFixed(1)} MB; the editor opens files up to 16 MB.`, `<button class="btn" data-v="head">Open First 5 MB</button>${dl}`);
    else html = note('warning', 'Couldn’t open the file', doc.error || '', `<button class="btn" data-v="retry">Try Again</button>`);
    v.innerHTML = html;
    v.onclick = e => this.viewerAction(e, doc);
  }

  viewerAction(e, doc) {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const a = b.dataset.v;
    if (a === 'download') download(fileUrl(doc.host, doc.path));
    else if (a === 'newtab') window.open(fileUrl(doc.host, doc.path, true), '_blank', 'noopener');
    else if (a === 'astext') this.reopenAs(doc, 'lossy');
    else if (a === 'head') this.reopenAs(doc, 'head');
    else if (a === 'retry') this.reopenAs(doc, doc.asText);
  }

  /** Load the tab again, e.g. as read-only text ('lossy') or its first 5 MB ('head'). */
  reopenAs(doc, asText) {
    this.disposeDoc(doc);
    doc.asText = asText || null;
    doc.loading = null;
    doc.kind = 'pending';
    doc.preview = false;
    if (this.active === doc) this.activate(doc);
    else this.load(doc);
  }

  /** Markdown, notebook or SVG rendered from the buffer (cached until it changes). */
  async renderPreview(doc) {
    const v = this.viewer;
    v.className = 'viewer full';
    v.onclick = null;
    const version = doc.model.getAlternativeVersionId();
    if (doc.viewEl && doc.viewVersion === version) {
      if (v.firstChild !== doc.viewEl) v.replaceChildren(doc.viewEl);
      if (doc.view === 'split') this.syncPreview();
      return;
    }
    // Markdown is redrawn in place: unchanged blocks (and their pictures) stay put.
    const reuse = doc.previewKind === 'markdown' && doc.viewEl;
    if (!reuse && doc.viewCleanup) { doc.viewCleanup(); doc.viewCleanup = null; }
    const el = reuse ? doc.viewEl : h(`<div class="rendered">${spinner(20)}</div>`);
    if (!reuse && doc.previewKind === 'markdown') this.bindPreview(doc, el);
    doc.viewEl = el;
    doc.viewVersion = version;
    if (v.firstChild !== el) v.replaceChildren(el);
    const opts = { host: doc.host, dir: dirname(doc.path), open: p => this.open(p, { host: doc.host, preview: false }) };
    const t0 = performance.now();
    try {
      const src = doc.model.getValue();
      if (doc.previewKind === 'markdown') await renderMarkdown(el, src, opts);
      else if (doc.previewKind === 'notebook') await renderNotebook(el, src, opts);
      else doc.viewCleanup = renderSvg(el, src);
    } catch (e) {
      el.innerHTML = `<div class="note"><h3>Couldn’t render a preview</h3><div>${esc(e.message || String(e))}</div></div>`;
    }
    this.renderCost = performance.now() - t0;
    if (doc === this.active && doc.view === 'split') this.syncPreview();
  }

  /** While typing in the side-by-side view, redraw the preview after a pause (longer for big files). */
  previewSoon(doc) {
    clearTimeout(this.previewTimer);
    const wait = Math.min(1000, Math.max(140, (this.renderCost || 0) * 3));
    this.previewTimer = setTimeout(() => {
      if (this.active === doc && doc.view === 'split' && doc.model) this.renderPreview(doc);
    }, wait);
  }

  /** The preview's half of scrolling in step, and double-click to jump to the source. */
  bindPreview(doc, el) {
    el.addEventListener('scroll', () => {
      if (this.active !== doc || doc.view !== 'split' || this.syncing === 'preview') return;
      this.syncEditor(el);
    }, { passive: true });
    el.addEventListener('dblclick', e => {
      const b = e.target.closest('.mdb[data-line]');
      if (!b || this.active !== doc || doc.view === 'preview' || e.target.closest('a')) return;
      const line = +b.dataset.line;
      this.ed.setPosition({ lineNumber: line, column: 1 });
      this.ed.revealLineInCenterIfOutsideViewport(line);
      this.ed.focus();
    });
  }

  // --- side by side: the editor and the preview scroll together ---------------------------
  lockSync(side) {
    this.syncing = side;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.syncing = null; }, 120);
  }

  /** The source line at the top of the editor, with a fraction for how far into it. */
  topLine() {
    const ed = this.ed;
    const ranges = ed.getVisibleRanges();
    if (!ranges.length) return 1;
    const n = ranges[0].startLineNumber;
    const top = ed.getTopForLineNumber(n), next = ed.getTopForLineNumber(n + 1);
    return n + (next > top ? Math.min(1, Math.max(0, (ed.getScrollTop() - top) / (next - top))) : 0);
  }

  /** Preview blocks with where they sit: [{line, lines, top, height}] (scroll coordinates). */
  previewBlocks(el) {
    const base = el.getBoundingClientRect().top - el.scrollTop;
    return [...el.querySelectorAll('.mdb[data-line]')].map(b => {
      const r = b.getBoundingClientRect();
      return { line: +b.dataset.line, lines: +b.dataset.lines || 1, top: r.top - base, height: r.height };
    });
  }

  syncPreview() {
    const doc = this.active;
    const el = doc && doc.viewEl;
    if (!el || doc.view !== 'split' || this.syncing === 'editor' || !el.isConnected) return;
    const ed = this.ed;
    let y;
    if (ed.getScrollTop() <= 0) y = 0;
    else if (ed.getScrollTop() + ed.getLayoutInfo().height >= ed.getScrollHeight() - 2) y = el.scrollHeight;
    else {
      const blocks = this.previewBlocks(el);
      if (!blocks.length) return;
      const line = this.topLine();
      let i = blocks.length - 1;
      while (i > 0 && blocks[i].line > line) i--;
      const b = blocks[i], nb = blocks[i + 1];
      if (line < b.line) y = b.top * Math.max(0, line - 1) / Math.max(1, b.line - 1);
      else if (line < b.line + b.lines) y = b.top + (line - b.line) / b.lines * b.height;
      else if (nb) y = b.top + b.height + (line - b.line - b.lines) / Math.max(1, nb.line - b.line - b.lines) * (nb.top - b.top - b.height);
      else y = b.top + b.height;
      y -= 12;
    }
    this.lockSync('preview');
    el.scrollTop = Math.max(0, y);
  }

  syncEditor(el) {
    const ed = this.ed;
    let top;
    if (el.scrollTop <= 0) top = 0;
    else if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) top = ed.getScrollHeight();
    else {
      const blocks = this.previewBlocks(el);
      if (!blocks.length) return;
      const y = el.scrollTop + 12;
      let i = blocks.length - 1;
      while (i > 0 && blocks[i].top > y) i--;
      const b = blocks[i], nb = blocks[i + 1];
      let line;
      if (y < b.top) line = 1 + (b.line - 1) * Math.max(0, y) / Math.max(1, b.top);
      else if (y < b.top + b.height) line = b.line + (y - b.top) / Math.max(1, b.height) * b.lines;
      else if (nb) line = b.line + b.lines + (y - b.top - b.height) / Math.max(1, nb.top - b.top - b.height) * (nb.line - b.line - b.lines);
      else line = b.line + b.lines;
      const n = Math.max(1, Math.floor(line));
      const lt = ed.getTopForLineNumber(n), next = ed.getTopForLineNumber(n + 1);
      top = lt + (line - n) * (next - lt);
    }
    this.lockSync('editor');
    ed.setScrollTop(top);
  }

  /** Drag the line between source and preview. */
  bindDivider() {
    const d = this.divider;
    d.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      const box = this.body.getBoundingClientRect();
      const move = ev => {
        this.splitAt = Math.min(80, Math.max(20, (ev.clientX - box.left) / box.width * 100));
        this.body.style.setProperty('--split', `${this.splitAt.toFixed(2)}%`);
      };
      const up = () => {
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        d.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
        store.set('md.split', +this.splitAt.toFixed(2));
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', () => {
      this.splitAt = 50;
      this.body.style.setProperty('--split', '50%');
      store.set('md.split', 50);
    });
  }

  /** Show a previewable file as 'source', 'split' or 'preview'. */
  setView(doc, view) {
    if (!doc || doc.kind !== 'text' || !doc.previewKind || !VIEWS.includes(view) || doc.view === view) return;
    if (doc.view !== 'preview' && this.ed.getModel() === doc.model) doc.viewState = this.ed.saveViewState();
    if (doc.view !== 'preview') doc.lastView = doc.view;
    doc.view = view;
    this.show(doc);
    if (view !== 'preview') this.ed.focus();
    this.ws.saveSession();
  }

  /** Preview on its own, or back to how the file was shown before (Mod+Shift+V). */
  togglePreview(doc = this.active) {
    if (!doc || doc.kind !== 'text' || !doc.previewKind) return;
    this.setView(doc, doc.view === 'preview' ? (doc.lastView || 'source') : 'preview');
  }

  /** Source and preview side by side, or back to the source. */
  toggleSplit(doc = this.active) {
    if (!doc || doc.kind !== 'text' || !doc.previewKind) return;
    this.setView(doc, doc.view === 'split' ? 'source' : 'split');
  }

  updateViewSeg() {
    const d = this.active;
    const can = !!(d && d.kind === 'text' && d.previewKind);
    this.viewSeg.hidden = !can;
    if (!can) return;
    const keys = { source: '', split: this.ws.keysFor('editor.previewSide'), preview: this.ws.keysFor('editor.preview') };
    const names = { source: 'Source', split: 'Side by Side', preview: 'Preview' };
    for (const b of this.viewSeg.children) {
      const v = b.dataset.view;
      b.classList.toggle('on', d.view === v);
      b.setAttribute('aria-pressed', String(d.view === v));
      b.title = keys[v] ? `${names[v]} (${kbd(keys[v])})` : names[v];
    }
  }

  revealAt(doc, { line, col, endLine, endCol, query, focus = true }) {
    if (doc.kind !== 'text' || this.active !== doc) return;
    if (doc.view === 'preview') { doc.view = doc.lastView || 'source'; this.show(doc); }
    const { Range } = this.monaco;
    const model = doc.model;
    const ln = Math.max(1, Math.min(line, model.getLineCount()));
    let range = null;
    if (query && query.text) {
      try {
        const m = model.findMatches(query.text, new Range(ln, 1, ln, model.getLineMaxColumn(ln)), !!query.regex, !!query.case, query.word ? WORD_SEPARATORS : null, false);
        if (m.length) range = m[0].range;
      } catch { /* bad regex */ }
    }
    if (!range) range = new Range(ln, col || 1, endLine || ln, endCol || col || 1);
    this.ed.setSelection(range);
    this.ed.revealRangeInCenterIfOutsideViewport(range);
    if (focus) this.ed.focus();
  }

  goToLine(line, col) {
    if (this.active && this.active.kind === 'text') this.revealAt(this.active, { line, col });
  }

  // --- editing / saving --------------------------------------------------------------
  onEdit(doc) {
    // Runs on every keystroke: only touch the DOM when what it shows changes.
    const pinned = doc.preview;
    doc.preview = false;
    if (pinned || this.isDirty(doc) !== doc.shownDirty) {
      this.renderTabs();
      this.ws.onDirtyChanged();
    }
    this.dirtyBackups.add(doc);
    this.saveBackups();
    if (settings.get('editor.autoSave') === 'delay') this.autoSaveSoon();
    if (doc.view === 'split' && doc === this.active) this.previewSoon(doc);
  }

  async save(doc = this.active, { force = false } = {}) {
    if (!doc || doc.kind !== 'text') return false;
    if (doc.readonly) {
      toast({ title: 'Opened read-only', message: `“${doc.name}” is shown as text for reading; saving it could damage the file.`, timeout: 3500 });
      return false;
    }
    if (doc.saving) return doc.saving;
    this.status.saving.hidden = false;
    this.status.saving.textContent = 'Saving…';
    doc.saving = this.write(doc, force);
    let result;
    try {
      result = await doc.saving;
    } finally {
      doc.saving = null;
      this.status.saving.hidden = true;
      this.renderTabs();
      this.ws.onDirtyChanged();
    }
    if (result !== 'conflict') return result;
    const r = await dialog({
      icon: 'warning', title: `“${doc.name}” changed on ${hostLabel(doc.host)}`,
      message: 'The file was modified on the server after you opened it. Replace it with your version?',
      buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: 'Replace', value: true, kind: 'danger' }],
    });
    return r ? this.save(doc, { force: true }) : false;
  }

  /** -> true, false (failed, already reported) or 'conflict' */
  async write(doc, force) {
    this.tidy(doc);
    const version = doc.model.getAlternativeVersionId();
    const text = doc.model.getValue();
    const expect = doc.mtime != null && !doc.deleted ? { mtime: doc.mtime, size: doc.size } : null;
    try {
      const r = await this.conn(doc).call('/api/write', { body: { path: doc.path, text, bom: doc.bom, expect, force } });
      doc.mtime = r.mtime;
      doc.size = r.size;
      doc.savedVersion = version;
      doc.deleted = false;
      doc.preview = false;
      if (doc.model.getAlternativeVersionId() === version) this.clearBackup(doc);
      return true;
    } catch (e) {
      if (e.status === 409 && e.data.conflict) return 'conflict';
      toastError(`Couldn’t save “${doc.name}”`, e);
      return false;
    }
  }

  async saveAll() {
    for (const d of this.dirtyDocs()) await this.save(d);
  }

  autoSaveNow() {
    for (const d of this.dirtyDocs()) if (!d.saving && !d.readonly) this.save(d);
  }

  /** Trailing whitespace and the final newline, as Settings → Editor asks (one undo step). */
  tidy(doc) {
    const trim = settings.get('editor.trimWhitespace'), nl = settings.get('editor.finalNewline');
    if (!trim && !nl) return;
    const m = doc.model;
    const edits = [];
    const { Range } = this.monaco;
    if (trim) {
      const n = m.getLineCount();
      for (let i = 1; i <= n; i++) {
        const line = m.getLineContent(i);
        const end = line.replace(/[ \t]+$/, '').length;
        if (end < line.length) edits.push({ range: new Range(i, end + 1, i, line.length + 1), text: '' });
      }
    }
    if (nl) {
      const last = m.getLineCount();
      if (m.getLineContent(last) !== '') edits.push({ range: new Range(last, m.getLineMaxColumn(last), last, m.getLineMaxColumn(last)), text: m.getEOL() });
    }
    if (!edits.length) return;
    m.pushStackElement();
    m.pushEditOperations([], edits, () => null);
    m.pushStackElement();
  }

  toggleAutoSave() {
    const on = settings.get('editor.autoSave') === 'off';
    settings.set('editor.autoSave', on ? 'delay' : 'off');
    toast({ title: on ? 'Auto Save on' : 'Auto Save off', message: on ? 'Files save a second after you stop typing.' : '', timeout: 2200 });
  }

  /** Replace the buffer with the file on the server, keeping undo history. */
  async reload(doc) {
    const r = await this.conn(doc).call('/api/read', { query: { path: doc.path } });
    if (r.text == null) return;
    if (r.text !== doc.model.getValue()) {
      const vs = this.active === doc ? this.ed.saveViewState() : null;
      doc.model.pushStackElement();
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.text }], () => null);
      doc.model.pushStackElement();
      if (vs) this.ed.restoreViewState(vs);
    }
    doc.mtime = r.mtime;
    doc.size = r.size;
    doc.bom = !!r.bom;
    doc.deleted = false;
    doc.savedVersion = doc.model.getAlternativeVersionId();
    this.clearBackup(doc);
    this.renderTabs();
    this.ws.onDirtyChanged();
  }

  async revert(doc = this.active) {
    if (!doc || doc.kind !== 'text') return;
    if (this.isDirty(doc)) {
      const ok = await dialog({
        icon: 'warning', title: `Revert “${doc.name}”?`, message: 'Your unsaved changes will be replaced by the version on the server.',
        buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: 'Revert', value: true, kind: 'danger' }],
      });
      if (!ok) return;
    }
    try { await this.reload(doc); } catch (e) { toastError(`Couldn’t revert “${doc.name}”`, e); }
  }

  /** Pick up changes made on the server (by a build, git, another editor…). */
  async checkExternal() {
    const all = this.docs.filter(d => d.kind === 'text' && !d.saving && !d.readonly);
    for (const host of new Set(all.map(d => d.host))) {
      if (this.ws.conn(host).state !== 'ok') continue;
      const docs = all.filter(d => d.host === host);
      let stats;
      try {
        stats = (await this.ws.conn(host).call('/api/stat', { body: { paths: docs.map(d => d.path), bg: 1 } })).stats;
      } catch { continue; }
      await this.applyStats(docs, stats);
    }
  }

  async applyStats(docs, stats) {
    for (const d of docs) {
      if (!(d.path in stats)) continue;
      const s = stats[d.path];
      if (!s) { if (!d.deleted) { d.deleted = true; this.renderTabs(); } continue; }
      if (s.mtime === d.mtime && s.size === d.size) { if (d.deleted) { d.deleted = false; this.renderTabs(); } continue; }
      if (!this.isDirty(d)) {
        try { await this.reload(d); } catch { /* try again next time */ }
      }
    }
  }

  // --- hot exit -------------------------------------------------------------------------
  backupKey(doc) { return `bak:${doc.host}:${doc.path}`; }

  writeBackups() {
    for (const d of this.dirtyBackups) {
      if (!d.model || d.model.isDisposed()) continue;
      if (this.isDirty(d) && d.model.getValueLength() < BACKUP_MAX) {
        store.set(this.backupKey(d), { text: d.model.getValue(), mtime: d.mtime, size: d.size, at: Date.now() });
      } else {
        store.del(this.backupKey(d));
      }
    }
    this.dirtyBackups.clear();
  }

  clearBackup(doc) {
    this.dirtyBackups.delete(doc);
    store.del(this.backupKey(doc));
  }

  restoreBackup(doc, server) {
    const bak = store.get(this.backupKey(doc));
    if (!bak || typeof bak.text !== 'string') return;
    if (bak.text === server.text) { store.del(this.backupKey(doc)); return; }
    doc.model.pushStackElement();
    doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: bak.text }], () => null);
    doc.model.pushStackElement();
    doc.preview = false;
    const changed = bak.mtime !== server.mtime || bak.size !== server.size;
    toast({
      title: `Restored unsaved changes to “${doc.name}”`,
      message: changed ? 'The file has also changed on the server since. Undo (Ctrl+Z) returns to the server version.' : 'Undo returns to the version on the server.',
      timeout: changed ? 9000 : 4000,
    });
  }

  // --- tabs ----------------------------------------------------------------------------
  async close(doc, { force = false } = {}) {
    if (!doc) return true;
    if (!force && this.isDirty(doc)) {
      this.activate(doc);
      const r = await dialog({
        icon: 'warning', title: `Do you want to save the changes you made to “${doc.name}”?`,
        message: 'Your changes will be lost if you don’t save them.',
        buttons: [{ label: 'Save', value: 'save', kind: 'primary' }, { label: 'Don’t Save', value: 'discard' }, { label: 'Cancel', value: null, kind: 'cancel' }],
      });
      if (!r) return false;
      if (r.value === 'save' && !(await this.save(doc))) return false;
    }
    const i = this.docs.indexOf(doc);
    if (i < 0) return true;
    this.docs.splice(i, 1);
    this.clearBackup(doc);
    this.disposeDoc(doc);
    if (this.active === doc) {
      this.active = null;
      const next = this.docs[i] || this.docs[i - 1];
      if (next) this.activate(next);
      else { this.show(null); this.ws.onActiveChanged(null); }
    }
    this.renderTabs();
    this.ws.saveSession();
    this.ws.onDirtyChanged();
    return true;
  }

  async closeMany(docs) {
    for (const d of [...docs]) if (!(await this.close(d))) return false;
    return true;
  }

  disposeDoc(doc) {
    if (doc.viewCleanup) { doc.viewCleanup(); doc.viewCleanup = null; }
    doc.viewEl = null;
    if (doc.model && !doc.model.isDisposed()) {
      if (this.ed && this.ed.getModel() === doc.model) this.ed.setModel(null);
      doc.model.dispose();
    }
    doc.model = null;
  }

  renderTabs() {
    const count = new Map();
    for (const d of this.docs) count.set(d.name, (count.get(d.name) || 0) + 1);
    const multi = this.ws.multiHost();
    reconcile(this.tabsEl, this.docs.map((d, i) => {
      const home = this.ws.conn(d.host).home;
      if (!d.uid) d.uid = ++seq;
      const cls = ['tab'];
      if (d === this.active) cls.push('on');
      if (d.preview) cls.push('preview');
      d.shownDirty = this.isDirty(d);
      if (d.shownDirty) cls.push('dirty');
      const desc = count.get(d.name) > 1 ? `<span class="desc">${esc(basename(dirname(d.path)))}</span>` : '';
      const name = d.deleted ? `<s>${esc(d.name)}</s>` : esc(d.name);
      const lock = d.readonly ? `<span class="lock" title="Read-only">${icons.lock}</span>` : '';
      const where = multi ? `${hostLabel(d.host)}:` : '';
      const chip = multi && d.host !== this.ws.host ? `<span class="hchip" style="--hc:var(--${hostColor(d.host)})">${esc(hostLabel(d.host))}</span>` : '';
      return {
        key: d.uid,
        cls: cls.join(' '),
        attrs: { 'data-i': String(i), draggable: 'true', role: 'tab', 'aria-selected': String(d === this.active), title: where + tildify(d.path, home) + (d.deleted ? ' (deleted on the server)' : '') },
        html: `${fileIcon(d.name)}<span class="nm">${name}</span>${lock}${desc}${chip}<button class="x" data-x aria-label="Close">${icons.xmark}</button>`,
      };
    }), this.tabCache);
    // Scrolling forces a layout: only when another tab became active.
    if (this.active !== this.scrolledTo) {
      this.scrolledTo = this.active;
      const on = this.tabsEl.querySelector('.tab.on');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  tabMenu(x, y, doc) {
    const i = this.docs.indexOf(doc);
    contextMenu(x, y, [
      { label: 'Close', keys: 'Alt+W', action: () => this.close(doc) },
      { label: 'Close Others', disabled: this.docs.length < 2, action: () => this.closeMany(this.docs.filter(d => d !== doc)) },
      { label: 'Close to the Right', disabled: i === this.docs.length - 1, action: () => this.closeMany(this.docs.slice(i + 1)) },
      { label: 'Close Saved', action: () => this.closeMany(this.docs.filter(d => !this.isDirty(d))) },
      { label: 'Close All', action: () => this.closeMany(this.docs) },
      '-',
      ...(doc.preview ? [{ label: 'Keep Open', action: () => { doc.preview = false; this.renderTabs(); } }] : []),
      { label: 'Reveal in Sidebar', action: () => this.ws.revealInExplorer(doc.host, doc.path) },
      { label: 'Copy Path', action: () => navigator.clipboard.writeText(doc.path).catch(() => {}) },
      { label: 'Download', icon: 'download', action: () => download(fileUrl(doc.host, doc.path)) },
      ...(doc.kind === 'text' ? ['-', { label: 'Revert File', disabled: !this.isDirty(doc), action: () => this.revert(doc) }] : []),
    ]);
  }

  renderEmpty() {
    const rows = [
      ['Go to File', 'go.file'],
      ['Show All Commands', 'go.command'],
      ['Find in Files', 'view.search'],
      ['Toggle Terminal', 'view.terminal'],
      ['Go to Folder', 'file.openFolder'],
    ];
    this.emptyEl.innerHTML = `<div class="inner"><div class="mark">${appIcon}</div>${rows.map(([l, id]) =>
      `<span class="l" data-cmd="${id}">${esc(l)}</span><span class="k">${keycaps(this.ws.keysFor(id))}</span>`).join('')}</div>`;
  }

  /** Coalesce status updates (cursor moves fire on every keystroke) into one per frame. */
  statusSoon() {
    if (this.statusQueued) return;
    this.statusQueued = true;
    requestAnimationFrame(() => { this.statusQueued = false; this.updateStatus(); });
  }

  updateStatus() {
    const d = this.active;
    const s = this.status;
    const path = d ? (this.ws.multiHost() ? `${hostLabel(d.host)}: ` : '') + tildify(d.path, this.ws.conn(d.host).home) : '';
    if (s.path.dataset.p !== path) {
      s.path.dataset.p = path;
      s.path.innerHTML = d ? `<bdi>${esc(path)}</bdi>` : '';
      s.path.title = d ? d.path : '';
    }
    s.ro.hidden = !(d && d.readonly);
    if (d && d.readonly) s.ro.textContent = d.truncated ? `Read-only · first ${HEAD_BYTES / (1 << 20)} MB` : 'Read-only';
    const text = d && d.kind === 'text' && this.ed && this.ed.getModel() === d.model;
    for (const k of ['pos', 'indent', 'enc', 'eol', 'lang']) s[k].hidden = !text;
    if (!text) return;
    const model = d.model;
    const pos = this.ed.getPosition();
    const sel = this.ed.getSelection();
    const selLen = sel && !sel.isEmpty() ? model.getValueLengthInRange(sel) : 0;
    s.pos.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ''}`;
    const o = model.getOptions();
    s.indent.textContent = o.insertSpaces ? `Spaces: ${o.tabSize}` : `Tab Size: ${o.tabSize}`;
    s.enc.textContent = d.bom ? 'UTF-8 with BOM' : 'UTF-8';
    s.eol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    s.lang.textContent = languageName(model.getLanguageId());
  }

  // --- options ---------------------------------------------------------------------------
  /** Markdown wraps like prose (as in VS Code); Alt+Z flips it for that file alone. */
  wrapFor(doc) {
    if (doc && doc.wrap) return doc.wrap;
    return doc && doc.previewKind === 'markdown' ? 'on' : settings.get('editor.wordWrap');
  }

  toggleWrap() {
    const doc = this.active;
    if (doc && doc.previewKind === 'markdown') {
      doc.wrap = this.wrapFor(doc) === 'on' ? 'off' : 'on';
      if (this.ed && this.ed.getModel() === doc.model) this.ed.updateOptions({ wordWrap: doc.wrap });
      return;
    }
    settings.set('editor.wordWrap', settings.get('editor.wordWrap') === 'on' ? 'off' : 'on');
  }

  zoom(delta) {
    settings.set('editor.fontSize', delta ? Math.max(9, Math.min(28, settings.get('editor.fontSize') + delta)) : 13);
  }

  setLanguage(id) {
    if (this.active && this.active.model) this.monaco.editor.setModelLanguage(this.active.model, id);
  }

  setEOL(crlf) {
    const d = this.active;
    if (!d || !d.model) return;
    d.model.pushEOL(crlf ? this.monaco.editor.EndOfLineSequence.CRLF : this.monaco.editor.EndOfLineSequence.LF);
  }

  setIndent(spaces, size) {
    const d = this.active;
    if (d && d.model) d.model.updateOptions({ insertSpaces: spaces, tabSize: size });
  }

  editorActions() {
    if (!this.ed || !this.ed.getModel()) return [];
    return this.ed.getSupportedActions().filter(a => a.label && a.isSupported()).map(a => ({ id: 'monaco:' + a.id, title: a.label, run: () => { this.ed.focus(); a.run(); } }));
  }

  // --- explorer bookkeeping ------------------------------------------------------------------
  onRenamed(host, src, dst) {
    let changed = false;
    for (const d of this.docs) {
      if (d.host !== host || !isUnder(d.path, src)) continue;
      d.path = dst + d.path.slice(src.length);
      const name = basename(d.path);
      if (name !== d.name && d.model && extname(name) !== extname(d.name)) {
        this.monaco.editor.setModelLanguage(d.model, languageFor(name, ''));
      }
      d.name = name;
      changed = true;
      if (d.model) {
        // Backups are keyed by path: move this one to the new name.
        store.del(`bak:${host}:${src + d.path.slice(dst.length)}`);
        this.dirtyBackups.add(d);
        this.saveBackups();
      }
    }
    if (changed) {
      this.renderTabs();
      this.updateStatus();
      this.ws.onActiveChanged(this.active);
      this.ws.saveSession();
    }
  }

  onDeleted(host, paths) {
    let changed = false;
    for (const d of this.docs) {
      if (d.host === host && paths.some(p => isUnder(d.path, p))) { d.deleted = true; changed = true; }
    }
    if (changed) this.renderTabs();
  }

  // --- session ----------------------------------------------------------------------------------
  serialize() {
    const own = h => (h === this.ws.host ? undefined : h);
    return {
      tabs: this.docs.map(d => ({ path: d.path, host: own(d.host), preview: !!d.preview, view: d.previewKind ? d.view : undefined })),
      active: this.activePath,
      activeHost: this.active ? own(this.active.host) : undefined,
    };
  }

  restore(session) {
    if (!session || !Array.isArray(session.tabs)) return;
    for (const t of session.tabs.slice(0, 40)) {
      const host = typeof t.host === 'string' ? t.host : this.ws.host;
      if (typeof t.path !== 'string' || this.find(host, t.path)) continue;
      this.docs.push({ host, path: t.path, name: basename(t.path), kind: 'pending', preview: !!t.preview, savedView: t.view });
    }
    // Tabs holding unsaved edits load now so their dirty dot shows.
    for (const d of this.docs) if (store.get(this.backupKey(d))) this.load(d);
    const active = this.find(session.activeHost || this.ws.host, session.active) || this.docs[0];
    if (active) this.activate(active, { focus: false });
    this.renderTabs();
  }

  // --- events --------------------------------------------------------------------------------------
  bind() {
    const tabs = this.tabsEl;
    const docAt = el => this.docs[+el.closest('[data-i]').dataset.i];
    tabs.addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      if (e.target.closest('[data-x]')) { e.stopPropagation(); this.close(docAt(t)); return; }
      this.activate(docAt(t));
    });
    tabs.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    tabs.addEventListener('auxclick', e => {
      const t = e.target.closest('.tab');
      if (t && e.button === 1) { e.preventDefault(); this.close(docAt(t)); }
    });
    tabs.addEventListener('dblclick', e => {
      const t = e.target.closest('.tab');
      if (t) { docAt(t).preview = false; this.renderTabs(); }
    });
    tabs.addEventListener('contextmenu', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      e.preventDefault();
      this.tabMenu(e.clientX, e.clientY, docAt(t));
    });
    tabs.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabs.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    // drag to reorder
    let dragFrom = -1;
    tabs.addEventListener('dragstart', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      dragFrom = +t.dataset.i;
      t.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.docs[dragFrom].path);
    });
    tabs.addEventListener('dragover', e => {
      if (dragFrom < 0) return;
      e.preventDefault();
      tabs.querySelectorAll('.drop-before').forEach(n => n.classList.remove('drop-before'));
      const t = e.target.closest('.tab');
      if (t) t.classList.add('drop-before');
    });
    tabs.addEventListener('drop', e => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const t = e.target.closest('.tab');
      const to = t ? +t.dataset.i : this.docs.length;
      const [d] = this.docs.splice(dragFrom, 1);
      this.docs.splice(to > dragFrom ? to - 1 : to, 0, d);
      dragFrom = -1;
      this.renderTabs();
      this.ws.saveSession();
    });
    tabs.addEventListener('dragend', () => { dragFrom = -1; this.renderTabs(); });

    this.el.querySelector('.tab-acts').addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'folders') this.ws.run('view.folders');
      else if (a === 'quick') this.ws.run('go.file');
      else if (a === 'terminal') this.ws.run('view.terminal');
      else if (a === 'more') { const r = b.getBoundingClientRect(); this.ws.moreMenu(r.right - 220, r.bottom + 6); }
    });
    this.viewSeg.addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) this.setView(this.active, b.dataset.view);
    });
    this.bindDivider();
    this.el.querySelector('.side-toggle').addEventListener('click', () => this.ws.run('view.sidebar'));
    const body = this.el.querySelector('.editor-body');
    body.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault(); });
    body.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      body.classList.add('drop');
    });
    body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) body.classList.remove('drop'); });
    body.addEventListener('drop', e => {
      body.classList.remove('drop');
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      let p;
      try { p = JSON.parse(raw); } catch { return; }
      const files = (p.items || []).filter(i => !i.isDir).slice(0, 20);
      files.forEach((i, n) => this.open(i.path, { host: i.host, preview: false, focus: n === files.length - 1 }));
    });
    this.emptyEl.addEventListener('click', e => {
      const l = e.target.closest('[data-cmd]');
      if (l) this.ws.run(l.dataset.cmd);
    });
    this.el.querySelector('.status').addEventListener('click', e => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const r = b.getBoundingClientRect();
      const s = b.dataset.s;
      if (s === 'pos') this.ws.run('go.line');
      else if (s === 'lang') this.ws.run('editor.language');
      else if (s === 'eol') contextMenu(r.left, r.top - 70, [
        { label: 'LF', action: () => this.setEOL(false) }, { label: 'CRLF', action: () => this.setEOL(true) }]);
      else if (s === 'indent') contextMenu(r.left, r.top - 180, [
        ...[2, 4, 8].map(n => ({ label: `Indent Using Spaces: ${n}`, action: () => this.setIndent(true, n) })), '-',
        ...[2, 4, 8].map(n => ({ label: `Indent Using Tabs: ${n}`, action: () => this.setIndent(false, n) })),
      ]);
      else if (s === 'enc' && this.active) contextMenu(r.left, r.top - 70, [
        { label: 'UTF-8', action: () => { this.active.bom = false; this.save(); } },
        { label: 'UTF-8 with BOM', action: () => { this.active.bom = true; this.save(); } },
      ]);
    });
  }
}
