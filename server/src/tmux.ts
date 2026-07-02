import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Synthetic tmux sessions created for per-window tabs (see createWindowTab)
// are grouped with a real session so they share its windows, but are never
// shown as sessions in their own right — filtered out of listSessions().
const WINDOW_TAB_PREFIX = "tmuxserver-view-";

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
}

export interface TmuxSession {
  name: string;
  created: number;
  attached: number;
  windows: TmuxWindow[];
}

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// tmux exits non-zero when its server isn't running, i.e. zero sessions
function emptyIfNoServer(err: unknown): string {
  const msg = (err as Error).message;
  if (/no server running|error connecting/i.test(msg)) return "";
  throw err;
}

const HOME = process.env.HOME ?? "";

function shortenHome(path: string): string {
  if (HOME && (path === HOME || path.startsWith(HOME + "/"))) {
    return "~" + path.slice(HOME.length);
  }
  return path;
}

export async function listSessions(): Promise<TmuxSession[]> {
  const [sessionsOut, windowsOut] = await Promise.all([
    tmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created}\t#{session_attached}",
    ]).catch(emptyIfNoServer),
    tmux([
      "list-windows",
      "-a",
      "-F",
      "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_path}\t#{window_activity_flag}",
    ]).catch(emptyIfNoServer),
  ]);

  const sessions = new Map<string, TmuxSession>();
  for (const line of sessionsOut.split("\n").filter(Boolean)) {
    const [name, created, attached] = line.split("\t");
    if (name.startsWith(WINDOW_TAB_PREFIX)) continue;
    sessions.set(name, {
      name,
      created: Number(created),
      attached: Number(attached),
      windows: [],
    });
  }
  for (const line of windowsOut.split("\n").filter(Boolean)) {
    const [sessionName, index, name, active, cwd, activity] = line.split("\t");
    sessions.get(sessionName)?.windows.push({
      index: Number(index),
      name,
      active: active === "1",
      cwd: shortenHome(cwd),
      activity: activity === "1",
    });
  }
  return [...sessions.values()];
}

export async function createSession(name?: string): Promise<TmuxSession> {
  const args = ["new-session", "-d", "-P", "-F", "#{session_name}"];
  if (name) args.push("-s", name);
  const createdName = (await tmux(args)).trim();
  const sessions = await listSessions();
  const created = sessions.find((s) => s.name === createdName);
  if (!created) throw new Error(`session "${createdName}" not found after create`);
  return created;
}

export async function killSession(name: string): Promise<void> {
  // "=" prefix forces an exact name match instead of tmux's prefix matching
  await tmux(["kill-session", "-t", `=${name}`]);
}

export async function renameSession(name: string, newName: string): Promise<void> {
  await tmux(["rename-session", "-t", `=${name}`, newName]);
}

export async function selectWindow(session: string, index: number): Promise<void> {
  await tmux(["select-window", "-t", `=${session}:${index}`]);
}

export async function killWindow(session: string, index: number): Promise<void> {
  await tmux(["kill-window", "-t", `=${session}:${index}`]);
}

// True for the synthetic per-window-tab sessions created by createWindowTab
// below — the only ones whose attached client needs to watch for its pinned
// window disappearing out from under it (see wsAttach's window-tab watcher).
export function isWindowTabSession(name: string): boolean {
  return name.startsWith(WINDOW_TAB_PREFIX);
}

// The stable id (e.g. "@12") of whatever window `session` currently has
// selected — unlike #{window_index}, this survives window renumbering, so
// it's safe to compare across polls to detect the window changing out from
// under a pinned attach.
export async function currentWindowId(session: string): Promise<string> {
  return (
    await tmux(["display-message", "-t", `=${session}:`, "-p", "#{window_id}"])
  ).trim();
}

export async function createWindow(session: string, cwd?: string): Promise<void> {
  // Without -c, tmux defaults a new window's cwd to the cwd of the process
  // that ran this command — the server's own directory, not the session's —
  // since it's invoked here via execFile rather than from inside a tmux
  // pane. Look up the active pane's path explicitly and pass it as -c.
  const dir = cwd ?? (await tmux(["display-message", "-t", `=${session}:`, "-p", "#{pane_current_path}"])).trim();
  await tmux(["new-window", "-t", `=${session}:`, "-c", dir]);
}

// Creates a tmux session grouped with `session` (sharing its window list)
// and points it at one specific window, giving that window an independently
// trackable "current window" pointer — verified live that grouped sessions
// diverge their curw independently once select-window runs on either side,
// and that killing one member of a group leaves the shared windows alive as
// long as another member remains. Returns the generated session's name,
// which callers attach to instead of `session` itself.
export async function createWindowTab(session: string, index: number): Promise<string> {
  const generated = `${WINDOW_TAB_PREFIX}${randomUUID().slice(0, 8)}`;
  // Note: unlike every other target in this file, new-session's *grouping*
  // target rejects the "=" exact-match prefix ("not found") — verified live.
  // Plain name only for this one call.
  await tmux(["new-session", "-d", "-t", session, "-s", generated]);
  await tmux(["select-window", "-t", `=${generated}:${index}`]);
  return generated;
}

