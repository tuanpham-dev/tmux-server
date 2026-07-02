import type { IncomingMessage } from "node:http";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import { applyTmuxOptions, getScrollState, scrollTo } from "./tmux.js";

interface ClientMsg {
  type: "input" | "resize" | "scrollQuery" | "scrollTo";
  data?: string;
  cols?: number;
  rows?: number;
  line?: number;
}

export function handleAttach(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const session = url.searchParams.get("session");
  if (!session) {
    ws.close(4000, "missing session parameter");
    return;
  }

  // Fire-and-forget: awaiting here would open an async gap between the WS
  // handshake and registering the "close" handler below — a socket that
  // closes inside that gap would leak its PTY forever.
  void applyTmuxOptions();

  const term = pty.spawn("tmux", ["attach-session", "-t", `=${session}`], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  term.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit" }));
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      term.write(msg.data);
    } else if (msg.type === "scrollQuery") {
      getScrollState(session)
        .then((state) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "scroll", ...state }));
          }
        })
        .catch(() => {});
    } else if (msg.type === "scrollTo" && Number.isFinite(msg.line)) {
      scrollTo(session, msg.line!)
        .then(() => getScrollState(session))
        .then((state) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "scroll", ...state }));
          }
        })
        .catch(() => {});
    } else if (
      msg.type === "resize" &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows) &&
      msg.cols! > 0 &&
      msg.rows! > 0
    ) {
      term.resize(msg.cols!, msg.rows!);
    }
  });

  ws.on("close", () => {
    term.kill();
  });
}
