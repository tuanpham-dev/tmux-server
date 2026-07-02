import { execFile } from "node:child_process";

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

export async function createWindow(session: string): Promise<void> {
  // No -c given: tmux defaults a new window's cwd to the session's current
  // active pane path, which is the behavior users expect from "New Window".
  await tmux(["new-window", "-t", `=${session}:`]);
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
