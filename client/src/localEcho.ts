// Zero-lag local echo overlay (plans/codeman-mobile-features.md Phase 2):
// while typing is buffered until Enter, render it instantly as absolutely-
// positioned spans over the terminal instead of waiting on a PTY round
// trip. Framework-free and engine-agnostic — takes a narrow adapter shaped
// exactly like TerminalEngineHandle's five LocalEcho primitives (T2a) so it
// works unchanged against either engine, and is unit-testable without one.

export interface LocalEchoAdapter {
  readonly cols: number;
  readLine(row: number): string;
  getCursor(): { col: number; row: number };
  isScrolledUp(): boolean;
  getCellMetrics(): { width: number; height: number };
  onRender(cb: () => void): () => void;
}

// Matched by shape (glyph + trailing space), not a fixed string — Claude
// Code's and Codex's prompts differ, and either could change between
// versions (LESSONS 2026-07-12: parse structure, not known strings). The
// space is a class, not a literal " " — Claude Code's Ink UI pads the glyph
// with a non-breaking space (U+00A0), presumably so the terminal never
// treats the gap as a wrap point, which a literal-space match silently
// never finds (confirmed live: readLine returns the glyph correctly, just
// followed by   instead of  ).
const PROMPT_GLYPHS = ["❯", ">"];
const PROMPT_GLYPH_PATTERNS = PROMPT_GLYPHS.map((g) => new RegExp(`${g}[  ]`));

// How the program that owns the pane rewraps a too-long input line — the
// overlay must predict the same cell positions the real echo will land on.
// "ink": Claude Code's Ink box (word wrap, hanging indent under the first
// row's text, final column reserved — see wrapPositions). "shell": a
// readline/zle line editor (character wrap into every column, continuation
// rows at column 0).
export type WrapMode = "ink" | "shell";

// Shells all share the zle/readline wrap behavior; anything else (Claude
// Code, Codex, other TUIs) keeps the ink model this overlay was built
// against. Matched against tmux's pane_current_command; a login shell can
// report with a leading dash.
const SHELL_COMMANDS = new Set(["sh", "ash", "dash", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "nu"]);
export function wrapModeForCommand(command: string): WrapMode {
  return SHELL_COMMANDS.has(command.trim().replace(/^-/, "").toLowerCase()) ? "shell" : "ink";
}

export class LocalEcho {
  private readonly adapter: LocalEchoAdapter;
  private readonly container: HTMLDivElement;
  private readonly unsubRender: () => void;
  private cellMetrics: { width: number; height: number };
  private pending = "";
  // Whether the most recent findAnchor() call landed on the prompt glyph
  // (true) or had to fall back to the raw cursor cell (false). A
  // glyph-anchored position is pinned to the prompt; the cursor-fallback
  // position, by definition, *is* the cursor, so render() only trusts an
  // anchored capture's row delta while the glyph is actually visible.
  private anchorIsStable = false;
  // Where the overlay's first char draws, captured once when the buffer
  // goes empty → non-empty and held until clear(). The prompt-glyph anchor
  // alone is only the start of the *input area* — the line can already hold
  // real text the buffer knows nothing about (a tab-completed path, text
  // typed before local echo activated, a recalled history entry), and the
  // cursor at first-keystroke time is exactly where new input will echo.
  // Never read live at render time: real PTY output arriving mid-typing
  // can move the cursor, which is the same re-basing hazard anchorIsStable
  // guards against. When the prompt glyph is visible the capture is
  // *anchored*: a column plus a row delta from the glyph, so streamed
  // output scrolling the prompt upward doesn't invalidate it. Heavily
  // themed shell prompts often end in other glyphs entirely (powerlevel10k
  // segments, "% ", "± ") — there, in shell wrap mode only, the capture is
  // *unanchored*: the absolute cursor cell, safe because a shell repaints
  // nothing while you type at its prompt, unlike an Ink TUI streaming
  // output above its input box. null = not captured (cursor-fallback
  // anchor in effect).
  private startCol: number | null = null;
  private startAnchored = false;
  private startRowDelta = 0; // anchored captures: rows below the glyph row
  private startRow = 0; // unanchored captures: absolute row (fallback)
  // Unanchored captures: the line's text left of the start cell (the
  // prompt, plus any pre-existing input) — constant while the buffer is
  // alive, so findUnanchoredRow can re-locate the row after the screen
  // scrolls under the overlay.
  private startLinePrefix = "";
  // See WrapMode — owned by TerminalView, which knows the pane's current
  // foreground command; the overlay itself can't tell an Ink box from zle.
  wrapMode: WrapMode = "ink";
  // The text currently being IME-composed, shown but not yet committed by
  // the OS — never part of `pending`. Predictive keyboards deliver nothing
  // at all through the normal onData path until text commits, so without
  // this a phone typing a sentence shows nothing on screen — not just
  // zero lag lost, but indistinguishable from "typing doesn't work".
  // Display-only: nothing reaches the PTY until the OS commits the text
  // through the engine's normal onData path. An earlier iteration flushed
  // completed words (space-terminated) to the PTY early so Claude's input
  // box could redraw per word, reconciling backspaces into already-sent
  // text with counted \x7f erases — dropped 2026-07-24: the reconciliation
  // depended on per-vendor IME revision behavior the browser only
  // partially surfaces (rewrites at commit time, word-deletes,
  // recomposition), and kept producing wrong text after backspace on real
  // devices despite repeated targeted fixes.
  private composing = "";

