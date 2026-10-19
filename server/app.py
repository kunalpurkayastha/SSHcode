"""sshcode server — a VS Code-style workspace for the hosts in your
~/.ssh/config: file explorer, Monaco editor and terminals in the browser.

Like sshweb, every connection goes through the system `ssh` binary
(ProxyJump, ProxyCommand, keys, agents and known_hosts work as they do in a
terminal). The server listens on 127.0.0.1 only and every request needs the
token cookie that the `sshcode` launcher hands to the browser.
"""
import email.utils
import json
import mimetypes
import os
import posixpath
import signal
import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import jobs  # noqa: E402
import remote  # noqa: E402
import terminals  # noqa: E402
import websocket  # noqa: E402
from remote import Conflict, Exists, NeedsAuth  # noqa: E402
from version import VERSION  # noqa: E402
from sftp import SFTPError, ConnectError, ST_NOFILE, ST_PERM  # noqa: E402

WEB = os.path.join(os.path.dirname(HERE), "web")
COOKIE = "sshcode_token"
TOKEN = ""  # set by serve()
HOSTS = remote.Hosts()
TERMS = terminals.Terminals()
JOBS = jobs.Jobs(HOSTS)

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png",
}
# Never rendered as documents from /api/file, whatever the remote file claims to be.
UNSAFE_INLINE = ("text/html", "application/xhtml+xml", "text/xml", "application/xml",
                 "application/javascript", "text/javascript")


def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8", "surrogateescape")