// Idempotent: closing a window-tab (or the idle sweep) may race a second
// close request for the same synthetic session, which should be a no-op
// rather than an error.
export async function killWindowTab(attachName: string): Promise<void> {
  try {
    await tmux(["kill-session", "-t", `=${attachName}`]);
  } catch (err) {
    if (!/session not found/i.test((err as Error).message)) throw err;
  }
}

// Attachment counts for every synthetic window-tab session, used by the
// idle-orphan sweep to decide what's safe to clean up.
export async function listWindowTabAttachment(): Promise<{ name: string; attached: number }[]> {
  const out = await tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_attached}",
  ]).catch(emptyIfNoServer);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, attached] = line.split("\t");
      return { name, attached: Number(attached) };
    })
    .filter((s) => s.name.startsWith(WINDOW_TAB_PREFIX));
}

export async function renameWindow(
  session: string,
  index: number,
  newName: string,
): Promise<void> {
  await tmux(["rename-window", "-t", `=${session}:${index}`, newName]);
}

export interface ScrollState {
  inMode: boolean;
  position: number;
  history: number;
  height: number;
}

// Scroll state of the session's active pane; tmux keeps scrollback
// internally, so this is the only source of truth for a scrollbar.
export async function getScrollState(session: string): Promise<ScrollState> {
  // The trailing colon matters: bare "=session" resolves to nothing for
  // display-message; "=session:" resolves to the session's active pane.
  const out = await tmux([
    "display-message",
    "-t",
    `=${session}:`,
    "-p",
    "#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}",
  ]);
  const [inMode, position, history, height] = out.trim().split("\t");
  return {
    inMode: inMode === "1",
    position: Number(position) || 0,
    history: Number(history) || 0,
    height: Number(height) || 0,
  };
}

// Enters copy-mode (idempotent — safe even if already active) and jumps to
// an absolute history line in one call; goto-line clamps out-of-range values.
export async function scrollTo(session: string, line: number): Promise<void> {
  await tmux([
    "copy-mode",
    "-t",
    `=${session}:`,
    ";",
    "send-keys",
    "-X",
    "-t",
    `=${session}:`,
    "goto-line",
    String(Math.max(0, Math.trunc(line))),
  ]);
}

interface PaneInfo {
  command: string;
  pid: number;
  cwd: string;
}

// The foreground process, pid, and cwd of a session's active pane. pane_pid
// is the pane's original process (usually the login shell); pane_current_command
// is whatever's currently in the foreground (the shell itself, or a program
// it exec'd/forked, like nvim).
async function getActivePane(session: string): Promise<PaneInfo> {
  const out = await tmux([
    "display-message",
    "-t",
    `=${session}:`,
    "-p",
    "#{pane_current_command}\t#{pane_pid}\t#{pane_current_path}",
  ]);
  const [command, pid, cwd] = out.trim().split("\t");
  return { command, pid: Number(pid), cwd };
}

interface ProcInfo {
  ppid: number;
  comm: string;
}

// Scans /proc once for a ppid+comm map of every process on the host. Linux
// only — callers must treat a failure (missing /proc, e.g. on macOS) as
// "unknown" and fall back to the keystroke-injection path.
async function buildProcessMap(): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return map;
  }
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const raw = await readFile(`/proc/${name}/stat`, "utf8");
          // Format: "pid (comm) state ppid ...". comm is parenthesized and
          // may itself contain spaces/parens, so match up to the last ")".
          const m = raw.match(/^\d+\s+\((.*)\)\s+\S+\s+(\d+)/);
          if (!m) return;
          map.set(Number(name), { comm: m[1], ppid: Number(m[2]) });
        } catch {
          // Process exited between readdir and read; ignore.
        }
      }),
  );
  return map;
}

// BFS down the process tree from rootPid (inclusive), collecting every
// process matching predicate in shallowest-first order. Nvim can run as a
// pair of same-named processes (a TUI host plus a nested core that actually
// owns the RPC socket), so the caller needs every match, not just the first.
function findDescendants(
  rootPid: number,
  map: Map<number, ProcInfo>,
  predicate: (comm: string) => boolean,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const [pid, info] of map) {
    const siblings = childrenOf.get(info.ppid) ?? [];
    siblings.push(pid);
    childrenOf.set(info.ppid, siblings);
  }
  const queue = [rootPid];
  const seen = new Set<number>();
  const matches: number[] = [];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = map.get(pid);
    if (info && predicate(info.comm)) matches.push(pid);
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return matches;
}

