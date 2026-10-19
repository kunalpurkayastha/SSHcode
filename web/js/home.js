// The start page: recent workspaces and the hosts in ~/.ssh/config.
import { esc, h, store, tildify, basename } from './util.js';
import { icons, appIcon } from './icons.js';
import { api } from './api.js';
import { spinner } from './ui.js';
import { themePref, setThemePref } from './theme.js';
import { settings, hostColor, hostLabel } from './settings.js';
import { openSettings } from './settings-ui.js';

/** A server's tile colour (Settings → Servers, else derived from its name). */
export const tileFor = alias => hostColor(alias);

export function workspaceHash(host, root) {
  const p = new URLSearchParams({ host });
  if (root) p.set('root', root);
  return '#' + p.toString().replace(/%2F/g, '/').replace(/%7E/g, '~');
}

export function noteRecentWorkspace(host, root, home) {
  const shown = tildify(root, home);
  const list = store.get('recents', []).filter(r => !(r.host === host && r.root === shown));
  list.unshift({ host, root: shown, at: Date.now() });
  store.set('recents', list.slice(0, 30));
}

/** "user@host:2222" → "ssh://user@host:2222" (ssh only understands the URI form). */
function destination(q) {
  const m = q.match(/^([^@\s/]+@)?([^:\s/@]+):(\d{1,5})$/);
  return m ? `ssh://${m[1] || ''}${m[2]}:${m[3]}` : q;
}

/** scp-style "host:/data" or "user@host:~/proj" → {host, root}. */
function hostAndPath(q) {
  const m = q.match(/^((?:[^@\s/:]+@)?[^:\s/@]+):([/~].*)$/);
  return m ? { host: m[1], root: m[2] } : null;
}

