"""Hosts and remote operations.

Everything goes through the system `ssh` binary with one ControlMaster per
host, so ProxyJump, ProxyCommand, keys, agents and known_hosts work exactly
as they do in a terminal. SFTP covers file access. A few small POSIX sh
scripts cover the rest (file list, search, recursive delete, copy, tar). They
are fed to `sh` on stdin, so the remote login shell (bash, zsh, fish…) never
has to parse them.
"""
import codecs
import glob
import json
import os
import posixpath
import secrets
import shlex
import subprocess
import threading

from sftp import SFTP, SFTPError, ConnectError, ST_NOFILE

HERE = os.path.dirname(os.path.realpath(__file__))
SSH_CONFIG = os.environ.get("SSHCODE_SSH_CONFIG")  # optional alternate config (-F)
RUNDIR = os.environ.get("SSHCODE_RUNDIR") or os.path.join(
    os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/sshcode-{os.getuid()}", "sshcode")
MAX_EDIT = 16 << 20  # largest file the editor will open


# --------------------------------------------------------------------------
# ssh config: list host aliases (OpenSSH resolves everything else via -G)
# --------------------------------------------------------------------------
def config_path():
    return SSH_CONFIG or os.path.expanduser("~/.ssh/config")


def parse_hosts(path, seen=None, depth=0):
    seen = seen if seen is not None else set()
    hosts = []
    if depth > 16 or path in seen:
        return hosts
    seen.add(path)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return hosts
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            parts = shlex.split(line.replace("=", " ", 1), comments=True)
        except ValueError:
            continue
        if not parts:
            continue
        key, args = parts[0].lower(), parts[1:]
        if key == "include":
            for pat in args:
                pat = os.path.expanduser(pat)
                if not os.path.isabs(pat):
                    pat = os.path.join(os.path.expanduser("~/.ssh"), pat)
                for p in sorted(glob.glob(pat)):
                    hosts += parse_hosts(p, seen, depth + 1)
        elif key == "host":
            for a in args:
                if not any(c in a for c in "*?!") and a not in hosts:
                    hosts.append(a)
    return hosts


def ssh_base():
    os.makedirs(RUNDIR, mode=0o700, exist_ok=True)
    argv = ["ssh"]
    if SSH_CONFIG:
        argv += ["-F", SSH_CONFIG]
    return argv + [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={RUNDIR}/cm-%C",
        "-o", "ControlPersist=600",
        "-o", "ServerAliveInterval=15",
        "-o", "ConnectTimeout=20",
    ]


def resolve(alias):
    try:
        out = subprocess.run(ssh_base() + ["-G", "--", alias], capture_output=True,
                             text=True, timeout=10).stdout
    except Exception:
        return {"alias": alias}
    cfg = {}
    for line in out.splitlines():
        k, _, v = line.partition(" ")
        cfg.setdefault(k, v)
    jump = cfg.get("proxyjump", "")
    if jump == "none":
        jump = ""
    pc = cfg.get("proxycommand", "")
    if pc == "none":
        pc = ""
    return {
        "alias": alias,
        "hostname": cfg.get("hostname", alias),
        "user": cfg.get("user", ""),
        "port": cfg.get("port", "22"),
        "jump": jump,
        "proxycommand": bool(pc),
    }


# --------------------------------------------------------------------------
# Connections
# --------------------------------------------------------------------------
class NeedsAuth(Exception):
    def __init__(self, kind, prompt, error, wrong=False, host=""):
        super().__init__(error)
        self.kind, self.prompt, self.error, self.wrong, self.host = kind, prompt, error, wrong, host


def valid_alias(host):
    # Refuse anything ssh could read as an option or that isn't a plain target.
    return bool(host) and not host.startswith("-") and not any(c.isspace() for c in host)


def ssh_env(prompt_file=os.devnull, secrets_file="", accept_hostkey=False):
    # Prompts never reach a terminal: they go to askpass.py, which answers
    # from what the web UI supplied and records what was asked.
    env = dict(os.environ)
    env.update({
        "SSH_ASKPASS": os.path.join(HERE, "askpass.py"),
        "SSH_ASKPASS_REQUIRE": "force",
        "DISPLAY": env.get("DISPLAY") or ":0",
        "SSHCODE_PROMPT_FILE": prompt_file,
        "SSHCODE_SECRETS_FILE": secrets_file,
        "SSHCODE_ACCEPT_HOSTKEY": "1" if accept_hostkey else "0",
    })
    return env


def is_hostkey_prompt(p):
    return "(yes/no" in p or "fingerprint" in p.lower()


def open_sftp(host, answers=None, accept_hostkey=False):
    """answers: {prompt text: reply}. One entry per prompt, so a jump host and
    the target can each have their own password."""
    if not valid_alias(host):
        raise ConnectError("invalid host")
    tag = secrets.token_hex(6)
    os.makedirs(RUNDIR, mode=0o700, exist_ok=True)
    prompt_file = os.path.join(RUNDIR, f"prompt-{tag}")
    secrets_file = os.path.join(RUNDIR, f"answers-{tag}")
    fd = os.open(secrets_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(answers or {}, f)
    env = ssh_env(prompt_file, secrets_file, accept_hostkey)
    try:
        return SFTP(ssh_base() + ["-s", "--", host, "sftp"], env=env)
    except ConnectError as e:
        hist = []
        try:
            with open(prompt_file, encoding="utf-8") as f:
                hist = [json.loads(l) for l in f if l.strip()]
        except (OSError, ValueError):
            pass
        err = str(e)
        # A prompt asked again after we answered it means that answer was wrong.
        wrong = next((h["prompt"] for h in hist if h["status"] == "retry"), None)
        if wrong:
            raise NeedsAuth("password", wrong, "Wrong answer for this prompt.", wrong=True)
        missing = next((h["prompt"] for h in hist if h["status"] == "refused"), None)
        if missing and is_hostkey_prompt(missing):
            raise NeedsAuth("hostkey", missing, err)
        if missing:
            raise NeedsAuth("password", missing, "")
        if hist and "Permission denied" in err:
            # Everything was answered but the server still said no.
            raise NeedsAuth("password", hist[-1]["prompt"], err, wrong=True)
        raise NeedsAuth("error", "", err)
    finally:
        for p in (prompt_file, secrets_file):
            try:
                os.unlink(p)
            except OSError:
                pass


class Hosts:
    def __init__(self):
        self.lock = threading.Lock()
        self.sessions = {}
        self.background = {}  # host -> second SFTP session for polling and prefetch
        self.bg_lock = threading.Lock()
        self.homes = {}
        self.used = set()
        self.answers = {}  # host -> {prompt: reply}, kept in memory for reconnects

    def connect(self, host, answers=None, accept_hostkey=False):
        try:
            sess = open_sftp(host, answers, accept_hostkey)
        except NeedsAuth:
            self.answers.pop(host, None)
            raise
        if answers:
            self.answers[host] = dict(answers)
        with self.lock:
            old = self.sessions.pop(host, None)
            self.sessions[host] = sess
            self.used.add(host)
        if old:
            old.close()
        with sess.lock:
            home = sess.realpath(".")
        self.homes[host] = home
        return home

    def connected(self, host):
        with self.lock:
            sess = self.sessions.get(host)
        return bool(sess and sess.alive)

    def get(self, host, background=False):
        """The host's SFTP session. Background work (refreshes, prefetch) gets
        its own channel, so it never queues in front of what you clicked."""
        if background:
            with self.bg_lock:  # one creator at a time, or a racer could close another's session
                sess = self.background.get(host)
                if sess and sess.alive:
                    return sess
                self.get(host)  # the foreground session owns sign-in and reconnects
                if sess:
                    sess.close()
                sess = self.background[host] = open_sftp(host, self.answers.get(host))
                return sess
        with self.lock:
            sess = self.sessions.get(host)
        if sess and sess.alive:
            return sess
        # Reconnect silently through the control master if possible.
        try:
            sess = open_sftp(host, self.answers.get(host))
        except NeedsAuth as e:
            raise NeedsAuth(e.kind, e.prompt, e.error or "not connected", host=host)
        with self.lock:
            self.sessions[host] = sess
            self.used.add(host)
        return sess

    def transfer(self, host):
        """A dedicated session for one long transfer (multiplexed, no re-auth)."""
        self.get(host)
        return open_sftp(host, self.answers.get(host))

    def disconnect(self, host):
        with self.lock:
            sess = self.sessions.pop(host, None)
        with self.bg_lock:  # never nested with self.lock here: get() takes them bg_lock first
            bg = self.background.pop(host, None)
        for s_ in (sess, bg):
            if s_:
                s_.close()
        self.answers.pop(host, None)
        subprocess.run(ssh_base() + ["-O", "exit", "--", host], capture_output=True, timeout=10)

    def shutdown(self):
        for h in list(self.used):
            try:
                self.disconnect(h)
            except Exception:
                pass

    # --- shell scripts over the control master ------------------------------
    def popen(self, host, script, args=()):
        """Start `sh` on the host with `script` on stdin and "$@" = args."""
        if not valid_alias(host):
            raise ConnectError("invalid host")
        self.get(host)  # make sure the master is up (raises NeedsAuth otherwise)
        head = "set -- " + " ".join(shlex.quote(str(a)) for a in args) + "\n"
        proc = subprocess.Popen(ssh_base() + ["-T", "--", host, "sh"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ssh_env(),
                                start_new_session=True)
        try:
            proc.stdin.write((head + script + "\n").encode("utf-8", "surrogateescape"))
            proc.stdin.close()
        except OSError:
            pass
        return proc

    def popen_feed(self, host, line, args=()):
        """Like popen, for a script that reads stdin itself: the remote sh
        reads one line (`read` never takes more), evals it, and whatever is
        written to the returned process's stdin after that is the command's
        input. The fixed command parses the same in any login shell."""
        if not valid_alias(host):
            raise ConnectError("invalid host")
        head = "set -- " + " ".join(shlex.quote(str(a)) for a in args) + "; " + line
        if "\n" in head:
            raise ValueError("names with line breaks can't be copied between servers")
        self.get(host)
        proc = subprocess.Popen(ssh_base() + ["-T", "--", host, "sh -c 'IFS= read -r s; eval \"$s\"'"],
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                env=ssh_env(), start_new_session=True)
        proc.stdin.write((head + "\n").encode("utf-8", "surrogateescape"))
        proc.stdin.flush()
        return proc

    def run(self, host, script, args=(), timeout=30, limit=8 << 20):
        """-> (exit code, stdout bytes, stderr text, cut short?)"""
        proc = self.popen(host, script, args)
        out, err, cut = bytearray(), bytearray(), [False]

        def pump_out():
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    return
                out.extend(chunk)
                if len(out) >= limit:
                    cut[0] = True
                    return

        def pump_err():
            for line in proc.stderr:
                if len(err) < 65536:
                    err.extend(line)

        t_out = threading.Thread(target=pump_out, daemon=True)
        t_err = threading.Thread(target=pump_err, daemon=True)
        t_out.start()
        t_err.start()
        t_out.join(timeout)
        if t_out.is_alive() or cut[0]:
            cut[0] = True
            proc.kill()
        t_out.join(5)
        t_err.join(5)
        try:
            rc = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = -1
        return rc, bytes(out[:limit]), err.decode("utf-8", "replace").strip(), cut[0]


# --------------------------------------------------------------------------
# File operations (callers hold sess.lock)
# --------------------------------------------------------------------------
class Conflict(Exception):
    def __init__(self, attrs):
        super().__init__("The file changed on the server.")
        self.mtime, self.size = attrs.mtime, attrs.size


def list_dir(sess, path):
    # Paths from the page are already absolute and clean: skip the realpath
    # round trip (and keep the name the user went to, symlink or not).
    if not (path.startswith("/") and posixpath.normpath(path) == path):
        path = sess.realpath(path)
    raw = sess.listdir(path)
    links = [name for name, _, a in raw if a.is_link()]
    resolved = dict(zip(links, sess.links_info([posixpath.join(path, n) for n in links]))) if links else {}
    entries = []
    for name, _, a in raw:
        kind, target = ("dir" if a.is_dir() else "file"), None
        if name in resolved:
            target, t = resolved[name]
            if t is None:
                kind = "broken"
            else:
                kind = "linkdir" if t.is_dir() else "link"
                a.size, a.mtime = t.size, t.mtime
        entries.append({"name": name, "type": kind, "size": a.size, "mtime": a.mtime,
                        "perm": a.perm, "target": target})
    return path, entries


def read_text(sess, path, lossy=False, head=None):
    """Text for the editor. lossy: decode anything (binary shown read-only);
    head: only the first `head` bytes of a file too large to open whole."""
    a, data = sess.read_file(path, limit=MAX_EDIT, head=head)
    info = {"path": path, "size": a.size or 0, "mtime": a.mtime}
    if data is None:
        info["tooLarge"] = True
        return info
    bom = data.startswith(codecs.BOM_UTF8)
    body = data[3:] if bom else data
    if lossy or head:
        info["text"] = body.decode("utf-8", "replace").replace("\0", "␀")
        info["readonly"] = True
        info["truncated"] = bool(head) and (a.size or 0) > len(data)
        info["bom"] = bom
        return info
    if b"\0" in body[:8192]:
        info["binary"] = True
        return info
    try:
        info["text"] = body.decode("utf-8")
    except UnicodeDecodeError:
        info["binary"] = True
        info["encoding"] = "unknown"
        return info
    info["bom"] = bom
    return info


def try_stat(sess, path):
    try:
        return sess.stat(path)
    except SFTPError as e:
        if e.code != ST_NOFILE:
            raise
        return None


def exists(sess, path):
    try:
        sess.lstat(path)
        return True
    except SFTPError as e:
        if e.code != ST_NOFILE:
            raise
        return False


def write_bytes(sess, path, payload, overwrite=True):
    view, pos = memoryview(payload), 0

    def read(n):
        nonlocal pos
        chunk = view[pos:pos + n]
        pos += len(chunk)
        return bytes(chunk)

    # No permission attrs: an existing file keeps its mode, a new one gets the
    # remote umask, like any editor saving in place.
    sess.write_from(path, read, overwrite=overwrite, perm=None)


def write_text(sess, path, text, bom=False, expect=None):
    data = text.encode("utf-8", "replace")
    cur = try_stat(sess, path)
    if expect and cur is not None and (cur.mtime, cur.size) != (expect.get("mtime"), expect.get("size")):
        raise Conflict(cur)
    write_bytes(sess, path, (codecs.BOM_UTF8 if bom else b"") + data)
    a = sess.stat(path)
    return {"mtime": a.mtime, "size": a.size}


class Exists(Exception):
    pass


def upload(sess, path, read, overwrite=False):
    """Write under a temporary name and move into place when complete, so a
    cancelled upload leaves nothing behind and a replaced file keeps its
    permissions. -> bytes written"""
    try:
        cur = sess.lstat(path)
    except SFTPError as e:
        if e.code != ST_NOFILE:
            raise
        cur = None
    if cur is not None and not overwrite:
        raise Exists(path)
    if cur is not None and cur.is_link():
        # Write through the link, as an editor would.
        return sess.write_from(path, read, overwrite=True, perm=None)
    d, name = posixpath.split(path)
    tmp = posixpath.join(d, f".{name}.{secrets.token_hex(3)}.part")
    try:
        n = sess.write_from(tmp, read, overwrite=False, perm=None)
        if cur is not None:
            if cur.perm is not None:
                sess.chmod(tmp, cur.perm)
            sess.replace(tmp, path)
        else:
            sess.rename(tmp, path)  # fails rather than clobbers if it appeared meanwhile
    except BaseException:
        try:
            sess.remove(tmp)
        except Exception:
            pass
        raise
    return n


def create(sess, path, is_dir, parents=False):
    if exists(sess, path):
        raise SFTPError(4, f"'{posixpath.basename(path)}' already exists")
    if parents:
        sess.makedirs(posixpath.dirname(path))
    if is_dir:
        sess.mkdir(path)
    else:
        write_bytes(sess, path, b"", overwrite=False)


def rename(sess, src, dst):
    if exists(sess, dst):
        raise SFTPError(4, f"'{posixpath.basename(dst)}' already exists")
    sess.rename(src, dst)


def stat_many(sess, paths):
    out = {}
    for p in paths:
        a = try_stat(sess, p)
        out[p] = None if a is None else {"mtime": a.mtime, "size": a.size,
                                         "type": "dir" if a.is_dir() else "file"}
    return out


# --------------------------------------------------------------------------
# Scripts
# --------------------------------------------------------------------------
# Directories nobody wants in Go to File / Find in Files.
SKIP_DIRS = [".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox",
             ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache", ".npm", ".yarn",
             ".pnpm-store", ".conda", ".Trash", ".vscode-server", ".cursor-server", ".rustup",
             ".cargo", "bower_components", ".next", ".nuxt", ".gradle", ".m2", "anaconda3",
             "miniconda3", "miniforge3", "mambaforge", ".pyenv", ".nvm", "snap"]

_RG_SKIP = " ".join(f"--glob '!{d}'" for d in SKIP_DIRS)
_FIND_SKIP = " -o ".join(f"-name '{d}'" for d in SKIP_DIRS)
_GREP_SKIP = " ".join(f"--exclude-dir='{d}'" for d in SKIP_DIRS)
# Kernel and runtime filesystems, skipped when the folder is "/" itself.
ROOT_SKIP = ["proc", "sys", "dev", "run", "snap"]


def for_root(script, root):
    """Fill the @…@ slots: anchored excludes for a search from "/", else nothing."""
    top = posixpath.normpath(root) == "/"
    return (script
            .replace("@RG_EXTRA@", "".join(f" --glob '!/{d}'" for d in ROOT_SKIP) if top else "")
            .replace("@FIND_EXTRA@", "".join(f" -o -path './{d}'" for d in ROOT_SKIP) if top else "")
            .replace("@GREP_EXTRA@", "".join(f" --exclude-dir='{d}'" for d in ROOT_SKIP) if top else ""))


FIND_FILES = f"""
cd "$1" 2>/dev/null || {{ echo "cannot open $1" >&2; exit 2; }}
if command -v rg >/dev/null 2>&1; then
  rg --files --hidden --no-messages {_RG_SKIP}@RG_EXTRA@ </dev/null 2>/dev/null
else
  find . \\( {_FIND_SKIP}@FIND_EXTRA@ \\) -prune -o -type f -print </dev/null 2>/dev/null | sed 's|^\\./||'
fi | head -n "$2"
"""

SEARCH = f"""
cd "$1" 2>/dev/null || {{ echo "cannot open $1" >&2; exit 2; }}
q=$2 o=$3 n=$4
c=0 w=0 r=0
case $o in *c*) c=1;; esac
case $o in *w*) w=1;; esac
case $o in *r*) r=1;; esac
if command -v rg >/dev/null 2>&1; then
  set -- --line-number --no-heading --with-filename --null --color=never --max-columns=400 \\
    --max-columns-preview --max-count=200 --hidden --no-messages {_RG_SKIP}@RG_EXTRA@
  if [ $c = 1 ]; then set -- "$@" --case-sensitive; else set -- "$@" --ignore-case; fi
  if [ $w = 1 ]; then set -- "$@" --word-regexp; fi
  if [ $r = 0 ]; then set -- "$@" --fixed-strings; fi
  rg "$@" -e "$q" . </dev/null 2>/dev/null
else
  set -- -rnIH --null -m 200 {_GREP_SKIP}@GREP_EXTRA@
  if [ $c = 0 ]; then set -- "$@" -i; fi
  if [ $w = 1 ]; then set -- "$@" -w; fi
  if [ $r = 1 ]; then set -- "$@" -E; else set -- "$@" -F; fi
  grep "$@" -e "$q" . </dev/null 2>/dev/null
fi | head -n "$n"
"""

REMOVE = 'rm -rf -- "$@" </dev/null'

COPY = """
if [ -e "$2" ] || [ -L "$2" ]; then echo "'$2' already exists" >&2; exit 17; fi
cp -a -- "$1" "$2" </dev/null
"""

TAR = 'd=$1; shift; cd "$d" && exec tar -czf - -- "$@" </dev/null'


def find_files(hosts, host, root, limit=50000):
    rc, out, err, cut = hosts.run(host, for_root(FIND_FILES, root), [root, limit], timeout=20)
    if rc == 2:
        raise SFTPError(ST_NOFILE, err or "folder not found")
    files = [l for l in out.decode("utf-8", "surrogateescape").split("\n") if l]
    return {"files": files, "truncated": cut or len(files) >= limit}


def search(hosts, host, root, query, case=False, word=False, regex=False, limit=4000):
    opts = ("c" if case else "") + ("w" if word else "") + ("r" if regex else "")
    rc, out, err, cut = hosts.run(host, for_root(SEARCH, root), [root, query, opts, limit], timeout=30)
    if rc == 2:
        raise SFTPError(ST_NOFILE, err or "folder not found")
    matches = []
    for raw in out.split(b"\n"):
        if not raw:
            continue
        if b"\0" in raw:
            path, _, rest = raw.partition(b"\0")
        else:  # grep without --null support: path:line:text
            path, _, rest = raw.partition(b":")
        num, _, text = rest.partition(b":")
        try:
            line = int(num)
        except ValueError:
            continue
        p = path.decode("utf-8", "surrogateescape")
        if p.startswith("./"):
            p = p[2:]
        matches.append({"path": p, "line": line,
                        "text": text.decode("utf-8", "replace")[:400]})
    return {"matches": matches, "truncated": cut or len(matches) >= limit}


def is_under(p, d):
    p, d = posixpath.normpath(p), posixpath.normpath(d)
    return p == d or p.startswith(d.rstrip("/") + "/")


def free_name(name, taken, is_dir=False):
    """“name copy.ext”, “name copy 2.ext”… — the first one not in `taken`."""
    dot = name.rfind(".")
    stem, ext = (name[:dot], name[dot:]) if dot > 0 and not is_dir else (name, "")
    for i in range(1, 10000):
        cand = f"{stem} copy{'' if i == 1 else ' ' + str(i)}{ext}"
        if cand not in taken:
            return cand
    raise ValueError("no free name")


# Copy or move on one host. Args: mode policy, then (source, target) pairs;
# a "replace" over a folder merges into it, like scp -r.
LOCAL = """
mode=$1 pol=$2; shift 2
while [ $# -ge 2 ]; do
  s=$1 t=$2; shift 2
  if [ -e "$t" ] || [ -L "$t" ]; then
    if [ "$pol" != replace ]; then echo "'${t##*/}' already exists" >&2; exit 17; fi
    if [ -d "$t" ] && [ ! -L "$t" ] && [ -d "$s" ] && [ ! -L "$s" ]; then
      cp -a -- "$s/." "$t/" </dev/null || exit 1
      if [ "$mode" = move ]; then rm -rf -- "$s" </dev/null || exit 1; fi
      echo ok; continue
    fi
    rm -rf -- "$t" </dev/null || exit 1
  fi
  if [ "$mode" = move ]; then mv -- "$s" "$t" </dev/null || exit 1
  else cp -a -- "$s" "$t" </dev/null || exit 1; fi
  echo ok
done
"""

# Between hosts: the source streams a tar after a marker line (anything a
# chatty login script prints comes before it and is skipped)…
TAR_OUT = 'd=$1; shift; cd "$d" || exit 2; printf "SSHCODE-TAR\\n"; exec tar -cf - "$@" </dev/null'
# …the destination unpacks it (one line: see Hosts.popen_feed)…
# GNU and BSD tar keep the exact permissions (-p); busybox tar applies the umask.
UNTAR = ('if [ "$2" = 1 ]; then mkdir "$1" || exit 1; fi; cd "$1" || exit 1; '
         'if tar --version </dev/null 2>/dev/null | grep -q -e GNU -e bsdtar; then exec tar -xpof -; fi; '
         'exec tar -xof -')
# …and new items move from the hidden folder into place: tmp, then pairs.
PLACE = """
tmp=$1; shift
while [ $# -ge 2 ]; do
  if [ -e "$2" ] || [ -L "$2" ]; then echo "'${2##*/}' already exists" >&2; exit 17; fi
  mv -- "$tmp/$1" "$2" </dev/null || exit 1
  shift 2
done
rm -rf -- "$tmp"
"""
# How much is coming: "entries bytes" (du -b is GNU; -k elsewhere).
SCAN = """
d=$1; shift
cd "$d" || exit 2
n=$(find "$@" 2>/dev/null </dev/null | wc -l)
b=$(du -sb "$@" 2>/dev/null </dev/null | awk '{s+=$1} END {print s+0}')
case $b in ''|0) b=$(du -sk "$@" 2>/dev/null </dev/null | awk '{s+=$1} END {print s*1024}');; esac
echo "$n $b"
"""


def safe_to_delete(path, home):
    p = posixpath.normpath(path)
    return p not in ("/", ".", "", posixpath.normpath(home or "/"))