class Handler(BaseHTTPRequestHandler):
    server_version = "sshcode"

    def log_message(self, fmt, *args):
        if os.environ.get("SSHCODE_VERBOSE"):
            super().log_message(fmt, *args)

    # --- helpers -----------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json_bytes(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, e):
        if isinstance(e, NeedsAuth):
            return self.send_json({"error": e.error or "authentication required", "auth": e.kind,
                                   "prompt": e.prompt, "wrong": e.wrong, "host": e.host}, 401)
        if isinstance(e, Conflict):
            return self.send_json({"error": str(e), "conflict": True,
                                   "mtime": e.mtime, "size": e.size}, 409)
        if isinstance(e, SFTPError):
            status = 404 if e.code == ST_NOFILE else 403 if e.code == ST_PERM else 500
            msg = str(e)
            if e.code == ST_NOFILE and msg in ("", "No such file"):
                msg = "No such file or folder"
            return self.send_json({"error": msg}, status)
        if isinstance(e, ConnectError):
            return self.send_json({"error": str(e), "disconnected": True}, 502)
        if isinstance(e, (KeyError, ValueError, TypeError)):
            return self.send_json({"error": f"bad request: {e}"}, 400)
        return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        name = host.split("]")[0] + "]" if host.startswith("[") else host.split(":")[0]
        return name in ("127.0.0.1", "localhost", "[::1]")

    def authorized(self, mutating):
        if not self.host_ok():
            return False
        cookies = self.headers.get("Cookie") or ""
        ok = bool(TOKEN) and any(c.strip() == f"{COOKIE}={TOKEN}" for c in cookies.split(";"))
        if mutating and self.headers.get("X-SSHCode") != "1":
            return False
        return ok

    def same_origin(self):
        return self.headers.get("Origin") == "http://" + (self.headers.get("Host") or "")

    def parse(self):
        u = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query, keep_blank_values=True).items()}
        return u.path, q

    def session(self, host, background=False):
        return HOSTS.get(host, background)

    # --- routing -----------------------------------------------------------
    def do_GET(self):
        path, q = self.parse()
        if path == "/api/health":
            if not self.host_ok():
                return self.send_json({"error": "forbidden"}, 403)
            return self.send_json({"ok": True, "app": "sshcode", "pid": os.getpid(), "version": VERSION})
        if path == "/" and q.get("t"):
            if not self.host_ok() or q.get("t") != TOKEN:
                return self.send_error(403, "Stale link: run `sshcode` again.")
            self.send_response(303)
            self.send_header("Set-Cookie", f"{COOKIE}={TOKEN}; HttpOnly; SameSite=Strict; "
                                           "Path=/; Max-Age=31536000")
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self.authorized(False):
            if path.startswith("/api/") or path.startswith("/ws/"):
                return self.send_json({"error": "forbidden"}, 403)
            return self.send_error(403, "Open sshcode with the `sshcode` command.")
        try:
            if path == "/ws/term":
                return self.ws_term(q)
            api = {
                "/api/hosts": self.api_hosts,
                "/api/ls": self.api_ls,
                "/api/read": self.api_read,
                "/api/file": self.api_file,
                "/api/archive": self.api_archive,
                "/api/find": self.api_find,
                "/api/terms": self.api_terms,
                "/api/jobs": self.api_jobs,
            }.get(path)
            if api:
                return api(q)
            if path.startswith("/api/"):
                return self.send_json({"error": "not found"}, 404)
            return self.static(path)
        except ConnectionError:  # the browser went away (or cancelled an upload)
            return
        except Exception as e:
            return self.fail(e)

    def do_POST(self):
        path, _ = self.parse()
        if not self.authorized(True):
            return self.send_json({"error": "forbidden"}, 403)
        try:
            body = self.body_json()
            fn = {
                "/api/connect": self.api_connect,
                "/api/disconnect": self.api_disconnect,
                "/api/write": self.api_write,
                "/api/stat": self.api_stat,
                "/api/create": self.api_create,
                "/api/rename": self.api_rename,
                "/api/copy": self.api_copy,
                "/api/delete": self.api_delete,
                "/api/search": self.api_search,
                "/api/transfer": self.api_transfer,
                "/api/jobs/cancel": self.api_jobs_cancel,
                "/api/jobs/dismiss": self.api_jobs_dismiss,
            }.get(path)
            if not fn:
                return self.send_json({"error": "not found"}, 404)
            return fn(body)
        except ConnectionError:  # the browser went away (or cancelled an upload)
            return
        except Exception as e:
            return self.fail(e)

    def do_PUT(self):
        path, q = self.parse()
        if not self.authorized(True):
            return self.send_json({"error": "forbidden"}, 403)
        if path != "/api/upload":
            return self.send_json({"error": "not found"}, 404)
        try:
            return self.api_upload(q)
        except ConnectionError:  # the browser went away (or cancelled an upload)
            return
        except Exception as e:
            return self.fail(e)

    # --- static files ----------------------------------------------------------
    def static(self, path):
        rel = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        if rel in ("", "."):
            rel = "index.html"
        root = os.path.realpath(WEB)
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return self.send_error(404)
        st = os.stat(full)
        modified = email.utils.formatdate(st.st_mtime, usegmt=True)
        if self.headers.get("If-Modified-Since") == modified:
            self.send_response(304)
            self.end_headers()
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("Last-Modified", modified)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if ext == ".html":
            host = self.headers.get("Host") or "127.0.0.1"
            self.send_header("Content-Security-Policy", (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https:; font-src 'self' data:; "
                f"connect-src 'self' ws://{host}; worker-src 'self' blob:; frame-src 'self'; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"))
            self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        with open(full, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # --- hosts -----------------------------------------------------------------
    def api_hosts(self, q):
        aliases = remote.parse_hosts(remote.config_path())
        with ThreadPoolExecutor(8) as ex:
            hosts = list(ex.map(remote.resolve, aliases))
        for h in hosts:
            h["connected"] = HOSTS.connected(h["alias"])
        self.send_json({"hosts": hosts, "config": remote.config_path()})

    def api_connect(self, b):
        host = b.get("host", "")
        answers = b.get("answers") or {}
        if not isinstance(answers, dict) or not all(isinstance(v, str) for v in answers.values()):
            return self.send_json({"error": "bad answers"}, 400)
        home = HOSTS.connect(host, answers, bool(b.get("accept_hostkey")))
        self.send_json({"ok": True, "home": home})

    def api_disconnect(self, b):
        host = b.get("host", "")
        TERMS.close_host(host)
        HOSTS.disconnect(host)
        self.send_json({"ok": True})

    # --- files -----------------------------------------------------------------
    def api_ls(self, q):
        sess = self.session(q.get("host", ""), q.get("bg") == "1")
        with sess.lock:
            path, entries = remote.list_dir(sess, q.get("path") or ".")
        self.send_json({"path": path, "entries": entries})

    def api_read(self, q):
        head = int(q["head"]) if q.get("head", "").isdigit() else None
        if head:
            head = min(head, 64 << 20)
        sess = self.session(q.get("host", ""))
        with sess.lock:
            info = remote.read_text(sess, q["path"], lossy=q.get("lossy") == "1", head=head)
        self.send_json(info)

    def api_write(self, b):
        text = b["text"]
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        sess = self.session(b.get("host", ""))
        with sess.lock:
            res = remote.write_text(sess, b["path"], text, bool(b.get("bom")),
                                    None if b.get("force") else b.get("expect"))
        self.send_json(res)

    def api_stat(self, b):
        sess = self.session(b.get("host", ""), bool(b.get("bg")))
        with sess.lock:
            stats = remote.stat_many(sess, list(b.get("paths") or [])[:500])
        self.send_json({"stats": stats})

    def api_create(self, b):
        sess = self.session(b.get("host", ""))
        with sess.lock:
            remote.create(sess, b["path"], bool(b.get("dir")), bool(b.get("parents")))
        self.send_json({"ok": True})

    def api_rename(self, b):
        sess = self.session(b.get("host", ""))
        with sess.lock:
            remote.rename(sess, b["src"], b["dst"])
        self.send_json({"ok": True})

    def api_copy(self, b):
        rc, _, err, _ = HOSTS.run(b.get("host", ""), remote.COPY, [b["src"], b["dst"]], timeout=600)
        if rc != 0:
            return self.send_json({"error": err or f"copy failed ({rc})"}, 409 if rc == 17 else 500)
        self.send_json({"ok": True})

    def api_delete(self, b):
        host = b.get("host", "")
        paths = [p for p in b.get("paths", []) if isinstance(p, str)]
        home = HOSTS.homes.get(host)
        if not paths or not all(p.startswith("/") and remote.safe_to_delete(p, home) for p in paths):
            return self.send_json({"error": "refusing to delete that path"}, 400)
        rc, _, err, _ = HOSTS.run(host, remote.REMOVE, paths, timeout=600)
        if rc != 0:
            return self.send_json({"error": err or f"delete failed ({rc})"}, 500)
        self.send_json({"ok": True})

    def api_find(self, q):
        self.send_json(remote.find_files(HOSTS, q.get("host", ""), q["root"]))

    def api_search(self, b):
        query = b.get("query", "")
        if not isinstance(query, str) or not query:
            return self.send_json({"matches": [], "truncated": False})
        self.send_json(remote.search(HOSTS, b.get("host", ""), b["root"], query,
                                     bool(b.get("case")), bool(b.get("word")), bool(b.get("regex"))))

    def api_file(self, q):
        host, path = q.get("host", ""), q["path"]
        inline = q.get("inline") == "1"
        sess = HOSTS.transfer(host)
        try:
            a = sess.stat(path)
            if a.is_dir():
                raise SFTPError(4, "is a directory")
            size = a.size or 0
            start, end, status = 0, size, 200
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes=") and "," not in rng:
                lo, _, hi = rng[6:].partition("-")
                try:
                    if lo:
                        start = int(lo)
                        end = min(size, int(hi) + 1) if hi else size
                    elif hi:
                        start, end = max(0, size - int(hi)), size
                    if start >= size and size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    status = 206
                except ValueError:
                    start, end = 0, size
            name = posixpath.basename(path)
            ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
            if inline and (ctype in UNSAFE_INLINE or ctype.startswith("text/")):
                ctype = "text/plain; charset=utf-8"
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(end - start))
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{max(start, end - 1)}/{size}")
            disp = "inline" if inline else "attachment"
            self.send_header("Content-Disposition",
                             f"{disp}; filename*=UTF-8''{urllib.parse.quote(name)}")
            # Browsers refuse to run their PDF viewer in a sandboxed document;
            # everything else that could render as a page stays sandboxed.
            if ctype != "application/pdf":
                self.send_header("Content-Security-Policy",
                                 "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; "
                                 "style-src 'unsafe-inline'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if end > start:
                for chunk in sess.read_iter(path, start, end):
                    self.wfile.write(chunk)
        finally:
            sess.close()

    def api_archive(self, q):
        host = q.get("host", "")
        d = q["dir"]
        names = [n for n in q.get("names", "").split("\n") if n]
        if not names or any("/" in n or n in (".", "..") for n in names):
            return self.send_json({"error": "bad names"}, 400)
        label = names[0] if len(names) == 1 else (posixpath.basename(d.rstrip("/")) or "files")
        proc = HOSTS.popen(host, remote.TAR, [d] + names)
        try:
            first = proc.stdout.read(65536)
            if not first:
                err = proc.stderr.read().decode("utf-8", "replace").strip()
                proc.wait()
                return self.send_json({"error": err or "tar produced no output"}, 500)
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{urllib.parse.quote(label)}.tar.gz")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(first)
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()

    def api_upload(self, q):
        host, path = q.get("host", ""), q["path"]
        if not path.startswith("/"):
            raise ValueError("path must be absolute")
        remaining = int(self.headers.get("Content-Length") or 0)

        def read(n):
            nonlocal remaining
            if remaining <= 0:
                return b""
            data = self.rfile.read(min(n, remaining))
            if not data:
                raise ConnectionError("upload interrupted")
            remaining -= len(data)
            return data

        sess = HOSTS.transfer(host)
        try:
            if q.get("mkdirs") == "1":
                sess.makedirs(posixpath.dirname(path))
            try:
                written = remote.upload(sess, path, read, overwrite=q.get("overwrite") == "1")
            except Exists:
                # Drain the body so the browser sees the reply.
                while read(1 << 20):
                    pass
                return self.send_json({"error": "exists", "exists": True}, 409)
            self.send_json({"ok": True, "bytes": written})
        finally:
            sess.close()

    # --- copy / move jobs ---------------------------------------------------------
    def api_transfer(self, b):
        src, dst = b.get("src") or {}, b.get("dst") or {}
        mode, policy = b.get("mode"), b.get("conflict") or "ask"
        names = src.get("names")
        if (mode not in ("copy", "move") or not isinstance(names, list) or not names
                or not all(jobs.valid_name(n) for n in names) or len(set(names)) != len(names)
                or not jobs.valid_dir(src.get("dir")) or not jobs.valid_dir(dst.get("dir"))
                or not remote.valid_alias(src.get("host", "")) or not remote.valid_alias(dst.get("host", ""))):
            return self.send_json({"error": "bad transfer request"}, 400)
        src = {"host": src["host"], "dir": src["dir"], "names": names}
        dst = {"host": dst["host"], "dir": dst["dir"]}
        HOSTS.get(src["host"])  # both ends signed in (401 names the host otherwise)
        HOSTS.get(dst["host"])
        if policy == "ask":
            clash = JOBS.conflicts(src, dst)
            if clash:
                return self.send_json({"conflicts": clash})
            policy = "error"
        if policy not in jobs.POLICIES:
            return self.send_json({"error": "bad conflict policy"}, 400)
        self.send_json({"job": JOBS.start(src, dst, mode, policy).info()})

    def api_jobs(self, q):
        self.send_json({"jobs": JOBS.list()})

    def api_jobs_cancel(self, b):
        job = JOBS.cancel(b.get("id", ""))
        self.send_json({"ok": bool(job)})

    def api_jobs_dismiss(self, b):
        JOBS.dismiss([i for i in b.get("ids") or [] if isinstance(i, str)])
        self.send_json({"ok": True})

    # --- terminals ---------------------------------------------------------------
    def api_terms(self, q):
        self.send_json({"terms": TERMS.detached(q.get("host", ""), q.get("ws", ""))})

    def ws_term(self, q):
        if not self.same_origin():
            return self.send_json({"error": "forbidden"}, 403)
        ws = websocket.upgrade(self)
        if ws is None:
            return
        term = None
        try:
            if q.get("id"):
                term = TERMS.get(q["id"])
                if term is None:
                    ws.send_text(json.dumps({"t": "gone"}))
                    return
            else:
                host = q.get("host", "")
                HOSTS.get(host)  # the terminal rides on this host's control master
                term = TERMS.create(host, q.get("cwd") or "", int(q.get("cols") or 80),
                                    int(q.get("rows") or 24), q.get("ws") or "")
            offset = int(q["offset"]) if q.get("offset", "").isdigit() else None
            term.attach(ws, offset)
            while True:
                msg = ws.recv()
                if msg is None:
                    break
                if isinstance(msg, bytes):
                    term.write(msg)
                    continue
                m = json.loads(msg)
                t = m.get("t")
                if t == "i":
                    term.write(m.get("d", "").encode("utf-8", "replace"))
                elif t == "r":
                    term.resize(m.get("c", 80), m.get("r", 24))
                elif t == "kill":
                    TERMS.remove(term.id)
                    break
        except websocket.Closed:
            pass
        except NeedsAuth as e:
            self._ws_error(ws, e.error or "not connected", auth=True)
        except Exception as e:
            self._ws_error(ws, f"{type(e).__name__}: {e}")
        finally:
            if term is not None:
                term.detach(ws)
            ws.close()

    def _ws_error(self, ws, message, auth=False):
        try:
            ws.send_text(json.dumps({"t": "error", "message": message, "auth": auth}))
        except websocket.Closed:
            pass


def serve(port, token, on_ready=None):
    global TOKEN
    TOKEN = token
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True

    def stop(*_):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if on_ready:
        on_ready(httpd.server_address[1])
    try:
        httpd.serve_forever()
    finally:
        JOBS.shutdown()
        TERMS.shutdown()
        HOSTS.shutdown()