export function renderHome(app) {
  document.title = 'sshcode';
  const el = h(`<div class="home"><div class="home-inner">
    ${appIcon}
    <h1>Connect to a Server</h1>
    <p class="lede">Open a folder on any host in <code>~/.ssh/config</code>.</p>
    <div class="card rim">
      <label class="search">${icons.search}<input spellcheck="false" autocomplete="off" placeholder="Search hosts, or type host:/folder" aria-label="Search hosts"></label>
      <div class="list" role="listbox"><div class="none">${spinner(18)}</div></div>
    </div>
    <div class="foot">
      <span class="kbd">↑</span> <span class="kbd">↓</span> to choose · <span class="kbd">↩</span> to connect
      <div class="appearance" role="radiogroup" aria-label="Appearance" style="display:inline-flex;gap:2px;margin-left:14px;vertical-align:middle"></div>
      <button class="ib sm" data-a="settings" title="Settings" style="vertical-align:middle;margin-left:2px">${icons.gear}</button>
    </div>
  </div></div>`);
  app.appendChild(el);
  const input = el.querySelector('input');
  const list = el.querySelector('.list');
  const appearance = el.querySelector('.appearance');
  let hosts = null, error = null, rows = [], sel = 0;

  const renderAppearance = () => {
    const cur = themePref();
    appearance.innerHTML = [['system', 'halfCircle', 'Match System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']]
      .map(([v, ic, t]) => `<button class="ib sm${cur === v ? ' on' : ''}" data-theme="${v}" title="${t}" role="radio" aria-checked="${cur === v}">${icons[ic]}</button>`).join('');
  };
  appearance.addEventListener('click', e => {
    const b = e.target.closest('[data-theme]');
    if (b) setThemePref(b.dataset.theme);
  });
  el.querySelector('[data-a=settings]').addEventListener('click', () => openSettings());
  renderAppearance();
  const offs = [settings.on('appearance', renderAppearance), settings.on('hosts', () => render())];

  const go = r => { if (r) location.hash = workspaceHash(r.host, r.root); };

  function render() {
    const q = input.value.trim();
    const hp = hostAndPath(q);
    const ql = (hp ? hp.host : q).toLowerCase();
    rows = [];
    let html = '';
    if (hp) {
      rows.push(hp);
      html += `<div class="group">Connect</div>${row(rows.length - 1, tileFor(hp.host), icons.folder, `Open ${esc(hp.root)}`, `on ${esc(hp.host)}`)}`;
    } else if (q && !(hosts || []).some(x => x.alias === q)) {
      const dest = destination(q);
      rows.push({ host: dest });
      html += `<div class="group">Connect</div>${row(rows.length - 1, 'blue', icons.globe, `Connect to “${esc(q)}”`, dest !== q ? esc(dest) : 'Any destination ssh understands, or host:/folder')}`;
    }
    const recents = store.get('recents', []).filter(r => !ql || `${r.host} ${r.root}`.toLowerCase().includes(ql)).slice(0, 5);
    if (recents.length) {
      html += '<div class="group">Recent</div>';
      for (const r of recents) {
        rows.push({ host: r.host, root: r.root, recent: r });
        const name = r.root === '~' ? '~' : basename(r.root);
        html += row(rows.length - 1, tileFor(r.host), icons.folder, esc(name), `${esc(hostLabel(r.host))} <span class="via">·</span> ${esc(r.root)}`, true);
      }
    }
    if (error) {
      html += `<div class="none">${esc(error)}</div>`;
    } else if (!hosts) {
      html += `<div class="none">${spinner(18)}</div>`;
    } else {
      const shown = hosts.filter(x => !ql || [x.alias, hostLabel(x.alias), x.hostname, x.user, x.jump].join(' ').toLowerCase().includes(ql));
      if (shown.length) html += '<div class="group">Hosts</div>';
      for (const x of shown) {
        rows.push({ host: x.alias });
        const port = x.port && x.port !== '22' ? `:${x.port}` : '';
        const where = `${x.user ? esc(x.user) + '@' : ''}${esc(x.hostname || '')}${port}`;
        const via = x.jump ? ` <span class="via">via ${esc(x.jump)}</span>` : x.proxycommand ? ' <span class="via">via ProxyCommand</span>' : '';
        const label = hostLabel(x.alias);
        html += row(rows.length - 1, tileFor(x.alias), icons.server, esc(label) + (label !== x.alias ? ` <span class="via">${esc(x.alias)}</span>` : ''), where + via, false, x.connected);
      }
      if (!rows.length) html += `<div class="none">No hosts match “${esc(q)}”.</div>`;
    }
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    list.innerHTML = html;
    paint();
  }

  function row(i, tile, icon, title, desc, forget = false, live = false) {
    return `<div class="hrow" data-i="${i}" role="option"><span class="tile ${tile}">${icon}</span>
      <div class="txt"><div class="t">${title}</div><div class="d">${desc}</div></div>
      <div class="end">${live ? '<span class="live" title="Connected"></span>' : ''}${forget ? `<button class="ib sm forget" data-forget="${i}" title="Remove from Recent">${icons.xmark}</button>` : ''}${icons.chevronRight}</div></div>`;
  }

  function paint() {
    list.querySelectorAll('.hrow').forEach(r => r.classList.toggle('sel', +r.dataset.i === sel));
    const on = list.querySelector('.hrow.sel');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  list.addEventListener('click', e => {
    const f = e.target.closest('[data-forget]');
    if (f) {
      const r = rows[+f.dataset.forget].recent;
      store.set('recents', store.get('recents', []).filter(x => !(x.host === r.host && x.root === r.root)));
      render();
      return;
    }
    const r = e.target.closest('.hrow');
    if (r) go(rows[+r.dataset.i]);
  });
  list.addEventListener('mousemove', e => {
    const r = e.target.closest('.hrow');
    if (r && +r.dataset.i !== sel) { sel = +r.dataset.i; paint(); }
  });
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
    else if (e.key === 'Escape') { input.value = ''; render(); }
  });

  api('/api/hosts').then(d => { hosts = d.hosts; render(); }, e => { error = e.message; render(); });
  render();
  input.focus();
  return { kind: 'home', dispose() { offs.forEach(f => f()); el.remove(); return true; } };
}
