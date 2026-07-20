import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getGitRoot } from "./files.js";

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
  // The active pane's current foreground command (tmux's pane_current_command,
  // e.g. "bash", "vim", "claude") — lets extensions gate a per-window action
  // on what's actually running there (see registerWindowAction) without a
  // second tmux query; this rides along on the same list-windows call below.
  command: string;
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

// tmux exits non-zero when its server isn't running, i.e. zero sessions — and,
// confirmed live, `list-windows -a` (unlike `list-sessions`) also exits
// non-zero with "no current target" when the server is alive but has zero
// sessions (nothing for "-a" to anchor "current" resolution to), rather than
// just printing nothing. Both cases mean the same thing to every caller here:
// there's nothing to list.
function emptyIfNoServer(err: unknown): string {
  const msg = (err as Error).message;
  if (/no server running|error connecting|no current target/i.test(msg)) return "";
  throw err;
}

// Matches every shape tmux's error text takes for "the thing I was asked to
// kill is already gone" — a plain missing target ("can't find session/window/
// pane: x"), the whole-server-just-exited case ("no server running"), and the
// target-resolution fallback tmux hits when a race leaves nothing to fall
// back to ("no current target", seen when two kills for the same last-window-
// of-the-last-session land concurrently). A caller-initiated kill racing
// itself (a double click, a stray duplicate dispatch) or racing the session's
// own natural death should be a no-op, not a surfaced error.
const ALREADY_GONE = /can't find (session|window|pane)|no server running|no current target/i;

const HOME = process.env.HOME ?? "";

function shortenHome(path: string): string {
  if (HOME && (path === HOME || path.startsWith(HOME + "/"))) {
    return "~" + path.slice(HOME.length);
  }
  return path;
}

// Same story as getScrollState/getRepoStatuses: every open tab polls
// "/api/sessions" every 3s, and each poll forked its own list-sessions +
// list-windows even though every caller gets the identical answer. Share one
// listing across all of them for a beat. The window is short enough that the
// UI can't perceive it (the poll it feeds is 3s), and any mutation this server
// makes — new/kill/rename session or window — invalidates it on response
// (see api.ts's middleware), so a user's own action is never served stale.
const SESSIONS_TTL_MS = 500;
let sessionsCache: { at: number; value: TmuxSession[] } | null = null;
let sessionsInFlight: Promise<TmuxSession[]> | null = null;

export function invalidateSessionsCache(): void {
  sessionsCache = null;
}

export function listSessions(): Promise<TmuxSession[]> {
  if (sessionsCache && Date.now() - sessionsCache.at < SESSIONS_TTL_MS) {
    return Promise.resolve(sessionsCache.value);
  }
  if (sessionsInFlight) return sessionsInFlight;
  sessionsInFlight = querySessions()
    .then((value) => {
      sessionsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      sessionsInFlight = null;
    });
  return sessionsInFlight;
}

async function querySessions(): Promise<TmuxSession[]> {
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
      "#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_path}\t#{window_activity_flag}\t#{pane_current_command}",
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
    const [sessionName, id, index, name, active, cwd, activity, command] = line.split("\t");
    const window: TmuxWindow = {
      id,
      index: Number(index),
      name,
      active: active === "1",
      cwd: shortenHome(cwd),
      activity: activity === "1",
      command: command ?? "",
    };
    sessions.get(sessionName)?.windows.push(window);
  }
  return [...sessions.values()];
}

export async function createSession(name?: string, cwd?: string): Promise<TmuxSession> {
  const args = ["new-session", "-d", "-P", "-F", "#{session_name}"];
  // Without -c, tmux starts the session in this server process's own cwd
  // (the server/ folder) — same pitfall as createWindow below. A caller-
  // provided cwd (the client's "default new session dir" setting, validated
  // in api.ts) wins over NEW_SESSION_CWD from server/.env. Either way, start
  // at the git repo root containing that dir (matching the FILES panel's
  // rooting), falling back to the dir itself when it isn't inside a repo.
  const dir = cwd || process.env.NEW_SESSION_CWD;
  if (dir) args.push("-c", (await getGitRoot(dir)) ?? dir);
  if (name) args.push("-s", name);
  const createdName = (await tmux(args)).trim();
  const sessions = await listSessions();
  const created = sessions.find((s) => s.name === createdName);
  if (!created) throw new Error(`session "${createdName}" not found after create`);
  return created;
}

