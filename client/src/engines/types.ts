// The TerminalEngine seam (plans/terminal-engine-setting.md): everything
// TerminalView needs from a terminal implementation, narrow enough that
// engines/ghostty.ts and engines/xterm.ts can each satisfy it without
// leaking their own package's types past this file. TerminalView keeps
// owning everything engine-independent — WS protocol, scrollbar, search,
// touch keys, key bindings, mouse/wheel/touch gesture policy — calling
// into these primitives instead of reaching into a specific engine.

// Matches both ghostty-web's and xterm.js's ITheme structurally (same
// field names, shared lineage) — callers never import a package-specific
// theme type.
export interface TerminalTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

// The subset of AppSettings an engine actually renders with — passed as a
// plain slice so an engine module never needs to know about unrelated app
// settings (upload conflict policy, tab placement, etc).
export interface TerminalEngineSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "medium";
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  lineHeight: number;
  letterSpacing: number;
  minimumContrastRatio: number;
  textThickness: number;
}

// 1-based cell-grid coordinates — matches the SGR mouse-report wire format
// mouseReports.ts encodes.
export interface CellPosition {
  col: number;
  row: number;
}

// 0-based screen-relative coordinates (row 0 = top of the visible
// viewport) — matches readLine's row numbering. Deliberately a distinct
// type from CellPosition: that one is 1-based for SGR wire compatibility,
// this one isn't a wire format at all.
export interface ScreenPosition {
  col: number;
  row: number;
}

