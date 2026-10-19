#!/usr/bin/env bash
# Install sshcode on Debian, Ubuntu and other Debian-based systems.
#
#   curl -fsSL https://raw.githubusercontent.com/kunalpurkayastha/sshcode/main/install.sh | bash
#   ./install.sh                 in a clone: sets up that clone where it is
#   ./install.sh --uninstall     removes the sshcode command again
#
# As a normal user it installs for that user (~/.local/share/sshcode, the command in
# ~/.local/bin) and uses sudo only for apt packages that are missing. As root it
# installs for everyone (/opt/sshcode, /usr/local/bin). Running it again updates.
#
# SSHCODE_REPO, SSHCODE_BRANCH and SSHCODE_DIR change where the code comes from and goes.
set -euo pipefail

REPO="${SSHCODE_REPO:-https://github.com/kunalpurkayastha/sshcode.git}"
BRANCH="${SSHCODE_BRANCH:-main}"
MARK=sshcode-installer  # in .git of a clone this script made, so --uninstall knows it may delete it

USAGE="Install sshcode on a Debian-based system.

  install.sh               install, or update an existing install
  install.sh --uninstall   remove the sshcode command (and the code, if this script downloaded it)

As a normal user: for that user (~/.local/share/sshcode, ~/.local/bin/sshcode).
As root: for everyone (/opt/sshcode, /usr/local/bin/sshcode).
Environment: SSHCODE_REPO, SSHCODE_BRANCH, SSHCODE_DIR."

say() { printf '==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

main() {
  local action=install
  case "${1:-}" in
    "") ;;
    --uninstall) action=uninstall ;;
    -h | --help) echo "$USAGE"; return ;;
    *) die "unknown option $1 (try --help)" ;;
  esac

  if [[ $EUID -eq 0 ]]; then
    umask 022  # the files are shared with every user
    DEST="${SSHCODE_DIR:-/opt/sshcode}"
    BIN=/usr/local/bin
    APPS=/usr/local/share/applications
  else
    DEST="${SSHCODE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/sshcode}"
    BIN="$HOME/.local/bin"
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  fi

  # Run from a clone, that clone is the install; piped from curl, the code is cloned into $DEST.
  HERE=""
  if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
    HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
    [[ -f $HERE/bin/sshcode && -f $HERE/server/app.py ]] || HERE=""
  fi

  "do_$action"
}

do_install() {
  if ! command -v apt-get >/dev/null || ! command -v dpkg >/dev/null; then
    die "this installer needs apt (Debian, Ubuntu, Mint, Pop!_OS, Raspberry Pi OS…). Elsewhere: install
python3 (3.9+), an OpenSSH client and curl, clone the repo, run scripts/vendor.sh and put bin/sshcode on your PATH."
  fi

  local want=()
  [[ -x /usr/bin/python3 ]] || want+=(python3)
  command -v ssh >/dev/null || want+=(openssh-client)
  command -v curl >/dev/null || want+=(curl)
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || want+=(ca-certificates)
  [[ -n $HERE ]] || command -v git >/dev/null || want+=(git)
  if ((${#want[@]})); then
    local sudo=""
    if [[ $EUID -ne 0 ]]; then
      command -v sudo >/dev/null || die "missing ${want[*]}: install them as root (apt-get install ${want[*]}), then run this again"
      sudo=sudo
    fi
    say "Installing ${want[*]} with apt"
    $sudo apt-get update -qq
    $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${want[@]}" >/dev/null
  fi
  /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' ||
    die "sshcode needs Python 3.9 or newer; this system has $(/usr/bin/python3 -V 2>&1)"

  local app
  if [[ -n $HERE ]]; then
    app="$HERE"
    say "Setting up the clone in $app"
  elif [[ -d $DEST/.git ]]; then
    app="$DEST"
    say "Updating $app"
    git -C "$app" pull -q --ff-only || die "couldn't update $app; to start afresh, run this with --uninstall and then again"
  elif [[ -e $DEST && -n "$(ls -A "$DEST")" ]]; then
    die "$DEST exists and isn't a clone of sshcode: move it away or set SSHCODE_DIR"
  else
    app="$DEST"
    say "Downloading sshcode into $app"
    mkdir -p "$(dirname "$app")"
    git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$app"
    touch "$app/.git/$MARK"
  fi
  chmod +x "$app/bin/sshcode" "$app/server/askpass.py" "$app/scripts/vendor.sh"

  say "Fetching the browser libraries (Monaco, xterm.js, fonts)"
  "$app/scripts/vendor.sh"

  if [[ -e $BIN/sshcode && ! -L $BIN/sshcode ]]; then
    die "$BIN/sshcode exists and isn't a link to sshcode: move it away, then run this again"
  fi
  mkdir -p "$BIN" "$APPS"
  ln -sfn "$app/bin/sshcode" "$BIN/sshcode"
  cat >"$APPS/sshcode.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=sshcode
Comment=Editor, files and terminals for your ssh hosts, in the browser
Exec="$BIN/sshcode"
Icon=$app/web/icon.svg
Terminal=false
Categories=Development;Network;
EOF

  say "Installed: $BIN/sshcode"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) echo "    $BIN isn't on your PATH yet (it will be after you log in again);"
       echo "    until then run $BIN/sshcode, or: export PATH=\"$BIN:\$PATH\"" ;;
  esac
  local st line state="${SSHCODE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/sshcode}"
  if [[ $EUID -ne 0 ]] && st="$("$app/bin/sshcode" status 2>/dev/null)" && [[ $st == *"running at"* ]]; then
    while IFS= read -r line; do echo "    $line"; done <<<"$st"
    if [[ $st == *restart* ]]; then
      :  # the launcher has said it
    elif [[ -n "$(find "$app/bin" "$app/server" -type f \( -name '*.py' -o -name sshcode \) -newer "$state/server.json" -print -quit)" ]]; then
      echo "    Its code changed since it started: run sshcode restart (open terminals close), then reload the page."
    else
      echo "    Reload open sshcode pages to use this version."
    fi
  fi
  echo
  echo "Open it with:  sshcode            (starts the server on 127.0.0.1:${SSHCODE_PORT:-8823}, opens the browser)"
  echo "          or:  sshcode HOST [PATH]"
}

do_uninstall() {
  local app="${HERE:-$DEST}"
  [[ -L $BIN/sshcode ]] && app="$(dirname "$(dirname "$(readlink -f "$BIN/sshcode")")")"
  if [[ -x $app/bin/sshcode ]]; then
    "$app/bin/sshcode" stop || true
  fi
  if [[ -L $BIN/sshcode ]]; then
    rm -f "$BIN/sshcode"
    say "Removed $BIN/sshcode"
  fi
  rm -f "$APPS/sshcode.desktop"
  if [[ -f $app/.git/$MARK ]]; then
    rm -rf "$app"
    say "Removed $app"
  elif [[ -d $app ]]; then
    say "Left your clone in $app"
  fi
  if [[ $EUID -ne 0 ]]; then
    local state="${XDG_STATE_HOME:-$HOME/.local/state}/sshcode"
    [[ -d $state ]] && say "Kept $state (login token and log); delete it to forget them"
  fi
  return 0
}

main "$@"