// Idempotent: a racing duplicate kill (double click, stray duplicate
// dispatch) or one that lands just after the session died on its own (last
// window exited) is a no-op rather than an error — see ALREADY_GONE.
export async function killSession(name: string): Promise<void> {
  try {
    // "=" prefix forces an exact name match instead of tmux's prefix matching
    await tmux(["kill-session", "-t", `=${name}`]);
  } catch (err) {
    if (!ALREADY_GONE.test((err as Error).message)) throw err;
  }
}

export async function renameSession(name: string, newName: string): Promise<void> {
  await tmux(["rename-session", "-t", `=${name}`, newName]);
}

export async function selectWindow(session: string, index: number): Promise<void> {
  await tmux(["select-window", "-t", `=${session}:${index}`]);
}

// Idempotent for the same reason as killSession above.
export async function killWindow(session: string, index: number): Promise<void> {
  try {
    await tmux(["kill-window", "-t", `=${session}:${index}`]);
  } catch (err) {
    if (!ALREADY_GONE.test((err as Error).message)) throw err;
  }
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
  // The tmux server process's own pid (#{pid} — Server PID per tmux(1)'s
  // FORMATS section, not a client/pane pid) — lets applyTmuxOptions tell
  // whether this attach is hitting the same tmux server instance its
  // options were last applied to (see that function's doc).
  serverPid: number;
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
    "#{session_id}\t#{window_id}\t#{pid}",
  ]);
  const [sessionId, windowId, serverPid] = out.trim().split("\t");
  return { sessionId, windowId, serverPid: Number(serverPid) };
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
  // pane_current_command of the current window's active pane — e.g. "bash",
  // "vim", "claude". Lets the attach watcher push foreground-program changes
  // to the client without a dedicated poll (see attachWatcher.ts).
  command: string;
}

// In list-sessions' format context, window_*/pane_* expand to each session's
// *current* window and its active pane — one call yields every session's
// current window (id, index, foreground command), keyed by stable session
// id. Verified live on tmux 3.5a.
export async function listSessionCurrentWindows(): Promise<Map<string, SessionCurrentWindow>> {
  const out = await tmux([
    "list-sessions",
    "-F",
    "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_current_command}",
  ]).catch(emptyIfNoServer);
  const map = new Map<string, SessionCurrentWindow>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [sessionId, name, windowId, windowIndex, command] = line.split("\t");
    map.set(sessionId, { name, windowId, windowIndex: Number(windowIndex), command: command ?? "" });
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

// The active pane's cwd, used to resolve relative file-path candidates
// hovered in the terminal (see resolvePaths in api.ts) — same tmux query
// createWindow/openLazygitWindow already use for the same purpose.
export async function paneCurrentPath(session: string): Promise<string> {
  return (
    await tmux(["display-message", "-t", `=${session}:`, "-p", "#{pane_current_path}"])
  ).trim();
}

// Returns the created window's index — the bottom terminal panel
// (plans/bottom-terminal-panel.md) needs it to attach the window it just
// created, via createWindowTab below.
export async function createWindow(session: string, cwd?: string): Promise<number> {
  // Without -c, tmux defaults a new window's cwd to the cwd of the process
  // that ran this command — the server's own directory, not the session's —
  // since it's invoked here via execFile rather than from inside a tmux
  // pane. Look up the active pane's path explicitly and pass it as -c.
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
  ]);
  return Number(created.trim());
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
    if (!ALREADY_GONE.test((err as Error).message)) throw err;
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

// Every scroll query costs a forked `tmux display-message` process, and each
// attached client fires one per output burst — so a busy pane watched from N
// browser tabs (all asking about the SAME session, all getting the same
// answer) multiplied into N forks per burst: measured at ~170 forks/sec across
// ~10 tabs on one streaming pane, enough kernel time and tmux-server load to
// stall the whole machine. Collapse them: one in-flight query per session is
// shared by every caller that arrives while it's running, and its result is
// reused for a beat afterwards. N tabs now cost the same as one.
const SCROLL_STATE_TTL_MS = 100;
const scrollStateInFlight = new Map<string, Promise<ScrollState>>();
const scrollStateCache = new Map<string, { at: number; state: ScrollState }>();

// Scroll state of the session's active pane; tmux keeps scrollback
// internally, so this is the only source of truth for a scrollbar.
export function getScrollState(session: string): Promise<ScrollState> {
  const fresh = scrollStateCache.get(session);
  if (fresh && Date.now() - fresh.at < SCROLL_STATE_TTL_MS) {
    return Promise.resolve(fresh.state);
  }
  const pending = scrollStateInFlight.get(session);
  if (pending) return pending;

  const query = queryScrollState(session)
    .then((state) => {
      scrollStateCache.set(session, { at: Date.now(), state });
      return state;
    })
    .finally(() => {
      scrollStateInFlight.delete(session);
    });
  scrollStateInFlight.set(session, query);
  return query;
}

