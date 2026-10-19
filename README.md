# SSHcode

A VS Code–style workspace for the hosts in your `~/.ssh/config`, in the browser:
file explorer, the Monaco editor (the editor inside VS Code) and real terminals,
drawn as macOS-style glass.

```
sshcode                     start the server if needed and open the browser
sshcode HOST [PATH]         open a workspace on HOST, e.g. sshcode myserver ~/proj
sshcode start | stop | restart | status | logs | serve
```

The server listens on `127.0.0.1:8823` (`SSHCODE_PORT` to change it). State,
the login token and the log live in `~/.local/state/sshcode/`.

## Install

On Debian, Ubuntu or another Debian-based system (Mint, Pop!_OS, Raspberry
Pi OS…):

```
curl -fsSL https://raw.githubusercontent.com/kunalpurkayastha/sshcode/main/install.sh | bash
```

(without curl: `wget -qO- <same URL> | bash`), or from a clone:

```
git clone https://github.com/kunalpurkayastha/sshcode.git
cd sshcode && ./install.sh
```

The installer adds whatever is missing with apt (Python 3.9+, the OpenSSH
client, curl, and git when it has to clone; sudo is used only for this),
downloads the browser libraries into `web/vendor` (pinned versions from the
npm registry, checked against their published sha512), links the `sshcode`
command into `~/.local/bin` and adds a menu entry. A curl install keeps the
code in `~/.local/share/sshcode`; a clone is used where it is. Run as root,
it installs for every user (`/opt/sshcode`, `/usr/local/bin/sshcode`).
Nothing runs as a service: `sshcode` starts the server the first time you
use it.

- **Update**: run the same command again (in a clone: `git pull && ./install.sh`).
  It says whether reloading the page is enough or the server needs
  `sshcode restart` (which closes open terminals).
- **Uninstall**: `./install.sh --uninstall`, or `curl … | bash -s -- --uninstall`.
  It stops the server and removes the command, the menu entry and the code
  the installer downloaded. Your own clone and `~/.local/state/sshcode` stay.
- **A machine without a desktop**: `sshcode start` there, forward the port
  from your computer (`ssh -L 8823:127.0.0.1:8823 thatmachine`) and open
  `http://127.0.0.1:8823/?t=TOKEN`, where TOKEN is the contents of
  `~/.local/state/sshcode/token` on that machine.

The servers you open need only sshd with SFTP (on by default) and a POSIX
`sh`. Use a recent Chrome, Edge or Firefox.

## What you get

- **Hosts**: every `Host` in `~/.ssh/config` (with `Include`s), recent
  workspaces, or type `user@host[:port]`, or `host:/data` to open a folder
  directly. ProxyJump, ProxyCommand, keys, the
  agent and `known_hosts` behave exactly as in a terminal because every
  connection is the system `ssh` binary. Passwords, key passphrases, jump-host
  logins and unknown host keys are asked for in a dialog, one prompt at a time.
