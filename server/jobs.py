"""Copy and move jobs: between folders on one host, and between hosts.

On one host the host does the work (cp -a / mv). Between hosts the bytes
stream through this process: `tar -c` on the source piped into `tar -x` on
the destination, one stream for everything, so a folder of small files costs
no round trip per file. New items unpack into a hidden folder next to their
target and move into place only once complete, so a cancelled or failed copy
leaves nothing half-written behind. Replace merges into what is there (files
with the same name are overwritten, folders are combined), like scp -r.
"""
import posixpath
import secrets
import threading
import time

import remote

KEEP = 15 * 60                            # finished jobs stay listed this long (s)
SLOTS = threading.BoundedSemaphore(2)     # at most two run at once; the rest queue
MARK = b"SSHCODE-TAR\n"
POLICIES = ("replace", "rename", "skip", "error")


class Cancelled(Exception):
    pass


class JobError(Exception):
    pass


def valid_name(n):
    return isinstance(n, str) and n not in ("", ".", "..") and "/" not in n and "\0" not in n


def valid_dir(d):
    return isinstance(d, str) and d.startswith("/") and posixpath.normpath(d) == d


def tail(lines):
    text = "\n".join(l for l in lines if l.strip())
    return text[-600:].strip()


class Job:
    def __init__(self, hosts, src, dst, mode, policy):
        self.hosts = hosts
        self.id = secrets.token_urlsafe(9)
        self.src_host, self.src_dir, self.names = src["host"], src["dir"], list(src["names"])
        self.dst_host, self.dst_dir = dst["host"], dst["dir"]
        self.mode, self.policy = mode, policy
        self.relay = self.src_host != self.dst_host
        self.state = "queued"
        self.total = None    # bytes expected (between hosts, once counted)
        self.done = 0        # bytes sent so far
        self.items_done = 0
        self.rate = 0.0
        self.error = self.warning = None
        self.created = time.time()
        self.finished = None
        self.targets = []    # names as written at the destination
        self.cancelled = False
        self.procs = []
        self.samples = []

    def info(self):
        return {
            "id": self.id, "mode": self.mode, "relay": self.relay, "state": self.state,
            "src": {"host": self.src_host, "dir": self.src_dir, "names": self.names},
            "dst": {"host": self.dst_host, "dir": self.dst_dir},
            "total": self.total, "done": self.done, "items": len(self.names), "itemsDone": self.items_done,
            "rate": round(self.rate), "error": self.error, "warning": self.warning,
            "created": self.created, "finished": self.finished, "targets": self.targets,
        }

    def cancel(self):
        self.cancelled = True
        for p in list(self.procs):
            if p.poll() is None:
                p.kill()

    # --- running ---------------------------------------------------------------
    def run(self):
        with SLOTS:
            try:
                if self.cancelled:
                    raise Cancelled
                self.state = "running"
                plan = self.plan()
                if plan:
                    if self.relay:
                        self.copy_between(plan)
                    else:
                        self.copy_within(plan)
                self.state = "done"
            except Cancelled:
                self.state = "canceled"
            except Exception as e:
                if self.cancelled:
                    self.state = "canceled"
                else:
                    self.error = str(e) or type(e).__name__
                    self.state = "failed"
            finally:
                self.finished = time.time()
                self.procs = []

    def plan(self):
        """[(name, target name, exists)] after the conflict policy."""
        sess = self.hosts.get(self.dst_host)
        with sess.lock:
            there = {n: a.is_dir() for n, _, a in sess.listdir(self.dst_dir)}
        home = self.hosts.homes.get(self.dst_host)
        same_dir = not self.relay and self.src_dir == self.dst_dir
        used, out = set(there), []
        for n in self.names:
            src = posixpath.join(self.src_dir, n)
            if not self.relay and remote.is_under(self.dst_dir, src):
                raise JobError(f"Can't {self.mode} “{n}” into itself.")
            if same_dir and self.mode == "move":
                continue  # already where it should be
            t, exists = n, n in used
            if exists:
                if same_dir or self.policy == "rename":
                    t, exists = remote.free_name(n, used, there.get(n, False)), False
                elif self.policy == "skip":
                    continue
                elif self.policy == "replace":
                    tgt = posixpath.join(self.dst_dir, n)
                    if home and posixpath.normpath(tgt) == posixpath.normpath(home):
                        raise JobError("Refusing to replace a home folder.")
                    if not self.relay and remote.is_under(src, tgt):
                        raise JobError(f"Can't replace “{n}” with something inside it.")
                else:
                    raise JobError(f"“{n}” already exists in {self.dst_dir}.")
            used.add(t)
            out.append((n, t, exists))
        return out

    def copy_within(self, plan):
        args = [self.mode, "replace" if self.policy == "replace" else "error"]
        for n, t, _ in plan:
            args += [posixpath.join(self.src_dir, n), posixpath.join(self.dst_dir, t)]
        proc = self.hosts.popen(self.dst_host, remote.LOCAL, args)
        self.procs.append(proc)
        err = []
        threading.Thread(target=lambda: err.extend(l.decode("utf-8", "replace") for l in proc.stderr),
                         daemon=True).start()
        for line in proc.stdout:
            if line.strip() == b"ok":
                self.targets.append(plan[self.items_done][1])
                self.items_done += 1
        rc = proc.wait()
        if self.cancelled:
            raise Cancelled
        if rc != 0:
            time.sleep(0.05)
            raise JobError(tail(err) or f"{self.mode} failed ({rc})")

    def copy_between(self, plan):
        names = [n for n, _, _ in plan]
        # Replace merges straight into the folder; otherwise everything lands
        # in a hidden folder first and moves into place once complete.
        direct = any(exists for _, _, exists in plan)
        tmp = None if direct else posixpath.join(self.dst_dir, f".sshcode-{self.id}")
        threading.Thread(target=self.scan, args=(names,), daemon=True).start()
        src_err, dst_err = [], []
        try:
            src = self.hosts.popen(self.src_host, remote.TAR_OUT, [self.src_dir] + ["./" + n for n in names])
            self.procs.append(src)
            dst = self.hosts.popen_feed(self.dst_host, remote.UNTAR, [tmp or self.dst_dir, "0" if direct else "1"])
            self.procs.append(dst)
            for proc, sink in ((src, src_err), (dst, dst_err)):
                threading.Thread(target=lambda p=proc, s=sink: s.extend(
                    l.decode("utf-8", "replace") for l in p.stderr), daemon=True).start()
            try:
                self.pump(src.stdout, dst.stdin)
            except BrokenPipeError:
                pass  # the destination stopped reading; its exit status says why
            finally:
                try:
                    dst.stdin.close()
                except OSError:
                    pass
            rc_src, rc_dst = src.wait(), dst.wait()
            if self.cancelled:
                raise Cancelled
            time.sleep(0.05)  # let the stderr readers catch up
            if rc_src not in (0, 1):
                raise JobError(tail(src_err) or f"reading on {self.src_host} failed ({rc_src})")
            if rc_dst != 0:
                raise JobError(tail(dst_err) or f"writing on {self.dst_host} failed ({rc_dst})")
            if rc_src == 1:
                self.warning = "Some files changed while they were being copied."
            if tmp:
                args = [tmp]
                for n, t, _ in plan:
                    args += [n, posixpath.join(self.dst_dir, t)]
                rc, _, err, _ = self.hosts.run(self.dst_host, remote.PLACE, args, timeout=120)
                if rc != 0:
                    raise JobError(err or f"couldn't move the copy into place ({rc})")
                tmp = None
            self.targets = [t for _, t, _ in plan]
            self.items_done = len(plan)
            if self.total is not None:
                self.total = max(self.total, self.done)
            if self.mode == "move":
                self.remove_sources(names)
        finally:
            for p in self.procs:
                if p.poll() is None:
                    p.kill()
                try:
                    p.wait(5)
                except Exception:
                    pass
            if tmp:
                self.cleanup(tmp)

    def pump(self, src, dst):
        # A login script that prints something puts it before the marker.
        buf = b""
        while MARK not in buf:
            chunk = src.read1(65536)
            if not chunk:
                return
            buf += chunk
            if len(buf) > 1 << 20:
                raise JobError(f"unexpected output from {self.src_host}")
        data = buf[buf.index(MARK) + len(MARK):]
        while True:
            if self.cancelled:
                raise Cancelled
            if data:
                dst.write(data)
                self.done += len(data)
                self.sample()
            data = src.read1(1 << 16)
            if not data:
                dst.flush()
                return

    def sample(self):
        now = time.monotonic()
        s = self.samples
        if s and now - s[-1][0] < 0.25:
            return
        s.append((now, self.done))
        while len(s) > 2 and now - s[0][0] > 4:
            s.pop(0)
        if len(s) > 1 and s[-1][0] > s[0][0]:
            self.rate = (s[-1][1] - s[0][1]) / (s[-1][0] - s[0][0])

    def scan(self, names):
        try:
            rc, out, _, _ = self.hosts.run(self.src_host, remote.SCAN, [self.src_dir] + ["./" + n for n in names],
                                           timeout=120)
            entries, size = (int(x) for x in out.split()[:2])
        except Exception:
            return
        if rc == 0:
            # tar adds a 512-byte header per entry and pads files to 512.
            self.total = max(self.done, size + entries * 768 + 10240)

    def remove_sources(self, names):
        home = self.hosts.homes.get(self.src_host)
        paths = [posixpath.join(self.src_dir, n) for n in names]
        if not all(remote.safe_to_delete(p, home) for p in paths):
            self.warning = "Copied, but the originals were left in place."
            return
        rc, _, err, _ = self.hosts.run(self.src_host, remote.REMOVE, paths, timeout=600)
        if rc != 0:
            self.warning = f"Copied, but removing the originals failed: {err or rc}"

    def cleanup(self, tmp):
        if posixpath.dirname(tmp) == self.dst_dir and posixpath.basename(tmp).startswith(".sshcode-"):
            try:
                self.hosts.run(self.dst_host, remote.REMOVE, [tmp], timeout=60)
            except Exception:
                pass