  constructor(overlayHost: HTMLElement, adapter: LocalEchoAdapter) {
    this.adapter = adapter;
    this.cellMetrics = adapter.getCellMetrics();
    this.container = document.createElement("div");
    this.container.className = "local-echo-overlay";
    overlayHost.appendChild(this.container);
    // Only re-renders while there's something to show: the terminal's own
    // cursor can't move from typing/composing alone (nothing is sent to
    // the PTY until Enter), but real output (a Claude response streaming
    // in) still repaints underneath, so the overlay needs to redraw on
    // top of it.
    this.unsubRender = adapter.onRender(() => {
      if (this.pending || this.composing) this.render();
    });
  }

  get pendingText(): string {
    return this.pending;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  // Android IMEs (Samsung's keyboard among them) sometimes deliver the
  // space between words as a non-breaking space (U+00A0) in both
  // composition text and committed bursts. Normalized to a real space at
  // every entry point: an NBSP forwarded raw to the PTY on Enter would
  // embed a literal \xc2\xa0 in the typed command.
  private static normalizeSpaces(text: string): string {
    return text.replace(/ /g, " ");
  }

  addChar(ch: string): void {
    this.appendText(ch);
  }

  appendText(rawText: string): void {
    this.captureStart();
    this.pending += LocalEcho.normalizeSpaces(rawText);
    this.render();
  }

  // Removes the last pending char — purely local: nothing in `pending` has
  // been sent anywhere, so there's never a real \x7f to cascade. Returns
  // false when there's nothing to remove.
  removeChar(): boolean {
    if (!this.pending) return false;
    this.pending = this.pending.slice(0, -1);
    this.render();
    return true;
  }

  // `text` is the IME's current full composition (compositionupdate's own
  // `data`), a replacement of the in-progress text each call, not an
  // incremental delta — never appended to. Display-only (see `composing`).
  setComposing(text: string): void {
    this.captureStart();
    this.composing = LocalEcho.normalizeSpaces(text);
    this.render();
  }

  // The composition ended (compositionend). Clears the transient preview —
  // never touches `pending`: the OS delivers the committed text through
  // the engine's normal onData path, which reaches `pending` like any
  // other typed burst.
  clearComposing(): void {
    if (!this.composing) return;
    this.composing = "";
    this.render();
  }

  clear(): void {
    this.pending = "";
    this.composing = "";
    // Deliberately the ONLY reset point for the captured start. Emptying
    // through backspaces or a cancelled composition puts the cursor back on
    // the captured cell, so the capture stays valid there.
    this.startCol = null;
    this.container.replaceChildren();
  }

  // Cell metrics can change once an extension font finishes loading (a
  // fallback face measures differently) — re-read them and reposition
  // whatever's still pending. Called alongside the engine's own
  // refreshFonts() (see TerminalView's fontsVersion effect).
  refreshFont(): void {
    this.cellMetrics = this.adapter.getCellMetrics();
    this.render();
  }

  dispose(): void {
    this.unsubRender();
    this.container.remove();
  }

  // Bottom-up shape scan for a prompt glyph followed by a space, anchoring
  // just past it; falls back to the real cursor cell if no marker is
  // visible (keeps typing visible even if the scan misses).
  private findAnchor(): { col: number; row: number } {
    const cursor = this.adapter.getCursor();
    for (let row = cursor.row; row >= 0; row--) {
      const line = this.adapter.readLine(row);
      for (const pattern of PROMPT_GLYPH_PATTERNS) {
        const match = pattern.exec(line);
        if (match) {
          this.anchorIsStable = true;
          return { col: match.index + 2, row };
        }
      }
    }
    this.anchorIsStable = false;
    return cursor;
  }

  // Snapshot where the buffer's first char will echo — the cursor cell at
  // first-keystroke time (see startCol). Idempotent: no-op while a capture
  // is held, so every appendText/setComposing can call it unconditionally.
  private captureStart(): void {
    if (this.startCol !== null) return;
    const anchor = this.findAnchor();
    const cursor = this.adapter.getCursor();
    if (!this.anchorIsStable) {
      // No prompt glyph to pin to — see startCol: shells still get an
      // unanchored capture off the cursor cell, Ink TUIs keep the live
      // cursor fallback (their screens repaint under the overlay).
      if (this.wrapMode === "shell") {
        this.startCol = cursor.col;
        this.startRow = cursor.row;
        this.startLinePrefix = this.adapter.readLine(cursor.row).slice(0, cursor.col);
        this.startAnchored = false;
      }
      return;
    }
    this.startAnchored = true;
    if (cursor.row < anchor.row || (cursor.row === anchor.row && cursor.col < anchor.col)) {
      // Cursor behind the glyph anchor (a scan that matched above the real
      // prompt) — trust the anchor, as before this capture existed.
      this.startCol = anchor.col;
      this.startRowDelta = 0;
      return;
    }
    this.startCol = cursor.col;
    this.startRowDelta = cursor.row - anchor.row;
  }

  // An unanchored capture has no glyph to re-find, but the screen still
  // scrolls under it: an input line wrapping on the bottom row pushes the
  // prompt up one, and a background job's output pushes it further. The
  // recorded startLinePrefix re-locates the row — same bottom-up scan as
  // findAnchor, keyed on text recorded from the live screen instead of a
  // known glyph. Falls back to the captured row when the prefix is blank
  // (nothing distinctive to match) or has scrolled off entirely.
  private findUnanchoredRow(): number {
    if (!this.startLinePrefix.trim()) return this.startRow;
    const cursor = this.adapter.getCursor();
    for (let row = cursor.row; row >= 0; row--) {
      if (this.adapter.readLine(row).startsWith(this.startLinePrefix)) return row;
    }
    return this.startRow;
  }

  // "shell" mode: zle/readline rely on the terminal's own autowrap — text
  // fills every column including the last, splits mid-word, and every
  // continuation row starts at column 0.
  //
  // "ink" mode: greedy word-wrap matching Ink's own box (confirmed live: it
  // never splits a word across rows, unlike a naive per-column wrap — which
  // put the overlay's wrap point wherever `cols` fell mid-word, several
  // columns off from the real terminal's, garbling every row after the
  // first divergence). Continuation rows re-indent to `indentCol` (the
  // input area's first column), not 0: Ink hangs wrapped input under the
  // first row's text, not under the "❯ " marker (confirmed live — the real
  // wrapped row starts two columns in, exactly matching the prompt prefix's
  // width). `start` can sit further right than `indentCol` when the line
  // already held text at capture time (see startCol).
  private static wrapPositions(
    text: string,
    start: { col: number; row: number },
    indentCol: number,
    cols: number,
    mode: WrapMode,
  ): { row: number; col: number }[] {
    const positions: { row: number; col: number }[] = [];
    if (mode === "shell") {
      let col = start.col;
      let row = start.row;
      for (let i = 0; i < text.length; i++) {
        if (col >= cols) {
          col = 0;
          row++;
        }
        positions.push({ row, col });
        col++;
      }
      return positions;
    }
    const tokens = text.match(/\S+\s*|\s+/g) ?? [];
    // Ink's box never lets text touch the terminal's final column — it
    // reserves it (so its cursor block always has a cell to render in),
    // wrapping a token whose end would cross it. Boundary established
    // empirically against real Claude Code (cols=43, prompt at col 2,
    // first line holding 35 chars + an inter-word space, so the next
    // token starts at col 38): a 4-char token ("ccc ", ending col 41)
    // stayed; 5- and 6-char tokens ("bbbb ", "bbbbb ", crossing col 42)
    // both wrapped. The token's trailing space counts toward the fit —
    // an unsent word sits one column further left than word+space will,
    // and visibly hops down a row the moment its space is typed, exactly
    // when the real box re-wraps it too.
    const edge = cols - 1;
    let col = start.col;
    let row = start.row;
    for (const token of tokens) {
      // Only wrap-before-token if the token isn't the first thing on this
      // row (a token wider than the whole row would loop forever waiting
      // for space that never comes) and it doesn't fit in what's left.
      if (col > indentCol && col + token.length > edge) {
        col = indentCol;
        row++;
      }
      for (let j = 0; j < token.length; j++) {
        if (col >= edge) {
          col = indentCol;
          row++;
        }
        positions.push({ row, col });
        col++;
      }
    }
    // Defensive: text.match can't undercount, but keep positions.length in
    // lockstep with text.length regardless.
    while (positions.length < text.length) {
      if (col >= edge) {
        col = indentCol;
        row++;
      }
      positions.push({ row, col });
      col++;
    }
    return positions;
  }

  private render(): void {
    this.container.replaceChildren();
    const text = this.pending + this.composing;
    if (!text || this.adapter.isScrolledUp()) return;
    const anchor = this.findAnchor();
    // An anchored capture is only trusted while the glyph anchor is: its
    // row delta is relative to the glyph, and the cursor-fallback anchor
    // tracks a cursor the capture was taken to be independent of. An
    // unanchored capture is its own absolute cell.
    let start = anchor;
    if (this.startCol !== null) {
      if (!this.startAnchored) start = { col: this.startCol, row: this.findUnanchoredRow() };
      else if (this.anchorIsStable) start = { col: this.startCol, row: anchor.row + this.startRowDelta };
    }
    const { width, height } = this.cellMetrics;
    const cols = this.adapter.cols;
    const frag = document.createDocumentFragment();
    const positions = LocalEcho.wrapPositions(text, start, anchor.col, cols, this.wrapMode);
    for (let i = 0; i < text.length; i++) {
      const { row, col } = positions[i];
      const span = document.createElement("span");
      // Composing (not-yet-committed) chars get their own class — matches
      // the underline convention native IME composition renders with, so
      // there's still a visible cue that this part hasn't committed yet.
      span.className = i < this.pending.length ? "local-echo-char" : "local-echo-char local-echo-char-composing";
      span.textContent = text[i];
      span.style.left = `${col * width}px`;
      span.style.top = `${row * height}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      // Overrides the CSS line-height (var(--terminal-line-height), a
      // unitless multiplier meaning "x times the font's own size" per CSS
      // semantics) with the actual measured cell height in px. The
      // engine's lineHeight *setting* means something different — "x times
      // the font's own measured natural line height" — so even the
      // default value of 1 resolves to a different, smaller number
      // (fontSize itself, e.g. 14px) than the real terminal's actual
      // per-cell line height (e.g. 18px, IBM Plex Mono's natural metric)
      // — visibly shrinking and mispositioning every overlay glyph inside
      // its own (correctly sized) cell box.
      span.style.lineHeight = `${height}px`;
      frag.appendChild(span);
    }
    this.container.appendChild(frag);
  }
}
