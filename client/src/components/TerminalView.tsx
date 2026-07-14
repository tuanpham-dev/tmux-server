import { FitAddon, Terminal, type ITheme } from "ghostty-web";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import { getContextGetter } from "../contextKeys";
import { bindingMatches, serializeEvent, type Keybinding } from "../keybindings";
import type { AppSettings } from "../settings";
import SearchBar from "./SearchBar";
import TouchKeyBar from "./TouchKeyBar";
import {
  applyRendererOverrides,
  parseHexColor,
  type RendererShim,
} from "../ghosttyShims";
import {
  cellFromPoint,
  encodeSgrMouse,
  focusReport,
  WheelLineAccumulator,
} from "../mouseReports";
import { buildLinkProvider, isOpenGesture, openUrl } from "../terminalLinks";

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
  theme: ITheme;
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // ghostty-web's open() takes over the element it's given: contenteditable,
  // role=textbox, a beforeinput preventDefault, and container-level key/paste
  // listeners. Those must never wrap the SearchBar/TouchKeyBar/scroll-track
  // (typing in the search box would be blocked by that beforeinput handler
  // and simultaneously leak into the PTY via the key listeners), so the
  // terminal gets this dedicated inner div and the widgets stay siblings.
  const screenRef = useRef<HTMLDivElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rendererShimRef = useRef<RendererShim | null>(null);
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
  // everything that arrived while its paint was suppressed (see the render
  // shim in the mount effect).
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
    focused &&
    (settings.touchKeyBar === "always" ||
      (settings.touchKeyBar === "auto" && coarsePointer));
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const stickyCtrlRef = useRef(false);
  stickyCtrlRef.current = stickyCtrl;
  const sendInputRef = useRef<(data: string) => void>(() => {});

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
    const raf = requestAnimationFrame(() => {
      // Belt-and-braces alongside the cancelAnimationFrame in the effect's
      // destructor: a tab opened and closed within the same tick (seen live
      // when the vanished-window sweep raced a just-created window) can
      // reach this frame after unmount already nulled the refs — building a
      // terminal (and a WS) then would throw mid-setup and leak both.
      if (disposed) return;
      const term = new Terminal({
        cursorBlink: initialSettings.current.cursorBlink,
        cursorStyle: initialSettings.current.cursorStyle,
        fontSize: initialSettings.current.fontSize,
        fontFamily: initialSettings.current.fontFamily,
        // Full theme application (incl. the ANSI-16 palette baked into the
        // WASM terminal config) only happens at construction — runtime theme
        // swaps are unsupported by ghostty-web 0.4.0, so a theme change
        // remounts this whole effect instead (see the [theme] dep below).
        theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);

      // ghostty-web 0.4.0's SelectionManager registers an anonymous document
      // "mousedown" listener (its mouseDownTarget tracker) during open() but
      // never removes it in dispose() — every terminal ever opened would leak
      // its renderer/WASM graph via that listener's closure until the page
      // reloads. Capture it here (this intercept is strictly synchronous
      // around open(), nothing else runs in between) and remove it ourselves
      // in cleanup below.
      const leakedMousedownListeners: [EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
      const realAddEventListener = document.addEventListener;
      document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === "mousedown") leakedMousedownListeners.push([listener, options]);
        return realAddEventListener.call(document, type, listener, options);
      }) as typeof document.addEventListener;
      term.open(screen);
      document.addEventListener = realAddEventListener;
      termRef.current = term;

      // ghostty-web's open() makes the screen div contenteditable and
      // leaves it focused (its trailing this.focus()). On touch devices
      // that arms the on-screen keyboard: Android pops it on ANY later
      // touch of a focused editable — swipes included, no focus() call
      // involved (confirmed on-device; a tab switch's display:none blur
      // was what made it seem intermittent). Blurring after open() proved
      // insufficient — the div ended up focused again through native
      // paths — so remove editability itself: a focused non-editable div
      // cannot summon the keyboard. Typing is unaffected on touch — the
      // hidden textarea is the IME target (onTouchEnd's tap path below)
      // and its key/composition/beforeinput events bubble to this
      // container where ghostty's InputHandler and the app's Android
      // bridge listen.
      if (window.matchMedia("(pointer: coarse)").matches) {
        screen.removeAttribute("contenteditable");
        screen.removeAttribute("role");
        screen.blur();
      }

      // Display settings ghostty-web has no options for — lineHeight,
      // letterSpacing, minimumContrastRatio — applied by shimming the
      // renderer (ghosttyShims.ts). The shim re-measures immediately;
      // resize the canvas to the current grid so the adjusted metrics are
      // live before the first fit.
      rendererShimRef.current = applyRendererOverrides(
        term.renderer!,
        {
          lineHeight: initialSettings.current.lineHeight,
          letterSpacing: initialSettings.current.letterSpacing,
          minimumContrastRatio: initialSettings.current.minimumContrastRatio,
          textThickness: initialSettings.current.textThickness,
        },
        parseHexColor(theme.background),
      );
      // Bounce fontFamily to run ghostty's handleFontChange — the only
      // public path that both resizes the canvas to the (now shimmed)
      // metrics AND force-renders. A bare renderer.resize() clears the
      // canvas without repainting (the dirty tracker still says clean).
      const bounceFont = () => {
        const family = term.options.fontFamily;
        term.options.fontFamily = `${family} `;
        term.options.fontFamily = family;
      };
      bounceFont();

      // ghostty-web drives an unconditional requestAnimationFrame loop
      // (startRenderLoop): every terminal repaints every frame for as long as
      // it exists, whether or not it is on screen. Browsers only THROTTLE
      // background tabs (~20fps, measured) rather than stopping them, and a
      // terminal on an inactive editor tab keeps painting too — so a window
      // with several tabs open on a busy pane burned CPU on canvases nobody
      // could see, on every one of them, forever. Skip the paint when there is
      // nothing to look at. Output still streams into the WASM terminal and
      // marks its rows dirty; suppressing the paint just defers the pixels,
      // and the reveal path below force-renders so no stale frame is shown.
      const renderer = term.renderer!;
      const originalRender = renderer.render.bind(renderer);
      renderer.render = ((...args: Parameters<typeof originalRender>) => {
        if (disposed) return;
        if (!visibleRef.current || document.hidden) return;
        return originalRender(...args);
      }) as typeof renderer.render;

      // Repaint everything that changed while the paint was suppressed. The
      // fontFamily bounce is the one public path that both re-sizes the canvas
      // to the shimmed metrics AND force-renders (see bounceFont above), which
      // is exactly what a terminal returning to screen needs.
      revealRef.current = () => {
        if (disposed) return;
        bounceFont();
        refitRef.current?.();
        scrollQueryRef.current?.();
      };

      if (import.meta.env.DEV) {
        // Debug handles for devtools poking (e.g. term.getMode(1002) while
        // QA-ing mouse forwarding, or shim overrides while QA-ing display
        // settings) — point at the most recently mounted terminal; never
        // present in production builds.
        (window as unknown as { __term?: Terminal }).__term = term;
        (window as unknown as { __termShim?: RendererShim }).__termShim =
          rendererShimRef.current;
      }

      // Ctrl+click (Cmd+click on Mac) links: URLs and local file paths
      // detected by our own regex provider. Activation is gated on the
      // modifier inside each activate callback, and onCapture below
      // additionally intercepts ctrl+mousedown while mouse-reporting is on
      // so a ctrl+click never reaches tmux. (OSC 8 hyperlinks are dropped:
      // ghostty-web 0.4.0 stubs getHyperlinkUri() to null, so their target
      // URIs are unreadable — revisit when upstream exposes the lookup.)
      //
      // ghostty-web's link hover callback is hover(isHovered: boolean) with
      // no MouseEvent, so the tooltip is positioned from the last pointer
      // position tracked by onCapture's mousemove below.
      const lastMouse = { x: 0, y: 0 };
      const hoverTooltip = document.createElement("div");
      hoverTooltip.className = "terminal-link-tooltip";
      term.element?.appendChild(hoverTooltip);
      const showTooltip = (text: string) => {
        const hostRect = term.element?.getBoundingClientRect();
        if (!hostRect) return;
        hoverTooltip.textContent = text;
        hoverTooltip.style.left = `${lastMouse.x - hostRect.left + 12}px`;
        hoverTooltip.style.top = `${lastMouse.y - hostRect.top + 16}px`;
        hoverTooltip.style.display = "block";
      };
      const hideTooltip = () => {
        hoverTooltip.style.display = "none";
      };

      // ghostty-web auto-registers its own OSC8LinkProvider (dead in 0.4.0:
      // getHyperlinkUri() is stubbed to null) and UrlRegexProvider (no
      // modifier gate, wins getLinkAt over later providers, bypasses the
      // hover tooltip). Both would starve the app's provider, so clear the
      // detector and register ours as the only one. Reaches into a private
      // field — ghostty-web is pinned to exactly 0.4.0 partly for this.
      (term as unknown as { linkDetector?: { providers: unknown[] } }).linkDetector?.providers.splice(0);

      term.registerLinkProvider(
        buildLinkProvider(term, {
          resolvePaths: (paths) => api.resolvePaths(attachNameRef.current, paths).then((r) => r.results),
          onOpenUrl: openUrl,
          onOpenFile: (path, line) => onOpenFileRef.current?.(path, line),
          onOpenFileSecondary: (path, line) => onOpenFileSecondaryRef.current?.(path, line),
          onHoverChange: (link) => {
            if (link) {
              showTooltip(link.text);
              linkActivateRef.current = (e) => link.activate(e);
            } else {
              hideTooltip();
              linkActivateRef.current = null;
            }
          },
        }),
      );

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

      // tmux keeps scrollback internally, so the terminal never scrolls
      // locally and ghostty's own scrollbar stays dormant. Instead, after
      // each output burst we ask tmux
      // for its copy-mode scroll state and drive an overlay thumb from it.
      // In-flight coalescing (not a fixed debounce) keeps this snappy: a
      // burst of "data" messages during continuous scrolling would otherwise
      // keep resetting a timer and compound into visible lag. A hard 80ms
      // floor on top caps the rate during sustained heavy output (e.g. `yes`)
      // — each query spawns a tmux subprocess server-side, so an unthrottled
      // per-chunk query flood burns real CPU for no visible benefit; a
      // trailing timer guarantees the final position still lands.
      // 80ms here meant up to 12.5 queries/sec per attached terminal, and each
      // one forks a `tmux display-message` server-side. Across a handful of
      // tabs watching the same busy pane that measured ~170 forks/sec —
      // enough kernel + tmux-server load to make the whole UI (page loads
      // included) unresponsive. The server now shares one query across every
      // client on a session (getScrollState's coalescing cache), and this
      // floor drops the per-client rate on top: a scrollbar thumb doesn't need
      // 12 updates a second, and the trailing timer still lands the final
      // position.
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
        // Both were previously ignored — a backgrounded window with ten tabs
        // open kept every one of them querying at full rate against a pane
        // nobody was looking at, which is what turned a per-tab trickle into a
        // machine-wide fork storm. Whichever condition unblocks fires one
        // catch-up query (the [visible] effect, or the visibilitychange
        // listener below), so the thumb is right the moment it can be seen.
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: toSend }));
        }
      };
      const dataSub = term.onData(forwardInput);

      // Android soft-keyboard bridge. Mobile IMEs report almost every key
      // as keydown keyCode 229 — which ghostty-web's InputHandler
      // deliberately ignores — and deliver the actual text as a beforeinput
      // on the focused editable (ghostty's hidden textarea, or the
      // contenteditable screen div itself); both bubble through `screen`.
      // 0.4.0 has no beforeinput handling at all (its only listener is the
      // contenteditable's blanket preventDefault), so without this bridge
      // every character typed on Android is silently dropped. Upstream
      // added the equivalent handler after 0.4.0 (handleBeforeInput in
      // lib/input-handler.ts on main); this mirrors its inputType mapping
      // and its value+time de-dup of an insertText that echoes a
      // just-committed composition (some keyboards fire both paths for the
      // same text) — drop the bridge when a release ships it. Events during
      // composition are skipped: ghostty already forwards the committed
      // text on compositionend. Desktop typing can't double-send: every
      // keydown InputHandler forwards is preventDefault()ed, so it never
      // produces a beforeinput.
      let lastCompositionData = "";
      let lastCompositionTime = 0;
      const onCompositionEnd = (e: CompositionEvent) => {
        // Runs after ghostty's own compositionend handler (registered
        // earlier on the same element), which has already read e.data and
        // forwarded it — clearing here can't lose input. Composition text
        // is the one insertion the blanket preventDefault can't cancel, so
        // it accumulates in the hidden textarea; ghostty only cleans the
        // container's text nodes, never textarea.value. Left in place, the
        // IME treats the previous command as context and re-composes
        // against its last word, committing data that repeats already-sent
        // text. Same reset xterm.js does after every commit.
        if (term.textarea) term.textarea.value = "";
        if (!e.data) return;
        lastCompositionData = e.data;
        lastCompositionTime = performance.now();
      };
      const onBeforeInput = (e: InputEvent) => {
        if (e.isComposing) return;
        let out: string | null;
        switch (e.inputType) {
          case "insertText":
          case "insertReplacementText":
            out = e.data ? e.data.replace(/\n/g, "\r") : null;
            break;
          case "insertLineBreak":
          case "insertParagraph":
            out = "\r";
            break;
          case "deleteContentBackward":
            out = "\x7f";
            break;
          case "deleteContentForward":
            out = "\x1b[3~";
            break;
          default:
            return;
        }
        e.preventDefault();
        if (out === null) return;
        if (
          e.data !== null &&
          e.data === lastCompositionData &&
          performance.now() - lastCompositionTime < 100
        ) {
          lastCompositionData = "";
          return;
        }
        forwardInput(out);
      };
      screen.addEventListener("compositionend", onCompositionEnd);
      screen.addEventListener("beforeinput", onBeforeInput);

      // ghostty-web's custom key handler semantics are INVERTED from
      // xterm.js: a truthy return means "handled — preventDefault and skip
      // the terminal's own key encoding", falsy means "process normally".
      // Handled combos below therefore return true. ghostty only consults
      // this handler on keydown, but the type guard stays as cheap
      // insurance against that changing. Combos come from the rebindable
      // keybindings map (via bindingsRef so a rebind applies without
      // re-mounting the terminal).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return false;
        const combo = serializeEvent(e);
        if (!combo) return false;
        const b = bindingsRef.current;
        const get = getContextGetter(e);
        if (bindingMatches(b["terminal.copy"], combo, get)) {
          e.preventDefault();
          const selection = term.getSelection();
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
          term.clear();
          return true;
        }
        if (bindingMatches(b["terminal.scrollToBottom"], combo, get)) {
          e.preventDefault();
          // tmux owns scrollback here (see the mount effect's comment above
          // requestScrollState), not the terminal's own buffer —
          // term.scrollToBottom() would be a no-op. Exiting copy-mode via
          // the same "cancel" the search overlay already uses on close is
          // what actually returns the pane to its live tail.
          sendSearchRef.current("cancel");
          return true;
        }
        return false;
      });

      // tmux runs with mouse on, and ghostty-web sends no mouse reports of
      // its own (its SelectionManager only ever selects locally), so this
      // layer encodes SGR reports itself (mouseReports.ts) and ships them
      // over the attach socket — the same bytes a native terminal would
      // write to tmux's tty. The app's gesture policy, unchanged from the
      // xterm era: plain click = tmux click; long-press = tmux press with
      // live motion; plain drag = LOCAL browser selection; Shift+gesture =
      // forwarded to tmux with the shift bit stripped (Shift is this app's
      // "force forward" modifier, not one tmux should see); middle/right =
      // tmux press/release directly. Wheel is handled separately below
      // (Shift+wheel keeps meaning horizontal scroll).
      const DRAG_THRESHOLD_PX = 4;
      const LONG_PRESS_MS = 500;

      const tracking = () => term.getMode(1002) || term.getMode(1000) || term.getMode(1003);
      const sendReport = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      };
      const cellOf = (e: { clientX: number; clientY: number }) => {
        const renderer = term.renderer!;
        return cellFromPoint(
          e.clientX,
          e.clientY,
          renderer.getCanvas().getBoundingClientRect(),
          renderer.charWidth,
          renderer.charHeight,
          term.cols,
          term.rows,
        );
      };
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
        if (!term.getMode(1002) && !term.getMode(1003)) return;
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

      // The one synthetic event left (down from the xterm era's
      // press/release replay pairs): a threshold-crossed plain drag starts
      // ghostty's local selection by re-dispatching the swallowed mousedown
      // on the canvas at the original press point — SelectionManager's
      // listeners don't gate on isTrusted — after which the real mousemove
      // stream extends the selection natively (and its mouseup handler
      // finalizes + copies it). The WeakSet marks it so onCapture below
      // passes it through instead of re-swallowing: dispatching on the
      // canvas still capture-descends through the screen div.
      const syntheticSelectStarts = new WeakSet<MouseEvent>();
      const startLocalSelection = (source: MouseEvent) => {
        const canvas = term.renderer?.getCanvas();
        if (!canvas) return;
        const synthetic = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: source.detail,
          clientX: source.clientX,
          clientY: source.clientY,
          button: 0,
          buttons: 1,
        });
        syntheticSelectStarts.add(synthetic);
        canvas.dispatchEvent(synthetic);
      };

      const onPendingMove = (e: MouseEvent) => {
        if (!pending) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        const source = pending.source;
        endPending();
        // Drag: hand the gesture to ghostty's local selection, anchored at
        // the original press point; the ongoing real moves extend it live.
        startLocalSelection(source);
      };

      const onPendingUp = (e: MouseEvent) => {
        if (!pending) return;
        const source = pending.source;
        endPending();
        e.preventDefault();
        e.stopPropagation();
        // Click: clear any leftover highlight from a prior local drag (the
        // swallowed mousedown never reached SelectionManager, so it had no
        // chance to clear stale selection itself), then report press+release
        // at the press cell so tmux gets a normal click.
        term.clearSelection();
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
      // on-screen keyboard — through this handler AND ghostty's canvas
      // listener. Swallowing every mouse event in this window kills the
      // whole synthesized burst; real mice are unaffected (nothing sets it
      // without touch).
      let suppressMouseUntil = 0;

      const onCapture = (e: MouseEvent) => {
        if (syntheticSelectStarts.has(e)) return;
        if (performance.now() < suppressMouseUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.type === "mousemove") {
          // Tracked unconditionally (before any bail-out below): the link
          // hover tooltip has no MouseEvent of its own to position from.
          lastMouse.x = e.clientX;
          lastMouse.y = e.clientY;
        }

        // Ctrl+click / Ctrl+Shift+click (Cmd equivalents on mac) on a
        // hovered link: swallow the whole press-to-release gesture so
        // nothing reaches tmux or ghostty (a forwarded ctrl+click would
        // e.g. re-trigger nvim's own <C-LeftMouse> tag-jump binding), and
        // activate the link directly on release. Deliberately ahead of the
        // tracking() check: ghostty's own unmodified-click activation is
        // suppressed wholesale (see onClickCapture below), making this the
        // only activation path whether or not tmux is mouse-reporting.
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

        // Without mouse tracking, plain gestures fall through to ghostty's
        // own local selection — nothing to forward.
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
        // The swallowed mousedown would normally be what focuses ghostty's
        // hidden textarea (its canvas listener) — do it ourselves.
        term.textarea?.focus();

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

      // ghostty-web's own click handler activates any link under the cursor
      // with no modifier gate (and would double-activate after our armed
      // path already ran). All link activation goes through the armed
      // press/release path above instead, so clicks never reach ghostty.
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
      // NOTE ghostty-web's custom wheel handler semantics are INVERTED from
      // xterm.js, same as the key handler above: truthy = "handled, stop".
      // attachCustomWheelEventHandler SETS the one handler (it doesn't
      // stack), so horizontal and vertical handling share this callback.
      const wheelAcc = new WheelLineAccumulator();
      term.attachCustomWheelEventHandler((e) => {
        // Diagonal trackpad motion (both deltas nonzero, no shift) counts
        // as vertical so ordinary scrolling keeps working normally.
        const horizontal = e.shiftKey ? e.deltaY : e.deltaY === 0 ? e.deltaX : 0;
        if (horizontal !== 0) {
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
          return true;
        }

        // Vertical wheel while tmux is mouse-reporting: one SGR wheel
        // report per DOM event, gated by xterm.js's line-accumulation math
        // (ported in WheelLineAccumulator) so sub-line trackpad deltas
        // accumulate until a full line's worth arrived instead of each
        // micro-event firing a report — exactly xterm 5.5's behavior in
        // tracking mode. Without tracking, fall through (return false):
        // ghostty's own wheel path already sends arrow keys in the
        // alternate screen.
        if (!tracking()) return false;
        const renderer = term.renderer;
        if (!renderer) return false;
        const lines = wheelAcc.linesFor(e, renderer.charHeight, term.rows);
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

      // Touch swipes: ghostty-web 0.4.0's only touch handling is a canvas
      // touchend that focuses the IME textarea — drags scroll nothing on
      // mobile. Convert single-finger swipes into synthetic wheel events
      // dispatched at the canvas: they funnel through the custom wheel
      // handler above, so every policy there (SGR reports under tracking,
      // nvim hscroll, ghostty's own fallback) applies to touch unchanged.
      // Once a drag crosses the threshold the whole gesture is a scroll,
      // and touchmove is preventDefault()ed to stop browser
      // pan/pull-to-refresh (belt-and-braces with the CSS touch-action:
      // none). Gesture endings are owned entirely by onTouchEnd below.
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
        term.renderer?.getCanvas().dispatchEvent(
          new WheelEvent("wheel", {
            deltaX,
            deltaY,
            clientX: t.clientX,
            clientY: t.clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      const onTouchEnd = (e: TouchEvent) => {
        // Own every gesture ending on the terminal: swallow it before
        // ghostty's canvas touchend (preventDefault + textarea.focus()),
        // whose focus call pops the on-screen keyboard — real devices
        // deliver post-scroll touchends with per-browser cancelable/compat
        // quirks, so suppressing ghostty's handler only on scrolls proved
        // unreliable. Focus — the thing that opens the keyboard — is
        // granted here and only here: a completed single-finger tap.
        // Swipes, cancelled gestures, and multi-touch never focus.
        const wasTap = touchLast !== null && !touchScrolling;
        if (!wasTap) suppressMouseUntil = performance.now() + 700;
        touchLast = null;
        touchScrolling = false;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (wasTap && e.type === "touchend") term.textarea?.focus();
      };
      screen.addEventListener("touchstart", onTouchStart, { passive: true });
      screen.addEventListener("touchmove", onTouchMove, { passive: false });
      screen.addEventListener("touchend", onTouchEnd, true);
      screen.addEventListener("touchcancel", onTouchEnd, true);

      // Focus in/out reports (mode 1004) — xterm sent these itself,
      // ghostty-web doesn't. focusin/focusout bubble from both focus
      // targets (the screen div via term.focus(), the hidden textarea via
      // presses); transitions between the two stay inside `screen` and are
      // filtered out via relatedTarget.
      const onFocusIn = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        if (term.getMode(1004)) sendReport(focusReport(true));
      };
      const onFocusOut = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        if (term.getMode(1004)) sendReport(focusReport(false));
      };
      screen.addEventListener("focusin", onFocusIn);
      screen.addEventListener("focusout", onFocusOut);

      // Fires when the tab becomes visible again (display:none → block) and on
      // window resizes, so hidden terminals refit as soon as they can measure.
      // Observes the screen div (what FitAddon measures), not the host: the
      // touch key bar mounting/unmounting resizes only the flex body around
      // the screen, never the host itself.
      //
      // The trailing settle pass exists for mobile keyboard show/hide storms
      // (win/vv observed bouncing 825→425→825→797 within milliseconds):
      // per-step refits have left the canvas mis-scaled — internal buffer at
      // the wrong resolution for its final CSS size, rendering blurry
      // stretched glyphs — until something forced a full re-layout (users
      // had to switch tabs). bounceFont is the one public path that
      // re-sizes the canvas to the shimmed metrics AND force-renders, so
      // running it once the storm goes quiet performs that tab-switch reset
      // automatically.
      let settleTimer: number | undefined;
      const observer = new ResizeObserver(() => {
        refit();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          if (disposed) return;
          bounceFont();
          refit();
        }, 350);
      });
      observer.observe(screen);

      // Same coarse-pointer gate as the [focused] effect below: a tab
      // opened by a tap would otherwise mount straight into a focused
      // contenteditable and pop the on-screen keyboard.
      if (focused && !window.matchMedia("(pointer: coarse)").matches) term.focus();

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
        screen.removeEventListener("compositionend", onCompositionEnd);
        screen.removeEventListener("beforeinput", onBeforeInput);
        screen.removeEventListener("focusin", onFocusIn);
        screen.removeEventListener("focusout", onFocusOut);
        observer.disconnect();
        dataSub.dispose();
        hoverTooltip.remove();
        ws.onclose = null;
        ws.close();
        term.dispose();
        for (const [listener, options] of leakedMousedownListeners) {
          document.removeEventListener("mousedown", listener, options);
        }
        termRef.current = null;
        rendererShimRef.current = null;
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
    // Theme is deliberately a dependency: ghostty-web can't re-theme a live
    // terminal (the ANSI palette is baked into its WASM config at
    // construction), so a theme switch tears the whole terminal + WS down
    // and rebuilds — tmux redraws the content on reattach. Theme identity is
    // stable (useThemeAssets), so this only fires on a real theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Apply settings changes to the live terminal without reconnecting.
  // ghostty-web's options object is a Proxy whose set-trap routes these
  // four through handleOptionChange (fontSize/fontFamily additionally
  // re-measure + resize the canvas); the shimmed metrics/contrast settings
  // hot-apply through the renderer shim, which re-measures — the explicit
  // renderer.resize repaints the canvas at the new metrics even when the
  // subsequent refit lands on unchanged cols/rows. (fontWeightBold has no
  // terminal-side hook at all: utils/fonts.ts re-registers the font faces
  // and the fontsVersion effect below forces the re-measure.)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorBlink = settings.cursorBlink;
    rendererShimRef.current?.setOverrides({
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      minimumContrastRatio: settings.minimumContrastRatio,
      textThickness: settings.textThickness,
    });
    // Same rationale as the mount-time bounce: handleFontChange is the one
    // public path that re-sizes AND force-renders with the shimmed metrics —
    // a shim-only change (e.g. contrast ratio) must repaint even though no
    // terminal cell went dirty and the refit below may land on unchanged
    // cols/rows.
    const family = term.options.fontFamily;
    term.options.fontFamily = `${family} `;
    term.options.fontFamily = family;
    refitRef.current?.();
  }, [settings]);

  // A newly-loaded extension font needs a re-measure even though
  // options.fontFamily was already set to its name (while the face was still
  // loading, so glyphs rendered in whatever fallback matched first) —
  // ghostty's option Proxy only reacts to an actual value *change*, so
  // reassigning the same string is a no-op. Bounce through a distinct value
  // to force it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const family = term.options.fontFamily;
    term.options.fontFamily = `${family} `;
    term.options.fontFamily = family;
    refitRef.current?.();
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

  // Not on touch devices: term.focus() focuses the contenteditable screen
  // div, and doing that inside a user gesture (tapping a tab, tapping out
  // of the bottom panel — anything that flips `focused`) pops the
  // on-screen keyboard. On touch, keyboard focus is granted only by a
  // direct tap on the terminal (the touchend handler in the mount effect).
  useEffect(() => {
    if (!focused) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    requestAnimationFrame(() => termRef.current?.focus());
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
      <div className="terminal-body">
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
      </div>
      <TouchKeyBar
        visible={keyBarVisible}
        stickyCtrl={stickyCtrl}
        onToggleStickyCtrl={() => setStickyCtrl((v) => !v)}
        onSendInput={(data) => sendInputRef.current(data)}
      />
    </div>
  );
}
