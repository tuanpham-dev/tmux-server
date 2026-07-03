import type { IncomingMessage } from "node:http";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import {
  applyTmuxOptions,
  currentWindowId,
  getScrollState,
  isWindowTabSession,
  scrollHorizontal,
  scrollTo,
} from "./tmux.js";

// How often a window-tab attach checks whether its pinned window is still
// tmux's current one for that synthetic session. tmux falls back to an
// adjacent window the instant the pinned one closes (shell exit, `nvim
// :q`, etc.) rather than ending the session, so without this the tab would
// silently start showing that fallback window instead of closing — this
// notices the switch and closes the tab, same as an explicit "Kill Window".
const WINDOW_PIN_CHECK_MS = 300;

interface ClientMsg {
  type: "input" | "resize" | "scrollQuery" | "scrollTo" | "hscroll";
  data?: string;
  cols?: number;
  rows?: number;
  line?: number;
  amount?: number;
  col?: number;
  row?: number;
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

  let pinWatcher: NodeJS.Timeout | null = null;
  if (isWindowTabSession(session)) {
    // select-window already ran (createWindowTab) before the client ever
    // attaches, so whatever window is current right now is the pinned one.
    currentWindowId(session)
      .then((pinnedId) => {
        pinWatcher = setInterval(() => {
          currentWindowId(session)
            .then((id) => {
              if (id !== pinnedId) {
                clearInterval(pinWatcher!);
                pinWatcher = null;
                term.kill();
              }
            })
            .catch(() => {
              // Session itself is gone — term.onExit below handles this.
            });
        }, WINDOW_PIN_CHECK_MS);
      })
      .catch(() => {});
  }

  term.onExit(() => {
    if (pinWatcher) clearInterval(pinWatcher);
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
      msg.type === "hscroll" &&
      Number.isFinite(msg.amount) &&
      Number.isFinite(msg.col) &&
      Number.isFinite(msg.row)
    ) {
      scrollHorizontal(session, msg.amount!, msg.col!, msg.row!).catch(() => {});
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
