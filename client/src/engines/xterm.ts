// xterm.js implementation of the TerminalEngine seam
// (plans/terminal-engine-setting.md) — a resurrection-and-forward-port of
// the pre-swap TerminalView (git show 4505044^), re-verified against
// @xterm/xterm 6.0.0 in the plan's T1 spike rather than trusted from the
// old comments. Nothing outside this file may import "@xterm/xterm" or its
// addons.
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal, type FontWeight } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cellFromPoint } from "../mouseReports";
import { buildXtermLinkProvider } from "../terminalLinks";
import type {
  CellPosition,
  TerminalEngineHandle,
  TerminalEngineOptions,
  TerminalEngineSettings,
} from "./types";

function toFontWeight(weight: TerminalEngineSettings["fontWeight"]): FontWeight {
  // "medium" maps to the numeric 500 weight — utils/fonts.ts registers the
  // font's 500-weight face under the same family name, and xterm's own
  // fontWeight option (rendered as real DOM text) picks it up natively via
  // the browser's own font matching, same visual result as ghostty's
  // canvas-side weight handling through a completely different mechanism.
  return weight === "medium" ? "500" : "normal";
}

// async to match CreateTerminalEngine's shared shape — xterm has no
// WASM-style init step (unlike ghostty), but the registry never needs to
// know which engine is live.
export async function createXtermEngine(options: TerminalEngineOptions): Promise<TerminalEngineHandle> {
  const {
    screen,
    settings: initialSettings,
    theme,
    onData,
    resolvePaths,
    onOpenUrl,
    onOpenFile,
    onOpenFileSecondary,
    onLinkHoverChange,
  } = options;

  let disposed = false;

  const term = new Terminal({
    // Required by @xterm/addon-unicode11's terminal.unicode API below.
    allowProposedApi: true,
    cursorBlink: initialSettings.cursorBlink,
    cursorStyle: initialSettings.cursorStyle,
    fontSize: initialSettings.fontSize,
    fontFamily: initialSettings.fontFamily,
    fontWeight: toFontWeight(initialSettings.fontWeight),
    fontWeightBold: initialSettings.fontWeightBold,
    lineHeight: initialSettings.lineHeight,
    letterSpacing: initialSettings.letterSpacing,
    // Native option — no shim needed, unlike ghostty. Default (4.5) mirrors
    // VS Code/code-server (terminal.integrated.minimumContrastRatio).
    minimumContrastRatio: initialSettings.minimumContrastRatio,
    // xterm's SelectionService only force-starts local selection for
    // Option+click/drag on Mac (shouldForceSelection branches on
    // Browser.isMac) — irrelevant here since this engine's local selection
    // goes through term.select() directly (see beginLocalSelection below),
    // never through xterm's own mousedown/shift-force path at all (T1
    // finding: that path only *extends* an existing selection, never
    // starts one from blank, and would double-report to tmux besides).
    // Left at its default; nothing in this engine relies on it.
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // xterm's default (Unicode 6) width table treats some emoji used in
  // prompts (e.g. a sailboat "⛵") as narrow, clipping half the glyph.
  // Unicode 11 tables classify them correctly. Spike-verified unchanged
  // against 6.0.0 (activeVersion switches to "11" without error).
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  // No leaked-resize-listener workaround here — the equivalent xterm 5.5.0
  // bug the pre-swap code worked around is spike-confirmed fixed in 6.0.0
  // (open() still adds one window "resize" listener, but dispose() now
  // correctly removes it).
  term.open(screen);

  const rowsEl = term.element?.querySelector(".xterm-rows") as HTMLElement | null;
  const applyTextThickness = (thickness: number) => {
    if (!rowsEl) return;
    // currentColor resolves per-element at use time (each character's own
    // DOM span keeps its own set `color`), not as a fixed value inherited
    // from where the stroke is declared — spike-verified visually (the
    // stroke matched each glyph's own color, not a single flat tint).
    rowsEl.style.webkitTextStroke = thickness > 0 ? `${thickness}px currentColor` : "";
  };
  applyTextThickness(initialSettings.textThickness);

  // xterm.js has no equivalent to ghostty-web's always-on render loop (it
  // only repaints dirty rows on actual content changes), so there's no
  // render-suppression-while-hidden workaround needed here — `isVisible`
  // from options is intentionally unused by this engine.

  const lastMouse = { x: 0, y: 0 };
  const onTooltipMouseMove = (e: MouseEvent) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  };
  screen.addEventListener("mousemove", onTooltipMouseMove);
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
  // content, so a file:// target routes through onOpenFile the same as a
  // detected file-path link.
  const activateOsc8 = (event: MouseEvent, text: string) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    try {
      const url = new URL(text);
      if (url.protocol === "file:") {
        onOpenFile(decodeURIComponent(url.pathname));
        return;
      }
    } catch {
      // Not a parseable URL — fall through to onOpenUrl (mailto:, custom
      // schemes some tools emit).
    }
    onOpenUrl(text);
  };
  term.options.linkHandler = {
    activate: activateOsc8,
    hover: (event, text) => {
      showTooltip(event, text);
      onLinkHoverChange((e) => activateOsc8(e, text));
    },
    leave: () => {
      hideTooltip();
      onLinkHoverChange(null);
    },
  };

  const linkProviderDisposable = term.registerLinkProvider(
    buildXtermLinkProvider(term, {
      resolvePaths,
      onOpenUrl,
      onOpenFile,
      onOpenFileSecondary,
      onHoverChange: (link) => {
        if (link) {
          // ILink.hover carries no MouseEvent (unlike term.options.linkHandler
          // above), so the tooltip is positioned from the dedicated mousemove
          // tracker — same pattern the ghostty engine uses.
          const hostRect = term.element?.getBoundingClientRect();
          if (hostRect) {
            hoverTooltip.textContent = link.text;
            hoverTooltip.style.left = `${lastMouse.x - hostRect.left + 12}px`;
            hoverTooltip.style.top = `${lastMouse.y - hostRect.top + 16}px`;
            hoverTooltip.style.display = "block";
          }
          onLinkHoverChange((e) => link.activate(e, link.text));
        } else {
          hideTooltip();
          onLinkHoverChange(null);
        }
      },
    }),
  );

  const dataSub = term.onData(onData);

  // Predictive keyboards (Gboard etc.) deliver nothing through onData at
  // all until a word actually commits (space, punctuation, a suggestion
  // tap) — xterm.js's own textarea still fires the standard Composition
  // Events throughout, which is the only signal available for previewing
  // the in-progress word before then. Listened on directly rather than
  // through xterm's own CompositionHelper (private, no public hook) —
  // xterm's own compositionend handler on the same element independently
  // reads the committed text and forwards it through the normal onData
  // path once this fires, so no double-send risk here either.
  let composingHandler: ((text: string | null) => void) | null = null;
  const onCompositionUpdate = (e: CompositionEvent) => composingHandler?.(e.data);
  const onCompositionEndForPreview = () => composingHandler?.(null);
  term.textarea?.addEventListener("compositionupdate", onCompositionUpdate);
  term.textarea?.addEventListener("compositionend", onCompositionEndForPreview);

  const cellFromPointOnEngine = (clientX: number, clientY: number): CellPosition => {
    const rect = screen.getBoundingClientRect();
    const width = rect.width / term.cols;
    const height = rect.height / term.rows;
    return cellFromPoint(clientX, clientY, rect, width, height, term.cols, term.rows);
  };

  // Fan-out for onRender: one real subscription to xterm's event,
  // broadcast to however many callers have asked to be notified.
  const renderListeners = new Set<() => void>();
  const renderSub = term.onRender(() => {
    for (const cb of renderListeners) cb();
  });

  // Active drag-selection teardown, set while a beginLocalSelection() drag
  // is in progress so a second call (shouldn't happen, but cheap to guard)
  // or dispose() can clean it up.
  let endLocalSelectionDrag: (() => void) | null = null;

  const handle: TerminalEngineHandle = {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => term.write(data),
    focus: () => term.focus(),
    focusInput: () => term.textarea?.focus(),
    getSelection: () => term.getSelection(),
    clearSelection: () => term.clearSelection(),
    clear: () => term.clear(),
    // T1 finding: xterm's own mousedown/shift-force replay path only
    // *extends* an existing selection (never starts one from blank) and
    // would double-report to tmux besides — so this engine skips DOM
    // replay entirely and drives term.select(column, row, length)
    // directly, updating it on each real mousemove for as long as the
    // drag continues (TerminalView's own onCapture has already released
    // the gesture by the time this is called, so these are this engine's
    // own temporary listeners, torn down on mouseup).
    beginLocalSelection: (clientX, clientY) => {
      endLocalSelectionDrag?.();
      const start = cellFromPointOnEngine(clientX, clientY);
      const startCol = start.col - 1;
      const startRow = start.row - 1;
      const linear = (row: number, col: number) => row * term.cols + col;
      const startLinear = linear(startRow, startCol);
      const update = (clientX2: number, clientY2: number) => {
        const cur = cellFromPointOnEngine(clientX2, clientY2);
        const curLinear = linear(cur.row - 1, cur.col - 1);
        if (curLinear >= startLinear) {
          term.select(startCol, startRow, curLinear - startLinear + 1);
        } else {
          term.select(cur.col - 1, cur.row - 1, startLinear - curLinear + 1);
        }
      };
      update(clientX, clientY);
      const onMove = (e: MouseEvent) => update(e.clientX, e.clientY);
      const onUp = () => endLocalSelectionDrag?.();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      endLocalSelectionDrag = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        endLocalSelectionDrag = null;
      };
    },
    cellFromPoint: cellFromPointOnEngine,
    getCharHeight: () => screen.getBoundingClientRect().height / term.rows,
    getMode: (mode) => {
      const modes = term.modes;
      switch (mode) {
        case 1000:
          return modes.mouseTrackingMode === "vt200";
        case 1002:
          return modes.mouseTrackingMode === "drag";
        case 1003:
          return modes.mouseTrackingMode === "any";
        case 1004:
          return modes.sendFocusMode;
        default:
          return false;
      }
    },
    fit: () => {
      if (disposed) return null;
      if (screen.clientWidth === 0 || screen.clientHeight === 0) return null;
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    // xterm has no render-suppression-while-hidden to undo — refresh(...)
    // just forces a repaint in case anything was missed, which is cheap
    // and safe even when nothing actually needs it.
    reveal: () => {
      if (disposed) return;
      term.refresh(0, term.rows - 1);
    },
    setSettings: (s) => {
      term.options.fontFamily = s.fontFamily;
      term.options.fontSize = s.fontSize;
      term.options.fontWeight = toFontWeight(s.fontWeight);
      term.options.fontWeightBold = s.fontWeightBold;
      term.options.cursorStyle = s.cursorStyle;
      term.options.cursorBlink = s.cursorBlink;
      term.options.lineHeight = s.lineHeight;
      term.options.letterSpacing = s.letterSpacing;
      term.options.minimumContrastRatio = s.minimumContrastRatio;
      applyTextThickness(s.textThickness);
    },
    // Spike finding: the DOM renderer re-measures on the next reflow once
    // document.fonts reflects the newly-loaded face — CSS font-family
    // naturally respects that, unlike a canvas renderer. refresh() is a
    // cheap belt-and-braces repaint regardless.
    refreshFonts: () => {
      if (disposed) return;
      term.refresh(0, term.rows - 1);
    },
    // xterm's custom key/wheel handler return-value convention is the
    // OPPOSITE of this interface's "true = handled": its own docs show
    // `return false` to mean "I handled it, skip xterm's own encoding"
    // for keys, and "return whether xterm.js should process the event"
    // for wheel (i.e. false = we handled it). Invert both ways here so
    // TerminalView's shared handler logic never needs to know.
    onKeyEvent: (handler) => {
      term.attachCustomKeyEventHandler((e) => !handler(e));
    },
    onWheelEvent: (handler) => {
      term.attachCustomWheelEventHandler((e) => !handler(e));
    },
    onComposingChange: (handler) => {
      composingHandler = handler;
    },
    dispatchSyntheticWheel: (init) => {
      screen.dispatchEvent(new WheelEvent("wheel", init));
    },
    // Global (0 = top of scrollback) and screen-relative indexing meet at
    // buffer.baseY — the same offset buildXtermLinkProvider (terminalLinks.ts)
    // already uses for the inverse conversion.
    readLine: (row) => {
      const idx = term.buffer.active.baseY + row;
      // xterm's buffer is a circular list: get() wraps the index modulo
      // length and never returns undefined, so out-of-range has to be
      // checked explicitly rather than relying on a falsy return.
      if (idx < 0 || idx >= term.buffer.active.length) return "";
      const line = term.buffer.active.getLine(idx);
      if (!line) return "";
      return line.translateToString(true, 0, term.cols);
    },
    getCursor: () => ({ col: term.buffer.active.cursorX, row: term.buffer.active.cursorY }),
    // baseY: top of the bottom page when fully scrolled down. viewportY:
    // top of what's currently shown. Equal means pinned to the bottom.
    isScrolledUp: () => term.buffer.active.viewportY !== term.buffer.active.baseY,
    getCellMetrics: () => {
      const rect = screen.getBoundingClientRect();
      return { width: rect.width / term.cols, height: rect.height / term.rows };
    },
    onRender: (cb) => {
      renderListeners.add(cb);
      return () => renderListeners.delete(cb);
    },
    dispose: () => {
      disposed = true;
      endLocalSelectionDrag?.();
      screen.removeEventListener("mousemove", onTooltipMouseMove);
      term.textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      term.textarea?.removeEventListener("compositionend", onCompositionEndForPreview);
      dataSub.dispose();
      renderSub.dispose();
      renderListeners.clear();
      linkProviderDisposable.dispose();
      hoverTooltip.remove();
      term.dispose();
    },
  };

  return handle;
}
