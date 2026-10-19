// Line icons drawn in the spirit of SF Symbols (24×24, 1.7 stroke, round
// joins) plus the colour used to tint each file type.
import { extname } from './util.js';

const line = inner => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const solid = inner => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${inner}</svg>`;

const DOC = 'M13.5 3H7.25C6 3 5 4 5 5.25v13.5C5 20 6 21 7.25 21h9.5C18 21 19 20 19 18.75V8.5z';
const FOLD = 'M13.5 3v3.75c0 .97.78 1.75 1.75 1.75H19';
const TRAY = 'M4.5 14.5v2.75C4.5 18.77 5.73 20 7.25 20h9.5c1.52 0 2.75-1.23 2.75-2.75V14.5';

export const icons = {
  sidebar: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M9.5 4.5v15M5.9 8.4h1.3M5.9 11h1.3"/>'),
  folder: solid('<path d="M2.5 7.4C2.5 6.07 3.57 5 4.9 5h3.66c.64 0 1.25.28 1.67.76l1.12 1.29h7.75c1.33 0 2.4 1.07 2.4 2.4v8.15c0 1.33-1.07 2.4-2.4 2.4H4.9c-1.33 0-2.4-1.07-2.4-2.4z"/>'),
  folderLine: line('<path d="M3 7.4C3 6.3 3.9 5.5 5 5.5h3.5c.6 0 1.1.25 1.5.7l1.1 1.3H19c1.1 0 2 .9 2 2v7.9c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2z"/>'),
  file: line(`<path d="${DOC}"/><path d="${FOLD}"/>`),
  fileText: line(`<path d="${DOC}"/><path d="${FOLD}"/><path d="M8.5 12.5h7M8.5 16h5"/>`),
  chevronRight: line('<path d="m9.5 6 6 6-6 6"/>'),
  chevronDown: line('<path d="m6 9.5 6 6 6-6"/>'),
  chevronUp: line('<path d="m6 14.5 6-6 6 6"/>'),
  chevronLeft: line('<path d="m14.5 6-6 6 6 6"/>'),
  plus: line('<path d="M12 5v14M5 12h14"/>'),
  xmark: line('<path d="M7 7l10 10M17 7 7 17"/>'),
  ellipsis: solid('<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>'),
  search: line('<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.5 15.5 4.75 4.75"/>'),
  terminal: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.75 14.5h3.75"/>'),
  refresh: line('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
  newFile: line(`<path d="M12 21H7.25C6 21 5 20 5 18.75V5.25C5 4 6 3 7.25 3h6.25L19 8.5V12"/><path d="${FOLD}"/><path d="M17.5 15v6M14.5 18h6"/>`),
  newFolder: line('<path d="M11.5 19.5H5c-1.1 0-2-.9-2-2V7.4C3 6.3 3.9 5.5 5 5.5h3.5c.6 0 1.1.25 1.5.7l1.1 1.3H19c1.1 0 2 .9 2 2V12"/><path d="M17.5 14.5v6M14.5 17.5h6"/>'),
  collapse: line('<path d="m8 4.5 4 4 4-4M8 19.5l4-4 4 4"/>'),
  upload: line(`<path d="M12 15.5V4.5M7.75 8.75 12 4.5l4.25 4.25"/><path d="${TRAY}"/>`),
  download: line(`<path d="M12 4.5v11M7.75 11.25 12 15.5l4.25-4.25"/><path d="${TRAY}"/>`),
  trash: line('<path d="M4.5 6.5h15M9.5 6.5V5c0-.83.67-1.5 1.5-1.5h2c.83 0 1.5.67 1.5 1.5v1.5M6.5 6.5l.85 11.6A2 2 0 0 0 9.34 20h5.32a2 2 0 0 0 2-1.9l.84-11.6M10 10.5v6M14 10.5v6"/>'),
  pencil: line('<path d="M4.5 19.5h3.75L18.9 8.85a2.65 2.65 0 0 0-3.75-3.75L4.5 15.75z"/><path d="m13.75 6.5 3.75 3.75"/>'),
  copy: line('<rect x="8.5" y="8.5" width="12" height="12" rx="2.75"/><path d="M15.5 8.5V6.25c0-1.52-1.23-2.75-2.75-2.75h-6.5C4.73 3.5 3.5 4.73 3.5 6.25v6.5c0 1.52 1.23 2.75 2.75 2.75H8.5"/>'),
  scissors: line('<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4 19.5 18M8.6 15.6 19.5 6"/>'),
  clipboard: line('<rect x="5" y="4.5" width="14" height="16" rx="2.5"/><path d="M9 4.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/>'),
  server: line('<rect x="3.5" y="4" width="17" height="7" rx="2.25"/><rect x="3.5" y="13" width="17" height="7" rx="2.25"/><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5.5M11 16.5h5.5"/>'),
  power: line('<path d="M12 3.75v7.5"/><path d="M7 6.75a7.25 7.25 0 1 0 10 0"/>'),
  sun: line('<circle cx="12" cy="12" r="3.75"/><path d="M12 3v1.75M12 19.25V21M3 12h1.75M19.25 12H21M5.64 5.64l1.24 1.24M17.12 17.12l1.24 1.24M5.64 18.36l1.24-1.24M17.12 6.88l1.24-1.24"/>'),
  moon: line('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  halfCircle: line('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  lock: line('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.75a3.5 3.5 0 0 1 7 0v2.75"/>'),
  key: line('<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 7.6-7.6M16.5 6.5l2 2M14 9l1.5 1.5"/>'),
  shield: line('<path d="M12 3.5 5 6v5.5c0 4.1 2.9 7.6 7 9 4.1-1.4 7-4.9 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  check: line('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  maximize: line('<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6.25 6.25M4.5 19.5l6.25-6.25"/>'),
  minimize: line('<path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l6-6M10 14l-6 6"/>'),
  globe: line('<circle cx="12" cy="12" r="8.25"/><path d="M3.75 12h16.5M12 3.75c2.25 2.3 3.4 5.05 3.4 8.25s-1.15 5.95-3.4 8.25C9.75 17.95 8.6 15.2 8.6 12s1.15-5.95 3.4-8.25z"/>'),
  clock: line('<circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 2"/>'),
  image: line('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17.5 4.5-4.5 3.5 3.5 2.5-2.5 5.5 5"/>'),
  link: line('<path d="M10 14a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66L11.5 6.84"/><path d="M14 10a4 4 0 0 0-5.66 0l-2.83 2.83a4 4 0 0 0 5.66 5.66l1.33-1.33"/>'),
  command: line('<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15zm0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9z"/>'),
  warning: line('<path d="M10.3 4.9a2 2 0 0 1 3.4 0l7.1 12.2a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4M12 16.75h.01"/>'),
  info: line('<circle cx="12" cy="12" r="8.25"/><path d="M12 11v5M12 8h.01"/>'),
  eye: line('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  wrap: line('<path d="M4 6.5h16M4 12h13a3 3 0 0 1 0 6h-4M4 17.5h5"/><path d="m14.5 15.5-2 2.5 2 2.5"/>'),
  textSize: line('<path d="M3.5 18 8 6l4.5 12M5.2 13.5h5.6M14 18l3-7.5 3 7.5M15 15.5h4"/>'),
  folderOpen: line('<path d="M3 17.5V7.4C3 6.3 3.9 5.5 5 5.5h3.5c.6 0 1.1.25 1.5.7l1.1 1.3H17c1.1 0 2 .9 2 2v1"/><path d="M3 17.5 5.6 11.2c.3-.7 1-1.2 1.8-1.2H20c.9 0 1.6.9 1.3 1.8l-2 6c-.3.8-1 1.2-1.8 1.2H5c-1.1 0-2-.9-2-2z"/>'),
  back: line('<path d="M10 5.5 3.5 12l6.5 6.5M4 12h16.5"/>'),
  alias: line('<path d="M8 16 16 8M9.5 8H16v6.5"/>'),
  code: line('<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>'),
  music: line('<path d="M9 18.25V6.5l10-2.25v12"/><circle cx="6.75" cy="18.25" r="2.25"/><circle cx="16.75" cy="16.25" r="2.25"/>'),
  film: line('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>'),
  home: line('<path d="M3.5 11 12 4l8.5 7"/><path d="M5.75 9.25v9.25c0 .83.67 1.5 1.5 1.5H10.5v-5.25h3V20h3.25c.83 0 1.5-.67 1.5-1.5V9.25"/>'),
  arrowUp: line('<path d="M12 19.5V5M6 10.75 12 4.75l6 6"/>'),
  upDown: line('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>'),
  // A gear: the teeth are a dashed ring around the body.
  gear: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="8.1" stroke-width="2.6" stroke-dasharray="2.55 3.81"/><circle cx="12" cy="12" r="6.2" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" stroke-width="1.7"/></svg>`,
  split: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M12 4.5v15"/>'),
  splitDown: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M3 12h18"/>'),
  panelRight: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M14.5 4.5v15"/>'),
  panelBottom: line('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M3 14h18"/>'),
  transfer: line('<path d="M8 19.5V5M4.25 8.75 8 5l3.75 3.75M16 4.5V19M12.25 15.25 16 19l3.75-3.75"/>'),
  serverPlus: line('<rect x="3.5" y="4" width="17" height="7" rx="2.25"/><path d="M11 20H5.75a2.25 2.25 0 0 1-2.25-2.25v-2.5A2.25 2.25 0 0 1 5.75 13H13"/><path d="M7.5 7.5h.01M11 7.5h5.5M18 14.5v6M15 17.5h6"/>'),
  keyboard: line('<rect x="2.5" y="6" width="19" height="12" rx="2.75"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>'),
  palette: line('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.75-.75 1.75-1.6 0-.45-.2-.8-.45-1.1-.25-.3-.42-.62-.42-1.05 0-.9.72-1.6 1.62-1.6H16.5a4 4 0 0 0 4-4c0-4.2-3.8-7.65-8.5-7.65z"/><circle cx="7.75" cy="11.5" r="1.1"/><circle cx="10.5" cy="7.6" r="1.1"/><circle cx="15" cy="8.2" r="1.1"/>'),
  grip: solid('<circle cx="9" cy="7" r="1.4"/><circle cx="15" cy="7" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="17" r="1.4"/><circle cx="15" cy="17" r="1.4"/>'),
  stop: line('<circle cx="12" cy="12" r="8.25"/><path d="m9.25 9.25 5.5 5.5M14.75 9.25l-5.5 5.5"/>'),
  arrowRight: line('<path d="M4.5 12h14.5M13.25 6 19.25 12l-6 6"/>'),
  sliders: line('<path d="M4 7h9.5M17.5 7H20M4 12h2.5M10.5 12H20M4 17h11M19 17h1"/><circle cx="15.5" cy="7" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  tag: solid('<circle cx="12" cy="12" r="6"/>'),
  slides: line('<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M12 16.5v3.5M8.5 20h7"/>'),
  play: solid('<path d="M8.5 5.6c0-.8.87-1.3 1.56-.88l9.06 5.72c.63.4.63 1.32 0 1.72l-9.06 5.72c-.69.43-1.56-.07-1.56-.88z"/>'),
  notes: line('<rect x="4.5" y="3.5" width="15" height="17" rx="2.75"/><path d="M8.25 8.5h7.5M8.25 12h7.5M8.25 15.5h4.5"/>'),
  minus: line('<path d="M5.5 12h13"/>'),
  grid: line('<rect x="4" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75"/>'),
  list: line('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.4"/>'),
  forward: line('<path d="m14.5 6 6 6-6 6M20 12H3.5"/>'),
};

