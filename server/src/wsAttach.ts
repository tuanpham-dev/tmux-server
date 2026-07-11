import type { IncomingMessage } from "node:http";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import { registerAttach, type AttachCallbacks } from "./attachWatcher.js";
import {
  applyTmuxOptions,
  getAttachIdentity,
  getScrollState,
  isWindowTabSession,
  scrollHorizontal,
  scrollTo,
  searchScrollback,
  type SearchAction,
} from "./tmux.js";

interface ClientMsg {
  type: "input" | "resize" | "scrollQuery" | "scrollTo" | "hscroll" | "search";
  data?: string;
  cols?: number;
  rows?: number;
  line?: number;
  amount?: number;
  col?: number;
  row?: number;
  action?: SearchAction;
  query?: string;
}

const SEARCH_ACTIONS = new Set<SearchAction>(["start", "next", "prev", "cancel"]);

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

  const send = (payload: object) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  term.onData((data) => send({ type: "data", data }));

  // The shared attach watcher notices tmux-native navigation this attach
  // can't report itself: the pinned window vanishing (close the tab, as the
  // old per-attach pin watcher did), a deliberate window switch inside a
  // window tab, or the client being switch-client'ed to another session.
  // The watcher reverts the deviation server-side; these callbacks only tell
  // the client which tab to surface. For a window tab, select-window already
  // ran (createWindowTab) before the client ever attaches, so whatever
  // window is current at registration is the pinned one.
  let exited = false;
  let unregister: (() => void) | null = null;
  const callbacks: AttachCallbacks = {
    onPinnedGone: () => term.kill(),
    onWindowSwitched: (windowIndex) => send({ type: "windowSwitched", windowIndex }),
    onSessionSwitched: (targetSession, windowIndex) =>
      send({ type: "sessionSwitched", session: targetSession, windowIndex }),
  };
  getAttachIdentity(session)
    .then(({ sessionId, windowId }) => {
      if (exited) return;
      unregister = registerAttach(
        term.pid,
        sessionId,
        isWindowTabSession(session) ? windowId : null,
        callbacks,
      );
    })
    .catch(() => {});

  term.onExit(() => {
    exited = true;
    unregister?.();
    unregister = null;
    send({ type: "exit" });
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on("message", (raw) => {
    // A message already in flight when the PTY exits can still arrive here
    // before the WS finishes closing — term.resize() on an exited PTY throws
    // ioctl EBADF synchronously, which is fatal since this runs inside a
    // "message" event callback (uncaught there crashes the whole process).
    if (exited) return;
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
      msg.type === "search" &&
      msg.action !== undefined &&
      SEARCH_ACTIONS.has(msg.action) &&
      (msg.action !== "start" || typeof msg.query === "string")
    ) {
      searchScrollback(session, msg.action, msg.query)
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
