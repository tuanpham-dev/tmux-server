// What the rest of the server may ask of a terminal engine. Sessions hold
// windows; a window is one terminal. Nothing outside the engine module knows
// how an engine does any of this — today the only engine is the bundled
// daemon (mux.ts), and an optional tmux backend can implement the same
// interface later without touching its callers.
//
// Targets are strings, the same three forms everywhere:
//   "work"       the session's current window
//   "work:2"     the session's window at index 2
//   "@<uuid>"    one window by its id, wherever it lives

import { daemonMultiplexer } from "./mux.js";

export interface MuxWindow {
  // Stable for the window's life and across a daemon restart.
  id: string;
  index: number;
  // The live name: the foreground command while `autoName` is on.
  name: string;
  autoName: boolean;
  current: boolean;
  // Live working directory (absolute).
  cwd: string;
  // What is running in the foreground right now ("zsh", "vim", "claude").
  command: string;
  // The command the window was created to run, re-typed on restore; "" for a
  // plain shell.
  declaredCommand: string;
  // Process names under the window's shell, breadth-first.
  commands: string[];
  // The shell's pid, for walking what it owns.
  pid: number;
  // Output arrived while nobody was viewing it.
  activity: boolean;
  lastOutputAt: number;
  // On a window brought back by a restore: what was running under its shell
  // before (["claude"]), until clearRestored is called for it.
  restoredCommands: string[] | null;
}

export interface MuxSession {
  id: string;
  name: string;
  // Epoch ms.
  createdAt: number;
  // Connected viewers.
  attached: number;
  // Where the session was started. Never moves.
  rootCwd: string;
  currentIndex: number;
  windows: MuxWindow[];
}

export interface CreateWindowOptions {
  cwd?: string;
  name?: string;
  // Typed into the new shell, so the window outlives the command.
  command?: string;
  // Don't make it the session's current window.
  background?: boolean;
}

export interface TerminalEngineSettings {
  // "" for the account's own shell.
  shell: string;
  saveScrollback: boolean;
  restoreOnStart: boolean;
}

export type MuxEvent =
  | { event: "bell"; session: string; windowId: string }
  | { event: "sessions-changed" };

// Everything a viewer can hear back while attached.
export interface AttachHandlers {
  output(data: Buffer): void;
  // History replay is done; input sent before this reaches a shell that
  // never asked for it.
  replayed(): void;
  // A session attach followed its session to another window.
  windowSwitched(index: number): void;
  resized(cols: number, rows: number): void;
  // The window or session ended, or the engine went away.
  closed(reason: string): void;
}

export interface AttachHandle {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  // This viewer became the one the user is looking at.
  activate(): void;
  close(): void;
}

export interface Multiplexer {
  listSessions(): Promise<MuxSession[]>;
  createSession(opts: { name?: string; cwd: string; command?: string }): Promise<{ id: string; name: string; windowId: string }>;
  killSession(session: string): Promise<void>;
  renameSession(session: string, to: string): Promise<void>;
  createWindow(session: string, opts?: CreateWindowOptions): Promise<{ index: number; windowId: string }>;
  selectWindow(target: string): Promise<void>;
  killWindow(target: string): Promise<void>;
  renameWindow(target: string, to: string): Promise<void>;
  resetWindowName(target: string): Promise<void>;
  // Marks a restored window's restoredCommands as dealt with.
  clearRestored(target: string): Promise<void>;
  // Raw bytes into the window's terminal, exactly as if typed.
  sendText(target: string, data: string): Promise<void>;
  // `pinned` attaches to exactly that window; otherwise to the target's
  // session, following its current window.
  attach(target: string, opts: { pinned: boolean; cols: number; rows: number }, handlers: AttachHandlers): Promise<AttachHandle>;
  // Daemon-wide events. Returns an unsubscribe.
  onEvent(listener: (event: MuxEvent) => void): () => void;
  // Whether the engine is up right now (it is started on demand otherwise).
  running(): Promise<boolean>;
  // Applies the user's terminal settings to the engine.
  configure(settings: TerminalEngineSettings): Promise<void>;
}

export function getMultiplexer(): Multiplexer {
  return daemonMultiplexer;
}