export interface TerminalEngineOptions {
  // Element the engine mounts into (TerminalView's `screen` ref, never the
  // outer host) — sibling widgets stay outside whatever key/paste
  // listeners the engine attaches to it.
  screen: HTMLElement;
  settings: TerminalEngineSettings;
  theme: TerminalTheme;
  // Whether this terminal is currently on screen — read by the engine's
  // own render-suppression (a hidden/backgrounded terminal shouldn't spend
  // paint cycles); combined internally with document.hidden.
  isVisible: () => boolean;
  // Raw typed/pasted/composed input — called for every onData-equivalent
  // event, including an engine's own IME workarounds. Sticky-Ctrl
  // transformation happens in the caller, not here.
  onData: (data: string) => void;
  // Link detection (regex/path scanning) is engine-agnostic and lives in
  // terminalLinks.ts; these are the app-level callbacks it already takes,
  // passed straight through by whichever adapter the engine module uses.
  resolvePaths: (paths: string[]) => Promise<(string | null)[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // Fired whenever link-hover state changes, so TerminalView's shared
  // mouse-capture layer knows whether a hovered link's activation callback
  // is armed for an open-gesture (ctrl/cmd) click. Hover tooltip DOM,
  // positioning, and show/hide are the engine's own concern.
  onLinkHoverChange: (activate: ((e: MouseEvent) => void) | null) => void;
}

// Everything TerminalView calls on a live engine instance. Kept narrow and
// descriptive of actual TerminalView call sites (extracted from the
// current ghostty-only implementation), not aspirational.
export interface TerminalEngineHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  // General terminal focus (e.g. tab activation, search close).
  focus(): void;
  // Focuses whichever element actually receives keyboard input — may
  // differ from focus() (e.g. a hidden IME textarea) — used by the mouse
  // capture layer after swallowing a press that would normally focus it.
  focusInput(): void;
  getSelection(): string;
  clearSelection(): void;
  // Clears the terminal's own local buffer (terminal.clear keybinding) —
  // unrelated to tmux scrollback, which the server owns.
  clear(): void;
  // Starts a local (non-tmux) text selection anchored at a screen point.
  // Subsequent real mousemove/mouseup events are not re-forwarded here —
  // the engine's own selection mechanism extends/finalizes them natively
  // once armed (ghostty: synthetic mousedown replay on its canvas; xterm:
  // term.select(), see plans/terminal-engine-setting.md's T1 findings).
  beginLocalSelection(clientX: number, clientY: number): void;
  cellFromPoint(clientX: number, clientY: number): CellPosition;
  getCharHeight(): number;
  // DEC private-mode query (mouse tracking, focus reporting, etc).
  getMode(mode: number): boolean;
  // Resizes to fit `screen`'s current box; returns the new grid, or null
  // if the container isn't measurable yet (zero size) — the caller is
  // responsible for telling the server about a real resize.
  fit(): { cols: number; rows: number } | null;
  // Forces a full repaint — used when a hidden/backgrounded terminal
  // becomes visible again and may be showing a stale or blank frame.
  reveal(): void;
  setSettings(settings: TerminalEngineSettings): void;
  // Forces a re-measure after an extension font finishes loading (glyphs
  // rendered against a fallback face while the real one was still
  // downloading need a nudge to redraw with it).
  refreshFonts(): void;
  // Attaches a key/wheel handler; return true to mark the event handled
  // (preventDefault + skip the engine's own key/wheel handling for it) —
  // each engine normalizes its own native return-value convention to this
  // shared "true = handled" shape.
  onKeyEvent(handler: (e: KeyboardEvent) => boolean): void;
  onWheelEvent(handler: (e: WheelEvent) => boolean): void;
  // Fires on every compositionupdate with the IME's current full
  // in-progress word (not an incremental delta), and once more with null
  // on compositionend — used to preview a not-yet-committed predictive-
  // keyboard word through LocalEcho, since the OS delivers nothing through
  // onData at all until the word actually commits.
  onComposingChange(handler: (text: string | null) => void): void;
  // Dispatches a synthetic wheel event at whichever internal element the
  // engine's own onWheelEvent handler actually listens on — used to route
  // touch-swipe gestures (computed in TerminalView) through the same wheel
  // policy real wheel events go through.
  dispatchSyntheticWheel(init: WheelEventInit): void;
  // Reads one screen-relative row's text (0 = top of the visible viewport),
  // right-trimmed of trailing whitespace, at most `cols` characters — used
  // by LocalEcho's prompt finder (plans/codeman-mobile-features.md).
  // Out-of-range rows return "".
  readLine(row: number): string;
  // The cursor's screen-relative position (0-based, matches readLine's row
  // numbering).
  getCursor(): ScreenPosition;
  // True when the local viewport isn't pinned to the bottom of the
  // engine's own buffer — tmux owns real scrollback, so this only ever
  // reflects a momentary local scroll, not tmux copy-mode.
  isScrolledUp(): boolean;
  // Cell size in CSS pixels, respecting lineHeight/letterSpacing — the
  // same grid both cellFromPoint and the engine's own renderer use.
  getCellMetrics(): { width: number; height: number };
  // Fires after each repaint completes; returns an unsubscribe. Multiple
  // subscribers are supported (unlike onKeyEvent/onWheelEvent, which each
  // set a single handler).
  onRender(cb: () => void): () => void;
  dispose(): void;
}

// Async because ghostty-web needs a one-time WASM init before its first
// Terminal can construct (memoized inside engines/ghostty.ts) — xterm.js
// has no such step but matches the same shape so the caller (and the
// engines/index.ts registry) never needs to know which engine is live.
export type CreateTerminalEngine = (options: TerminalEngineOptions) => Promise<TerminalEngineHandle>;

// Shared marker so TerminalView's mouse-capture layer (onCapture) can
// recognize an event a beginLocalSelection() implementation dispatched
// itself, and let it pass through instead of re-swallowing it as a new
// user gesture — a capture-phase listener on an ancestor of the engine's
// own selection target would otherwise intercept it. A Symbol-keyed
// property avoids any collision with real MouseEvent fields.
const SYNTHETIC_SELECT_MARKER = Symbol("terminalEngineSyntheticSelectStart");
export function markSyntheticSelectStart(event: MouseEvent): void {
  (event as unknown as Record<symbol, boolean>)[SYNTHETIC_SELECT_MARKER] = true;
}
export function isSyntheticSelectStart(event: MouseEvent): boolean {
  return (event as unknown as Record<symbol, boolean>)[SYNTHETIC_SELECT_MARKER] === true;
}
