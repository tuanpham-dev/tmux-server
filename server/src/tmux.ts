import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Synthetic tmux sessions created for per-window tabs (see createWindowTab)
// are grouped with a real session so they share its windows, but are never
// shown as sessions in their own right — filtered out of listSessions().
const WINDOW_TAB_PREFIX = "tmuxserver-view-";

export interface TmuxWindow {
  // Stable tmux id ("@12") — survives renumbering, unlike index. Lets the
  // client re-target a tab whose window moved without losing track of it.
  id: string;
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
}

export interface TmuxSession {
  // Stable tmux id ("$3") — survives rename, unlike name. Lets the client
  // re-target a tab whose session was renamed out-of-band instead of the
  // tab silently going stale.
  id: string;
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
      "#{session_id}\t#{session_name}\t#{session_created}\t#{session_attached}",
    ]).catch(emptyIfNoServer),
    tmux([
      "list-windows",
      "-a",
      "-F",
      "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_path}\t#{window_activity_flag}",
    ]).catch(emptyIfNoServer),
  ]);

  const sessions = new Map<string, TmuxSession>();
  for (const line of sessionsOut.split("\n").filter(Boolean)) {
    const [id, name, created, attached] = line.split("\t");
    if (name.startsWith(WINDOW_TAB_PREFIX)) continue;
    sessions.set(name, {
      id,
      name,
      created: Number(created),
      attached: Number(attached),
      windows: [],
    });
  }
  for (const line of windowsOut.split("\n").filter(Boolean)) {
    const [sessionName, id, index, name, active, cwd, activity] = line.split("\t");
    sessions.get(sessionName)?.windows.push({
      id,
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
  // Without -c, tmux starts the session in this server process's own cwd
  // (the server/ folder) — same pitfall as createWindow below. NEW_SESSION_CWD
  // comes from server/.env (loaded in index.ts).
  const cwd = process.env.NEW_SESSION_CWD;
  if (cwd) args.push("-c", cwd);
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

export interface AttachIdentity {
  sessionId: string;
  windowId: string;
}

// The stable ids (e.g. "$3" / "@12") of the attached session and whatever
// window it currently has selected — unlike names and indexes, these survive
// session renames and window renumbering, so the attach watcher can compare
// them across polls and use them as unambiguous command targets.
export async function getAttachIdentity(session: string): Promise<AttachIdentity> {
  const out = await tmux([
    "display-message",
    "-t",
    `=${session}:`,
    "-p",
    "#{session_id}\t#{window_id}",
  ]);
  const [sessionId, windowId] = out.trim().split("\t");
  return { sessionId, windowId };
}

export interface TmuxClient {
  pid: number;
  tty: string;
  sessionId: string;
}

// Every attached tmux client. client_pid is the pid of the client process
// itself — for attaches spawned by this server, exactly node-pty's term.pid,
// which is how the attach watcher matches clients to WS connections.
export async function listClients(): Promise<TmuxClient[]> {
  const out = await tmux([
    "list-clients",
    "-F",
    "#{client_pid}\t#{client_tty}\t#{session_id}",
  ]).catch(emptyIfNoServer);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, tty, sessionId] = line.split("\t");
      return { pid: Number(pid), tty, sessionId };
    });
}

export interface SessionCurrentWindow {
  name: string;
  windowId: string;
  windowIndex: number;
}

// In list-sessions' format context, window_* expands to each session's
// *current* window — one call yields every session's current window (id and
// index), keyed by stable session id. Verified live on tmux 3.5a.
export async function listSessionCurrentWindows(): Promise<Map<string, SessionCurrentWindow>> {
  const out = await tmux([
    "list-sessions",
    "-F",
    "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}",
  ]).catch(emptyIfNoServer);
  const map = new Map<string, SessionCurrentWindow>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [sessionId, name, windowId, windowIndex] = line.split("\t");
    map.set(sessionId, { name, windowId, windowIndex: Number(windowIndex) });
  }
  return map;
}

// Window ids of the session's whole window list — for a grouped window-tab
// session this is the shared set, so a pinned id missing from it means the
// pinned window itself is gone (not merely deselected).
export async function listGroupWindowIds(sessionId: string): Promise<string[]> {
  const out = await tmux(["list-windows", "-t", sessionId, "-F", "#{window_id}"]);
  return out.split("\n").filter(Boolean);
}

