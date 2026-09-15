// The host's process tree, for questions the terminal engine can't answer on
// its own: which window owns a listening port (ports.ts), and where a running
// nvim is listening (editor.ts).
import { readdir, readFile } from "node:fs/promises";

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
export function findDescendants(
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
