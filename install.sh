#!/usr/bin/env bash
# tmux-server installer — clones the repo, builds it, and (on systemd
# systems) installs it as a user service. No sudo; everything lives under
# $HOME. Safe to re-run: it updates an existing install instead of failing.
#
#   curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/tmux-server/main/install.sh | bash
#
# Override the source repo or install location for testing/forks:
#   TMUX_SERVER_REPO=/path/to/repo TMUX_SERVER_DIR=/tmp/tsv bash install.sh
set -euo pipefail

REPO_URL="${TMUX_SERVER_REPO:-https://github.com/tuanpham-dev/tmux-server.git}"
INSTALL_DIR="${TMUX_SERVER_DIR:-$HOME/.local/share/tmux-server}"
BIN_DIR="$HOME/.local/bin"

if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RESET=""
fi
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()  { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }

heading "Checking dependencies"

command -v git >/dev/null 2>&1 || die "git not found — install it via your package manager"
ok "git found"

command -v tmux >/dev/null 2>&1 || die "tmux not found — install it via your package manager (e.g. apt install tmux, brew install tmux)"
ok "tmux found"

command -v node >/dev/null 2>&1 || die "node not found — install Node.js 20+ (https://nodejs.org)"
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || die "node $NODE_VERSION found, but 20+ is required — install Node.js 20+ (https://nodejs.org)"
ok "node $NODE_VERSION"

TOOLCHAIN_OK=1
{ command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1; } || TOOLCHAIN_OK=0
command -v make >/dev/null 2>&1 || TOOLCHAIN_OK=0
{ command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; } || TOOLCHAIN_OK=0
[ "$TOOLCHAIN_OK" -eq 1 ] || die "missing C/C++ toolchain (need a C compiler, make, and python3) — node-pty won't build. Debian/Ubuntu: apt install build-essential python3. macOS: xcode-select --install"
ok "C/C++ toolchain found"

heading "Installing to $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  ok "existing install found — updating"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR already exists and isn't a tmux-server checkout — remove it or set TMUX_SERVER_DIR to a different path"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
ok "source ready"

heading "Building"
( cd "$INSTALL_DIR" && npm install && npm run build )
ok "build complete"

heading "Installing the tmux-server command"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/tmux-server" "$BIN_DIR/tmux-server"
chmod +x "$INSTALL_DIR/bin/tmux-server"
ok "linked $BIN_DIR/tmux-server -> $INSTALL_DIR/bin/tmux-server"

heading "Service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1; then
  "$INSTALL_DIR/bin/tmux-server" enable
else
  warn "no systemd user session available — start it manually with: tmux-server start"
fi

heading "Done"
PORT_LINE="$(sed -n 's/^PORT=//p' "$INSTALL_DIR/server/.env" 2>/dev/null | tail -n1 | tr -d '[:space:]')"
echo "tmux-server is at http://127.0.0.1:${PORT_LINE:-3001}"
echo "Config (PORT, AUTH_TOKEN, ALLOWED_HOSTS, NEW_SESSION_CWD) goes in $INSTALL_DIR/server/.env — see the README."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Run 'tmux-server doctor' any time to check the install, or 'tmux-server help' for all commands."