// Verified live: a "$id:@id" target resolves the window within the given
// session even when the window is shared across a session group.
export async function selectWindowById(sessionId: string, windowId: string): Promise<void> {
  await tmux(["select-window", "-t", `${sessionId}:${windowId}`]);
}

// Re-points one specific client (by tty, from listClients) at a session.
export async function switchClient(tty: string, sessionId: string): Promise<void> {
  await tmux(["switch-client", "-c", tty, "-t", sessionId]);
}

export async function createWindow(session: string, cwd?: string): Promise<void> {
  // Without -c, tmux defaults a new window's cwd to the cwd of the process
  // that ran this command — the server's own directory, not the session's —
  // since it's invoked here via execFile rather than from inside a tmux
  // pane. Look up the active pane's path explicitly and pass it as -c.
  const dir = cwd ?? (await tmux(["display-message", "-t", `=${session}:`, "-p", "#{pane_current_path}"])).trim();
  await tmux(["new-window", "-t", `=${session}:`, "-c", dir]);
}

// Finds the session's lazygit window — by the active pane's running command,
// with the window name as a fallback for panes momentarily running something
// else (e.g. lazygit shelling out to an editor) — or creates one running
// lazygit in `cwd`. Returns the window index for the caller to activate.
export async function openLazygitWindow(session: string, cwd?: string): Promise<number> {
  const out = await tmux([
    "list-windows",
    "-t",
    `=${session}:`,
    "-F",
    "#{window_index}\t#{window_name}\t#{pane_current_command}",
  ]);
  for (const line of out.split("\n").filter(Boolean)) {
    const [index, name, command] = line.split("\t");
    if (command === "lazygit" || name === "lazygit") return Number(index);
  }
  // Same server-cwd pitfall as createWindow above: without -c the new window
  // would open in the server's own directory.
  const dir = cwd ?? (await tmux(["display-message", "-t", `=${session}:`, "-p", "#{pane_current_path}"])).trim();
  const created = await tmux([
    "new-window",
    "-t",
    `=${session}:`,
    "-P",
    "-F",
    "#{window_index}",
    "-c",
    dir,
    "lazygit",
  ]);
  return Number(created.trim());
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

export type SearchAction = "start" | "next" | "prev" | "cancel";

// Drives copy-mode search for the scrollback search overlay. "start" uses
// search-backward-text (plain-text match) rather than search-backward
// (regex) — verified live against tmux 3.5a's man page and behavior — so a
// user typing "a.b" or "(x)" searches for that literal string instead of a
// pattern. search-again/search-reverse repeat the last search in the same
// (plain-text) mode, so next/prev stay literal without re-specifying it.
export async function searchScrollback(
  session: string,
  action: SearchAction,
  query?: string,
): Promise<void> {
  const target = `=${session}:`;
  if (action === "cancel") {
    await tmux(["send-keys", "-X", "-t", target, "cancel"]);
    return;
  }
  if (action === "start") {
    await tmux(["copy-mode", "-t", target]);
    await tmux(["send-keys", "-X", "-t", target, "search-backward-text", query ?? ""]);
    return;
  }
  await tmux(["send-keys", "-X", "-t", target, action === "next" ? "search-again" : "search-reverse"]);
}

interface GeometryPane {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  command: string;
  pid: number;
}

// pane_left/top/right/bottom are cell coordinates in the session's current
// window, inclusive on all four edges — matches the col/row range the client
// computes from cursor position (0..cols-1 / 0..rows-1).
async function listPaneGeometry(session: string): Promise<GeometryPane[]> {
  const out = await tmux([
    "list-panes",
    "-t",
    `=${session}:`,
    "-F",
    "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_right}\t#{pane_bottom}\t#{pane_current_command}\t#{pane_pid}",
  ]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, left, top, right, bottom, command, pid] = line.split("\t");
      return {
        id,
        left: Number(left),
        top: Number(top),
        right: Number(right),
        bottom: Number(bottom),
        command,
        pid: Number(pid),
      };
    });
}

const HSCROLL_MAX_TICKS = 50;
const HSCROLL_SOCKET_CACHE_TTL_MS = 2000;

// Keyed by pane_id (stable across renumbering, unlike pane index).
const hscrollSocketCache = new Map<string, { socket: string; expires: number }>();
const hscrollState = new Map<string, { amount: number; inFlight: boolean }>();

