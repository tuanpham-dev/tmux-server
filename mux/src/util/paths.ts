import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { platform } from '../platform/index.ts';

// All paths resolve lazily so tests can point TMUX_SERVER_STATE_DIR / TMUX_SERVER_CONFIG_DIR
// at throwaway directories per process.
export function stateDir(): string {
  return (
    process.env.TMUX_SERVER_STATE_DIR ??
    (process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, 'tmux-server')
      : join(homedir(), '.local', 'state', 'tmux-server'))
  );
}

export function configDir(): string {
  return (
    process.env.TMUX_SERVER_CONFIG_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, 'tmux-server')
      : join(homedir(), '.config', 'tmux-server'))
  );
}

export function socketPath(): string { return platform.socketAddress(stateDir()); }
export function statePath(): string { return join(stateDir(), 'state.json'); }
export function scrollbackDir(): string { return join(stateDir(), 'scrollback'); }
export function logPath(): string { return join(stateDir(), 'daemon.log'); }
export function pidPath(): string { return join(stateDir(), 'daemon.pid'); }
// mux.json, not config.json: ~/.config/tmux-server/ is shared with the app's own
// settings.json — the daemon's file is namespaced to stay out of its way.
export function configPath(): string { return join(configDir(), 'mux.json'); }

export function ensureStateDirs(): void {
  // Creating scrollbackDir creates stateDir too; mode applies to what gets created.
  mkdirSync(scrollbackDir(), { recursive: true, mode: 0o700 });
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

import { fileURLToPath } from 'node:url';

/** Absolute path of the daemon entry — spawned by clients, matched in pid-staleness checks. */
export function daemonEntryPath(): string {
  return fileURLToPath(new URL('../daemon/index.ts', import.meta.url));
}
