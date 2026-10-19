"""Minimal SFTP v3 client that talks over the stdin/stdout of a subprocess.

The subprocess is normally `ssh -s <host> sftp`, so every option in the
user's ssh config (ProxyJump, ProxyCommand, IdentityFile, agent, ...) is
honoured by OpenSSH itself and never parsed here.

Round trips are what makes a remote file browser feel slow (doubly so through
a jump host), so requests are pipelined where the protocol allows it and
handles are closed without waiting for the reply.
"""
import os
import struct
import subprocess
import threading

FXP_INIT, FXP_VERSION, FXP_OPEN, FXP_CLOSE, FXP_READ, FXP_WRITE = 1, 2, 3, 4, 5, 6
FXP_LSTAT, FXP_FSTAT, FXP_SETSTAT, FXP_OPENDIR, FXP_READDIR = 7, 8, 9, 11, 12
FXP_REMOVE, FXP_MKDIR, FXP_RMDIR, FXP_REALPATH, FXP_STAT, FXP_RENAME = 13, 14, 15, 16, 17, 18
FXP_READLINK = 19
FXP_STATUS, FXP_HANDLE, FXP_DATA, FXP_NAME, FXP_ATTRS = 101, 102, 103, 104, 105
FXP_EXTENDED = 200

ATTR_SIZE, ATTR_UIDGID, ATTR_PERM, ATTR_TIME, ATTR_EXT = 1, 2, 4, 8, 0x80000000

O_READ, O_WRITE, O_APPEND, O_CREAT, O_TRUNC, O_EXCL = 1, 2, 4, 8, 0x10, 0x20

ST_OK, ST_EOF, ST_NOFILE, ST_PERM = 0, 1, 2, 3

CHUNK = 32768
WINDOW = 64


class SFTPError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg or f"SFTP error {code}")
        self.code = code


class ConnectError(Exception):
    pass


class Attrs:
    __slots__ = ("size", "uid", "gid", "perm", "atime", "mtime")

    def __init__(self):
        self.size = self.uid = self.gid = self.perm = self.atime = self.mtime = None

    def is_dir(self):
        return self.perm is not None and (self.perm & 0o170000) == 0o040000

    def is_link(self):
        return self.perm is not None and (self.perm & 0o170000) == 0o120000


class Reader:
    def __init__(self, data):
        self.d, self.i = data, 0

    def u32(self):
        v = struct.unpack_from(">I", self.d, self.i)[0]
        self.i += 4
        return v

    def u64(self):
        v = struct.unpack_from(">Q", self.d, self.i)[0]
        self.i += 8
        return v

    def bytes(self):
        n = self.u32()
        v = self.d[self.i:self.i + n]
        self.i += n
        return v

    def str(self):
        return self.bytes().decode("utf-8", "surrogateescape")

    def attrs(self):
        a = Attrs()
        flags = self.u32()
        if flags & ATTR_SIZE:
            a.size = self.u64()
        if flags & ATTR_UIDGID:
            a.uid, a.gid = self.u32(), self.u32()
        if flags & ATTR_PERM:
            a.perm = self.u32()
        if flags & ATTR_TIME:
            a.atime, a.mtime = self.u32(), self.u32()
        if flags & ATTR_EXT:
            for _ in range(self.u32()):
                self.bytes()
                self.bytes()
        return a


def s(v):
    if isinstance(v, str):
        v = v.encode("utf-8", "surrogateescape")
    return struct.pack(">I", len(v)) + v


def u32(v):
    return struct.pack(">I", v)


def u64(v):
    return struct.pack(">Q", v)


