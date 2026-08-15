// Browser-opener bridge (plans/browser-opener-bridge.md): a $BROWSER shim in
// tmux panes relays server-side "open a URL" attempts (xdg-open falls back to
// $BROWSER on headless boxes) to POST /api/open-url, which fans out to every
// connected client over SSE — the focused app tab then opens the URL in the
// user's actual browser, rewriting loopback ports to the app's port proxy.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Response } from "express";

const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
);
const shimBinDir = path.join(configDir, "bin");

// The canonical shim path — what applyTmuxOptions points tmux's global
// BROWSER at. Port-independent (the port is baked into the script body), so
// multiple instances share it last-boot-wins (accepted in the plan).
export const openShimPath = path.join(shimBinDir, "open-in-browser");

// $BROWSER/xdg-open convention: the URL arrives as $1. The custom header is
// the CSRF guard — a cross-origin browser request carrying it needs a CORS
// preflight the server never approves, while curl sends it freely. -m 2
// mirrors the bell hook: a slow/dead server must never hang the caller.
function shimScript(port: number): string {
  return `#!/bin/sh
# Written by tmux-server at startup — relays a URL open to the app's browser
# tab (loopback-only POST /api/open-url). Also installed as xdg-open so
# desktop-server users can opt in by prepending this directory to PATH.
[ -n "$1" ] || exit 1
exec curl -s -m 2 -X POST -H 'X-Tmux-Server-Open: 1' --data-urlencode "url=$1" "http://127.0.0.1:${port}/api/open-url"
`;
}

// Best-effort at boot: a read-only config dir shouldn't stop the server, it
// just disables the bridge (index.ts logs and continues).
export async function ensureOpenShim(port: number): Promise<string> {
  await mkdir(shimBinDir, { recursive: true });
  const script = shimScript(port);
  for (const file of [openShimPath, path.join(shimBinDir, "xdg-open")]) {
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  return openShimPath;
}

const HEARTBEAT_MS = 30_000;

const subscribers = new Set<Response>();

export function subscribeOpenUrl(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  subscribers.add(res);
  // Per-connection heartbeat so intermediaries (the WS tunnel's HTTP path,
  // reverse proxies) don't reap an idle stream between real events.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();
  res.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
}

// Fire-and-forget by design (plan: no queue) — an open with no connected
// client is dropped, matching what a native headless terminal would do.
export function broadcastOpenUrl(url: string, serverPort: number): void {
  const frame = `data: ${JSON.stringify({ url, serverPort })}\n\n`;
  for (const res of subscribers) res.write(frame);
}

// `tmux-server open` bridge (plans/cli-open-command.md): the CLI POSTs
// /api/open-target, which broadcasts one of these as a *named* SSE event on
// this same subscriber set — reusing the open-url stream instead of a
// second connection per client. `path`/`projectCwd` are already
// `~`-shortened by the caller so they compare directly against
// TmuxSession.path.
export interface OpenTargetPayload {
  kind: "dir" | "file";
  path: string;
  projectCwd: string;
  line?: number;
  action?: "editor" | "preview";
}

export function broadcastOpenTarget(payload: OpenTargetPayload): number {
  const frame = `event: open-target\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) res.write(frame);
  return subscribers.size;
}
