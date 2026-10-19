// What the folder view and Quick Look say about a file: its kind in words,
// its date the way Finder writes it, and big folder and document icons.
import { esc, extname } from './util.js';
import { icons, fileTint, mediaKind, isImage } from './icons.js';

export const isDirType = t => t === 'dir' || t === 'linkdir';

const KINDS = {
  py: 'Python script', js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript (React)', jsx: 'JavaScript (React)',
  json: 'JSON', jsonl: 'JSON Lines', md: 'Markdown document', txt: 'Plain text', log: 'Log file', csv: 'CSV table', tsv: 'TSV table',
  html: 'HTML page', css: 'Stylesheet', sh: 'Shell script', bash: 'Shell script', zsh: 'Shell script', c: 'C source', h: 'C header',
  cpp: 'C++ source', hpp: 'C++ header', cu: 'CUDA source', rs: 'Rust source', go: 'Go source', java: 'Java source', rb: 'Ruby script',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'Settings', cfg: 'Settings', conf: 'Settings', xml: 'XML document', sql: 'SQL',
  ipynb: 'Jupyter notebook', pdf: 'PDF document', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image',
  webp: 'WebP image', svg: 'SVG image', bmp: 'BMP image', avif: 'AVIF image', ico: 'Icon', mp4: 'MPEG-4 movie', mov: 'QuickTime movie',
  webm: 'WebM movie', mkv: 'Matroska movie', mp3: 'MP3 audio', wav: 'WAV audio', flac: 'FLAC audio', m4a: 'MPEG-4 audio', ogg: 'Ogg audio',
  pptx: 'PowerPoint presentation', ppt: 'PowerPoint 97 presentation', docx: 'Word document', doc: 'Word 97 document', xlsx: 'Excel workbook',
  zip: 'ZIP archive', tar: 'Tar archive', gz: 'Gzip archive', tgz: 'Gzip tar archive', bz2: 'Bzip2 archive', xz: 'XZ archive', '7z': '7-Zip archive',
  pt: 'PyTorch weights', pth: 'PyTorch weights', ckpt: 'Checkpoint', safetensors: 'Safetensors weights', npy: 'NumPy array', npz: 'NumPy arrays',
  pkl: 'Pickle', parquet: 'Parquet table', h5: 'HDF5 data', tex: 'LaTeX document', bib: 'BibTeX', lock: 'Lock file', env: 'Environment',
};

export function kindOf(e) {
  if (isDirType(e.type)) return e.type === 'linkdir' ? 'Folder (alias)' : 'Folder';
  if (e.type === 'broken') return 'Broken alias';
  const x = extname(e.name);
  if (KINDS[x]) return KINDS[x] + (e.type === 'link' ? ' (alias)' : '');
  if (!x && e.perm != null && e.perm & 0o111) return 'Executable';
  return x ? `${x.toUpperCase()} file` : 'Document';
}

const dayMs = 86400000;
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t * 1000), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return `Today at ${fmtTime.format(d)}`;
  if (d.getTime() >= start - dayMs) return `Yesterday at ${fmtTime.format(d)}`;
  return `${fmtDay.format(d)} at ${fmtTime.format(d)}`;
}

/** A folder, drawn the macOS way (tinted with the accent colour). */
export function bigFolder(link) {
  return `<svg class="fv-glyph" viewBox="0 0 64 64" aria-hidden="true"><path d="M5 15.5A4.5 4.5 0 0 1 9.5 11h14.7c1.2 0 2.4.5 3.2 1.4l3 3.1h24.1a4.5 4.5 0 0 1 4.5 4.5v29.5a4.5 4.5 0 0 1-4.5 4.5h-45A4.5 4.5 0 0 1 5 49.5z" class="fb"/><path d="M5 22.5A4.5 4.5 0 0 1 9.5 18h45a4.5 4.5 0 0 1 4.5 4.5v27a4.5 4.5 0 0 1-4.5 4.5h-45A4.5 4.5 0 0 1 5 49.5z" class="ff"/>${link ? '<path d="M44 46h8v-8M52 46l-9-9" class="fl"/>' : ''}</svg>`;
}

/** A document: a page with its corner folded and its extension on a coloured band. */
export function bigDoc(name) {
  const x = extname(name).slice(0, 5).toUpperCase();
  const tint = fileTint(name);
  const kind = mediaKind(name);
  const glyph = kind === 'video' ? icons.film : kind === 'audio' ? icons.music : kind === 'slides' ? icons.slides : isImage(name) ? icons.image : '';
  return `<svg class="fv-glyph fv-doc" viewBox="0 0 64 64" aria-hidden="true" style="--tint: var(--${tint})"><path d="M15 4.5h23.6c.9 0 1.8.4 2.5 1l10.4 10.4c.7.7 1 1.6 1 2.5V55a4.5 4.5 0 0 1-4.5 4.5h-33A4.5 4.5 0 0 1 10.5 55V9A4.5 4.5 0 0 1 15 4.5z" class="pg"/><path d="M38.5 4.8v9.7a4 4 0 0 0 4 4h9.7" class="fold"/>${x ? `<rect x="14" y="38" width="36" height="13" rx="3" class="band"/><text x="32" y="47.6" text-anchor="middle" class="ext">${esc(x)}</text>` : ''}</svg>${glyph ? `<span class="fv-badge" style="--tint: var(--${tint})">${glyph}</span>` : ''}`;
}
