import { execFile } from "node:child_process";

export interface ListeningPort {
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
// user — root-owned listeners (e.g. system services) omit it entirely.
function parseProcess(line: string): { process?: string; pid?: number } {
  const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (!match) return {};
  return { process: match[1], pid: Number(match[2]) };
}

export async function listPorts(): Promise<ListeningPort[]> {
  const stdout = await ss(["-H", "-ltnp"]);
  const byPort = new Map<number, ListeningPort>();

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
