// HTTP client for the sshcode server, plus the sign-in flow (passwords,
// passphrases and unknown host keys are asked for here, one prompt at a time).
import { dialog } from './ui.js';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method, body, query, signal } = {}) {
  const url = query ? `${path}?${new URLSearchParams(query)}` : path;
  const init = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'X-SSHCode': '1' }, signal };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Can’t reach the sshcode server. Start it again with `sshcode`.', 0, { offline: true });
  }
  let data = {};
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(data.error || r.statusText || 'Request failed', r.status, data);
  return data;
}

export const needsAuth = e => e instanceof ApiError && e.status === 401 && !!e.data.auth;

function promptKind(prompt) {
  if (/passphrase/i.test(prompt)) return 'Passphrase';
  if (/code|token|otp|one-time/i.test(prompt)) return 'Code';
  return 'Password';
}

/**
 * Connect to `host`, asking for whatever ssh wants on the way. Resolves to
 * the remote home directory, or null if the user cancelled.
 */
export async function connect(host) {
  let extra = {};
  for (;;) {
    try {
      const d = await api('/api/connect', { body: { host, ...extra } });
      return d.home;
    } catch (e) {
      const d = e.data || {};
      if (d.auth === 'hostkey') {
        const r = await dialog({
          icon: 'shield', title: `Trust “${host}”?`, wide: true,
          message: 'This server’s key isn’t in your known_hosts yet. Compare the fingerprint with the one you expect before trusting it.',
          detail: d.prompt,
          buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: 'Trust and Connect', value: true, kind: 'primary' }],
        });
        if (!r) return null;
        extra = { ...extra, accept_hostkey: true };
      } else if (d.auth === 'password') {
        // One answer per prompt: a ProxyJump chain asks the jump host and the
        // target separately, and each keeps its own reply.
        const answers = { ...(extra.answers || {}) };
        delete answers[d.prompt];
        const kind = promptKind(d.prompt);
        const r = await dialog({
          icon: 'lock', title: `Sign in to ${host}`,
          message: d.wrong ? 'That was rejected. Try again.' : Object.keys(answers).length ? 'Next step of the login chain.' : '',
          detail: d.prompt,
          input: { type: 'password', placeholder: kind },
          buttons: [{ label: 'Cancel', value: null, kind: 'cancel' }, { label: 'Connect', value: true, kind: 'primary' }],
        });
        if (!r) return null;
        extra = { ...extra, answers: { ...answers, [d.prompt]: r.input } };
      } else {
        throw e;
      }
    }
  }
}

/** Connect without asking anything: the home folder, or null when ssh wants a password or a host key. */
export async function connectQuiet(host) {
  try {
    return (await api('/api/connect', { body: { host } })).home;
  } catch (e) {
    if (needsAuth(e)) return null;
    throw e;
  }
}

export const fileUrl = (host, path, inline) =>
  '/api/file?' + new URLSearchParams({ host, path, ...(inline ? { inline: '1' } : {}) });

export const archiveUrl = (host, dir, names) =>
  '/api/archive?' + new URLSearchParams({ host, dir, names: names.join('\n') });

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** PUT one file with progress (bytes sent); rejects with status 409 if it
 *  exists, or with an AbortError when `signal` fires. */
export function uploadFile(host, path, file, { overwrite = false, mkdirs = false, signal } = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const x = new XMLHttpRequest();
    if (signal) signal.addEventListener('abort', () => x.abort(), { once: true });
    x.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    x.open('PUT', '/api/upload?' + new URLSearchParams({ host, path, overwrite: overwrite ? '1' : '0', mkdirs: mkdirs ? '1' : '0' }));
    x.setRequestHeader('X-SSHCode', '1');
    x.upload.onprogress = ev => onProgress(ev.loaded);
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status < 300) resolve(d);
      else reject(new ApiError(d.error || x.statusText, x.status, d));
    };
    x.onerror = () => reject(new ApiError('network error', 0));
    x.send(file);
  });
}