/** The app icon: a glassy blue squircle with a prompt. */
export const appIcon = `<svg class="app-icon" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="ai-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6fd0ff"/><stop offset=".5" stop-color="#1a86ff"/><stop offset="1" stop-color="#5b4df2"/></linearGradient>
    <linearGradient id="ai-s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".25"/></linearGradient>
    <radialGradient id="ai-h" cx=".3" cy=".1" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="15" fill="url(#ai-g)"/>
  <rect x="3" y="3" width="58" height="58" rx="15" fill="url(#ai-h)"/>
  <rect x="3.6" y="3.6" width="56.8" height="56.8" rx="14.4" fill="none" stroke="url(#ai-s)" stroke-width="1.2"/>
  <path d="M19.5 23.5 28 32l-8.5 8.5" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M32.5 41h12" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>
</svg>`;

// --- file types ---------------------------------------------------------------
const TINT = {
  yellow: 'js mjs cjs json jsonc json5 jsonl env',
  cyan: 'jsx tsx dart',
  blue: 'ts mts cts py pyi pyw md mdx markdown css lua r dockerfile ps1 rst',
  orange: 'rs swift html htm xml svelte ipynb zig mp3 wav flac ogg oga m4a aac opus weba pptx pptm ppsx ppsm potx potm ppt pps key odp',
  red: 'rb java scala pdf erb',
  teal: 'go tex bib sty cls',
  indigo: 'c h cc cpp cxx hpp hh m mm php cs less',
  green: 'sh bash zsh fish vue csv tsv cu cuh nix',
  purple: 'kt kts jl ex exs hs elm clj graphql gql proto',
  pink: 'yaml yml scss sass sql prisma mp4 m4v webm mov ogv mkv',
  brown: 'toml lock makefile mk cmake gradle zip tar gz tgz bz2 xz 7z rar zst db sqlite parquet whl jar',
  gray: 'txt log ini cfg conf properties gitignore gitattributes editorconfig license out',
};
const TINT_OF = {};
for (const [color, exts] of Object.entries(TINT)) for (const e of exts.split(' ')) TINT_OF[e] = color;

