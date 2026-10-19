"""Remote terminals: `ssh -tt host` on a local pseudo-terminal, bridged to a
WebSocket. The ssh process goes through the host's control master, so no
re-authentication. Output is kept in a ring buffer so a reloaded page can
reattach and redraw; a terminal nobody is attached to is closed after GRACE
seconds."""
import fcntl
import json
import os
import secrets
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

import remote
from websocket import Closed

RING = 512 << 10
GRACE = 15 * 60
# Runs in the child: make the pty its controlling terminal (so ssh gets
# SIGWINCH on resize), then become ssh.
CTTY = ("import fcntl,os,sys,termios;fcntl.ioctl(0,termios.TIOCSCTTY,0);"
        "os.execvp(sys.argv[1],sys.argv[1:])")


def remote_command(cwd):
    # The remote login shell parses this, whatever it is (bash, zsh, fish,
    # tcsh), so only plain single quotes are safe. Odd paths start in ~.
    if not cwd or any(c in cwd for c in "'\\!\n\r"):
        return "exec $SHELL -l"
    return f"cd '{cwd}'; exec $SHELL -l"


def set_size(fd, cols, rows):
    cols, rows = max(2, min(int(cols), 1000)), max(2, min(int(rows), 500))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Terminal:
    def __init__(self, host, cwd, cols, rows, workspace=""):
        self.id = secrets.token_urlsafe(12)
        self.host, self.cwd, self.workspace = host, cwd, workspace
        self.created = time.time()
        self.lock = threading.Lock()     # ring, ws, exit_code
        self.io_lock = threading.Lock()  # the pty master fd
        self.ws = None
        self.ring = bytearray()
        self.total = 0
        # (byte offset, cols, rows) at every size change: output is replayed at
        # the geometry it was written for, or line editing redraws come out garbled.
        self.sizes = [(0, cols, rows)]
        self.exit_code = None
        self.detached_at = time.monotonic()
        argv = remote.ssh_base() + ["-tt", "--", host, remote_command(cwd)]
        env = dict(os.environ, TERM="xterm-256color")
        env.pop("SSH_ASKPASS_REQUIRE", None)  # a prompt, if any, belongs in the terminal
        master, slave = os.openpty()
        set_size(master, cols, rows)
        try:
            self.proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", CTTY] + argv,
                                         stdin=slave, stdout=slave, stderr=slave, env=env,
                                         start_new_session=True, close_fds=True)
        except Exception:
            os.close(master)
            raise
        finally:
            os.close(slave)
        self.master = master
        threading.Thread(target=self._pump, daemon=True).start()

    # --- output ----------------------------------------------------------------
    def _send(self, payload):
        """Caller holds self.lock."""
        if self.ws is None:
            return
        try:
            if isinstance(payload, dict):
                self.ws.send_text(json.dumps(payload))
            else:
                self.ws.send_binary(payload)
        except Closed:
            self.ws = None
            self.detached_at = time.monotonic()

    def _pump(self):
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:  # EIO once ssh and everything else closed the pty
                data = b""
            if not data:
                break
            with self.lock:
                self.ring += data
                if len(self.ring) > RING:
                    del self.ring[:len(self.ring) - RING]
                self.total += len(data)
                self._send(data)
        code = self.proc.wait()
        with self.io_lock:
            fd, self.master = self.master, -1
            os.close(fd)
        with self.lock:
            self.exit_code = code
            self._send({"t": "exit", "code": code})

    def attach(self, ws, offset=None):
        """Bind a socket; replay what it hasn't seen (all of the ring if its
        position is unknown or already scrolled out)."""
        with self.lock:
            old, self.ws = self.ws, ws
            if old is not None and old is not ws:
                try:
                    old.send_text(json.dumps({"t": "taken"}))
                    old.close(4001)
                except Closed:
                    pass
            start = self.total - len(self.ring)
            if offset is not None and start <= offset <= self.total:
                at = offset
            else:
                at = start
            cols, rows = next(((c, r) for off, c, r in reversed(self.sizes) if off <= at), self.sizes[0][1:])
            self._send({"t": "hello", "id": self.id, "at": at, "reset": at != offset, "cols": cols, "rows": rows})
            pos = at
            for off, c, r in self.sizes:
                if off <= at:
                    continue
                if off > pos:
                    self._send(bytes(self.ring[pos - start:off - start]))
                    pos = off
                self._send({"t": "size", "c": c, "r": r})
            if self.total > pos:
                self._send(bytes(self.ring[pos - start:]))
            self._send({"t": "live"})
            if self.exit_code is not None:
                self._send({"t": "exit", "code": self.exit_code})

    def detach(self, ws):
        with self.lock:
            if self.ws is ws:
                self.ws = None
                self.detached_at = time.monotonic()

    # --- input -----------------------------------------------------------------
    def write(self, data):
        with self.io_lock:
            view = memoryview(data)
            while view and self.master >= 0:
                try:
                    n = os.write(self.master, view)
                except OSError:
                    return
                view = view[n:]

    def resize(self, cols, rows):
        cols, rows = int(cols), int(rows)
        with self.io_lock:
            if self.master >= 0:
                set_size(self.master, cols, rows)
        with self.lock:
            if self.sizes[-1][1:] != (cols, rows):
                self.sizes.append((self.total, cols, rows))
            start = self.total - len(self.ring)
            while len(self.sizes) > 1 and self.sizes[1][0] <= start:
                self.sizes.pop(0)

    def kill(self):
        if self.proc.poll() is not None:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGHUP)
        except (ProcessLookupError, PermissionError):
            return

        def force():
            if self.proc.poll() is None:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        threading.Timer(3, force).start()

    def info(self):
        return {"id": self.id, "host": self.host, "cwd": self.cwd, "created": self.created,
                "attached": self.ws is not None, "exited": self.exit_code is not None}


class Terminals:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        threading.Thread(target=self._reap, daemon=True).start()

    def create(self, host, cwd, cols, rows, workspace=""):
        t = Terminal(host, cwd, cols, rows, workspace)
        with self.lock:
            self.items[t.id] = t
        return t

    def get(self, tid):
        with self.lock:
            return self.items.get(tid)

    def detached(self, host, workspace):
        with self.lock:
            items = list(self.items.values())
        return sorted((t.info() for t in items
                       if (not host or t.host == host) and t.workspace == workspace and t.ws is None),
                      key=lambda i: i["created"])

    def remove(self, tid):
        with self.lock:
            t = self.items.pop(tid, None)
        if t:
            t.kill()

    def close_host(self, host):
        with self.lock:
            ids = [t.id for t in self.items.values() if t.host == host]
        for tid in ids:
            self.remove(tid)

    def _reap(self):
        while True:
            time.sleep(30)
            now = time.monotonic()
            with self.lock:
                items = list(self.items.values())
            for t in items:
                if t.ws is None and now - t.detached_at > (60 if t.exit_code is not None else GRACE):
                    self.remove(t.id)

    def shutdown(self):
        with self.lock:
            items = list(self.items.values())
        for t in items:
            t.kill()
