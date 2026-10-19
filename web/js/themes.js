// Editor and terminal colour themes. Each family has a light and a dark
// variant (the app's appearance picks one, or Settings pins it): a background,
// syntax colours and the 16 terminal colours. Monaco's and xterm's themes are
// derived from these plus the accent colour (cursor and selection), so the
// whole window follows one accent.

// syntax keys: plain comment string number keyword preproc type decl
// declOther func projFunc attr url regexp
const ANSI = 'black red green yellow blue magenta cyan white brightBlack brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite'.split(' ');

export const FAMILIES = [
  {
    id: 'xcode', name: 'Xcode',
    dark: {
      bg: '#16171d', fg: '#dfdfe0',
      syntax: { plain: 'dfdfe0', comment: '7f8c98', string: 'fc6a5d', number: 'd0bf69', keyword: 'fc5fa3', preproc: 'fd8f3f', type: 'd0a8ff', decl: '5dd8ff', declOther: '41a1c0', func: 'a167e6', projFunc: '67b7a4', attr: 'bf8555', url: '5482ff', regexp: 'ff8170' },
      ansi: ['#1c1c1e', '#ff453a', '#30d158', '#ffd60a', '#0a84ff', '#bf5af2', '#64d2ff', '#d1d1d6', '#8e8e93', '#ff6961', '#4ae17a', '#ffe066', '#409cff', '#da8fff', '#8de2ff', '#ffffff'],
      termFg: '#e6e6e8',
    },
    light: {
      bg: '#ffffff', fg: '#1d1d1f',
      syntax: { plain: '1d1d1f', comment: '707f8c', string: 'c41a16', number: '1c00cf', keyword: '9b2393', preproc: '643820', type: '3900a0', decl: '0b4f79', declOther: '0f68a0', func: '6c36a9', projFunc: '326d74', attr: '815f03', url: '0e0eff', regexp: 'c41a16' },
      ansi: ['#1d1d1f', '#d70015', '#248a3d', '#a05a00', '#0040dd', '#8944ab', '#0071a4', '#8e8e93', '#6c6c70', '#ff3b30', '#2fa84f', '#c27c00', '#007aff', '#af52de', '#1a98c9', '#aeaeb2'],
    },
  },
  {
    id: 'github', name: 'GitHub',
    dark: {
      bg: '#0d1117', fg: '#e6edf3',
      syntax: { plain: 'e6edf3', comment: '8b949e', string: 'a5d6ff', number: '79c0ff', keyword: 'ff7b72', preproc: 'ff7b72', type: 'ffa657', decl: '7ee787', declOther: '79c0ff', func: '79c0ff', projFunc: 'ffa657', attr: '79c0ff', url: 'a5d6ff', regexp: '7ee787' },
      ansi: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'],
    },
    light: {
      bg: '#ffffff', fg: '#1f2328',
      syntax: { plain: '1f2328', comment: '59636e', string: '0a3069', number: '0550ae', keyword: 'cf222e', preproc: 'cf222e', type: '953800', decl: '116329', declOther: '0550ae', func: '0550ae', projFunc: '953800', attr: '0550ae', url: '0a3069', regexp: '116329' },
      ansi: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
    },
  },
  {
    id: 'one', name: 'One',
    dark: {
      bg: '#282c34', fg: '#abb2bf',
      syntax: { plain: 'abb2bf', comment: '7f848e', string: '98c379', number: 'd19a66', keyword: 'c678dd', preproc: 'e5c07b', type: 'e5c07b', decl: 'e06c75', declOther: 'e06c75', func: 'd19a66', projFunc: 'e06c75', attr: 'd19a66', url: '61afef', regexp: '56b6c2' },
      ansi: ['#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0', '#4f5666', '#be5046', '#a5e075', '#f0a45d', '#4dc4ff', '#de73ff', '#4cd1e0', '#e6e6e6'],
    },
    light: {
      bg: '#fafafa', fg: '#383a42',
      syntax: { plain: '383a42', comment: 'a0a1a7', string: '50a14f', number: '986801', keyword: 'a626a4', preproc: 'c18401', type: 'c18401', decl: 'e45649', declOther: 'e45649', func: '986801', projFunc: 'e45649', attr: '986801', url: '4078f2', regexp: '0184bc' },
      ansi: ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7', '#4f525e', '#e06c75', '#3e953a', '#986801', '#2c6bed', '#9c27b0', '#0997b3', '#696c77'],
    },
  },
  {
    id: 'solarized', name: 'Solarized',
    dark: {
      bg: '#002b36', fg: '#93a1a1',
      syntax: { plain: '93a1a1', comment: '657b83', string: '2aa198', number: 'd33682', keyword: '859900', preproc: 'cb4b16', type: 'b58900', decl: '268bd2', declOther: '268bd2', func: '6c71c4', projFunc: '268bd2', attr: 'b58900', url: '268bd2', regexp: 'dc322f' },
      ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3'],
    },
    light: {
      bg: '#fdf6e3', fg: '#586e75',
      syntax: { plain: '586e75', comment: '93a1a1', string: '2aa198', number: 'd33682', keyword: '859900', preproc: 'cb4b16', type: 'b58900', decl: '268bd2', declOther: '268bd2', func: '6c71c4', projFunc: '268bd2', attr: 'b58900', url: '268bd2', regexp: 'dc322f' },
      ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#93a1a1', '#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#002b36'],
    },
  },
  {
    id: 'catppuccin', name: 'Catppuccin',
    dark: {
      bg: '#1e1e2e', fg: '#cdd6f4',
      syntax: { plain: 'cdd6f4', comment: '9399b2', string: 'a6e3a1', number: 'fab387', keyword: 'cba6f7', preproc: 'f5c2e7', type: 'f9e2af', decl: '89b4fa', declOther: '89b4fa', func: 'fab387', projFunc: 'f2cdcd', attr: 'f9e2af', url: 'f5e0dc', regexp: 'f5c2e7' },
      ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
    },
    light: {
      bg: '#eff1f5', fg: '#4c4f69',
      syntax: { plain: '4c4f69', comment: '7c7f93', string: '40a02b', number: 'fe640b', keyword: '8839ef', preproc: 'ea76cb', type: 'df8e1d', decl: '1e66f5', declOther: '1e66f5', func: 'fe640b', projFunc: 'dd7878', attr: 'df8e1d', url: 'dc8a78', regexp: 'ea76cb' },
      ansi: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
    },
  },
  {
    id: 'gruvbox', name: 'Gruvbox',
    dark: {
      bg: '#282828', fg: '#ebdbb2',
      syntax: { plain: 'ebdbb2', comment: '928374', string: 'b8bb26', number: 'd3869b', keyword: 'fb4934', preproc: '8ec07c', type: 'fabd2f', decl: '83a598', declOther: '83a598', func: 'd3869b', projFunc: '83a598', attr: 'fabd2f', url: '83a598', regexp: 'fe8019' },
      ansi: ['#3c3836', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
    },
    light: {
      bg: '#fbf1c7', fg: '#3c3836',
      syntax: { plain: '3c3836', comment: '928374', string: '79740e', number: '8f3f71', keyword: '9d0006', preproc: '427b58', type: 'b57614', decl: '076678', declOther: '076678', func: '8f3f71', projFunc: '076678', attr: 'b57614', url: '076678', regexp: 'af3a03' },
      ansi: ['#3c3836', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#282828'],
    },
  },
  {
    id: 'nord', name: 'Nord',
    dark: {
      bg: '#2e3440', fg: '#d8dee9',
      syntax: { plain: 'd8dee9', comment: '7b88a1', string: 'a3be8c', number: 'b48ead', keyword: '81a1c1', preproc: '5e81ac', type: '8fbcbb', decl: '81a1c1', declOther: '8fbcbb', func: '88c0d0', projFunc: 'd8dee9', attr: '8fbcbb', url: '88c0d0', regexp: 'ebcb8b' },
      ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
    },
    light: {
      bg: '#eceff4', fg: '#2e3440',
      syntax: { plain: '2e3440', comment: '6f7b91', string: '4d7a3a', number: '8a5a87', keyword: '3d6a9e', preproc: '5e81ac', type: '2f7a78', decl: '3d6a9e', declOther: '2f7a78', func: '2b7a8f', projFunc: '2e3440', attr: '2f7a78', url: '2b7a8f', regexp: '9a6f1e' },
      ansi: ['#3b4252', '#bf616a', '#5f8a4a', '#b3862b', '#5e81ac', '#9a6b94', '#3f8d9e', '#6b7385', '#4c566a', '#a8505a', '#4d7a3a', '#9a6f1e', '#3d6a9e', '#8a5a87', '#2b7a8f', '#2e3440'],
    },
  },
  {
    id: 'dracula', name: 'Dracula',
    dark: {
      bg: '#282a36', fg: '#f8f8f2',
      syntax: { plain: 'f8f8f2', comment: '6272a4', string: 'f1fa8c', number: 'bd93f9', keyword: 'ff79c6', preproc: 'ff79c6', type: '8be9fd', decl: 'ff79c6', declOther: '8be9fd', func: 'bd93f9', projFunc: 'ffb86c', attr: '50fa7b', url: '8be9fd', regexp: 'ff5555' },
      ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
    },
    light: {
      bg: '#fffbeb', fg: '#1f1f1f',
      syntax: { plain: '1f1f1f', comment: '6c664b', string: '846e15', number: '644ac9', keyword: 'a3144d', preproc: 'a3144d', type: '036a96', decl: 'a3144d', declOther: '036a96', func: '644ac9', projFunc: 'a34d14', attr: '14710a', url: '036a96', regexp: 'cb3a2a' },
      ansi: ['#1f1f1f', '#cb3a2a', '#14710a', '#846e15', '#644ac9', '#a3144d', '#036a96', '#6c664b', '#57534a', '#d74c3d', '#198d0c', '#9e841a', '#7862d0', '#bf185a', '#047fb4', '#2c2b31'],
    },
  },
];

// Apple's accent colours: [dark, light] for the colour and for text drawn in it.
export const ACCENTS = {
  blue: { name: 'Blue', dark: '#0a84ff', light: '#007aff' },
  purple: { name: 'Purple', dark: '#bf5af2', light: '#a550d6' },
  pink: { name: 'Pink', dark: '#ff375f', light: '#f0265a' },
  red: { name: 'Red', dark: '#ff453a', light: '#ff3b30' },
  orange: { name: 'Orange', dark: '#ff9f0a', light: '#f08700' },
  yellow: { name: 'Yellow', dark: '#ffd60a', light: '#e0a800' },
  green: { name: 'Green', dark: '#30d158', light: '#28b14c' },
  graphite: { name: 'Graphite', dark: '#98989d', light: '#8e8e93' },
};

export const family = id => FAMILIES.find(f => f.id === id) || FAMILIES[0];
export const accentColor = (id, dark) => (ACCENTS[id] || ACCENTS.blue)[dark ? 'dark' : 'light'];

// --- colour maths ---------------------------------------------------------------
const hex = c => c.replace('#', '');
const rgb = c => { const h = hex(c); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const toHex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
export const alpha = (c, a) => '#' + hex(c).slice(0, 6) + Math.round(a * 255).toString(16).padStart(2, '0');

function rules(c) {
  return [
    { token: '', foreground: c.plain },
    { token: 'comment', foreground: c.comment, fontStyle: c.italicComments ? 'italic' : '' },
    { token: 'comment.doc', foreground: c.comment },
    { token: 'string', foreground: c.string },
    { token: 'string.escape', foreground: c.preproc },
    { token: 'string.key.json', foreground: c.declOther },
    { token: 'string.value.json', foreground: c.string },
    { token: 'string.link', foreground: c.url },
    { token: 'number', foreground: c.number },
    { token: 'regexp', foreground: c.regexp },
    { token: 'keyword', foreground: c.keyword },
    { token: 'keyword.flow', foreground: c.keyword },
    { token: 'keyword.json', foreground: c.keyword },
    { token: 'storage', foreground: c.keyword },
    { token: 'type', foreground: c.type },
    { token: 'type.identifier', foreground: c.type },
    { token: 'identifier', foreground: c.plain },
    { token: 'variable', foreground: c.projFunc },
    { token: 'variable.predefined', foreground: c.func },
    { token: 'variable.parameter', foreground: c.projFunc },
    { token: 'constant', foreground: c.func },
    { token: 'predefined', foreground: c.func },
    { token: 'annotation', foreground: c.preproc },
    { token: 'metatag', foreground: c.preproc },
    { token: 'meta', foreground: c.preproc },
    { token: 'tag', foreground: c.decl },
    { token: 'tag.id', foreground: c.declOther },
    { token: 'tag.class', foreground: c.declOther },
    { token: 'attribute.name', foreground: c.attr },
    { token: 'attribute.value', foreground: c.string },
    { token: 'attribute.value.number', foreground: c.number },
    { token: 'attribute.value.unit', foreground: c.number },
    { token: 'delimiter', foreground: c.plain },
    { token: 'operator', foreground: c.plain },
    { token: 'key', foreground: c.declOther },
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'header', foreground: c.keyword, fontStyle: 'bold' },
    { token: 'invalid', foreground: 'ff453a' },
  ];
}

/** Monaco theme data for a variant, with the accent driving cursor and selection. */
export function monacoTheme(v, dark, accent) {
  const fg = v.fg;
  const a = (c, x) => alpha(c, x);
  const widget = mix(v.bg, dark ? '#ffffff' : '#000000', dark ? 0.07 : 0.025);
  const line = dark ? '#ffffff' : '#000000';
  return {
    base: dark ? 'vs-dark' : 'vs', inherit: true, rules: rules(v.syntax),
    colors: {
      'editor.background': v.bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': a(fg, dark ? 0.3 : 0.34),
      'editorLineNumber.activeForeground': a(fg, 0.72),
      'editorCursor.foreground': accent,
      'editor.selectionBackground': a(accent, dark ? 0.36 : 0.22),
      'editor.inactiveSelectionBackground': a(fg, 0.1),
      'editor.selectionHighlightBackground': a(fg, dark ? 0.08 : 0.07),
      'editor.lineHighlightBackground': a(dark ? fg : accent, dark ? 0.04 : 0.045),
      'editor.lineHighlightBorder': '#00000000',
      'editor.wordHighlightBackground': a(fg, 0.07),
      'editor.wordHighlightStrongBackground': a(fg, 0.11),
      'editor.findMatchBackground': dark ? '#ffd60a55' : '#ffcc0080',
      'editor.findMatchHighlightBackground': dark ? '#ffd60a26' : '#ffcc0040',
      'editor.findRangeHighlightBackground': a(fg, 0.04),
      'editorBracketMatch.background': a(fg, 0.08),
      'editorBracketMatch.border': a(fg, 0.25),
      'editorIndentGuide.background1': a(fg, dark ? 0.07 : 0.08),
      'editorIndentGuide.activeBackground1': a(fg, dark ? 0.17 : 0.18),
      'editorWhitespace.foreground': a(fg, 0.16),
      'editorGutter.background': v.bg,
      'editorStickyScroll.background': mix(v.bg, line, dark ? 0.04 : 0.025),
      'editorStickyScrollHover.background': mix(v.bg, line, dark ? 0.08 : 0.05),
      'editorOverviewRuler.border': '#00000000',
      'editorWidget.background': widget,
      'editorWidget.border': a(line, dark ? 0.1 : 0.1),
      'editorWidget.foreground': fg,
      'editorSuggestWidget.background': widget,
      'editorSuggestWidget.border': a(line, 0.1),
      'editorSuggestWidget.selectedBackground': accent,
      'editorSuggestWidget.selectedForeground': '#ffffff',
      'editorSuggestWidget.selectedIconForeground': '#ffffff',
      'editorSuggestWidget.highlightForeground': accent,
      'editorSuggestWidget.focusHighlightForeground': '#ffffff',
      'editorHoverWidget.background': widget,
      'editorHoverWidget.border': a(line, 0.1),
      'editorError.foreground': dark ? '#ff453a' : '#ff3b30',
      'editorWarning.foreground': dark ? '#ffd60a' : '#c27c00',
      'editorInfo.foreground': accent,
      'editorLink.activeForeground': accent,
      'list.hoverBackground': a(fg, 0.07),
      'list.activeSelectionBackground': accent,
      'list.activeSelectionForeground': '#ffffff',
      'list.focusBackground': accent,
      'list.focusForeground': '#ffffff',
      'list.highlightForeground': accent,
      'list.inactiveSelectionBackground': a(fg, 0.1),
      'quickInput.background': widget,
      'quickInputList.focusBackground': accent,
      'quickInputList.focusForeground': '#ffffff',
      'input.background': a(fg, 0.07),
      'input.border': a(line, 0.1),
      'input.foreground': fg,
      'inputOption.activeBackground': a(accent, 0.25),
      'inputOption.activeBorder': accent,
      'focusBorder': a(accent, 0.6),
      'widget.shadow': dark ? '#00000080' : '#0000002e',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': a(fg, 0.13),
      'scrollbarSlider.hoverBackground': a(fg, 0.22),
      'scrollbarSlider.activeBackground': a(fg, 0.3),
      'minimap.background': v.bg,
      'menu.background': widget,
      'menu.foreground': fg,
      'menu.selectionBackground': accent,
      'menu.selectionForeground': '#ffffff',
      'menu.separatorBackground': a(line, 0.12),
      'menu.border': a(line, 0.1),
      'diffEditor.insertedTextBackground': dark ? '#30d1582e' : '#34c75926',
      'diffEditor.removedTextBackground': dark ? '#ff453a2e' : '#ff3b3026',
    },
  };
}

/** xterm.js theme for a variant. */
export function termTheme(v, dark, accent) {
  const t = {
    background: v.bg,
    foreground: v.termFg || v.fg,
    cursor: accent,
    cursorAccent: v.bg,
    selectionBackground: alpha(accent, dark ? 0.38 : 0.24),
    selectionInactiveBackground: alpha(v.fg, 0.12),
  };
  ANSI.forEach((k, i) => { t[k] = v.ansi[i]; });
  return t;
}

/** A few lines of code coloured like the theme, for the picker in Settings. */
export function sampleHtml(v) {
  const c = k => `#${v.syntax[k]}`;
  const s = (k, t) => `<span style="color:${c(k)}">${t}</span>`;
  return `<pre style="background:${v.bg};color:${c('plain')}">${s('comment', '# say hello')}
${s('keyword', 'def')} greet(${s('projFunc', 'names')}):
    ${s('keyword', 'for')} n ${s('keyword', 'in')} names:
        print(${s('string', '"hi"')}, n, ${s('number', '42')})</pre>`;
}
