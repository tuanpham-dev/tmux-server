import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import { getContextGetter } from "../contextKeys";
import { loadEngine, type TerminalEngineName } from "../engines";
import { isSyntheticSelectStart, type TerminalEngineHandle, type TerminalTheme } from "../engines/types";
import { bindingMatches, serializeEvent, type Keybinding } from "../keybindings";
import { LocalEcho } from "../localEcho";
import type { AppSettings } from "../settings";
import { sendWithInkSafeEnters, whenMatches } from "../touchKeys";
import FloatingTouchKeys from "./FloatingTouchKeys";
import SearchBar from "./SearchBar";
import TouchKeyBar from "./TouchKeyBar";
import {
  encodeSgrMouse,
  focusReport,
  WheelLineAccumulator,
} from "../mouseReports";
import { isOpenGesture, openUrl } from "../terminalLinks";

// A single onData call is either a plain-text/IME burst or one full control
// sequence (an escape code, a lone control byte) — never a mix — so this
// only needs to check "any control byte present", not tokenize per-key.
function isPrintableBurst(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

// Clipboard images have no filename; the ones dropped from a file manager
// (handled separately, via file.name) do.
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
function extensionForImageMime(mime: string): string {
  return IMAGE_EXTENSIONS[mime] ?? "png";
}

type SearchAction = "start" | "next" | "prev" | "cancel";

interface Props {
  attachName: string;
  // Shown at all (its editor group's own active tab) — drives the `hidden`
  // class and refit. A tab can be visible without being focused (a visible
  // tab in a split pane that doesn't currently have app/keyboard focus).
  visible: boolean;
  // Additionally its group has app focus — drives keyboard-focus grabbing
  // and the on-screen touch key bar. Every focused tab is visible, but not
  // every visible tab is focused (plans/vscode-editor-group-splits.md).
  focused: boolean;
  settings: AppSettings;
  // The active extension color theme's terminal palette, or the built-in
  // Plastic Legacy theme if none is selected/loaded — see theme.ts.
  theme: TerminalTheme;
  // Bumped by utils/fonts.ts whenever an extension-contributed font finishes
  // (or stops) loading — triggers a re-measure below, since a font that
  // arrives after settings.fontFamily was already applied needs a nudge
  // the terminal wouldn't otherwise give it (see that effect's comment).
  fontsVersion: number;
  // Resolved command-id → binding list map (keybindings.ts); the terminal.*
  // entries drive the custom key handler below, so rebinds apply live via a
  // ref.
  bindings: Record<string, Keybinding[]>;
  onExit: () => void;
  onError: (err: unknown) => void;
  // tmux-native navigation inside this attach, reported (and already
  // reverted) by the server's attach watcher: a window switch within a
  // window tab, or a cross-session switch from any tab.
  onWindowSwitch?: (windowIndex: number) => void;
  onSessionSwitch?: (session: string, windowIndex: number) => void;
  // Ctrl+click / Ctrl+Shift+click (Cmd+click / Cmd+Shift+click on mac) on a
  // detected file-path link — same primary/secondary pair as QuickSwitcher's
  // Enter/Shift+Enter.
  onOpenFile?: (path: string, line?: number) => void;
  onOpenFileSecondary?: (path: string, line?: number) => void;
  // The pane's current working directory (App.tsx's sessions data), used as
  // the destination for image paste/drop uploads (plans/codeman-mobile-
  // features.md Phase 3) — "" (window not found yet) just disables that
  // feature for this render, same as an empty localEchoWhen.
  cwd?: string;
}

export default function TerminalView({
  attachName,
  visible,
  focused,
  settings,
  theme,
  fontsVersion,
  bindings,
  onExit,
  onError,
  onWindowSwitch,
  onSessionSwitch,
  onOpenFile,
  onOpenFileSecondary,
  cwd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The engine's open() takes over the element it's given: contenteditable,
  // role=textbox, a beforeinput preventDefault, and container-level key/paste
  // listeners. Those must never wrap the SearchBar/TouchKeyBar/scroll-track
  // (typing in the search box would be blocked by that beforeinput handler
  // and simultaneously leak into the PTY via the key listeners), so the
  // terminal gets this dedicated inner div and the widgets stay siblings.
  const screenRef = useRef<HTMLDivElement>(null);
  // Positioning context for FloatingTouchKeys (touchKeyBarStyle "floating")
  // — the toggle clamps its drag/expand geometry to this element's bounds.
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TerminalEngineHandle | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  // Read from inside the mount effect's long-lived closure (which only ever
  // sees the `visible` value it mounted with), so the scroll-query throttle
  // below can tell whether this terminal is actually on screen right now.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // requestScrollState, exposed so the [visible] effect can fire the one query
  // a revealed tab skipped while it was hidden.
  const scrollQueryRef = useRef<(() => void) | null>(null);
  // Force-repaints a terminal that was just revealed, catching it up on
  // everything that arrived while its paint was suppressed (see the engine's
  // reveal()).
  const revealRef = useRef<(() => void) | null>(null);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
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
  // Set (by the link provider's onLinkHoverChange, wired in the mount
  // effect below) to the currently-hovered link's own activation call, or
  // null when nothing's hovered. Read from onCapture's mouse-mode
  // interception so a ctrl+click on a link is activated directly and never
  // reaches tmux (which would e.g. re-trigger nvim's own <C-LeftMouse>
  // tag-jump binding).
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
    requestAnimationFrame(() => engineRef.current?.focus());
  };
  // Referenced from inside the mount effect's key handler (Ctrl+Shift+F
  // toggle-close), which only runs once and can't see this render's
  // closure directly — same ref-forwarding pattern as onExitRef above.
  const handleSearchCloseRef = useRef(handleSearchClose);
  handleSearchCloseRef.current = handleSearchClose;

  // Touch key bar: onscreen keys a mobile keyboard can't send (Esc, Tab,
  // arrows, Ctrl+C) plus sticky Ctrl for the next character typed. The
  // sendInput/stickyCtrl refs are read from inside the engine's onData in
  // the mount effect below, which needs the always-current values without
  // re-running.
  // "auto" requires hover: none on top of pointer: coarse so it means real
  // mobile devices (phones/tablets) — a touch-screen laptop's primary input
  // still hovers, and its hardware keyboard makes the bar pure noise there.
  // The bare pointer:coarse checks elsewhere in this file (focus-grab
  // suppression) intentionally keep the looser meaning.
  const MOBILE_MQ = "(pointer: coarse) and (hover: none)";
  const [mobilePointer, setMobilePointer] = useState(
    () => window.matchMedia(MOBILE_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => setMobilePointer(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const keyBarVisible =
    focused &&
    (settings.touchKeyBar === "always" ||
      (settings.touchKeyBar === "auto" && mobilePointer));
  // "auto" reuses the same mobile predicate as the touch key bar — xterm on
  // real phones/tablets (mature native IME/soft-keyboard handling), ghostty
  // everywhere else.
  const resolvedEngine: TerminalEngineName =
    settings.terminalEngine === "auto"
      ? mobilePointer
        ? "xterm"
        : "ghostty"
      : settings.terminalEngine;
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const stickyCtrlRef = useRef(false);
  stickyCtrlRef.current = stickyCtrl;
  const sendInputRef = useRef<(data: string) => void>(() => {});
  // Voice transcripts (Phase 5) route through this instead — set to the
  // mount effect's sendTextOrEcho, the same local-echo-or-direct fork image
  // paste/drop already uses (Phase 3), so spoken text lands in the buffered
  // overlay when local echo is active instead of going straight to the PTY.
  const sendTextRef = useRef<(text: string) => void>(() => {});
  // Pushed by the server's attach watcher (a "command" WS message) whenever
  // this attach's foreground program changes — drives touch keys' `when`
  // filter. "" until the first push arrives.
  const [currentCommand, setCurrentCommand] = useState("");
  // Read from inside the mount effect's long-lived forwardInput closure,
  // which only ever sees the values it mounted with — same ref-mirroring
  // pattern as bindingsRef/visibleRef above, gating zero-lag local echo.
  const mobilePointerRef = useRef(mobilePointer);
  mobilePointerRef.current = mobilePointer;
  const localEchoWhenRef = useRef(settings.localEchoWhen);
  localEchoWhenRef.current = settings.localEchoWhen;
  const localEchoRef = useRef<LocalEcho | null>(null);
  // Image paste/drop (plans/codeman-mobile-features.md Phase 3) reads these
  // live from inside the same long-lived mount-effect closure.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const uploadConflictRef = useRef(settings.uploadConflict);
  uploadConflictRef.current = settings.uploadConflict;

  useEffect(() => {
    const container = containerRef.current!;
    const screen = screenRef.current!;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    // Defer setup one frame: StrictMode's dev double-mount disposes the first
    // instance within the same tick, and building a terminal (plus a WS
    // connection) only to dispose it in the same tick is wasted work either
    // way. The rAF is cancelled by that first cleanup, so only the surviving
    // mount ever builds a terminal (and WS connection) at all.
    const raf = requestAnimationFrame(async () => {
      // Belt-and-braces alongside the cancelAnimationFrame in the effect's
      // destructor: a tab opened and closed within the same tick (seen live
      // when the vanished-window sweep raced a just-created window) can
      // reach this frame after unmount already nulled the refs — building a
      // terminal (and a WS) then would throw mid-setup and leak both.
      if (disposed) return;

      // Dynamic import: the non-selected engine's package never loads.
      // Re-checked after both awaits — a tab can close (or a fast re-render
      // can re-run this whole effect on an engine change) while either is
      // in flight.
      const create = await loadEngine(resolvedEngine);
      if (disposed) return;

      // Mutable, not const: reconnect() replaces this on every attempt, and
      // every closure below reads it live rather than capturing one socket.
      let ws: WebSocket;
      let reconnectAttempt = 0;
      let reconnectTimer: number | undefined;
      const proto = location.protocol === "https:" ? "wss" : "ws";

      // Every path that puts raw bytes on the wire as terminal input —
      // mouse reports, touch keys, focus reports — funnels through this;
      // only the engine's own onData (real typed/pasted/composed input)
      // additionally goes through sticky-Ctrl via forwardInput below.
      const sendInput = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      };
      sendInputRef.current = sendInput;

      // Assigned once the engine (LocalEcho's adapter) exists below;
      // forwardInput only ever runs from real user input, which can't
      // happen before then — same "mutable, read live" idiom as `ws`.
      let localEcho: LocalEcho | null = null;
      // Mirrors currentCommand React state inside this closure (which the
      // "command" message handler below updates directly, in the same
      // scope) so forwardInput/routeLocalEcho always see the live value —
      // the outer `currentCommand` variable this effect captured at mount
      // time never changes without a remount.
      let liveCommand = "";

      // Buffered-until-Enter local echo (plans/codeman-mobile-features.md):
      // Enter sends whatever's pending through the same Ink-safe delayed-\r
      // path touch keys use (T1); backspace edits the pending text locally
      // until it's empty, then cascades to a real \x7f; any other control
      // byte (Ctrl+C, Esc, Tab, arrows) flushes pending text immediately
      // alongside it — only Enter has the Ink text+\r race this delays for.
      const routeLocalEcho = (data: string, echo: LocalEcho) => {
        if (data === "\r") {
          const pending = echo.pendingText;
          echo.clear();
          sendWithInkSafeEnters(pending + "\r", sendInput);
          return;
        }
        if (data === "\x7f") {
          if (echo.hasPending) echo.removeChar();
          else sendInput(data);
          return;
        }
        if (isPrintableBurst(data)) {
          echo.appendText(data);
          return;
        }
        const pending = echo.pendingText;
        echo.clear();
        sendInput(pending + data);
      };

      const localEchoActive = () =>
        !!localEcho && mobilePointerRef.current && whenMatches(localEchoWhenRef.current, liveCommand);

      const forwardInput = (data: string) => {
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
        if (localEchoActive()) {
          routeLocalEcho(toSend, localEcho!);
          return;
        }
        sendInput(toSend);
      };

      // Image paste/drop (plans/codeman-mobile-features.md Phase 3): typed
      // through local echo when it's currently active (mobile + matching
      // pane), sent directly otherwise — same fork every other input path
      // in this file uses, just without the sticky-Ctrl/control-byte cases
      // that don't apply to a plain path string.
      const sendTextOrEcho = (text: string) => {
        if (localEchoActive()) localEcho!.appendText(text);
        else sendInput(text);
      };
      sendTextRef.current = sendTextOrEcho;

      // Gated by localEchoWhen alone (not mobilePointer — desktop paste is
      // the common case for this one) so it works independently of the
      // local-echo feature itself.
      const uploadAndType = async (blob: Blob, filename: string) => {
        const destDir = cwdRef.current;
        if (!destDir) return;
        const conflict = uploadConflictRef.current;
        const apiConflict = conflict === "ask" ? "fail" : conflict;
        try {
          const result = await api.uploadFile(`${destDir}/uploads`, filename, blob, apiConflict);
          sendTextOrEcho(result.path);
        } catch (err) {
          onErrorRef.current(err);
        }
      };

      const engine = await create({
        screen,
        settings: {
          fontFamily: initialSettings.current.fontFamily,
          fontSize: initialSettings.current.fontSize,
          fontWeight: initialSettings.current.fontWeight,
          fontWeightBold: initialSettings.current.fontWeightBold,
          cursorStyle: initialSettings.current.cursorStyle,
          cursorBlink: initialSettings.current.cursorBlink,
          lineHeight: initialSettings.current.lineHeight,
          letterSpacing: initialSettings.current.letterSpacing,
          minimumContrastRatio: initialSettings.current.minimumContrastRatio,
          textThickness: initialSettings.current.textThickness,
        },
        theme,
        isVisible: () => visibleRef.current,
        onData: forwardInput,
        resolvePaths: (paths) => api.resolvePaths(attachNameRef.current, paths).then((r) => r.results),
        onOpenUrl: openUrl,
        onOpenFile: (path, line) => onOpenFileRef.current?.(path, line),
        onOpenFileSecondary: (path, line) => onOpenFileSecondaryRef.current?.(path, line),
        onLinkHoverChange: (activate) => {
          linkActivateRef.current = activate;
        },
      });
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      // engine structurally satisfies LocalEchoAdapter (same five T2a
      // methods) — no wrapping needed. Constructed unconditionally and
      // cheaply (one overlay div + one onRender subscription); forwardInput
      // decides per-call whether to actually route through it, so gating
      // (mobile pointer, currentCommand) can change live without a remount.
      localEcho = new LocalEcho(terminalBodyRef.current!, engine);
      localEchoRef.current = localEcho;

      const refit = () => {
        // fit() itself no-ops (returns null) on a disposed/zero-size
        // terminal; a ResizeObserver callback can still fire after cleanup
        // disconnects it.
        const result = engine.fit();
        if (result && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: result.cols, rows: result.rows }));
        }
      };
      refitRef.current = refit;

      // tmux keeps scrollback internally, so the terminal never scrolls
      // locally and the engine's own scrollbar (if any) stays dormant.
      // Instead, after each output burst we ask tmux for its copy-mode
      // scroll state and drive an overlay thumb from it. In-flight
      // coalescing (not a fixed debounce) keeps this snappy: a burst of
      // "data" messages during continuous scrolling would otherwise keep
      // resetting a timer and compound into visible lag. A hard 250ms floor
      // on top caps the rate during sustained heavy output (e.g. `yes`) —
      // each query spawns a tmux subprocess server-side, so an unthrottled
      // per-chunk query flood burns real CPU for no visible benefit; a
      // trailing timer guarantees the final position still lands.
      const SCROLL_QUERY_FLOOR_MS = 250;
      let queryInFlight = false;
      let queryDirty = false;
      let lastQuerySentAt = 0;
      let queryThrottleTimer: number | undefined;
      const sendScrollQuery = () => {
        queryInFlight = true;
        lastQuerySentAt = Date.now();
        ws.send(JSON.stringify({ type: "scrollQuery" }));
      };
      const requestScrollState = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Nothing can observe the answer unless this terminal is on screen:
        // its tab must be the active one in its editor group (visibleRef) AND
        // the browser tab itself must be in the foreground (document.hidden).
        if (!visibleRef.current || document.hidden) return;
        if (queryInFlight) {
          queryDirty = true;
          return;
        }
        if (queryThrottleTimer !== undefined) return;
        const elapsed = Date.now() - lastQuerySentAt;
        if (elapsed >= SCROLL_QUERY_FLOOR_MS) {
          sendScrollQuery();
          return;
        }
        queryThrottleTimer = window.setTimeout(() => {
          queryThrottleTimer = undefined;
          if (ws.readyState === WebSocket.OPEN && !queryInFlight) sendScrollQuery();
        }, SCROLL_QUERY_FLOOR_MS - elapsed);
      };
      scrollQueryRef.current = requestScrollState;

      revealRef.current = () => {
        if (disposed) return;
        engine.reveal();
        refitRef.current?.();
        scrollQueryRef.current?.();
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
            engine.write(msg.data);
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
          } else if (msg.type === "command" && typeof msg.command === "string") {
            // A program switch invalidates any buffered pending text —
            // e.g. exiting claude mid-type would otherwise leave a stale
            // overlay in front of whatever now owns the pane.
            if (msg.command !== liveCommand) localEcho?.clear();
            liveCommand = msg.command;
            setCurrentCommand(msg.command);
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

      // ghostty-web's custom key handler semantics are INVERTED from
      // xterm.js: a truthy return means "handled — preventDefault and skip
      // the terminal's own key encoding", falsy means "process normally".
      // The engine normalizes this to "true = handled" regardless of which
      // engine is live. Only consulted on keydown, but the type guard stays
      // as cheap insurance against that changing. Combos come from the
      // rebindable keybindings map (via bindingsRef so a rebind applies
      // without re-mounting the terminal).
      engine.onKeyEvent((e) => {
        if (e.type !== "keydown") return false;
        const combo = serializeEvent(e);
        if (!combo) return false;
        const b = bindingsRef.current;
        const get = getContextGetter(e);
        if (bindingMatches(b["terminal.copy"], combo, get)) {
          e.preventDefault();
          const selection = engine.getSelection();
          if (selection) copyText(selection).catch((err) => onErrorRef.current(err));
          return true;
        }
        if (bindingMatches(b["terminal.find"], combo, get)) {
          e.preventDefault();
          // Toggle: closing here (rather than just opening) needs the
          // ref-forwarded handler since this handler is set up once and
          // can't see later renders' searchOpen value directly.
          if (searchOpenRef.current) handleSearchCloseRef.current();
          else setSearchOpen(true);
          return true;
        }
        if (bindingMatches(b["terminal.newline"], combo, get)) {
          e.preventDefault();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: "\n" }));
          }
          return true;
        }
        if (bindingMatches(b["terminal.clear"], combo, get)) {
          e.preventDefault();
          engine.clear();
          return true;
        }
        if (bindingMatches(b["terminal.scrollToBottom"], combo, get)) {
          e.preventDefault();
          // tmux owns scrollback here (see requestScrollState above), not
          // the terminal's own buffer. Exiting copy-mode via the same
          // "cancel" the search overlay already uses on close is what
          // actually returns the pane to its live tail.
          sendSearchRef.current("cancel");
          return true;
        }
        return false;
      });

      // tmux runs with mouse on, and the engine sends no mouse reports of
      // its own (its own selection mechanism only ever selects locally), so
      // this layer encodes SGR reports itself (mouseReports.ts) and ships
      // them over the attach socket — the same bytes a native terminal
      // would write to tmux's tty. The app's gesture policy: plain click =
      // tmux click; long-press = tmux press with live motion; plain drag =
      // LOCAL browser selection; Shift+gesture = forwarded to tmux with the
      // shift bit stripped (Shift is this app's "force forward" modifier,
      // not one tmux should see); middle/right = tmux press/release
      // directly. Wheel is handled separately below (Shift+wheel keeps
      // meaning horizontal scroll).
      const DRAG_THRESHOLD_PX = 4;
      const LONG_PRESS_MS = 500;

      const tracking = () => engine.getMode(1002) || engine.getMode(1000) || engine.getMode(1003);
      const sendReport = sendInput;
      const cellOf = (e: { clientX: number; clientY: number }) => engine.cellFromPoint(e.clientX, e.clientY);
      // Shift deliberately absent: see the gesture-policy comment above.
      const modsOf = (e: MouseEvent) => ({ alt: e.altKey, ctrl: e.ctrlKey });

      let pending: { startX: number; startY: number; source: MouseEvent } | null = null;
      let longPressTimer: number | undefined;
      // Button currently held-and-reported to tmux (long-press or
      // shift/middle/right press). While set, the document-level listeners
      // below stream motion reports and the terminating release — document-
      // level so a release outside the terminal still ends the gesture.
      let heldButton: 0 | 1 | 2 | null = null;
      let lastMotionCell = { col: 0, row: 0 };

      const onHeldMove = (e: MouseEvent) => {
        if (heldButton === null) return;
        e.preventDefault();
        e.stopPropagation();
        // Button-event tracking (1002) / any-event (1003) report motion;
        // plain 1000 reports only press/release. Coalesce to one report per
        // cell crossed — pixel-granular mousemove floods add nothing.
        if (!engine.getMode(1002) && !engine.getMode(1003)) return;
        const { col, row } = cellOf(e);
        if (col === lastMotionCell.col && row === lastMotionCell.row) return;
        lastMotionCell = { col, row };
        sendReport(encodeSgrMouse("motion", heldButton, col, row, modsOf(e)));
      };
      const onHeldUp = (e: MouseEvent) => {
        if (heldButton === null) return;
        e.preventDefault();
        e.stopPropagation();
        lastMotionCell = cellOf(e);
        endHeld();
      };
      const beginHeld = (button: 0 | 1 | 2, source: MouseEvent) => {
        heldButton = button;
        const { col, row } = cellOf(source);
        lastMotionCell = { col, row };
        sendReport(encodeSgrMouse("press", button, col, row, modsOf(source)));
        document.addEventListener("mousemove", onHeldMove, true);
        document.addEventListener("mouseup", onHeldUp, true);
      };
      // Always reports the release (at the last known cell) — a press must
      // never be left dangling in tmux, even when the gesture ends
      // abnormally (a new press superseding it, or unmount mid-drag).
      function endHeld() {
        if (heldButton === null) return;
        sendReport(encodeSgrMouse("release", heldButton, lastMotionCell.col, lastMotionCell.row));
        heldButton = null;
        document.removeEventListener("mousemove", onHeldMove, true);
        document.removeEventListener("mouseup", onHeldUp, true);
      }

      const onPendingMove = (e: MouseEvent) => {
        if (!pending) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        const source = pending.source;
        endPending();
        // Drag: hand the gesture to the engine's local selection, anchored
        // at the original press point; the ongoing real moves extend it live.
        engine.beginLocalSelection(source.clientX, source.clientY);
      };

      const onPendingUp = (e: MouseEvent) => {
        if (!pending) return;
        const source = pending.source;
        endPending();
        e.preventDefault();
        e.stopPropagation();
        // Click: clear any leftover highlight from a prior local drag (the
        // swallowed mousedown never reached the engine's own selection
        // mechanism, so it had no chance to clear stale selection itself),
        // then report press+release at the press cell so tmux gets a
        // normal click.
        engine.clearSelection();
        const { col, row } = cellOf(source);
        const mods = modsOf(source);
        sendReport(encodeSgrMouse("press", 0, col, row, mods));
        sendReport(encodeSgrMouse("release", 0, col, row, mods));
      };

      function endPending() {
        if (!pending) return;
        window.clearTimeout(longPressTimer);
        document.removeEventListener("mousemove", onPendingMove, true);
        document.removeEventListener("mouseup", onPendingUp, true);
        pending = null;
      }

      // Set by the touch handlers below when a swipe-scroll ends: Android
      // synthesizes compatibility mouse events after a touchend it wasn't
      // allowed to cancel (they're often non-cancelable post-scroll), and
      // that ghost mousedown would focus the hidden textarea — popping the
      // on-screen keyboard — through this handler AND the engine's own
      // listener. Swallowing every mouse event in this window kills the
      // whole synthesized burst; real mice are unaffected (nothing sets it
      // without touch).
      let suppressMouseUntil = 0;
      const lastMouse = { x: 0, y: 0 };

      const onCapture = (e: MouseEvent) => {
        if (isSyntheticSelectStart(e)) return;
        if (performance.now() < suppressMouseUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.type === "mousemove") {
          lastMouse.x = e.clientX;
          lastMouse.y = e.clientY;
        }

        // Ctrl+click / Ctrl+Shift+click (Cmd equivalents on mac) on a
        // hovered link: swallow the whole press-to-release gesture so
        // nothing reaches tmux or the engine (a forwarded ctrl+click would
        // e.g. re-trigger nvim's own <C-LeftMouse> tag-jump binding), and
        // activate the link directly on release. Deliberately ahead of the
        // tracking() check: the engine's own unmodified-click activation is
        // suppressed wholesale, making this the only activation path
        // whether or not tmux is mouse-reporting.
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

        // Without mouse tracking, plain gestures fall through to the
        // engine's own local selection — nothing to forward.
        if (!tracking()) return;
        // Moves/releases of in-flight gestures are handled by the document-
        // level pending/held listeners registered on press.
        if (e.type !== "mousedown") return;
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        const button = e.button as 0 | 1 | 2;

        endPending();
        endHeld();
        e.preventDefault();
        e.stopPropagation();
        // The swallowed mousedown would normally be what focuses the
        // engine's hidden textarea — do it ourselves.
        engine.focusInput();

        if (button !== 0 || e.shiftKey) {
          // Middle/right press, or Shift-forced forward: report the press
          // immediately; the held listeners stream motion + release.
          beginHeld(button, e);
          return;
        }

        // Plain left press: click, drag, or long-press — unknown until
        // movement (or its absence) tells. Swallow and decide.
        pending = { startX: e.clientX, startY: e.clientY, source: e };
        document.addEventListener("mousemove", onPendingMove, true);
        document.addEventListener("mouseup", onPendingUp, true);
        longPressTimer = window.setTimeout(() => {
          if (!pending) return;
          const source = pending.source;
          endPending();
          // Held without moving: start a real tmux press now; the held
          // listeners stream the rest live.
          beginHeld(0, source);
        }, LONG_PRESS_MS);
      };
      const capturedMouseEvents = ["mousedown", "mousemove", "mouseup"] as const;
      for (const type of capturedMouseEvents) {
        screen.addEventListener(type, onCapture, true);
      }

      // The engine's own click handler activates any link under the cursor
      // with no modifier gate (and would double-activate after our armed
      // path already ran). All link activation goes through the armed
      // press/release path above instead, so clicks never reach the engine.
      const onClickCapture = (e: MouseEvent) => {
        e.stopPropagation();
      };
      screen.addEventListener("click", onClickCapture, true);

      // Horizontal scroll: tmux has no concept of horizontal wheel — it
      // maps any wheel button other than "up" to WheelDown, so forwarding
      // one through the PTY would scroll vertically instead. Detect the
      // gesture here and ask the server to deliver <ScrollWheelLeft>/
      // <ScrollWheelRight> straight to nvim over RPC, which handles the
      // actual scrolling itself.
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
      // NOTE the engine's custom wheel handler semantics are INVERTED from
      // xterm.js, same as the key handler above: truthy = "handled, stop".
      // onWheelEvent SETS the one handler (it doesn't stack), so horizontal
      // and vertical handling share this callback.
      const wheelAcc = new WheelLineAccumulator();
      engine.onWheelEvent((e) => {
        // Diagonal trackpad motion (both deltas nonzero, no shift) counts
        // as vertical so ordinary scrolling keeps working normally.
        const horizontal = e.shiftKey ? e.deltaY : e.deltaY === 0 ? e.deltaX : 0;
        if (horizontal !== 0) {
          const rect = container.getBoundingClientRect();
          hScrollCol = Math.min(
            engine.cols - 1,
            Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * engine.cols)),
          );
          hScrollRow = Math.min(
            engine.rows - 1,
            Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * engine.rows)),
          );
          hScrollPx += horizontal;
          if (!hScrollRafPending) {
            hScrollRafPending = true;
            requestAnimationFrame(flushHScroll);
          }
          e.preventDefault();
          return true;
        }

        // Vertical wheel while tmux is mouse-reporting: one SGR wheel
        // report per DOM event, gated by xterm.js's line-accumulation math
        // (ported in WheelLineAccumulator) so sub-line trackpad deltas
        // accumulate until a full line's worth arrived instead of each
        // micro-event firing a report. Without tracking, fall through
        // (return false): the engine's own wheel path already sends arrow
        // keys in the alternate screen.
        if (!tracking()) return false;
        const lines = wheelAcc.linesFor(e, engine.getCharHeight(), engine.rows);
        if (lines !== 0) {
          const { col, row } = cellOf(e);
          sendReport(
            encodeSgrMouse(lines < 0 ? "wheelUp" : "wheelDown", 0, col, row, {
              alt: e.altKey,
              ctrl: e.ctrlKey,
            }),
          );
        }
        e.preventDefault();
        return true;
      });

      // Touch swipes: the engine's only touch handling (if any) is a
      // canvas touchend that focuses the IME textarea — drags scroll
      // nothing on mobile by default. Convert single-finger swipes into
      // synthetic wheel events dispatched through the engine: they funnel
      // through the custom wheel handler above, so every policy there (SGR
      // reports under tracking, nvim hscroll, the engine's own fallback)
      // applies to touch unchanged. Once a drag crosses the threshold the
      // whole gesture is a scroll, and touchmove is preventDefault()ed to
      // stop browser pan/pull-to-refresh (belt-and-braces with the CSS
      // touch-action: none). Gesture endings are owned entirely by
      // onTouchEnd below.
      const TOUCH_SCROLL_THRESHOLD_PX = 8;
      let touchLast: { x: number; y: number } | null = null;
      let touchScrolling = false;
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) {
          touchLast = null;
          return;
        }
        touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchScrolling = false;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (!touchLast || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = touchLast.x - t.clientX;
        const dy = touchLast.y - t.clientY;
        if (!touchScrolling && Math.hypot(dx, dy) < TOUCH_SCROLL_THRESHOLD_PX) return;
        touchScrolling = true;
        e.preventDefault();
        touchLast = { x: t.clientX, y: t.clientY };
        // Dominant axis only: the wheel handler treats mixed deltas as
        // vertical, which would swallow slightly-diagonal horizontal swipes.
        const [deltaX, deltaY] = Math.abs(dx) > Math.abs(dy) ? [dx, 0] : [0, dy];
        engine.dispatchSyntheticWheel({
          deltaX,
          deltaY,
          clientX: t.clientX,
          clientY: t.clientY,
          bubbles: true,
          cancelable: true,
        });
      };
      const onTouchEnd = (e: TouchEvent) => {
        // Own every gesture ending on the terminal: swallow it before the
        // engine's own touchend (which may focus its textarea and pop the
        // on-screen keyboard) — real devices deliver post-scroll touchends
        // with per-browser cancelable/compat quirks, so suppressing the
        // engine's handler only on scrolls proved unreliable. Focus — the
        // thing that opens the keyboard — is granted here and only here: a
        // completed single-finger tap. Swipes, cancelled gestures, and
        // multi-touch never focus.
        const wasTap = touchLast !== null && !touchScrolling;
        if (!wasTap) suppressMouseUntil = performance.now() + 700;
        touchLast = null;
        touchScrolling = false;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (wasTap && e.type === "touchend") engine.focusInput();
      };
      screen.addEventListener("touchstart", onTouchStart, { passive: true });
      screen.addEventListener("touchmove", onTouchMove, { passive: false });
      screen.addEventListener("touchend", onTouchEnd, true);
      screen.addEventListener("touchcancel", onTouchEnd, true);

      // Focus in/out reports (mode 1004). focusin/focusout bubble from
      // both focus targets (the screen div via engine.focus(), the hidden
      // textarea via presses); transitions between the two stay inside
      // `screen` and are filtered out via relatedTarget.
      const onFocusIn = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        if (engine.getMode(1004)) sendReport(focusReport(true));
      };
      const onFocusOut = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        if (engine.getMode(1004)) sendReport(focusReport(false));
        localEcho?.clear();
      };
      screen.addEventListener("focusin", onFocusIn);
      screen.addEventListener("focusout", onFocusOut);

      // Image paste/drop (plans/codeman-mobile-features.md Phase 3): upload
      // to <cwd>/uploads and type the resulting path. Capture phase on
      // paste, ahead of ghostty-web's own bundled paste handling, so a
      // non-image paste (the common case) is left completely alone — only
      // an image item gets preventDefault/stopPropagation, never a plain
      // text paste.
      const onPaste = (e: ClipboardEvent) => {
        if (!whenMatches(localEchoWhenRef.current, liveCommand)) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageItem = Array.from(items).find((it) => it.type.startsWith("image/"));
        if (!imageItem) return;
        const blob = imageItem.getAsFile();
        if (!blob) return;
        e.preventDefault();
        e.stopPropagation();
        uploadAndType(blob, `paste-${Date.now()}.${extensionForImageMime(imageItem.type)}`);
      };
      screen.addEventListener("paste", onPaste, true);

      // Drop targets the whole terminal body (scrollbar/search-bar/touch-key
      // gutters included), not just the screen — anywhere over the pane is a
      // reasonable drop target. dragover must preventDefault too, or the
      // browser never fires drop at all (its default is "reject the drop").
      const onDragOver = (e: DragEvent) => {
        if (!whenMatches(localEchoWhenRef.current, liveCommand)) return;
        if (!Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) return;
        e.preventDefault();
      };
      const onDrop = (e: DragEvent) => {
        if (!whenMatches(localEchoWhenRef.current, liveCommand)) return;
        const files = Array.from(e.dataTransfer?.files ?? []);
        const imageFile = files.find((f) => f.type.startsWith("image/"));
        if (!imageFile) return;
        e.preventDefault();
        uploadAndType(imageFile, imageFile.name || `drop-${Date.now()}.${extensionForImageMime(imageFile.type)}`);
      };
      terminalBodyRef.current!.addEventListener("dragover", onDragOver);
      terminalBodyRef.current!.addEventListener("drop", onDrop);

      // Fires when the tab becomes visible again (display:none → block) and on
      // window resizes, so hidden terminals refit as soon as they can measure.
      // Observes the screen div (what fit() measures), not the host: the
      // touch key bar mounting/unmounting resizes only the flex body around
      // the screen, never the host itself.
      //
      // The trailing settle pass exists for mobile keyboard show/hide storms
      // (win/vv observed bouncing 825→425→825→797 within milliseconds):
      // per-step refits have left the canvas mis-scaled — internal buffer at
      // the wrong resolution for its final CSS size, rendering blurry
      // stretched glyphs — until something forced a full re-layout (users
      // had to switch tabs). engine.reveal() is the one public path that
      // re-sizes the canvas to the shimmed metrics AND force-renders, so
      // running it once the storm goes quiet performs that tab-switch reset
      // automatically.
      let settleTimer: number | undefined;
      const observer = new ResizeObserver(() => {
        refit();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          if (disposed) return;
          engine.reveal();
          refit();
        }, 350);
      });
      observer.observe(screen);

      // Same coarse-pointer gate as the [focused] effect below: a tab
      // opened by a tap would otherwise mount straight into a focused
      // contenteditable and pop the on-screen keyboard.
      if (focused && !window.matchMedia("(pointer: coarse)").matches) engine.focus();

      cleanup = () => {
        clearTimeout(reconnectTimer);
        clearTimeout(queryThrottleTimer);
        clearTimeout(settleTimer);
        onDragEnd();
        endPending();
        endHeld();
        for (const type of capturedMouseEvents) {
          screen.removeEventListener(type, onCapture, true);
        }
        screen.removeEventListener("click", onClickCapture, true);
        screen.removeEventListener("touchstart", onTouchStart);
        screen.removeEventListener("touchmove", onTouchMove);
        screen.removeEventListener("touchend", onTouchEnd, true);
        screen.removeEventListener("touchcancel", onTouchEnd, true);
        screen.removeEventListener("focusin", onFocusIn);
        screen.removeEventListener("focusout", onFocusOut);
        screen.removeEventListener("paste", onPaste, true);
        terminalBodyRef.current?.removeEventListener("dragover", onDragOver);
        terminalBodyRef.current?.removeEventListener("drop", onDrop);
        observer.disconnect();
        ws.onclose = null;
        ws.close();
        localEcho?.dispose();
        localEchoRef.current = null;
        engine.dispose();
        engineRef.current = null;
        refitRef.current = null;
        scrollQueryRef.current = null;
        revealRef.current = null;
      };
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
    // Theme is deliberately a dependency: neither engine can re-theme a live
    // terminal (ghostty's ANSI palette is baked into its WASM config at
    // construction; this app applies xterm's theme the same remount-based
    // way for uniform behavior across engines), so a theme switch tears the
    // whole terminal + WS down and rebuilds — tmux redraws the content on
    // reattach. Theme identity is stable (useThemeAssets), so this only
    // fires on a real theme change. resolvedEngine is also deliberately a
    // dependency: switching engines (directly or via "auto" re-resolving on
    // a device-class change) needs the exact same rebuild-and-reattach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, resolvedEngine]);

  // Apply settings changes to the live terminal without reconnecting.
  useEffect(() => {
    engineRef.current?.setSettings({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      fontWeightBold: settings.fontWeightBold,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      minimumContrastRatio: settings.minimumContrastRatio,
      textThickness: settings.textThickness,
    });
    refitRef.current?.();
  }, [settings]);

  // A newly-loaded extension font needs a re-measure even though
  // fontFamily was already set to its name (while the face was still
  // loading, so glyphs rendered in whatever fallback matched first).
  useEffect(() => {
    engineRef.current?.refreshFonts();
    refitRef.current?.();
    localEchoRef.current?.refreshFont();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontsVersion]);

  // A tab that was hidden skipped every scroll query while it was off screen
  // (see requestScrollState), so its thumb reflects whatever the pane looked
  // like when it was last visible. Catch it up once, on reveal — the one
  // moment the answer can actually be seen.
  useEffect(() => {
    if (visible) revealRef.current?.();
  }, [visible]);

  // Counterpart to the document.hidden bail-outs above: a backgrounded browser
  // tab neither paints nor queries, so catch both up the moment it returns to
  // the foreground.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && visibleRef.current) revealRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Not on touch devices: engine.focus() focuses the contenteditable screen
  // div, and doing that inside a user gesture (tapping a tab, tapping out
  // of the bottom panel — anything that flips `focused`) pops the
  // on-screen keyboard. On touch, keyboard focus is granted only by a
  // direct tap on the terminal (the touchend handler in the mount effect).
  useEffect(() => {
    if (!focused) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    requestAnimationFrame(() => engineRef.current?.focus());
  }, [focused]);

  return (
    <div
      ref={containerRef}
      className={`terminal-host${visible ? "" : " hidden"}`}
    >
      {/* The touch key bar sits below this body in normal flow (flex
          column), so the terminal shrinks above it instead of rendering
          its last rows underneath; the overlays anchor to the body so
          they too stay clear of the bar. */}
      <div ref={terminalBodyRef} className="terminal-body">
        <div ref={screenRef} className="terminal-screen" />
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
        {settings.touchKeyBarStyle === "floating" && (
          <FloatingTouchKeys
            visible={keyBarVisible}
            keys={settings.touchKeys}
            currentCommand={currentCommand}
            stickyCtrl={stickyCtrl}
            onToggleStickyCtrl={() => setStickyCtrl((v) => !v)}
            onSendInput={(data) => sendInputRef.current(data)}
            onSendVoiceText={(text) => sendTextRef.current(text)}
            containerRef={terminalBodyRef}
          />
        )}
      </div>
      {settings.touchKeyBarStyle !== "floating" && (
        <TouchKeyBar
          visible={keyBarVisible}
          keys={settings.touchKeys}
          currentCommand={currentCommand}
          stickyCtrl={stickyCtrl}
          onToggleStickyCtrl={() => setStickyCtrl((v) => !v)}
          onSendInput={(data) => sendInputRef.current(data)}
          onSendVoiceText={(text) => sendTextRef.current(text)}
        />
      )}
    </div>
  );
}