class SFTP:
    """One SFTP session. Not thread-safe; callers hold `self.lock`."""

    def __init__(self, argv, env=None):
        self.lock = threading.Lock()
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, start_new_session=True)
        self.stderr = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self.rin, self.wout = self.proc.stdout, self.proc.stdin
        self.next_id = 1
        self.deferred = set()  # ids whose replies are read and dropped later
        self.extensions = {}   # what the server offers beyond v3, e.g. posix-rename@openssh.com
        try:
            self._send(FXP_INIT, u32(3))
            t, r = self._recv()
        except (OSError, EOFError, struct.error):
            self.proc.wait(timeout=10)
            raise ConnectError(self.error_text() or "ssh exited")
        if t != FXP_VERSION:
            raise ConnectError("unexpected SFTP handshake reply")
        try:
            r.u32()
            while r.i < len(r.d):
                name = r.str()
                self.extensions[name] = r.str()
        except struct.error:
            pass

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr.append(line.decode("utf-8", "replace").rstrip())
            del self.stderr[:-50]

    def error_text(self):
        return "\n".join(l for l in self.stderr if l.strip())

    @property
    def alive(self):
        return self.proc.poll() is None

    def close(self):
        try:
            self.wout.close()
        except OSError:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()

    # --- framing -----------------------------------------------------------
    def _send(self, t, payload):
        self.wout.write(u32(len(payload) + 1) + bytes([t]) + payload)
        self.wout.flush()

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.rin.read(n - len(buf))
            if not chunk:
                raise EOFError("connection closed")
            buf += chunk
        return buf

    def _recv(self):
        n = struct.unpack(">I", self._read_exact(4))[0]
        data = self._read_exact(n)
        return data[0], Reader(data[1:])

    def _req(self, t, payload):
        rid = self.next_id
        self.next_id = (self.next_id + 1) & 0xFFFFFFFF
        self._send(t, u32(rid) + payload)
        return rid

    def _recv_id(self):
        while True:
            t, r = self._recv()
            rid = r.u32()
            if rid in self.deferred:
                self.deferred.discard(rid)
                continue
            return t, rid, r

    def _close_later(self, h):
        """Close a handle without waiting for the reply (saves a round trip)."""
        self.deferred.add(self._req(FXP_CLOSE, s(h)))

    def batch(self, reqs):
        """Send [(type, payload)] pipelined; returns [(reply type, Reader)] in order."""
        results = [None] * len(reqs)
        waiting = {}  # request id -> index
        nxt = 0
        try:
            while nxt < len(reqs) or waiting:
                while nxt < len(reqs) and len(waiting) < WINDOW:
                    t, payload = reqs[nxt]
                    waiting[self._req(t, payload)] = nxt
                    nxt += 1
                t, rid, r = self._recv_id()
                results[waiting.pop(rid)] = (t, r)
        except BaseException:
            self.deferred.update(waiting)
            raise
        return results

    def _call(self, t, payload):
        rid = self._req(t, payload)
        rt, got, r = self._recv_id()
        if got != rid:
            raise SFTPError(-1, "out-of-order SFTP reply")
        return rt, r

    @staticmethod
    def _status(r, ok_eof=False):
        code = r.u32()
        msg = r.str() if r.i < len(r.d) else ""
        if code == ST_OK or (ok_eof and code == ST_EOF):
            return code
        raise SFTPError(code, msg)

    def _expect(self, rt, r, want):
        if rt == FXP_STATUS:
            self._status(r)
            raise SFTPError(-1, "unexpected OK status")
        if rt != want:
            raise SFTPError(-1, f"unexpected reply type {rt}")
        return r

    # --- operations --------------------------------------------------------
    def realpath(self, path):
        r = self._expect(*self._call(FXP_REALPATH, s(path)), FXP_NAME)
        r.u32()
        return r.str()

    def stat(self, path):
        return self._expect(*self._call(FXP_STAT, s(path)), FXP_ATTRS).attrs()

    def lstat(self, path):
        return self._expect(*self._call(FXP_LSTAT, s(path)), FXP_ATTRS).attrs()

    def listdir(self, path):
        """-> [(name, longname, attrs)]. Two READDIRs stay in flight, so a
        small folder costs two round trips (open, read) instead of four."""
        h = self._expect(*self._call(FXP_OPENDIR, s(path)), FXP_HANDLE).bytes()
        out, pending, eof = [], [], False
        try:
            pending += [self._req(FXP_READDIR, s(h)), self._req(FXP_READDIR, s(h))]
            while pending:
                rt, rid, r = self._recv_id()
                pending.remove(rid)
                if rt == FXP_STATUS:
                    self._status(r, ok_eof=True)
                    eof = True
                    continue
                r = self._expect(rt, r, FXP_NAME)
                for _ in range(r.u32()):
                    name, longname, a = r.str(), r.str(), r.attrs()
                    if name not in (".", ".."):
                        out.append((name, longname, a))
                if not eof:
                    pending.append(self._req(FXP_READDIR, s(h)))
        except BaseException:
            self.deferred.update(pending)
            raise
        finally:
            self._close_later(h)
        return out

    def links_info(self, paths):
        """[(readlink target or None, stat of the target or None)], pipelined."""
        reqs = []
        for p in paths:
            reqs += [(FXP_READLINK, s(p)), (FXP_STAT, s(p))]
        replies = self.batch(reqs)
        out = []
        for i in range(0, len(replies), 2):
            (t1, r1), (t2, r2) = replies[i], replies[i + 1]
            target = None
            if t1 == FXP_NAME:
                r1.u32()
                target = r1.str()
            out.append((target, r2.attrs() if t2 == FXP_ATTRS else None))
        return out

    def _close_handle(self, h):
        rt, r = self._call(FXP_CLOSE, s(h))
        if rt == FXP_STATUS:
            self._status(r)

    def _simple(self, t, payload):
        rt, r = self._call(t, payload)
        if rt != FXP_STATUS:
            raise SFTPError(-1, f"unexpected reply type {rt}")
        self._status(r)

    def mkdir(self, path):
        self._simple(FXP_MKDIR, s(path) + u32(0))

    def rmdir(self, path):
        self._simple(FXP_RMDIR, s(path))

    def remove(self, path):
        self._simple(FXP_REMOVE, s(path))

    def rename(self, src, dst):
        self._simple(FXP_RENAME, s(src) + s(dst))

    def replace(self, src, dst):
        """Rename over an existing dst in one step (OpenSSH's posix-rename),
        or remove dst first where the server lacks it."""
        if "posix-rename@openssh.com" in self.extensions:
            self._simple(FXP_EXTENDED, s("posix-rename@openssh.com") + s(src) + s(dst))
            return
        try:
            self.remove(dst)
        except SFTPError as e:
            if e.code != ST_NOFILE:
                raise
        self.rename(src, dst)

    def chmod(self, path, perm):
        self._simple(FXP_SETSTAT, s(path) + u32(ATTR_PERM) + u32(perm & 0o7777))

    def readlink(self, path):
        r = self._expect(*self._call(FXP_READLINK, s(path)), FXP_NAME)
        r.u32()
        return r.str()

    def makedirs(self, path):
        parts, cur = [p for p in path.split("/") if p], "/" if path.startswith("/") else ""
        for p in parts:
            cur = (cur.rstrip("/") + "/" + p) if cur else p
            try:
                if not self.stat(cur).is_dir():
                    raise SFTPError(4, f"{cur} exists and is not a directory")
            except SFTPError as e:
                if e.code != ST_NOFILE:
                    raise
                self.mkdir(cur)

    def rmtree(self, path):
        for name, _, a in self.listdir(path):
            child = path.rstrip("/") + "/" + name
            if a.is_dir() and not a.is_link():
                self.rmtree(child)
            else:
                self.remove(child)
        self.rmdir(path)

    def open(self, path, flags, perm=None):
        attrs = u32(ATTR_PERM) + u32(perm) if perm is not None else u32(0)
        return self._expect(*self._call(FXP_OPEN, s(path) + u32(flags) + attrs), FXP_HANDLE).bytes()

    def _read_handle(self, h, start=0, end=None):
        """Pipelined reads of an open handle; yields byte chunks in order."""
        pending = {}   # rid -> (offset, length)
        got = {}       # offset -> bytes
        pos = nxt = start
        eof = end

        def issue(off, ln):
            pending[self._req(FXP_READ, s(h) + u64(off) + u32(ln))] = (off, ln)

        try:
            while True:
                while len(pending) < WINDOW and (eof is None or nxt < eof):
                    ln = CHUNK if eof is None else min(CHUNK, eof - nxt)
                    issue(nxt, ln)
                    nxt += ln
                if not pending:
                    break
                t, rid, r = self._recv_id()
                off, ln = pending.pop(rid)
                if t == FXP_STATUS:
                    self._status(r, ok_eof=True)
                    eof = off if eof is None else min(eof, off)
                    continue
                data = r.bytes()
                got[off] = data
                if 0 < len(data) < ln:
                    issue(off + len(data), ln - len(data))
                while pos in got:
                    chunk = got.pop(pos)
                    if eof is not None and pos + len(chunk) > eof:
                        chunk = chunk[:eof - pos]
                    if not chunk:
                        break
                    pos += len(chunk)
                    yield chunk
        finally:
            # Whatever is still in flight gets dropped when it arrives.
            self.deferred.update(pending)

    def read_iter(self, path, start=0, end=None):
        """Pipelined read; yields byte chunks in order."""
        h = self.open(path, O_READ)
        try:
            yield from self._read_handle(h, start, end)
        finally:
            self._close_later(h)

    def read_file(self, path, limit=None, head=None):
        """-> (Attrs, bytes or None): stat and open go out together, then the
        reads, so two round trips in all. bytes is None when the file is
        bigger than `limit`; `head` reads only the first `head` bytes."""
        (t1, r1), (t2, r2) = self.batch([(FXP_STAT, s(path)), (FXP_OPEN, s(path) + u32(O_READ) + u32(0))])
        h = r2.bytes() if t2 == FXP_HANDLE else None
        try:
            a = self._expect(t1, r1, FXP_ATTRS).attrs()
            if h is None:
                self._expect(t2, r2, FXP_HANDLE)
            if a.is_dir():
                raise SFTPError(4, "Is a directory")
            size = a.size or 0
            if head is None and limit is not None and size > limit:
                return a, None
            # Size 0 can still mean content (/proc and friends): read to EOF then.
            if not size:
                end = head
            else:
                end = size if head is None else min(size, head)
            data = bytearray()
            reader = self._read_handle(h, 0, end)
            try:
                for chunk in reader:
                    data += chunk
                    if head is None and limit is not None and len(data) > limit:
                        return a, None
            finally:
                reader.close()
            return a, bytes(data)
        finally:
            if h is not None:
                self._close_later(h)

    def write_from(self, path, read, overwrite=True, perm=0o644):
        """read(n) -> bytes; returns total bytes written."""
        flags = O_WRITE | O_CREAT | (O_TRUNC if overwrite else O_EXCL)
        h = self.open(path, flags, perm)
        pending, off, err = set(), 0, None
        try:
            while True:
                data = read(CHUNK)
                if not data:
                    break
                pending.add(self._req(FXP_WRITE, s(h) + u64(off) + s(data)))
                off += len(data)
                while len(pending) >= WINDOW:
                    _, rid, r = self._recv_id()
                    pending.discard(rid)
                    self._status(r)
            while pending:
                _, rid, r = self._recv_id()
                pending.discard(rid)
                try:
                    self._status(r)
                except SFTPError as e:
                    err = err or e
            if err:
                raise err
        finally:
            try:
                while pending:
                    _, rid, _ = self._recv_id()
                    pending.discard(rid)
            except Exception:
                pass
            self._close_handle(h)
        return off
