// Every command with its default shortcut. The workspace supplies what each
// one does; Settings → Keyboard lists them and lets you rebind them.
// Shortcuts use "Mod" (⌘ on macOS, Ctrl elsewhere) and "Ctrl" (the Control
// key everywhere, like VS Code's Ctrl+`).
import { isMac, normKeys } from './util.js';
import { settings } from './settings.js';

export const COMMANDS = [
  // go
  { id: 'go.file', group: 'Go', title: 'Go to File…', keys: 'Mod+P', icon: 'search', inTerminal: isMac },
  { id: 'go.command', group: 'Go', title: 'Show All Commands', keys: isMac ? 'Mod+Shift+P' : 'F1', alt: ['Mod+Shift+P', 'F1'], icon: 'command', inTerminal: true },
  { id: 'go.line', group: 'Go', title: 'Go to Line…', keys: 'Ctrl+G', icon: 'chevronRight' },
  { id: 'file.openFolder', group: 'Go', title: 'Go to Folder…', alias: 'Open Folder… cd change directory', keys: 'Mod+O', icon: 'folderOpen' },
  { id: 'go.up', group: 'Go', title: 'Go to Enclosing Folder', icon: 'arrowUp' },
  { id: 'go.home', group: 'Go', title: 'Go to Home Folder', icon: 'home' },
  { id: 'go.slash', group: 'Go', title: 'Go to / (Server Root)', icon: 'server' },
  // files
  { id: 'file.save', group: 'File', title: 'Save', keys: 'Mod+S' },
  { id: 'file.saveAll', group: 'File', title: 'Save All' },
  { id: 'file.newFile', group: 'File', title: 'New File…', keys: 'Alt+N', icon: 'newFile' },
  { id: 'file.newFolder', group: 'File', title: 'New Folder…', icon: 'newFolder' },
  { id: 'file.close', group: 'File', title: 'Close Editor', keys: 'Alt+W', icon: 'xmark' },
  { id: 'file.closeAll', group: 'File', title: 'Close All Editors' },
  { id: 'file.revert', group: 'File', title: 'Revert File' },
  { id: 'file.autoSave', group: 'File', title: 'Toggle Auto Save' },
  { id: 'file.upload', group: 'File', title: 'Upload Files…', icon: 'upload' },
  { id: 'file.uploadFolder', group: 'File', title: 'Upload Folder…', icon: 'upload' },
  { id: 'file.download', group: 'File', title: 'Download Active File', icon: 'download' },
  { id: 'file.copyPath', group: 'File', title: 'Copy Path of Active File', icon: 'copy' },
  // servers
  { id: 'workspace.addServer', group: 'Servers', title: 'Add Server to Sidebar…', alias: 'connect another host multi-root workspace', icon: 'serverPlus' },
  { id: 'workspace.addFolder', group: 'Servers', title: 'Add Folder to Sidebar…', alias: 'multi-root workspace', icon: 'newFolder' },
  { id: 'view.transfers', group: 'Servers', title: 'Show Transfers', alias: 'uploads copies progress', icon: 'transfer' },
  { id: 'remote.reconnect', group: 'Servers', title: 'Reconnect', icon: 'refresh' },
  { id: 'remote.hosts', group: 'Servers', title: 'Show All Hosts', icon: 'server' },
  { id: 'remote.disconnect', group: 'Servers', title: 'Disconnect', icon: 'power' },
  // view
  { id: 'view.sidebar', group: 'View', title: 'Toggle Sidebar', keys: 'Mod+B', icon: 'sidebar' },
  { id: 'view.explorer', group: 'View', title: 'Show Explorer', keys: 'Mod+Shift+E', icon: 'folderLine' },
  { id: 'view.search', group: 'View', title: 'Find in Files', keys: 'Mod+Shift+F', icon: 'search' },
  { id: 'view.sidebarSide', group: 'View', title: 'Move Sidebar Left / Right', icon: 'sidebar' },
  { id: 'view.panelSide', group: 'View', title: 'Move Terminal Panel Bottom / Right', icon: 'panelRight' },
  { id: 'view.wrap', group: 'View', title: 'Toggle Word Wrap', keys: 'Alt+Z', icon: 'wrap' },
  { id: 'view.minimap', group: 'View', title: 'Toggle Minimap' },
  { id: 'view.hidden', group: 'View', title: 'Toggle Hidden Files', icon: 'eye' },
  { id: 'view.zoomIn', group: 'View', title: 'Bigger Editor Text', icon: 'textSize' },
  { id: 'view.zoomOut', group: 'View', title: 'Smaller Editor Text', icon: 'textSize' },
  { id: 'view.zoomReset', group: 'View', title: 'Reset Editor Text Size', icon: 'textSize' },
  { id: 'editor.preview', group: 'View', title: 'Toggle Preview (Markdown, Notebook, SVG)', keys: 'Mod+Shift+V', icon: 'eye' },
  { id: 'editor.previewSide', group: 'View', title: 'Toggle Side-by-Side Preview', alias: 'markdown split preview to the side readme', icon: 'split' },
  { id: 'view.folders', group: 'View', title: 'Toggle Folder View', alias: 'finder file manager browser icons grid list ide editor', keys: 'Mod+Alt+F', icon: 'grid', inTerminal: true },
  { id: 'editor.asText', group: 'View', title: 'Reopen Active File as Text (Read-only)', icon: 'code' },
  { id: 'editor.language', group: 'View', title: 'Change Language Mode…' },
  { id: 'explorer.refresh', group: 'View', title: 'Refresh Explorer', icon: 'refresh' },
  { id: 'explorer.collapse', group: 'View', title: 'Collapse Folders in Explorer', icon: 'collapse' },
  { id: 'explorer.reveal', group: 'View', title: 'Reveal Active File in Explorer' },
  // terminal
  { id: 'view.terminal', group: 'Terminal', title: 'Toggle Terminal', keys: 'Ctrl+`', icon: 'terminal', inTerminal: true },
  { id: 'term.new', group: 'Terminal', title: 'New Terminal', keys: 'Ctrl+Shift+`', icon: 'plus', inTerminal: true },
  { id: 'term.newOn', group: 'Terminal', title: 'New Terminal on Server…', icon: 'terminal' },
  { id: 'term.split', group: 'Terminal', title: 'Split Terminal Right', keys: 'Ctrl+Shift+5', icon: 'split', inTerminal: true },
  { id: 'term.splitDown', group: 'Terminal', title: 'Split Terminal Down', icon: 'splitDown', inTerminal: true },
  { id: 'term.focusNext', group: 'Terminal', title: 'Focus Next Terminal Pane', inTerminal: true },
  { id: 'term.focusPrev', group: 'Terminal', title: 'Focus Previous Terminal Pane', inTerminal: true },
  { id: 'term.join', group: 'Terminal', title: 'Join Terminal Panes into One', icon: 'collapse' },
  { id: 'term.rename', group: 'Terminal', title: 'Rename Terminal…', icon: 'pencil' },
  { id: 'term.kill', group: 'Terminal', title: 'Kill Terminal', icon: 'trash' },
  { id: 'term.max', group: 'Terminal', title: 'Maximize Terminal Panel', icon: 'maximize' },
  // look
  { id: 'settings.open', group: 'Settings', title: 'Settings…', alias: 'preferences personalize customize theme', keys: 'Mod+,', icon: 'gear', inTerminal: true },
  { id: 'settings.keys', group: 'Settings', title: 'Keyboard Shortcuts…', alias: 'keybindings', icon: 'keyboard' },
  { id: 'theme.editor', group: 'Settings', title: 'Change Editor Theme…', alias: 'color theme', icon: 'palette' },
  { id: 'theme.system', group: 'Settings', title: 'Appearance: Match System', icon: 'halfCircle' },
  { id: 'theme.light', group: 'Settings', title: 'Appearance: Light', icon: 'sun' },
  { id: 'theme.dark', group: 'Settings', title: 'Appearance: Dark', icon: 'moon' },
];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The shortcut a command answers to now ('' = none). */
export function keysOf(cmd) {
  const over = settings.get('keys');
  return has(over, cmd.id) ? over[cmd.id] : cmd.keys || '';
}

/** Every shortcut that triggers it (the default's alternatives only while it isn't rebound). */
export function allKeysOf(cmd) {
  const over = settings.get('keys');
  if (has(over, cmd.id)) return over[cmd.id] ? [over[cmd.id]] : [];
  return [cmd.keys, ...(cmd.alt || [])].filter(Boolean);
}

/** Map of normalized shortcut -> command, later entries losing to earlier ones. */
export function buildKeymap(commands) {
  const map = new Map();
  for (const c of commands) for (const k of allKeysOf(c)) if (!map.has(normKeys(k))) map.set(normKeys(k), c);
  return map;
}

/** The command (other than `id`) already using `keys`. */
export function keyOwner(keys, id) {
  const n = normKeys(keys);
  return COMMANDS.find(c => c.id !== id && allKeysOf(c).some(k => normKeys(k) === n)) || null;
}

/** Shortcuts the browser keeps for itself, whatever the page does. */
export const RESERVED = new Set(['Mod+W', 'Mod+T', 'Mod+N', 'Mod+Shift+T', 'Mod+Shift+N', 'Mod+Tab', 'Mod+Shift+Tab', 'Mod+Q', 'Mod+Shift+W'].map(normKeys));