async function queryScrollState(session: string): Promise<ScrollState> {
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

// A scroll-affecting command (scrollTo/copy-mode exit) just changed the pane
// under us — drop the cached answer so the next query reflects it immediately
// rather than serving a stale position for up to the TTL.
export function invalidateScrollState(session: string): void {
  scrollStateCache.delete(session);
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

export interface PaneMaps {
  // pane_pid → owning session, for walking a port owner's ppid chain.
  byPid: Map<number, string>;
  // pane_id ("%21") → owning session, for the TMUX_PANE environ fallback
  // (see ports.ts) — pane ids are what tmux puts in a pane's environment.
  byPaneId: Map<string, string>;
}

// Every pane across every session on the host, for attributing listening
// ports to the tmux session that owns them (see ports.ts). Synthetic
// window-tab sessions are grouped with a real session and share its
// windows/panes — list-panes emits a shared pane once per linked session,
// so skipping the synthetic line still leaves the real session's entry.
export async function listAllPanePids(): Promise<PaneMaps> {
  const out = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_id}\t#{pane_pid}",
  ]).catch(emptyIfNoServer);
  const byPid = new Map<number, string>();
  const byPaneId = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [sessionName, paneId, pid] = line.split("\t");
    if (sessionName.startsWith(WINDOW_TAB_PREFIX)) continue;
    byPid.set(Number(pid), sessionName);
    byPaneId.set(paneId, sessionName);
  }
  return { byPid, byPaneId };
}

export interface ProcInfo {
  ppid: number;
  comm: string;
}

