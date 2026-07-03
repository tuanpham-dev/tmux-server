import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import type { AppSettings } from "../settings";
import SearchBar from "./SearchBar";
import TouchKeyBar from "./TouchKeyBar";
import { terminalTheme } from "../theme";
import { buildLinkProvider, isOpenGesture, openUrl } from "../terminalLinks";

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
  // Ctrl+click / Ctrl+Shift+click on a detected file-path link — same
  // primary/secondary pair as QuickSwitcher's Enter/Shift+Enter.
  onOpenFile?: (path: string, line?: number) => void;
  onOpenFileSecondary?: (path: string, line?: number) => void;
}

export default function TerminalView({
  attachName,
  active,
  settings,
  onExit,
  onError,
  onWindowSwitch,
  onSessionSwitch,
  onOpenFile,
  onOpenFileSecondary,
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
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenFileSecondaryRef = useRef(onOpenFileSecondary);
  onOpenFileSecondaryRef.current = onOpenFileSecondary;
  // Set (by the custom link provider's onHoverChange or the OSC-8
  // linkHandler's hover/leave, both wired in the mount effect below) to the
  // currently-hovered link's own activation call, or null when nothing's
  // hovered. Read from onCapture's mouse-mode interception so a ctrl+click
  // on a link is activated directly and never reaches tmux (which would
  // e.g. re-trigger nvim's own <C-LeftMouse> tag-jump binding).
  const linkActivateRef = useRef<((e: MouseEvent) => void) | null>(null);
  // True from a swallowed ctrl+mousedown on a hovered link until its
  // matching mouseup — see onCapture's link-interception branch below.
  const linkPressArmedRef = useRef(false);
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

  // Touch key bar: onscreen keys a mobile keyboard can't send (Esc, Tab,
  // arrows, Ctrl+C) plus sticky Ctrl for the next character typed. The
  // sendInput/stickyCtrl refs are read from inside term.onData in the mount
  // effect below, which needs the always-current values without re-running.
  const [coarsePointer, setCoarsePointer] = useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarsePointer(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const keyBarVisible =
    active &&
    (settings.touchKeyBar === "always" ||
      (settings.touchKeyBar === "auto" && coarsePointer));
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const stickyCtrlRef = useRef(false);
  stickyCtrlRef.current = stickyCtrl;
  const sendInputRef = useRef<(data: string) => void>(() => {});

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
      // Belt-and-braces alongside the cancelAnimationFrame in the effect's
      // destructor: a tab opened and closed within the same tick (seen live
      // when the vanished-window sweep raced a just-created window) can
      // reach this frame after unmount already nulled the refs — building a
      // terminal (and a WS) then would throw mid-setup and leak both.
      if (disposed) return;
      const term = new Terminal({
        // Required by @xterm/addon-unicode11's terminal.unicode API below.
        allowProposedApi: true,
        cursorBlink: initialSettings.current.cursorBlink,
        cursorStyle: initialSettings.current.cursorStyle,
        fontSize: initialSettings.current.fontSize,
        fontFamily: initialSettings.current.fontFamily,
        fontWeightBold: initialSettings.current.fontWeightBold,
        // VS Code/code-server default (terminal.integrated.minimumContrastRatio).
        // Without it, e.g. lazygit's selected row keeps its original foreground
        // colors on the blue selection background and becomes unreadable.
        minimumContrastRatio: 4.5,
        // On Mac, xterm's SelectionService only force-starts local selection
        // for Option+click/drag, ignoring Shift entirely (shouldForceSelection
        // branches on Browser.isMac). The drag/Shift+drag swap below needs
        // Option held on the synthetic drag-start event on Mac clients for
        // force-selection to trigger at all.
        macOptionClickForcesSelection: true,
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

      // Ctrl+click (Cmd+click on Mac) links: URLs and local file paths
      // detected by our own regex provider, plus explicit OSC 8 hyperlinks
      // (`ls --hyperlink`, gcc, etc.) via xterm's built-in linkHandler.
      // Activation is gated on the modifier inside each activate callback
      // (xterm's own recommendation — Linkifier itself doesn't gate on it),
      // and onCapture below additionally intercepts ctrl+mousedown while
      // mouse-reporting is on so a ctrl+click never reaches tmux.
      const hoverTooltip = document.createElement("div");
      hoverTooltip.className = "xterm-hover terminal-link-tooltip";
      term.element?.appendChild(hoverTooltip);
      const showTooltip = (event: MouseEvent, text: string) => {
        const hostRect = term.element?.getBoundingClientRect();
        if (!hostRect) return;
        hoverTooltip.textContent = text;
        hoverTooltip.style.left = `${event.clientX - hostRect.left + 12}px`;
        hoverTooltip.style.top = `${event.clientY - hostRect.top + 16}px`;
        hoverTooltip.style.display = "block";
      };
      const hideTooltip = () => {
        hoverTooltip.style.display = "none";
      };

      // OSC 8's `text` is the link's real target URI, not the visible cell
      // content (confirmed against xterm's OscLinkProvider source — it
      // looks the URI up by the cell's urlId rather than reading the
      // rendered characters), so a file:// target routes through
      // onOpenFile the same as a detected file-path link, and the hover
      // tooltip shows the true destination even when the visible text
      // doesn't match it (the guide's own rationale for showing it).
      const activateOsc8 = (event: MouseEvent, text: string) => {
        if (!isOpenGesture(event)) return;
        try {
          const url = new URL(text);
          if (url.protocol === "file:") {
            onOpenFileRef.current?.(decodeURIComponent(url.pathname));
            return;
          }
        } catch {
          // Not a parseable URL — fall through and let openUrl/window.open
          // decide (e.g. mailto:, custom schemes some tools emit).
        }
        openUrl(text);
      };
      term.options.linkHandler = {
        activate: activateOsc8,
        hover: (event, text) => {
          showTooltip(event, text);
          linkActivateRef.current = (e) => activateOsc8(e, text);
        },
        leave: () => {
          hideTooltip();
          linkActivateRef.current = null;
        },
      };

      const linkProviderDisposable = term.registerLinkProvider(
        buildLinkProvider(term, {
          resolvePaths: (paths) => api.resolvePaths(attachNameRef.current, paths).then((r) => r.results),
          onOpenUrl: openUrl,
          onOpenFile: (path, line) => onOpenFileRef.current?.(path, line),
          onOpenFileSecondary: (path, line) => onOpenFileSecondaryRef.current?.(path, line),
          onHoverChange: (link) => {
            linkActivateRef.current = link ? (e) => link.activate(e, link.text) : null;
          },
        }),
      );

      // WebGL2 rendering is noticeably smoother on panes with heavy output;
      // falls back to xterm's default (DOM) renderer if unsupported — no
      // separate canvas addon is installed here — (no GPU/WebGL2 in the
      // environment, an older browser) or if the context is lost later
      // (e.g. a mobile browser reclaiming GPU memory in the background) —
      // dispose is safe to call again from onExit below and a fresh
      // Terminal mount just doesn't have WebGL loaded a second time.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Unsupported — term already has its default renderer.
      }

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

      sendInputRef.current = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
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
        let toSend = data;
        // Sticky Ctrl from the touch key bar: converts the next single
        // letter typed into its control code (Ctrl+A..Z is ASCII & 0x1f for
        // both cases), then disarms regardless of what was typed — matches
        // how sticky modifiers behave on mobile OS keyboards.
        if (stickyCtrlRef.current) {
          if (data.length === 1 && /[a-zA-Z]/.test(data)) {
            toSend = String.fromCharCode(data.charCodeAt(0) & 0x1f);
          }
          stickyCtrlRef.current = false;
          setStickyCtrl(false);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: toSend }));
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

      // tmux runs with mouse support on, so xterm forwards plain drags to
      // tmux (tmux's own copy-mode selection) and reserves Shift+drag for
      // local browser selection — that split is hardcoded in xterm's
      // SelectionService with no option to flip it. Swap the two: Shift-held
      // events reach tmux unmodified by clearing the shift bit in the
      // capture phase (still true drag or click, tmux just never sees the
      // S- modifier). Plain gestures need more care — xterm decides
      // click-vs-selection at mousedown time, before movement is known, so a
      // blind shift-bit flip on mousedown would force every plain click into
      // local selection too (the caret in nvim would never move). Instead,
      // swallow the plain mousedown and replay it once we've learned whether
      // it became a drag, a click, or a held press. Only while the app is
      // actually mouse-reporting; otherwise plain gestures already select
      // locally and this would only get in the way. Deliberately leaves
      // wheel events alone (Shift+wheel keeps meaning horizontal scroll,
      // below).
      const isMacClient = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);
      // Marks events this handler itself created so they pass through
      // unmodified instead of being reprocessed as a new gesture.
      const syntheticEvents = new WeakSet<MouseEvent>();
      const DRAG_THRESHOLD_PX = 4;
      const LONG_PRESS_MS = 500;

      let pending: { startX: number; startY: number; source: MouseEvent } | null = null;
      let longPressTimer: number | undefined;

      const replay = (
        type: "mousedown" | "mouseup",
        source: MouseEvent,
        shiftKey: boolean,
        altKey: boolean,
      ) => {
        const el = term.element;
        if (!el) return;
        const synthetic = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: source.detail,
          screenX: source.screenX,
          screenY: source.screenY,
          clientX: source.clientX,
          clientY: source.clientY,
          button: source.button,
          buttons: type === "mouseup" ? 0 : source.buttons,
          shiftKey,
          altKey,
          ctrlKey: source.ctrlKey,
          metaKey: source.metaKey,
        });
        syntheticEvents.add(synthetic);
        el.dispatchEvent(synthetic);
      };

      const onPendingMove = (e: MouseEvent) => {
        if (!pending) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        const source = pending.source;
        endPending();
        // Drag: force local selection to start at the original press point;
        // the ongoing real moves (now unintercepted) extend it live.
        replay("mousedown", source, true, isMacClient);
      };

      const onPendingUp = () => {
        if (!pending) return;
        const source = pending.source;
        endPending();
        // Click: clear any leftover highlight from a prior local drag (a
        // forced-selection mousedown never runs _handleSingleClick, so a
        // plain click wouldn't otherwise clear stale selection state), then
        // replay press+release unshifted so tmux gets a normal click report.
        term.clearSelection();
        replay("mousedown", source, false, false);
        replay("mouseup", source, false, false);
      };

      function endPending() {
        if (!pending) return;
        window.clearTimeout(longPressTimer);
        document.removeEventListener("mousemove", onPendingMove, true);
        document.removeEventListener("mouseup", onPendingUp, true);
        pending = null;
      }

      const onCapture = (e: MouseEvent) => {
        if (syntheticEvents.has(e)) return;
        if (term.modes.mouseTrackingMode === "none") return;

        // Ctrl+click / Ctrl+Shift+click on a hovered link: swallow the
        // whole press-to-release gesture so nothing reaches tmux (a
        // replayed ctrl+click would e.g. re-trigger nvim's own
        // <C-LeftMouse> tag-jump binding), and activate the link directly
        // on release. Checked before the shift-swap branch below so
        // Ctrl+Shift+click lands here rather than being shift-un-modified
        // and falling through to a plain-tmux-click replay.
        if (linkPressArmedRef.current) {
          if (e.type === "mouseup" || e.type === "mousemove") {
            e.preventDefault();
            e.stopPropagation();
          }
          if (e.type === "mouseup") {
            linkPressArmedRef.current = false;
            // Re-check at release time: if the pointer dragged off the
            // link or the modifier was released first, drop the gesture
            // instead of activating (matches a normal link click's
            // cancel-by-drag-away behavior).
            if (isOpenGesture(e) && linkActivateRef.current) linkActivateRef.current(e);
          }
          return;
        }
        if (isOpenGesture(e) && e.type === "mousedown" && linkActivateRef.current) {
          e.preventDefault();
          e.stopPropagation();
          linkPressArmedRef.current = true;
          return;
        }

        if (e.shiftKey) {
          Object.defineProperty(e, "shiftKey", { get: () => false });
          return;
        }

        if (e.button !== 0 || e.type !== "mousedown") return;

        e.preventDefault();
        e.stopPropagation();
        term.focus();
        endPending();
        pending = { startX: e.clientX, startY: e.clientY, source: e };
        document.addEventListener("mousemove", onPendingMove, true);
        document.addEventListener("mouseup", onPendingUp, true);
        longPressTimer = window.setTimeout(() => {
          if (!pending) return;
          const source = pending.source;
          endPending();
          // Held without moving: start a real press in tmux now; the
          // ongoing real moves/release (now unintercepted) report live.
          replay("mousedown", source, false, false);
        }, LONG_PRESS_MS);
      };
      const capturedMouseEvents = ["mousedown", "mousemove", "mouseup"] as const;
      for (const type of capturedMouseEvents) {
        container.addEventListener(type, onCapture, true);
      }

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
        endPending();
        for (const type of capturedMouseEvents) {
          container.removeEventListener(type, onCapture, true);
        }
        observer.disconnect();
        dataSub.dispose();
        linkProviderDisposable.dispose();
        hoverTooltip.remove();
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
      <TouchKeyBar
        visible={keyBarVisible}
        stickyCtrl={stickyCtrl}
        onToggleStickyCtrl={() => setStickyCtrl((v) => !v)}
        onSendInput={(data) => sendInputRef.current(data)}
      />
    </div>
  );
}