async function resolveNvimSocketCached(paneId: string, panePid: number): Promise<string | null> {
  const cached = hscrollSocketCache.get(paneId);
  if (cached && cached.expires > Date.now()) return cached.socket;
  const socket = await findNvimSocket(panePid);
  if (!socket) {
    hscrollSocketCache.delete(paneId);
    return null;
  }
  hscrollSocketCache.set(paneId, { socket, expires: Date.now() + HSCROLL_SOCKET_CACHE_TTL_MS });
  return socket;
}

function nvimRemoteSend(socket: string, keys: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("nvim", ["--server", socket, "--remote-send", keys], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}

// Delivers <ScrollWheelLeft>/<ScrollWheelRight> to the nvim RPC socket of
// whichever pane sits under (col, row) — tmux can't carry a horizontal wheel
// event itself (see wsAttach's "hscroll" handler for why), so this bypasses
// the PTY entirely and lets nvim's own mouse handling do the actual
// scrolling. Silently no-ops for anything that isn't nvim, or if nvim's
// socket can't be found (matches openFileInWindow's fallback behavior).
export async function scrollHorizontal(
  session: string,
  amount: number,
  col: number,
  row: number,
): Promise<void> {
  const clamped = Math.max(-HSCROLL_MAX_TICKS, Math.min(HSCROLL_MAX_TICKS, Math.trunc(amount)));
  if (clamped === 0) return;

  const panes = await listPaneGeometry(session);
  const pane = panes.find(
    (p) => col >= p.left && col <= p.right && row >= p.top && row <= p.bottom,
  );
  if (!pane || pane.command.replace(/^-/, "") !== "nvim") return;

  let state = hscrollState.get(pane.id);
  if (!state) {
    state = { amount: 0, inFlight: false };
    hscrollState.set(pane.id, state);
  }
  // Bursts of wheel ticks arrive faster than a remote-send round trip; fold
  // them into whichever run is already in flight instead of spawning a new
  // nvim process per tick.
  state.amount += clamped;
  if (state.inFlight) return;

  state.inFlight = true;
  try {
    while (state.amount !== 0) {
      const n = state.amount;
      state.amount = 0;
      const socket = await resolveNvimSocketCached(pane.id, pane.pid);
      if (!socket) break;
      const keys = (n > 0 ? "<ScrollWheelRight>" : "<ScrollWheelLeft>").repeat(Math.abs(n));
      try {
        await nvimRemoteSend(socket, keys);
      } catch {
        // Cached socket may be stale (nvim restarted) — drop it and retry
        // resolution once before giving up on this batch.
        hscrollSocketCache.delete(pane.id);
        const retrySocket = await resolveNvimSocketCached(pane.id, pane.pid);
        if (!retrySocket) break;
        try {
          await nvimRemoteSend(retrySocket, keys);
        } catch {
          break;
        }
      }
    }
  } finally {
    state.inFlight = false;
    hscrollState.delete(pane.id);
  }
}

interface PaneInfo {
  command: string;
  pid: number;
  cwd: string;
  windowIndex: number;
}

// The foreground process, pid, cwd, and window index of a session's active
// pane. pane_pid is the pane's original process (usually the login shell);
// pane_current_command is whatever's currently in the foreground (the shell
// itself, or a program it exec'd/forked, like nvim).
async function getActivePane(session: string): Promise<PaneInfo> {
  const out = await tmux([
    "display-message",
    "-t",
    `=${session}:`,
    "-p",
    "#{pane_current_command}\t#{pane_pid}\t#{pane_current_path}\t#{window_index}",
  ]);
  const [command, pid, cwd, windowIndex] = out.trim().split("\t");
  return { command, pid: Number(pid), cwd, windowIndex: Number(windowIndex) };
}

interface SessionPane {
  windowIndex: number;
  paneActive: boolean;
  id: string;
  command: string;
  pid: number;
}

// Every pane across every window in the session — used to find a running
// nvim outside the currently-viewed window (see openFileInWindow below).
async function listSessionPanes(session: string): Promise<SessionPane[]> {
  const out = await tmux([
    "list-panes",
    "-s",
    "-t",
    `=${session}:`,
    "-F",
    "#{window_index}\t#{pane_active}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}",
  ]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, paneActive, id, command, pid] = line.split("\t");
      return {
        windowIndex: Number(windowIndex),
        paneActive: paneActive === "1",
        id,
        command,
        pid: Number(pid),
      };
    });
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

