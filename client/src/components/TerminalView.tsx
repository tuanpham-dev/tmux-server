import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import type { AppSettings } from "../settings";
import SearchBar from "./SearchBar";
import { terminalTheme } from "../theme";

type SearchAction = "start" | "next" | "prev" | "cancel";

interface Props {
  attachName: string;
  active: boolean;
  settings: AppSettings;
  onExit: () => void;
  onError: (err: unknown) => void;
  // tmux-native navigation inside this attach, reported (and already
  // reverted) by the server's attach watcher: a window switch within a
  // window tab, or a cross-session switch from any tab.
  onWindowSwitch?: (windowIndex: number) => void;
  onSessionSwitch?: (session: string, windowIndex: number) => void;
}

export default function TerminalView({
  attachName,
  active,
  settings,
  onExit,
  onError,
  onWindowSwitch,
  onSessionSwitch,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onWindowSwitchRef = useRef(onWindowSwitch);
  onWindowSwitchRef.current = onWindowSwitch;
  const onSessionSwitchRef = useRef(onSessionSwitch);
  onSessionSwitchRef.current = onSessionSwitch;
  // The WS attaches to the name the tab was opened with; a later rename only
  // changes the display title, the existing attachment survives it.
  const attachNameRef = useRef(attachName);
  const initialSettings = useRef(settings);

  // Scrollback search overlay. sendSearchRef is set inside the mount effect
  // below (where it has closure access to the live `ws`, which is replaced
  // on every reconnect) so these handlers always reach the current socket.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  // False whenever the query has changed since the last "start" — the next
  // Enter/Shift+Enter re-starts the search instead of stepping an existing
  // one, matching how most find boxes treat an edited query.
  const searchStartedRef = useRef(false);
  const sendSearchRef = useRef<(action: SearchAction, query?: string) => void>(() => {});

  const handleSearchQueryChange = (q: string) => {
    setSearchQuery(q);
    searchStartedRef.current = false;
  };
  const handleSearchNext = () => {
    if (!searchQuery) return;
    if (searchStartedRef.current) {
      sendSearchRef.current("next");
    } else {
      sendSearchRef.current("start", searchQuery);
      searchStartedRef.current = true;
    }
  };
  const handleSearchPrev = () => {
    if (!searchQuery) return;
    if (searchStartedRef.current) {
      sendSearchRef.current("prev");
    } else {
      sendSearchRef.current("start", searchQuery);
      searchStartedRef.current = true;
    }
  };
  const handleSearchClose = () => {
    sendSearchRef.current("cancel");
    setSearchOpen(false);
    setSearchQuery("");
    searchStartedRef.current = false;
    requestAnimationFrame(() => termRef.current?.focus());
  };
  // Referenced from inside the mount effect's key handler (Ctrl+Shift+F
  // toggle-close), which only runs once and can't see this render's
  // closure directly — same ref-forwarding pattern as onExitRef above.
  const handleSearchCloseRef = useRef(handleSearchClose);
  handleSearchCloseRef.current = handleSearchClose;

  useEffect(() => {
    const container = containerRef.current!;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    // Defer setup one frame: StrictMode's dev double-mount disposes the first
    // instance within the same tick, and xterm's constructor schedules internal
    // timers that throw if the terminal is disposed before they run. The rAF is
    // cancelled by that first cleanup, so only the surviving mount ever builds
    // a terminal (and WS connection) at all.
    const raf = requestAnimationFrame(() => {
      const term = new Terminal({
        // Required by @xterm/addon-unicode11's terminal.unicode API below.
        allowProposedApi: true,
        cursorBlink: initialSettings.current.cursorBlink,
        cursorStyle: initialSettings.current.cursorStyle,
        fontSize: initialSettings.current.fontSize,
        fontFamily: initialSettings.current.fontFamily,
        fontWeightBold: initialSettings.current.fontWeightBold,
        theme: terminalTheme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // xterm's default (Unicode 6) width table treats some emoji used in
      // prompts (e.g. the sailboat "⛵" in this shell's prompt) as narrow,
      // clipping half the glyph. Unicode 11 tables classify them correctly.
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.open(container);
      termRef.current = term;

      // Mutable, not const: reconnect() replaces this on every attempt, and
      // every closure below reads it live rather than capturing one socket.
      let ws: WebSocket;
      let reconnectAttempt = 0;
      let reconnectTimer: number | undefined;
      const proto = location.protocol === "https:" ? "wss" : "ws";

      const refit = () => {
        // A ResizeObserver callback can still fire after cleanup disconnects
        // it; fitting a disposed terminal throws inside the fit addon.
        if (disposed) return;
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      };
      refitRef.current = refit;

      // tmux keeps scrollback internally, so xterm never scrolls and its own
      // scrollbar can't appear. Instead, after each output burst we ask tmux
      // for its copy-mode scroll state and drive an overlay thumb from it.
      // In-flight coalescing (not a fixed debounce) keeps this snappy: a
      // burst of "data" messages during continuous scrolling would otherwise
      // keep resetting a timer and compound into visible lag.
      let queryInFlight = false;
      let queryDirty = false;
      const requestScrollState = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (queryInFlight) {
          queryDirty = true;
          return;
        }
        queryInFlight = true;
        ws.send(JSON.stringify({ type: "scrollQuery" }));
      };

      // Last known state, kept for drag math; updated by server replies and,
      // optimistically, by drag moves so the thumb never waits on a round trip.
      const lastState = { position: 0, history: 0, height: 0 };

      const renderThumb = (position: number, history: number, height: number) => {
        const track = scrollTrackRef.current;
        if (!track) return;
        const total = history + height;
        if (total <= height) {
          track.classList.remove("visible");
          return;
        }
        track.classList.add("visible");
        const thumb = track.firstElementChild as HTMLElement;
        thumb.style.height = `${Math.max(6, (height / total) * 100)}%`;
        thumb.style.top = `${((history - position) / total) * 100}%`;
      };

      const applyScrollState = (s: { position: number; history: number; height: number }) => {
        lastState.position = s.position;
        lastState.history = s.history;
        lastState.height = s.height;
        renderThumb(s.position, s.history, s.height);
      };

      // A close preceded by an "exit" message means tmux itself is gone
      // (session/window killed) — close the tab, same as before. A close
      // with no "exit" first means something broke the pipe underneath
      // (server restart, sleep/wake, network blip) — reconnect instead of
      // losing the tab. Retrying is safe even if the session really did die
      // while disconnected: the next attach attempt gets its own "exit"
      // message immediately and the tab closes then, just delayed.
      let receivedExit = false;

      const connect = () => {
        ws = new WebSocket(
          `${proto}://${location.host}/ws/attach?session=${encodeURIComponent(attachNameRef.current)}`,
        );

        ws.onopen = () => {
          reconnectAttempt = 0;
          container.classList.remove("reconnecting");
          refit();
        };

        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "data") {
            term.write(msg.data);
            requestScrollState();
          } else if (msg.type === "scroll") {
            queryInFlight = false;
            applyScrollState(msg);
            if (queryDirty) {
              queryDirty = false;
              requestScrollState();
            }
          } else if (msg.type === "windowSwitched" && Number.isFinite(msg.windowIndex)) {
            onWindowSwitchRef.current?.(msg.windowIndex);
          } else if (
            msg.type === "sessionSwitched" &&
            typeof msg.session === "string" &&
            Number.isFinite(msg.windowIndex)
          ) {
            onSessionSwitchRef.current?.(msg.session, msg.windowIndex);
          } else if (msg.type === "exit") {
            receivedExit = true;
            ws.close();
          }
        };

        ws.onclose = () => {
          if (disposed) return;
          if (receivedExit) {
            onExitRef.current();
            return;
          }
          container.classList.add("reconnecting");
          const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
          reconnectAttempt++;
          reconnectTimer = window.setTimeout(connect, delay);
        };
      };

      connect();

      // Closure over the outer `let ws`, which connect() reassigns on every
      // reconnect — always reaches whichever socket is currently live. The
      // server replies to a "search" message with a "scroll" message, same
      // as scrollTo, so the existing scroll handler above already updates
      // the scrollbar thumb to track matches with no extra message type.
      sendSearchRef.current = (action, query) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "search", action, query }));
        }
      };

      // Dragging/clicking the overlay bar jumps tmux's copy-mode scroll
      // position directly (goto-line), rather than emulating wheel ticks.
      const track = scrollTrackRef.current!;
      let dragging = false;
      let dragOffsetPx = 0;
      let rafPending = false;

      const positionFromClientY = (clientY: number) => {
        const trackRect = track.getBoundingClientRect();
        const total = lastState.history + lastState.height;
        const thumbHeightPx = Math.max(
          6,
          (lastState.height / total) * trackRect.height,
        );
        const draggableRangePx = Math.max(1, trackRect.height - thumbHeightPx);
        const thumbTopPx = Math.min(
          draggableRangePx,
          Math.max(0, clientY - trackRect.top - dragOffsetPx),
        );
        const topFraction = thumbTopPx / trackRect.height;
        const target = lastState.history - topFraction * total;
        return Math.round(Math.min(lastState.history, Math.max(0, target)));
      };

      // Coalesce-to-latest: if several mousemoves land in one animation
      // frame, the most recent target line always wins — an earlier
      // "if pending, drop" version could send a stale position and leave
      // the drag short of where the cursor actually ended up.
      let pendingLine = 0;
      const sendScrollTo = (line: number) => {
        pendingLine = line;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "scrollTo", line: pendingLine }));
          }
        });
      };

      // Pointer Events (not mouse-only) so dragging works with touch and pen,
      // not just a mouse — a plain mousedown/mousemove/mouseup pair never
      // fires from a touchscreen. Pointer capture keeps events targeting the
      // track even if a finger slides off the narrow 14px hit area.
      const onDragMove = (e: PointerEvent) => {
        const line = positionFromClientY(e.clientY);
        // Optimistic redraw: don't wait for the server round trip to move
        // the thumb, or dragging feels laggy even though it isn't anymore.
        renderThumb(line, lastState.history, lastState.height);
        sendScrollTo(line);
      };

      const onDragEnd = (e?: PointerEvent) => {
        dragging = false;
        document.body.classList.remove("scrollbar-dragging");
        track.removeEventListener("pointermove", onDragMove);
        track.removeEventListener("pointerup", onDragEnd);
        track.removeEventListener("pointercancel", onDragEnd);
        // Send the exact release position directly, bypassing the rAF
        // throttle — guarantees the final spot lands even if the last
        // in-flight frame got skipped.
        if (e && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "scrollTo", line: positionFromClientY(e.clientY) }));
        }
      };

      const onThumbPointerDown = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const thumb = track.firstElementChild as HTMLElement;
        dragOffsetPx = e.clientY - thumb.getBoundingClientRect().top;
        dragging = true;
        document.body.classList.add("scrollbar-dragging");
        track.setPointerCapture(e.pointerId);
        track.addEventListener("pointermove", onDragMove);
        track.addEventListener("pointerup", onDragEnd);
        track.addEventListener("pointercancel", onDragEnd);
      };

      const onTrackPointerDown = (e: PointerEvent) => {
        if (dragging) return;
        // Click/tap on the bare track: jump directly under the cursor.
        dragOffsetPx = 0;
        const line = positionFromClientY(e.clientY);
        renderThumb(line, lastState.history, lastState.height);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "scrollTo", line }));
        }
      };

      track.addEventListener("pointerdown", (e) => {
        const thumb = track.firstElementChild as HTMLElement;
        if (e.target === thumb) onThumbPointerDown(e);
        else onTrackPointerDown(e);
      });

      const dataSub = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // attachCustomKeyEventHandler fires for keydown/keypress/keyup alike;
      // without the type guard each combo below would fire up to 3x.
      // Returning false stops xterm's own handling (e.g. sending a plain CR
      // for Shift+Enter), but xterm's underlying textarea still gets the
      // browser's default action unless we preventDefault it ourselves — for
      // Enter that default is inserting a literal newline into the textarea,
      // which xterm then reads and forwards as a second, unwanted Enter.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyC") {
          e.preventDefault();
          const selection = term.getSelection();
          if (selection) copyText(selection).catch((err) => onErrorRef.current(err));
          return false;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyF") {
          e.preventDefault();
          // Toggle: closing here (rather than just opening) needs the
          // ref-forwarded handler since this handler is set up once and
          // can't see later renders' searchOpen value directly.
          if (searchOpenRef.current) handleSearchCloseRef.current();
          else setSearchOpen(true);
          return false;
        }
        if (e.shiftKey && e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: "\n" }));
          }
          return false;
        }
        return true;
      });

      // xterm.js ignores Shift+wheel outright (and never emits horizontal
      // mouse reports at all), and tmux has no concept of horizontal wheel
      // either — it maps any wheel button other than "up" to WheelDown,
      // so forwarding one through the PTY would scroll vertically instead.
      // Bypass both: detect the gesture here and ask the server to deliver
      // <ScrollWheelLeft>/<ScrollWheelRight> straight to nvim over RPC,
      // which handles the actual scrolling itself.
      const HSCROLL_PX_PER_TICK = 50;
      let hScrollPx = 0;
      let hScrollCol = 0;
      let hScrollRow = 0;
      let hScrollRafPending = false;
      const flushHScroll = () => {
        hScrollRafPending = false;
        const ticks = Math.trunc(hScrollPx / HSCROLL_PX_PER_TICK);
        if (ticks === 0) return;
        hScrollPx -= ticks * HSCROLL_PX_PER_TICK;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "hscroll", amount: ticks, col: hScrollCol, row: hScrollRow }),
          );
        }
      };
      term.attachCustomWheelEventHandler((e) => {
        // Diagonal trackpad motion (both deltas nonzero, no shift) falls
        // through unchanged so vertical scrolling keeps working normally.
        const horizontal = e.shiftKey ? e.deltaY : e.deltaY === 0 ? e.deltaX : 0;
        if (horizontal === 0) return true;
        const rect = container.getBoundingClientRect();
        hScrollCol = Math.min(
          term.cols - 1,
          Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * term.cols)),
        );
        hScrollRow = Math.min(
          term.rows - 1,
          Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * term.rows)),
        );
        hScrollPx += horizontal;
        if (!hScrollRafPending) {
          hScrollRafPending = true;
          requestAnimationFrame(flushHScroll);
        }
        e.preventDefault();
        return false;
      });

      // Fires when the tab becomes visible again (display:none → block) and on
      // window resizes, so hidden terminals refit as soon as they can measure.
      const observer = new ResizeObserver(refit);
      observer.observe(container);

      if (active) term.focus();

      cleanup = () => {
        clearTimeout(reconnectTimer);
        onDragEnd();
        observer.disconnect();
        dataSub.dispose();
        ws.onclose = null;
        ws.close();
        term.dispose();
        termRef.current = null;
        refitRef.current = null;
      };
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply settings changes to the live terminal without reconnecting.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.fontWeightBold = settings.fontWeightBold;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorBlink = settings.cursorBlink;
    refitRef.current?.();
  }, [settings]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => termRef.current?.focus());
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className={`terminal-host${active ? "" : " hidden"}`}
    >
      {searchOpen && (
        <SearchBar
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleSearchClose}
        />
      )}
      <div ref={scrollTrackRef} className="tmux-scrollbar">
        <div className="tmux-scrollbar-thumb" />
      </div>
      <div className="reconnect-overlay">Reconnecting…</div>
    </div>
  );
}
