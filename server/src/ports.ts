import { execFile } from "node:child_process";
import { buildProcessMap, listAllPanePids, type ProcInfo } from "./tmux.js";

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

// Ancestors of this server process, up to (but excluding) the tmux pane it's
// running in, if any. A port whose owning process's chain passes through one
// of these pids before reaching a pane belongs to tmux-server itself (or a
// sibling dev-server process spawned by the same `npm run dev`/concurrently
// tree, e.g. Vite) rather than to something the user launched in a tmux
// session — it's excluded the same way an unattributable port is.
function computeOwnAncestors(procMap: Map<number, ProcInfo>, panePids: Map<number, string>): Set<number> {
  const ancestors = new Set<number>();
  let pid = process.pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (panePids.has(pid)) break;
    ancestors.add(pid);
    if (pid <= 1) break;
    const info = procMap.get(pid);
    if (!info) break;
    pid = info.ppid;
  }
  return ancestors;
}

// Walks a port's owning pid up its parent chain looking for a tmux pane.
// Returns the owning session name, or null if the chain hits tmux-server's own
// ancestry, the process tree root, or a dead end first.
function attributeToSession(
  pid: number,
  procMap: Map<number, ProcInfo>,
  panePids: Map<number, string>,
  ownAncestors: Set<number>,
): string | null {
  let cur = pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (ownAncestors.has(cur)) return null;
    const session = panePids.get(cur);
    if (session) return session;
    if (cur <= 1) return null;
    const info = procMap.get(cur);
    if (!info) return null;
    cur = info.ppid;
  }
  return null;
}

// Listening ports whose owning process lives inside a tmux pane's process
// tree — everything else (system services, daemonized/detached processes,
// tmux-server's own server and dev tooling) is excluded.
export async function listTmuxPorts(): Promise<ListeningPort[]> {
  const [ports, panePids, procMap] = await Promise.all([
    listPorts(),
    listAllPanePids(),
    buildProcessMap(),
  ]);
  const ownAncestors = computeOwnAncestors(procMap, panePids);

  const attributed: ListeningPort[] = [];
  for (const port of ports) {
    if (port.pid === undefined) continue;
    const session = attributeToSession(port.pid, procMap, panePids, ownAncestors);
    if (session) attributed.push({ ...port, session });
  }
  return attributed;
}

const TUNNEL_CACHE_TTL_MS = 3_000;
let tunnelCache: { expiresAt: number; ports: Set<number> } | null = null;
let tunnelCachePromise: Promise<Set<number>> | null = null;

// The set of ports currently tunnelable, cached briefly so a single page
// load — which can open many tunnel channels back to back — doesn't trigger
// a fresh tmux exec + /proc sweep + ss run per channel.
export function getTunnelablePorts(): Promise<Set<number>> {
  if (tunnelCache && tunnelCache.expiresAt > Date.now()) {
    return Promise.resolve(tunnelCache.ports);
  }
  if (tunnelCachePromise) return tunnelCachePromise;

  tunnelCachePromise = listTmuxPorts()
    .then((ports) => {
      const set = new Set(ports.map((p) => p.port));
      tunnelCache = { expiresAt: Date.now() + TUNNEL_CACHE_TTL_MS, ports: set };
      return set;
    })
    .finally(() => {
      tunnelCachePromise = null;
    });
  return tunnelCachePromise;
}