const IMAGE = new Set('png jpg jpeg gif webp bmp ico avif svg'.split(' '));
export const isImage = name => IMAGE.has(extname(name));

// How a file opens when it isn't plain text for the editor.
const MEDIA = {
  image: 'png jpg jpeg gif webp bmp ico avif',
  pdf: 'pdf',
  video: 'mp4 m4v webm mov ogv mkv',
  audio: 'mp3 wav flac ogg oga m4a aac opus weba',
  slides: 'pptx pptm ppsx ppsm potx potm ppt pps pot',
};
const MEDIA_OF = {};
for (const [kind, exts] of Object.entries(MEDIA)) for (const e of exts.split(' ')) MEDIA_OF[e] = kind;
export const mediaKind = name => MEDIA_OF[extname(name)] || null;

/** Text files that also have a rendered view. */
export function previewKind(name) {
  const e = extname(name);
  if (e === 'md' || e === 'markdown' || e === 'mdx') return 'markdown';
  if (e === 'ipynb') return 'notebook';
  if (e === 'svg') return 'svg';
  return null;
}

const SPECIAL = { dockerfile: 'dockerfile', makefile: 'makefile', license: 'license', 'license.md': 'license', '.gitignore': 'gitignore', '.env': 'env', 'cmakelists.txt': 'cmake', 'gemfile': 'rb', 'rakefile': 'rb', 'vagrantfile': 'rb', 'jenkinsfile': 'gradle', 'procfile': 'conf' };

export function fileTint(name) {
  const low = name.toLowerCase();
  const key = SPECIAL[low] || (low.startsWith('.env') ? 'env' : extname(low));
  if (IMAGE.has(key)) return 'purple';
  return TINT_OF[key] || 'gray';
}

export function fileIcon(name) {
  const tint = fileTint(name);
  const kind = mediaKind(name);
  const svg = isImage(name) ? icons.image : kind === 'video' ? icons.film : kind === 'audio' ? icons.music : kind === 'slides' ? icons.slides : icons.fileText;
  return `<span class="ic t-${tint}">${svg}</span>`;
}

export const folderIcon = () => `<span class="ic folder">${icons.folder}</span>`;