// Scans /proc once for a ppid+comm map of every process on the host. Linux
// only — callers must treat a failure (missing /proc, e.g. on macOS) as
// "unknown" and fall back to the keystroke-injection path.
export async function buildProcessMap(): Promise<Map<number, ProcInfo>> {
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

function nvimRemote(socket: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("nvim", ["--server", socket, ...args], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}

// "--remote-tab" is "--remote" but opens the file with :tab-edit instead of
// :edit, so it lands in a new tab rather than replacing the pane's current
// buffer.
//
// A `+<line>` CLI arg here does NOT do what it does for a plain `nvim
// +<line> file` invocation — confirmed empirically against a scratch
// `--listen` socket: nvim treats it as a second, literal filename ("+5" as
// its own new buffer) rather than a startup command, and the cursor stays
// on line 1. `:tabe +<line> file`'s Ex-command `+cmd` argument is a
// different mechanism and isn't available through `--remote-tab`. Instead,
// open the tab first, then drive the cursor with a second `--remote-send`
// once it's the active buffer.
async function nvimRemoteOpen(socket: string, filePath: string, line?: number): Promise<void> {
  await nvimRemote(socket, ["--remote-tab", filePath]);
  if (line) await nvimRemote(socket, ["--remote-send", `<Esc>:${line}<CR>`]);
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

// ":tabe [+cmd] file" — the Ex-command "+cmd" argument (distinct from the
// CLI "+line" convention, and from --remote-tab's lack of one; see
// nvimRemoteOpen above) — confirmed empirically to jump the cursor as
// expected.
function vimTabeCmd(filePath: string, line?: number): string {
  const cmd = line ? `+${line} ` : "";
  return `:tabe ${cmd}${escapeForVimCmdline(filePath)}`;
}

const EDITOR_COMMANDS = new Set(["nvim", "vim"]);
const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"]);

// RPC-only nvim open: true if `pid`'s nvim has a reachable socket and the
// file was opened as a new tab through it. Never falls back to keystrokes —
// callers decide what an unreachable socket means for their pane.
async function tryNvimRpcOpen(pid: number, filePath: string, line?: number): Promise<boolean> {
  const socket = await findNvimSocket(pid);
  if (!socket) return false;
  await nvimRemoteOpen(socket, filePath, line);
  return true;
}

// Opens filePath as a new tab in whatever nvim/vim is running in `paneId`
// (RPC for nvim when reachable, else Escape + ":tabe" keystrokes). Safe to
// call on the pane the user is currently looking at — that's the only case
// this is used for; a hidden pane in another window instead defers the
// keystroke fallback (see openFileInWindow's step 2 and
// openFileInPaneWithKeys below).
async function openInEditorPane(paneId: string, pid: number, command: string, filePath: string, line?: number): Promise<void> {
  if (command === "nvim" && (await tryNvimRpcOpen(pid, filePath, line))) return;
  await tmux(["send-keys", "-t", paneId, "Escape"]);
  await tmux(["send-keys", "-t", paneId, "-l", vimTabeCmd(filePath, line)]);
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
export async function openFileInWindow(session: string, filePath: string, line?: number): Promise<OpenFileResult> {
  const pane = await getActivePane(session);
  // Login shells report their command with a leading "-" (e.g. "-zsh").
  const command = pane.command.replace(/^-/, "");
  const target = `=${session}:`;
  // Classic vim CLI form ("vim +42 file") — distinct from --remote-tab's
  // lack of +line support (see nvimRemoteOpen) but confirmed working here
  // since these two branches spawn a fresh `nvim` process directly.
  const nvimCliArg = line ? `+${line} ${shellQuote(filePath)}` : shellQuote(filePath);

  if (EDITOR_COMMANDS.has(command)) {
    await openInEditorPane(target, pane.pid, command, filePath, line);
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
    if (await tryNvimRpcOpen(otherNvimPane.pid, filePath, line)) {
      return { windowIndex: otherNvimPane.windowIndex };
    }
    return { windowIndex: otherNvimPane.windowIndex, deferredPane: otherNvimPane.id };
  }

  if (SHELL_COMMANDS.has(command)) {
    await tmux(["send-keys", "-t", target, "C-u"]);
    await tmux(["send-keys", "-t", target, "-l", `nvim ${nvimCliArg}`]);
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
    `nvim ${nvimCliArg}`,
  ]);
  return { windowIndex: Number(out.trim()) };
}

// Completes a deferred open (see OpenFileResult.deferredPane) by injecting
// Escape + ":tabe" keystrokes into paneId once its window's tab is open and
// visible. Re-checks the pane is still running an editor first — it may have
// changed (or exited) between the scan and this call — and no-ops otherwise
// rather than typing into whatever's running now.
export async function openFileInPaneWithKeys(paneId: string, filePath: string, line?: number): Promise<void> {
  const out = await tmux(["display-message", "-t", paneId, "-p", "#{pane_current_command}"]);
  const command = out.trim().replace(/^-/, "");
  if (!EDITOR_COMMANDS.has(command)) return;
  await tmux(["send-keys", "-t", paneId, "Escape"]);
  await tmux(["send-keys", "-t", paneId, "-l", vimTabeCmd(filePath, line)]);
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

// Last tmux server pid these options were successfully applied to — a fresh
// tmux server (first attach ever, or one started after a `kill-server`) has
// none of them set, but every attach after that first one is hitting the
// exact same long-lived server process, so re-running 5 `tmux set*` forks on
// every single attach/reconnect is pure waste. Module-level, not per-attach:
// intentionally shared across every concurrent attach.
let lastOptionsAppliedPid: number | null = null;

export async function applyTmuxOptions(port: number, serverPid: number): Promise<void> {
  if (serverPid === lastOptionsAppliedPid) return;
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
  // terminal-features hyperlinks: tmux only forwards OSC 8 hyperlink escape
  // sequences (see TerminalView's linkHandler) to clients whose declared
  // terminal capabilities include "hyperlinks" — xterm.js supports them
  // fully, but the built-in xterm* feature set tmux ships with doesn't list
  // it, so without this tmux silently strips every OSC 8 sequence before it
  // ever reaches the browser (confirmed empirically: identical PTY output
  // with vs. without this option, byte-for-byte, except the OSC 8 bytes are
  // simply absent). "-a" appends this as an additional terminal-features
  // entry rather than replacing the existing xterm* one — tmux merges
  // capability flags across all entries whose pattern matches the client's
  // TERM, so both entries' flags apply together.
  await tmux(["set", "-a", "-g", "terminal-features", "xterm*:hyperlinks"]).catch(() => {});
  // alert-bell: fires whenever any pane rings the terminal bell (Claude Code
  // bells on permission prompts) — POSTs to the loopback-only /api/push/bell
  // (server/src/push.ts), which fans out a web-push notification to every
  // subscribed browser. #{session_name}/#{window_index} are tmux format
  // strings, expanded by tmux itself at fire time, not by this process —
  // this whole 4th argv element is delivered to execFile verbatim (no shell
  // in between), then re-parsed by tmux's own command language when the hook
  // actually runs `run-shell "..."`. -m 2: never let a slow/dead server hang
  // the pane on every bell.
  await tmux([
    "set-hook",
    "-g",
    "alert-bell",
    `run-shell "curl -s -m 2 -XPOST http://127.0.0.1:${port}/api/push/bell?pane=#{session_name}:#{window_index}"`,
  ]).catch(() => {});
  lastOptionsAppliedPid = serverPid;
}
