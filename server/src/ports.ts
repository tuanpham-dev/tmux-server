import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildProcessMap, listAllPanePids, type PaneMaps, type ProcInfo } from "./tmux.js";

export interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  session: string;
}

interface RawPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
}

function ss(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ss", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Address column looks like "127.0.0.54:53", "0.0.0.0:5432", "*:8080", or
// "[::]:8086" — split off the trailing ":port" rather than assuming a fixed
// delimiter count, since IPv6 addresses contain colons themselves.
function parseAddress(field: string): { address: string; port: number } | null {
  const idx = field.lastIndexOf(":");
  if (idx === -1) return null;
  const port = Number(field.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let address = field.slice(0, idx);
  address = address.replace(/^\[|\]$/g, "");
  return { address, port };
}

// The "users:" column only appears for sockets owned by the requesting
// user — root-owned listeners (e.g. system services) omit it entirely, and
// therefore can never be attributed to a tmux pane below.
function parseProcess(line: string): { process?: string; pid?: number } {
  const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (!match) return {};
  return { process: match[1], pid: Number(match[2]) };
}

async function listPorts(): Promise<RawPort[]> {
  const stdout = await ss(["-H", "-ltnp"]);
  const byPort = new Map<number, RawPort>();

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // State  Recv-Q  Send-Q  Local-Address:Port  Peer-Address:Port  [Process]
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const parsed = parseAddress(fields[3]);
    if (!parsed) continue;

    const { process: proc, pid } = parseProcess(line);
    const existing = byPort.get(parsed.port);
    // Prefer whichever entry has process info when the same port shows up
    // twice (e.g. separate IPv4/IPv6 listeners).
    if (!existing || (!existing.process && proc)) {
      byPort.set(parsed.port, { port: parsed.port, address: parsed.address, process: proc, pid });
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

const MAX_ANCESTRY_HOPS = 64;

// Interactive shells mark the boundary between the server's own npm/dev tree
// and whoever launched it — a user's pane shell, or an agent's per-command
// wrapper shell. npm runs package scripts with plain `sh`, deliberately
// absent here so it stays inside the tree.
const BOUNDARY_SHELLS = new Set(["zsh", "bash", "fish", "csh", "tcsh", "ksh"]);

// Ancestors of this server process, up to the tmux pane it's running in, the
// first interactive shell, or the process-tree root — whichever comes first
// (all excluded). A port whose owning process's chain passes through one of
// these pids belongs to tmux-server itself or a sibling dev-server process
// spawned by the same `npm run dev`/concurrently tree (e.g. Vite), rather
// than to something the user launched in a tmux session. Stopping at the
// shell keeps the set to exactly that tree: collecting all the way to the
// pane would also sweep in the launching shell/agent, wrongly excluding any
// *other* dev server the same agent spawns later.
function computeOwnAncestors(procMap: Map<number, ProcInfo>, panePids: Map<number, string>): Set<number> {
  const ancestors = new Set<number>();
  let pid = process.pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (pid <= 1 || panePids.has(pid)) break;
    const info = procMap.get(pid);
    if (info && BOUNDARY_SHELLS.has(info.comm)) break;
    ancestors.add(pid);
    if (!info) break;
    pid = info.ppid;
  }
  return ancestors;
}

// "own": the chain hit tmux-server's own ancestry — hard-excluded, no
// fallback. "unknown": the chain dead-ended (reparented orphan, exited
// parent) — eligible for the TMUX_PANE environ fallback below.
type Attribution = { session: string } | "own" | "unknown";

// Walks a port's owning pid up its parent chain looking for a tmux pane.
function attributeToSession(
  pid: number,
  procMap: Map<number, ProcInfo>,
  panePids: Map<number, string>,
  ownAncestors: Set<number>,
): Attribution {
  let cur = pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (ownAncestors.has(cur)) return "own";
    const session = panePids.get(cur);
    if (session) return { session };
    if (cur <= 1) return "unknown";
    const info = procMap.get(cur);
    if (!info) return "unknown";
    cur = info.ppid;
  }
  return "unknown";
}

// TMUX_PANE survives reparenting: when the shell/agent that spawned a process
// exits, the process is reparented to pid 1 and the ppid walk above dead-ends,
// but the pane id it was spawned in stays in its (immutable) /proc environ.
// Same-user readable only — the same constraint ss's process column already
// imposes, so this can never attribute a port ss couldn't name.
async function readTmuxPaneFromEnviron(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith("TMUX_PANE=")) return entry.slice("TMUX_PANE=".length);
    }
  } catch {
    // Exited, foreign-user, or no /proc (macOS) — unattributable.
  }
  return null;
}

// Listening ports whose owning process lives inside a tmux pane's process
// tree, by ppid walk or — for orphaned trees — by TMUX_PANE environ.
// Everything else (system services, tmux-server's own server and dev
// tooling, processes from panes since closed) is excluded.
async function scanTmuxPorts(): Promise<ListeningPort[]> {
  const [ports, panes, procMap] = await Promise.all([
    listPorts(),
    listAllPanePids(),
    buildProcessMap(),
  ]);
  const ownAncestors = computeOwnAncestors(procMap, panes.byPid);

  const attributed = await Promise.all(
    ports.map(async (port): Promise<ListeningPort | null> => {
      if (port.pid === undefined) return null;
      const result = attributeToSession(port.pid, procMap, panes.byPid, ownAncestors);
      if (result === "own") return null;
      if (result !== "unknown") return { ...port, session: result.session };
      const paneId = await readTmuxPaneFromEnviron(port.pid);
      const session = paneId ? panes.byPaneId.get(paneId) : undefined;
      return session ? { ...port, session } : null;
    }),
  );
  return attributed.filter((p): p is ListeningPort => p !== null);
}

const SCAN_CACHE_TTL_MS = 2_000;
let scanCache: { expiresAt: number; ports: ListeningPort[] } | null = null;
let scanPromise: Promise<ListeningPort[]> | null = null;

// Cached briefly so the panel's 5s poll (one per connected client) and the
// tunnel gate — which can open many channels back to back on a single page
// load — share one tmux exec + /proc sweep + ss run.
export function listTmuxPorts(): Promise<ListeningPort[]> {
  if (scanCache && scanCache.expiresAt > Date.now()) {
    return Promise.resolve(scanCache.ports);
  }
  if (scanPromise) return scanPromise;

  scanPromise = scanTmuxPorts()
    .then((ports) => {
      scanCache = { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, ports };
      return ports;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

// Looks up a single port's tmux attribution on demand (kill confirmation and
// the 5s SIGKILL-escalation recheck both want a fresh, uncached read, unlike
// getTunnelablePorts below).
export async function findTmuxPort(port: number): Promise<ListeningPort | null> {
  const ports = await scanTmuxPorts();
  return ports.find((p) => p.port === port) ?? null;
}

// The set of ports currently tunnelable — a view over the shared cached scan.
export function getTunnelablePorts(): Promise<Set<number>> {
  return listTmuxPorts().then((ports) => new Set(ports.map((p) => p.port)));
}