- **Going anywhere**: the folder name above the tree is a menu (like
  Finder's path menu): every parent up to `/`, Home, recent folders and **Go
  to Folder…** (Ctrl+O), where the current path comes selected so typing
  `/data` replaces it (relative paths and Tab completion work too). Right-click
  a folder → Go Into; Ctrl+↑ or the ↑ button goes to the enclosing folder.
  The folder is remembered per host and is part of the URL.
- **Several servers side by side**: the server button above the tree (or F1 →
  *Add Server to Sidebar*) puts a folder from any other host next to the
  first one, each in its own section with its server's colour. Go to File,
  Find in Files (pick the folder), terminals and the editor work across all of
  them, and they come back after a reload (a server that needs a password
  waits for a click on *Sign In…* rather than prompting by itself).
- **Moving files between servers**: drag files or folders from one server's
  section to another's (Shift moves instead of copying), use Copy/Paste, or
  *Copy To* in the context menu. The bytes stream through sshcode as one tar
  archive (no round trip per file), unpack into a hidden folder and move into
  place only when complete, so a cancelled copy leaves nothing behind. Within
  one server a drag moves (Ctrl or ⌥ copies) and the server does the work
  (`mv`, `cp -a`). Name clashes ask Finder's question: Keep Both, Replace
  (folders merge: same-named files are overwritten) or Skip.
- **Uploads**: drop files or whole folders from the desktop onto any folder
  (closed folders spring open as you hover), or use *Upload Files…* /
  *Upload Folder…*. Uploads are written under a temporary name and appear
  only when complete; a replaced file keeps its permissions.
- **Transfers**: every upload, copy and move shows in the ⇅ popover at the
  top right with progress, speed, time left and cancel; click a finished one
  to see it in the sidebar.
- **Explorer**: lazy folder tree, multi-select, inline New File / New Folder
  (`a/b/c.py` creates the folders), rename (F2), delete, duplicate,
  cut/copy/paste, download files or folders (`.tar.gz`; in Chrome you can
  also drag a file to the desktop), Open in Terminal, Find in Folder. Drag a
  file onto the editor to open it, or onto a terminal to type its path. It
  refreshes when you come back to the window and after commands you run in
  the terminal.
- **Editor**: Monaco with Xcode's light/dark syntax colours, preview tabs
  (single-click previews, double-click or editing keeps the tab), save with
  conflict detection (it won't silently overwrite a file that changed on the
  server), clean files reload when they change on the server, unsaved edits
  survive a reload or crash (kept in the browser until saved), image preview,
  CRLF/BOM preserved, language/indent/EOL in the status bar, optional auto
  save, word wrap, minimap.
- **Markdown side by side**: a `.md` file opens as two panes, the source on
  the left and the rendered page on the right. The page follows as you type
  (only the paragraph you're in is redrawn) and the two sides scroll together;
  double-click the rendered side to put the cursor on that line, and drag the
  line between them to resize (double-click it for half and half). The
  switch above the editor flips between Source, Side by Side and Preview
  (Ctrl+Shift+V: the preview alone and back), remembered per file. Relative
  images and links work, code is coloured, and Markdown wraps like prose
  (Alt+Z turns that off for the file).
- **Viewing anything**: images, PDFs (the browser's own PDF viewer, with
  search/zoom/print), video and audio (seekable), Jupyter notebooks rendered
  with their plots, tables and errors (source one click away), SVG drawn as
  an image. Binary files open as read-only text on request, and files over
  16 MB open their first 5 MB read-only (handy for logs). Notebook/Markdown
  HTML is sanitised (DOMPurify).
- **Folder View** (the grid button by the tabs, or Ctrl+Alt+F; the code
  button goes back): the editor's place goes to a Finder-like window on the
  folder. Icons with thumbnails of the pictures, or a list with Date
  Modified, Size and Kind (click a heading to sort); back and forward, the
  folder's name opens the path menu, a filter field, an icon-size slider.
  Folders open with a double-click or Enter; files open in **Quick Look**
  (Space or a double-click): Markdown and notebooks rendered, code coloured,
  pictures, PDFs, video, sound and slides, ←/→ through the folder, and Open
  in Editor (Ctrl+Enter) one click away. New Folder, rename in place (F2),
  copy/cut/paste, duplicate, delete, Get Info, a rubber band to select, drag
  onto a folder to move (folders spring open while you hover), drag to and
  from the sidebar, another server or the desktop, and drop files to upload.
  The sidebar steers it (a folder shows it, a file reveals it), a folder of
  thousands of files scrolls smoothly (only what's on screen is drawn), and
  a reload keeps the view you were in.
- **PowerPoint (.pptx)**: slides drawn in the browser, nothing installed on
  the server. Thumbnails down the side, the slides in one scrolling column,
  speaker notes under each slide, zoom, and **Play** for a full-screen show
  (arrows, space or a click to advance, Esc to leave; hidden slides are
  skipped). It reads themes, masters and layouts, text with its bullets and
  autofit, the 187 preset shapes and custom ones, pictures (cropped,
  recoloured, and old EMF/WMF clip art, charts and equations redrawn as
  vectors), tables with their styles, charts (column, bar, line, area, pie,
  doughnut, scatter, bubble, radar) from the values stored in the file,
  SmartArt, links between slides, and embedded video and sound. Text stays
  text: sharp at any zoom, and you can select and copy it. Big decks aren't
  downloaded whole: only the parts a slide needs come over (a 40 MB deck
  with a video opens after ~100 KB). Carlito and Caladea (bundled) stand in
  for Calibri and Cambria with the same metrics, so lines break where they
  did in PowerPoint. Not drawn: animations and transitions, 3-D effects,
  WordArt warps, and the newest chart types (waterfall, sunburst…), which
  show the picture PowerPoint saves for older versions when there is one.
- **Terminals**: real login shells over a pty (`ssh -tt` through the host's
  control master, so no second login), on any of your servers, opened in the
  sidebar folder you're in. Drag a tab onto the edge of a terminal to split
  beside it, onto another group's tabs to join it, or along the tabs to
  reorder; drag the dividers to resize. Double-click a tab to rename it;
  right-click to give it a colour. They survive a page reload, in the same
  arrangement: the server keeps them for 15 minutes and replays recent output
  at the size it was written for.
- **Settings** (Ctrl+, or the gear), laid out like System Settings, every
  change live:
  - *Appearance*: light/dark/auto, accent colour, wallpaper, floating or
    edge-to-edge panes, sidebar left/right, terminal panel bottom/right,
    translucent sidebar, animations.
  - *Editor*: eight themes (Xcode, GitHub, One, Solarized, Catppuccin,
    Gruvbox, Nord, Dracula), each light and dark, and the editor can stay dark
    in a light window. Font, size, line height, ligatures, cursor, line
    numbers, whitespace, guides, bracket colours, sticky scroll, minimap,
    wrap, indentation, auto save, trim trailing spaces, final newline,
    preview tabs, how Markdown opens (side by side, source or preview).
  - *Terminal*: font size, line height, cursor, start folder, copy on select,
    right-click paste, bell, scrollback, GPU rendering.
  - *Files*: row size, coloured icons, folders first, hidden files,
    never-show patterns, single-click behaviour, confirmations; whether a
    new tab opens in the editor or the Folder View, icons or list, icon
    size, picture thumbnails.
  - *Servers*: a colour and a display name for each host.
  - *Keyboard*: rebind any command.
  - *General*: export, import or reset.

  Settings live in the browser (localStorage) and stay in step between tabs.
- **Go to File** (fuzzy, uses `rg --files` or `find` remotely), **Find in
  Files** (`rg` or `grep`) and a **command palette**. From `/` they skip
  `/proc`, `/sys`, `/dev`, `/run` and `/snap`.

## Shortcuts

Ctrl on Linux, ⌘ on macOS.

| | |
|---|---|
| Go to File | Ctrl+P (type `>` for commands, `:` for a line) |
| Command palette | F1 (Ctrl+Shift+P is Firefox's private window) |
| Save | Ctrl+S |
| Toggle terminal / new terminal | Ctrl+\` / Ctrl+Shift+\` |
| Split terminal | Ctrl+Shift+5 |
| Settings | Ctrl+, |
| Toggle sidebar | Ctrl+B |
| Find in Files / Explorer | Ctrl+Shift+F / Ctrl+Shift+E |
| Go to Folder (anywhere, e.g. /data) | Ctrl+O |
| New File / Close editor | Alt+N / Alt+W (Ctrl+N/W belong to the browser) |
| Word wrap | Alt+Z |
| Preview alone (Markdown, notebook, SVG) / back | Ctrl+Shift+V |
| Folder View / back to the editor | Ctrl+Alt+F |
| Terminal copy / paste | Ctrl+Shift+C / Ctrl+Shift+V |
| Slides: next / previous, first / last | ↓ → Space / ↑ ← · Home / End |
| Slides: zoom, play | Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+Enter (Shift: from the start) |

In the explorer: arrows, Enter (open), Space (preview), F2, Delete,
Ctrl+C/X/V, Ctrl+↓ (open / go into), Ctrl+↑ (enclosing folder), and typing
jumps to a name.

In the Folder View: arrows (Shift to extend), Enter or Ctrl+↓ (open),
Space (Quick Look; there ←/→ step and Ctrl+Enter opens the editor),
Backspace or Ctrl+↑ (enclosing folder), Alt+←/→ or Ctrl+[ / Ctrl+] (back,
forward), F2, Delete, Ctrl+A, Ctrl+C/X/V, Ctrl+F (filter), Ctrl+Shift+.
(hidden files), and typing jumps to a name. "Toggle Side-by-Side Preview"
is in the command palette (F1) and can be given a key in Settings.

## Why it feels quick over ssh

Remote latency, not the browser, is what usually makes a remote editor feel
slow, so sshcode avoids round trips: SFTP requests are pipelined (a folder
listing with symlinks is 2–3 round trips instead of 5 plus 2 per link; opening
a file is 2 instead of 4; handles close without waiting), and automatic work
(refresh on focus, change detection, folder prefetch on hover) runs on a
second SFTP channel so it never queues in front of what you clicked. With a
50 ms round trip a folder with symlinks listed in 206 ms instead of 1.4 s.

The UI avoids the expensive parts of "glass": no backdrop blur (over a smooth
gradient it looks the same), opaque editor and terminal panes, no masked
overlays, no animated caret or smooth scrolling, the terminal drawn with
WebGL, and nothing rebuilt per keystroke.

## How it works

- `bin/sshcode`: launcher (Python stdlib). `serve` runs the server in the
  foreground; everything else manages a background one.
- `server/app.py`: `ThreadingHTTPServer` with the JSON API, static files and
  the terminal WebSocket (`server/websocket.py`, a minimal RFC 6455).
- `server/remote.py`: one ssh ControlMaster per host
  (`$XDG_RUNTIME_DIR/sshcode/cm-*`). File access is SFTP (`server/sftp.py`). Search, file lists, recursive delete, copy and tar are small
  POSIX `sh` scripts fed on stdin, so the remote login shell never parses them.
- `server/askpass.py`: answers ssh's prompts from what the dialog sent.
- `server/terminals.py`: `ssh -tt host` on a local pty, ring buffer for
  reattach.
- `server/jobs.py`: copy and move jobs, within a host (`cp -a`, `mv`) and
  between hosts (`tar -c` piped into `tar -x`, unpacked beside the target and
  moved into place), with progress and cancel.
- `web/`: vanilla ES modules, no build step. `web/vendor/` holds Monaco
  0.52.2 (the last release with a supported AMD build), xterm.js 6 (+ WebGL
  addon), marked and DOMPurify (loaded only when a preview opens) and the
  fonts. It isn't in git: `scripts/vendor.sh` fetches it (`--force` to
  fetch again).
- `install.sh`: the Debian installer described under Install.
- `web/js/preview.js` renders Markdown block by block, each block tagged with
  the source lines it came from: an edit redraws only the blocks that changed
  (pictures don't reload), and the two panes scroll together by those marks
  (`web/js/editor.js`).
- `web/js/folders.js`: the Folder View. Items are laid out by arithmetic and
  only those on screen are in the page; thumbnails are drawn once into small
  WebP blobs and kept. `quicklook.js` is Quick Look, `fileinfo.js` the kinds,
  dates and big icons.
- `web/js/pptx/`: the slide viewer, loaded the first time a deck opens. A
  zip reader over HTTP Range requests (`zip.js`, inflating with the browser's
  `DecompressionStream`), DrawingML colours/fills/lines (`ooxml.js`), shape
  geometry (`geometry.js`, evaluating the preset formulas in `shapes.js`,
  generated from ECMA-376's presetShapeDefinitions.xml by
  `scripts/pptx-shapes.py`), text (`text.js`), tables (`table.js`), charts
  (`chart.js`), EMF/WMF to SVG (`metafile.js`), slides (`render.js`) and the
  viewer itself (`viewer.js`, with `web/css/slides.css`).

Fonts: SF Pro / SF Mono are used when the system has them (macOS, iOS);
elsewhere Inter and JetBrains Mono, which are bundled (OFL). Carlito and
Caladea (OFL) are bundled for slides.

## Security

- Listens on 127.0.0.1 only and checks the `Host` header (no DNS rebinding).
- Every request needs the token cookie that `sshcode` hands the browser
  (`SameSite=Strict`, `HttpOnly`). State-changing requests also need an
  `X-SSHCode` header, and the terminal socket checks `Origin`.
- Passwords are kept only in the server's memory (for silent reconnects) and
  are never written to disk. Host keys are checked by OpenSSH against your
  `known_hosts`.
- Remote files served for preview get `Content-Security-Policy: sandbox`
  (except PDFs, which browsers only show in their viewer unsandboxed);
  rendered Markdown and notebook output go through DOMPurify, and SVGs are
  shown as images, so scripts inside them never run. Slides are built with
  DOM calls (text is never parsed as HTML), pictures in them come from inside
  the file only (linked web images aren't fetched), and links open only for
  http(s), mailto and ftp.

## Testing without real servers

Run an unprivileged OpenSSH on a high port and point sshcode at a separate
config and state dir, so nothing touches your real hosts or sessions:

```
SSHCODE_STATE=/tmp/sc-state SSHCODE_PORT=8830 SSHCODE_SSH_CONFIG=/tmp/sc/ssh_config \
SSHCODE_RUNDIR=/run/user/$UID/sshcode-test sshcode start
```

(`apt-get download openssh-server openssh-sftp-server`, extract with
`dpkg-deb -x`, and give `sshd_config` `UsePAM no`, `StrictModes no`,
`PerSourcePenalties no` (tests fail sign-ins on purpose) and
`SshdSessionPath`/`SshdAuthPath`/`Subsystem sftp` pointing into the extract.)

After an update, `sshcode` says so if the running server is older than the
page: run `sshcode restart` (open terminals close) and reload.