class Jobs:
    def __init__(self, hosts):
        self.hosts = hosts
        self.lock = threading.Lock()
        self.items = {}

    def conflicts(self, src, dst):
        """Names that already exist where they are going: [{name, dir}]."""
        if src["host"] == dst["host"] and src["dir"] == dst["dir"]:
            return []  # a copy onto itself gets a new name; a move there is a no-op
        sess = self.hosts.get(dst["host"])
        with sess.lock:
            there = {n: a.is_dir() for n, _, a in sess.listdir(dst["dir"])}
        return [{"name": n, "dir": there[n]} for n in src["names"] if n in there]

    def start(self, src, dst, mode, policy):
        job = Job(self.hosts, src, dst, mode, policy)
        with self.lock:
            self._prune()
            self.items[job.id] = job
        threading.Thread(target=job.run, daemon=True).start()
        return job

    def list(self):
        with self.lock:
            self._prune()
            return [j.info() for j in sorted(self.items.values(), key=lambda j: j.created)]

    def cancel(self, jid):
        with self.lock:
            job = self.items.get(jid)
        if job:
            job.cancel()
        return job

    def dismiss(self, ids):
        with self.lock:
            for jid in ids:
                job = self.items.get(jid)
                if job and job.finished:
                    del self.items[jid]

    def _prune(self):
        now = time.time()
        for jid, job in list(self.items.items()):
            if job.finished and now - job.finished > KEEP:
                del self.items[jid]

    def shutdown(self):
        with self.lock:
            jobs = list(self.items.values())
        for j in jobs:
            j.cancel()
