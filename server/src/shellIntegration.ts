// Shell integration (plans/warp-features.md Phase 1): a generated rc snippet
// the user sources from .zshrc/.bashrc. Inside tmux panes it emits OSC 133
// prompt marks — tmux (>= 3.4) tracks these natively, which is what powers
// copy-mode previous-prompt/next-prompt and the app's prompt-jump keys — and
// reports command start/end (command line, cwd, exit code) to
// POST /api/command-events/report for the command-history UI and
// finished-command notifications. Reports are fire-and-forget background
// curls that never block the prompt; with the server down they do nothing.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
);

// Canonical path users source. Port-independent path with the port baked
// into the body, last-boot-wins across instances — same trade-off as
// openUrl.ts's shim, accepted in the plan.
export const shellIntegrationPath = path.join(configDir, "shell-integration.sh");

function shortHome(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// The snippet users add to their rc — surfaced by the Settings card and the
// README so both render the exact same line.
export const shellIntegrationSourceLine = `[ -f ${shortHome(shellIntegrationPath)} ] && . ${shortHome(shellIntegrationPath)}`;

// Every reference to a possibly-unset variable uses the \${VAR-} default
// form: the snippet runs inside arbitrary user rc environments, including
// interactive shells with `set -u`, where a bare "$UNSET" would abort
// sourcing with "unbound variable".
function scriptBody(port: number): string {
  return `# tmux-server shell integration — written by tmux-server at startup; edits
# are overwritten. Source it from your shell rc (zsh or bash):
#   ${shellIntegrationSourceLine}
#
# Inside tmux panes this emits OSC 133 prompt marks (tmux >= 3.4 tracks them
# for copy-mode previous-prompt/next-prompt) and reports command start/end to
# the local tmux-server for command history and finished-command
# notifications. Everything is a no-op outside tmux or in non-interactive
# shells; reports are backgrounded and never block the prompt.

case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
[ -n "\${TMUX_PANE-}" ] || return 0
[ -n "\${_TMUX_SERVER_INTEGRATION-}" ] && return 0
_TMUX_SERVER_INTEGRATION=1

# The subshell keeps the backgrounded curl out of the interactive shell's job
# table (no "[1] 1234" noise, nothing for the shell to reap). The custom
# header is the CSRF guard (same idea as the open-url shim): a cross-origin
# browser request carrying it needs a CORS preflight the server never
# approves, while a local curl sends it freely.
# shell=$$ + a per-shell sequence number let the server pair each end with
# its start: the two reports are independent backgrounded curls, and for a
# fast command the end can genuinely arrive first — without the pair key the
# end would attach to whatever start happened to be latest (observed live
# with nested shells in one pane). The end also re-sends the command text so
# it stands alone when it wins that race.
_tmux_server_report() {
  ( command curl -s -m 1 -X POST -H 'X-Tmux-Server-Events: 1' \\
      --data-urlencode "pane=$TMUX_PANE" \\
      --data-urlencode "shell=$$" \\
      --data-urlencode "seq=\${_TMUX_SERVER_SEQ-0}" \\
      --data-urlencode "event=$1" \\
      --data-urlencode "command=$2" \\
      --data-urlencode "cwd=$PWD" \\
      --data-urlencode "exit=$3" \\
      "http://127.0.0.1:${port}/api/command-events/report" >/dev/null 2>&1 & )
}

# $1 = the command line about to run.
_tmux_server_on_preexec() {
  _TMUX_SERVER_SEQ=$(( \${_TMUX_SERVER_SEQ-0} + 1 ))
  _TMUX_SERVER_CMD="$1"
  _TMUX_SERVER_RAN=1
  printf '\\033]133;C\\033\\\\'
  _tmux_server_report start "$1" ""
}

# $1 = the exit status of the command that just finished. The end report is
# gated on _TMUX_SERVER_RAN so the first prompt after sourcing (no preceding
# command) and empty-line Enters report nothing.
_tmux_server_on_precmd() {
  printf '\\033]133;D;%s\\033\\\\\\033]133;A\\033\\\\' "$1"
  if [ -n "\${_TMUX_SERVER_RAN-}" ]; then
    _TMUX_SERVER_RAN=
    _tmux_server_report end "\${_TMUX_SERVER_CMD-}" "$1"
  fi
}

if [ -n "\${ZSH_VERSION-}" ]; then
  _tmux_server_zsh_preexec() { _tmux_server_on_preexec "$1"; }
  # $? must be captured before anything else runs in the hook body; earlier
  # precmd hooks registered by other tools may still have clobbered it — a
  # known limitation every OSC 133 integration shares.
  _tmux_server_zsh_precmd() { _tmux_server_on_precmd $?; }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _tmux_server_zsh_preexec
  add-zsh-hook precmd _tmux_server_zsh_precmd

elif [ -n "\${BASH_VERSION-}" ]; then
  # Full command line from history — BASH_COMMAND alone would give only the
  # first simple command of a pipeline/compound.
  _tmux_server_bash_command() {
    HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed '1 s/^ *[0-9][0-9]*[* ] *//'
  }

  if declare -p preexec_functions >/dev/null 2>&1; then
    # bash-preexec is loaded — compose with it instead of owning the DEBUG
    # trap ourselves. It passes the command as $1 and preserves $? for
    # precmd functions.
    _tmux_server_bp_preexec() { _tmux_server_on_preexec "$1"; }
    _tmux_server_bp_precmd() { _tmux_server_on_precmd $?; }
    preexec_functions+=(_tmux_server_bp_preexec)
    precmd_functions+=(_tmux_server_bp_precmd)
  else
    # Minimal preexec emulation: PROMPT_COMMAND provides precmd; a DEBUG
    # trap provides preexec. _TMUX_SERVER_AT_PROMPT arms exactly one DEBUG
    # firing per displayed prompt — the user's command — and the guards
    # below reject the firings that aren't it (our own hook functions, the
    # user's pre-existing PROMPT_COMMAND entries re-running on an empty-line
    # Enter, and subshells like PS1 command substitutions).
    _tmux_server_bash_preexec() {
      [ -n "\${_TMUX_SERVER_AT_PROMPT-}" ] || return 0
      [ "$BASH_SUBSHELL" = 0 ] || return 0
      case "$BASH_COMMAND" in _tmux_server_*) return 0 ;; esac
      case ";\${PROMPT_COMMAND-};" in *";$BASH_COMMAND;"*) return 0 ;; esac
      _TMUX_SERVER_AT_PROMPT=
      _tmux_server_on_preexec "$(_tmux_server_bash_command)"
    }
    _tmux_server_bash_precmd() {
      _tmux_server_on_precmd $?
    }
    _tmux_server_arm() {
      _TMUX_SERVER_AT_PROMPT=1
    }
    # Ours first so $? is still the user command's status; arm last so the
    # DEBUG firings for the intervening PROMPT_COMMAND entries can't pass
    # the at-prompt guard.
    PROMPT_COMMAND="_tmux_server_bash_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND};_tmux_server_arm"

    # Chain any pre-existing DEBUG trap rather than clobbering it. trap -p
    # prints "trap -- '<shell-quoted body>' DEBUG"; the eval unquotes the
    # body safely regardless of embedded quotes.
    _tmux_server_prev_trap=$(trap -p DEBUG)
    if [ -n "$_tmux_server_prev_trap" ]; then
      _tmux_server_prev_trap=\${_tmux_server_prev_trap#trap -- }
      _tmux_server_prev_trap=\${_tmux_server_prev_trap% DEBUG}
      eval "_TMUX_SERVER_PREV_DEBUG=$_tmux_server_prev_trap"
    fi
    unset _tmux_server_prev_trap
    _tmux_server_debug_hook() {
      _tmux_server_bash_preexec
      if [ -n "\${_TMUX_SERVER_PREV_DEBUG-}" ]; then eval "$_TMUX_SERVER_PREV_DEBUG"; fi
    }
    trap '_tmux_server_debug_hook' DEBUG
  fi
fi
`;
}

// Best-effort at boot, same contract as ensureOpenShim: a read-only config
// dir just disables the feature (index.ts logs and continues).
export async function ensureShellIntegration(port: number): Promise<string> {
  await mkdir(configDir, { recursive: true });
  await writeFile(shellIntegrationPath, scriptBody(port));
  return shellIntegrationPath;
}