// Finds the unix-domain socket a running nvim process is listening on, by
// cross-referencing its open socket fds (/proc/<pid>/fd) against the kernel's
// socket table (/proc/net/unix), which lists the bound path alongside each
// listening socket's inode. Returns null if nvim can't be located this way
// (non-Linux host, sandboxed /proc, or nvim started with no default server).
async function readNvimSocketPath(nvimPid: number): Promise<string | null> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${nvimPid}/fd`);
  } catch {
    return null;
  }
  const inodes = new Set<string>();
  await Promise.all(
    fds.map(async (fd) => {
      try {
        const target = await readlink(`/proc/${nvimPid}/fd/${fd}`);
        const m = target.match(/^socket:\[(\d+)\]$/);
        if (m) inodes.add(m[1]);
      } catch {
        // fd closed between readdir and readlink; ignore.
      }
    }),
  );
  if (inodes.size === 0) return null;

  let unixTable: string;
  try {
    unixTable = await readFile("/proc/net/unix", "utf8");
  } catch {
    return null;
  }
  for (const line of unixTable.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const inode = cols[6];
    const socketPath = cols[7];
    if (inode && inodes.has(inode) && socketPath?.includes("nvim")) {
      return socketPath;
    }
  }
  return null;
}

async function findNvimSocket(panePid: number): Promise<string | null> {
  const map = await buildProcessMap();
  const nvimPids = findDescendants(panePid, map, (comm) => comm === "nvim");
  for (const pid of nvimPids) {
    const socket = await readNvimSocketPath(pid);
    if (socket) return socket;
  }
  return null;
}

// "--remote-tab" is "--remote" but opens the file with :tab-edit instead of
// :edit, so it lands in a new tab rather than replacing the pane's current
// buffer.
function nvimRemoteOpen(socket: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "nvim",
      ["--server", socket, "--remote-tab", filePath],
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve();
      },
    );
  });
}

// Backslash-escapes characters vim's cmdline treats specially, so a path with
// spaces or one of these symbols is read as a single filename argument to
// ":tabe" rather than being split or (for "%"/"#") expanded as the alternate
// file.
function escapeForVimCmdline(p: string): string {
  return p.replace(/([ \\%#|"!<])/g, "\\$1");
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

const EDITOR_COMMANDS = new Set(["nvim", "vim"]);
const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"]);

// Opens filePath in the given session's active window, choosing behavior
// from the active pane's current foreground process:
//  - nvim/vim running: reuse it, opening the file in a new tab (RPC
//    "--remote-tab" for nvim when its socket can be found, else Escape +
//    ":tabe" keystrokes as a fallback for plain vim or an unreachable
//    socket).
//  - idle shell: clear any half-typed input (C-u) and type "nvim <path>".
//  - anything else (a busy pane): never inject into it — open nvim in a new
//    tmux window instead, without switching to it (see -d below). Returns
//    that new window's index so the caller can open a dedicated tab for it;
//    every other path returns null (the file opened in an existing window).
export async function openFileInWindow(session: string, filePath: string): Promise<number | null> {
  const pane = await getActivePane(session);
  // Login shells report their command with a leading "-" (e.g. "-zsh").
  const command = pane.command.replace(/^-/, "");
  const target = `=${session}:`;

  if (EDITOR_COMMANDS.has(command)) {
    if (command === "nvim") {
      const socket = await findNvimSocket(pane.pid);
      if (socket) {
        await nvimRemoteOpen(socket, filePath);
        return null;
      }
    }
    await tmux(["send-keys", "-t", target, "Escape"]);
    await tmux(["send-keys", "-t", target, "-l", `:tabe ${escapeForVimCmdline(filePath)}`]);
    await tmux(["send-keys", "-t", target, "Enter"]);
    return null;
  }

  if (SHELL_COMMANDS.has(command)) {
    await tmux(["send-keys", "-t", target, "C-u"]);
    await tmux(["send-keys", "-t", target, "-l", `nvim ${shellQuote(filePath)}`]);
    await tmux(["send-keys", "-t", target, "Enter"]);
    return null;
  }

  // No -c given here would default the new window's cwd to the server
  // process's own directory rather than the session's — same pitfall as
  // createWindow above. Reuse the active pane's cwd we already fetched.
  //
  // -d matters: without it, tmux makes the new window current for `target`
  // — but `session` here may be a window-tab's own synthetic grouped
  // session, whose whole point is staying pinned to the window it was
  // opened for. Without -d, opening a file from a busy window-tab would
  // silently re-point that tab at the new nvim window instead of leaving it
  // alone. The caller opens a proper dedicated tab for the new window
  // instead, using the index -P/-F prints back.
  const out = await tmux([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_index}",
    "-t",
    target,
    "-c",
    pane.cwd,
    `nvim ${shellQuote(filePath)}`,
  ]);
  return Number(out.trim());
}

export async function applyTmuxOptions(): Promise<void> {
  // aggressive-resize: size windows to the largest interested client rather
  // than the smallest attached one, so a small browser viewport doesn't clamp
  // other clients.
  await tmux(["set", "-wg", "aggressive-resize", "on"]).catch(() => {});
  // monitor-activity: window_activity_flag (surfaced in the sidebar as an
  // indicator dot) only ever populates when this is on.
  await tmux(["set", "-wg", "monitor-activity", "on"]).catch(() => {});
  // mouse: without it tmux (an alternate-screen app) makes xterm translate
  // wheel events into arrow keys — scrolling steps through shell history
  // instead of the scrollback. With it, the wheel enters copy-mode and
  // scrolls tmux's own buffer.
  await tmux(["set", "-g", "mouse", "on"]).catch(() => {});
}
