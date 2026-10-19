// Routing: #host=<alias>[&root=<folder>] opens a workspace, anything else
// shows the host list.
import { renderHome } from './home.js';
import { openWorkspace } from './workspace.js';
import { toast } from './ui.js';
import './theme.js';

const NEEDS_SERVER = 2;  // server/version.py

const app = document.getElementById('app');
let current = null;
let lastHash = location.hash;
let busy = false;

function parse(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  return { host: p.get('host'), root: p.get('root') };
}

async function route() {
  if (busy) return;
  busy = true;
  try {
    const { host, root } = parse(location.hash);
    if (current && current.kind === 'ws' && current.host === host) {
      if (root && current.root && current.setRoot) await current.setRoot(root);
      lastHash = location.hash;
      return;
    }
    if (current) {
      const ok = await current.dispose();
      if (ok === false) {
        // Stay put: put the old address back without another hashchange.
        history.replaceState(null, '', lastHash || '#');
        return;
      }
    }
    lastHash = location.hash;
    current = null;
    app.innerHTML = '';
    current = host ? openWorkspace(app, host, root) : renderHome(app);
  } finally {
    busy = false;
  }
  if (location.hash !== lastHash) route();
}

// Monaco cancels in-flight worker requests when a model goes away; those
// rejections are expected, not errors.
window.addEventListener('unhandledrejection', e => {
  if (e.reason && (e.reason.name === 'Canceled' || e.reason.message === 'Canceled')) e.preventDefault();
});

window.addEventListener('hashchange', route);
route();

// The page updates on reload, the server only on restart: say so if they differ.
fetch('/api/health').then(r => r.json()).then(hh => {
  if ((hh.version || 1) < NEEDS_SERVER) {
    toast({ kind: 'error', timeout: 0, title: 'Restart sshcode to finish updating',
      message: 'The page is newer than the server. Run `sshcode restart` in a terminal (open terminals will close), then reload.' });
  }
}).catch(() => {});