// RPC-only nvim open: true if `pid`'s nvim has a reachable socket and the
// file was opened as a new tab through it. Never falls back to keystrokes —
// callers decide what an unreachable socket means for their pane.
async function tryNvimRpcOpen(pid: number, filePath: string): Promise<boolean> {
  const socket = await findNvimSocket(pid);
  if (!socket) return false;
  await nvimRemoteOpen(socket, filePath);
  return true;
}

// Opens filePath as a new tab in whatever nvim/vim is running in `paneId`
// (RPC for nvim when reachable, else Escape + ":tabe" keystrokes). Safe to
// call on the pane the user is currently looking at — that's the only case
// this is used for; a hidden pane in another window instead defers the
// keystroke fallback (see openFileInWindow's step 2 and
// openFileInPaneWithKeys below).
async function openInEditorPane(paneId: string, pid: number, command: string, filePath: string): Promise<void> {
  if (command === "nvim" && (await tryNvimRpcOpen(pid, filePath))) return;
  await tmux(["send-keys", "-t", paneId, "Escape"]);
  await tmux(["send-keys", "-t", paneId, "-l", `:tabe ${escapeForVimCmdline(filePath)}`]);
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

export interface OpenFileResult {
  windowIndex: number | null;
  // Set only when a running nvim was found in another window but its RPC
  // socket couldn't be reached: the pane's %id, for the client to complete
  // via openFileInPaneWithKeys once that window's tab is open and visible —
  // injecting keystrokes into a pane the user can't see would be invisible
  // and confusing if something went wrong.
  deferredPane?: string;
}

// Opens filePath, preferring (in order): the current window's active pane if
// it's already running nvim/vim; any nvim found in another window of the
// session; an idle shell in the current window; or, failing all of that, a
// new tmux window. See each branch below for why.
export async function openFileInWindow(session: string, filePath: string): Promise<OpenFileResult> {
  const pane = await getActivePane(session);
  // Login shells report their command with a leading "-" (e.g. "-zsh").
  const command = pane.command.replace(/^-/, "");
  const target = `=${session}:`;

  if (EDITOR_COMMANDS.has(command)) {
    await openInEditorPane(target, pane.pid, command, filePath);
    return { windowIndex: null };
  }

  // Look for nvim already running in some other window before falling back
  // to typing into an idle shell or spawning a fresh window — reusing it
  // means the file lands next to whatever the user's already editing.
  // Only each window's own active pane is considered (mirroring the
  // current-window check above); ties broken by lowest window index for a
  // deterministic pick.
  const otherNvimPane = (await listSessionPanes(session))
    .filter(
      (p) =>
        p.paneActive &&
        p.windowIndex !== pane.windowIndex &&
        p.command.replace(/^-/, "") === "nvim",
    )
    .sort((a, b) => a.windowIndex - b.windowIndex)[0];

  if (otherNvimPane) {
    if (await tryNvimRpcOpen(otherNvimPane.pid, filePath)) {
      return { windowIndex: otherNvimPane.windowIndex };
    }
    return { windowIndex: otherNvimPane.windowIndex, deferredPane: otherNvimPane.id };
  }

  if (SHELL_COMMANDS.has(command)) {
    await tmux(["send-keys", "-t", target, "C-u"]);
    await tmux(["send-keys", "-t", target, "-l", `nvim ${shellQuote(filePath)}`]);
    await tmux(["send-keys", "-t", target, "Enter"]);
    return { windowIndex: null };
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
  return { windowIndex: Number(out.trim()) };
}

// Completes a deferred open (see OpenFileResult.deferredPane) by injecting
// Escape + ":tabe" keystrokes into paneId once its window's tab is open and
// visible. Re-checks the pane is still running an editor first — it may have
// changed (or exited) between the scan and this call — and no-ops otherwise
// rather than typing into whatever's running now.
export async function openFileInPaneWithKeys(paneId: string, filePath: string): Promise<void> {
  const out = await tmux(["display-message", "-t", paneId, "-p", "#{pane_current_command}"]);
  const command = out.trim().replace(/^-/, "");
  if (!EDITOR_COMMANDS.has(command)) return;
  await tmux(["send-keys", "-t", paneId, "Escape"]);
  await tmux(["send-keys", "-t", paneId, "-l", `:tabe ${escapeForVimCmdline(filePath)}`]);
  await tmux(["send-keys", "-t", paneId, "Enter"]);
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
