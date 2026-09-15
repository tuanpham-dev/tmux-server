// The OS service that keeps tmux-server running: a systemd user unit on
// Linux, a launchd agent on macOS (Task Scheduler on Windows arrives with the
// Windows stage). Commands talk to this interface, never to systemctl or
// launchctl directly.
import { launchd } from './launchd.ts';
import { systemd } from './systemd.ts';

export interface ServiceManager {
  /** "systemd" or "launchd", for messages. */
  kind: string;
  /** Whether this machine can run the service at all right now. */
  available(): boolean;
  /** Whether the service definition is written. */
  installed(): boolean;
  /** Writes (or refreshes) the service definition. */
  install(): void;
  start(): void;
  stop(): void;
  restart(): void;
  /** Starts it now and at login/boot. */
  enable(): void;
  disable(): void;
  active(): boolean;
  enabled(): boolean;
  /** Pid of the service's main process, when running. */
  mainPid(): number | null;
  /** Prints the manager's own status output. */
  printStatus(): void;
  /** Follows the service's logs until interrupted. */
  followLogs(): void;
  /** Extra checks for `doctor` (e.g. systemd linger). */
  doctor(report: { ok(msg: string): void; warn(msg: string): void }): void;
}

export function pickServiceManager(): ServiceManager | null {
  if (process.platform === 'linux') return systemd;
  if (process.platform === 'darwin') return launchd;
  return null;
}

/** The manager, only when it can actually be used on this machine. */
export function usableServiceManager(): ServiceManager | null {
  const manager = pickServiceManager();
  return manager?.available() ? manager : null;
}
