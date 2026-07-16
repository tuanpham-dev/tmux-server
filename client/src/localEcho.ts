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

export class LocalEcho {
  private readonly adapter: LocalEchoAdapter;
  private readonly container: HTMLDivElement;
  private readonly unsubRender: () => void;
  private cellMetrics: { width: number; height: number };
  private pending = "";
  // How much of `pending`, from the start, has already been sent to the PTY
  // for real (word-boundary flush, below) — never re-sent by a later Enter/
  // control-char flush, which must only forward the remainder. The overlay
  // itself doesn't care about this split: it always draws the full
  // `pending` string at the (freshly recomputed, every render) anchor, so
  // once the flushed prefix's real echo lands the two coincide exactly —
  // same text, same cell position — with no special-casing needed to hide
  // or reconcile the overlap.
  private flushedOffset = 0;
  // Whether the most recent findAnchor() call landed on the prompt glyph
  // (true) or had to fall back to the raw cursor cell (false) — see
  // flushCompletedWord's guard. A glyph-anchored position is pinned to the
  // prompt and stays put regardless of anything a word-boundary flush's
  // real echo does to the cursor; the cursor-fallback position, by
  // definition, *is* the cursor, so a flushed word's real echo moving the
  // cursor mid-typing would silently re-base the whole overlay on top of
  // text that's already really there, duplicating it.
  private anchorIsStable = false;
  // The text currently being IME-composed, shown but not yet committed by
  // the OS — never part of `pending`. Predictive keyboards deliver nothing
  // at all through the normal onData path until text commits, so without
  // this a phone typing a sentence shows nothing on screen — not just
  // zero lag lost, but indistinguishable from "typing doesn't work".
  // Gboard composes one word at a time (committing at each space);
  // Samsung's keyboard composes the ENTIRE message across spaces,
  // committing only on Enter — which made word-flush (below) never fire
  // there at all: every "completed" word was still composition. So
  // completed words are flushed from the composition too (see
  // flushComposition), with composingSentText tracking exactly what was
  // sent so the eventual commit doesn't double-send it.
  private composing = "";
  // The exact prefix of `composing` already flushed to the PTY. Consumed
  // (skipped over) when the composition's committed text arrives through
  // appendText; erased with real backspaces if the IME revises text we
  // already sent, or if the composition is cancelled outright.
  private composingSentText = "";

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

  // The part of `pending` not yet sent anywhere — what an Enter/control-char
  // flush (or the next word-boundary flush) still needs to forward. Equal to
  // `pendingText` until the first word-boundary flush.
  get unsentText(): string {
    return this.pending.slice(this.flushedOffset);
  }

  // Returns the text to send to the PTY immediately (a just-completed word,
  // trailing space included) once the just-added text ends on a word
  // boundary, so Claude's own input box gets to redraw/resize at roughly
  // one-word granularity instead of staying static until Enter — or null
  // if nothing's due yet. Caller (TerminalView's routeLocalEcho) is
  // responsible for actually sending it.
  //
  // Gated on anchorIsStable: only safe once the prompt glyph itself has
  // been found, since a cursor-fallback anchor *is* the cursor — the real
  // echo of an early-flushed word would move it, silently re-basing every
  // future render's overlay on top of text already really there. Skipping
  // the flush there just falls back to today's buffer-until-Enter behavior
  // for that render, not a regression.
  private flushCompletedWord(): string | null {
    if (!this.anchorIsStable) return null;
    const remainder = this.unsentText;
    if (!remainder.endsWith(" ")) return null;
    this.flushedOffset = this.pending.length;
    return remainder;
  }

  // Android IMEs (Samsung's keyboard among them) sometimes deliver the
  // space between words as a non-breaking space (U+00A0) in both
  // composition text and committed bursts. Normalized to a real space at
  // every entry point: the word-boundary detection here only looks for
  // U+0020, and an NBSP forwarded raw to the PTY would embed a literal
  // \xc2\xa0 in the typed command.
  private static normalizeSpaces(text: string): string {
    return text.replace(/ /g, " ");
  }

  addChar(ch: string): string | null {
    return this.appendText(ch);
  }

  appendText(rawText: string): string | null {
    const text = LocalEcho.normalizeSpaces(rawText);
    // A committed burst that begins with the composition prefix we already
    // flushed live (flushComposition below) is that composition's commit —
    // count the prefix as sent rather than re-sending it. The IME's
    // matching preview teardown (clearComposing) hasn't run yet at this
    // point: both engines' own composition handlers forward the committed
    // text before this module's compositionend listeners fire.
    if (this.composingSentText && text.startsWith(this.composingSentText)) {
      const already = this.composingSentText.length;
      this.composingSentText = "";
      const base = this.pending.length;
      this.pending += text;
      this.flushedOffset = base + already;
      this.render();
      return this.flushCompletedWord();
    }
    if (this.composingSentText) {
      // The commit doesn't match what was flushed (the IME revised text we
      // already sent, e.g. an autocorrect rewrite at commit time) — erase
      // the flushed prefix with real backspaces, then let the normal flush
      // resend from the corrected text.
      const erase = "\x7f".repeat(this.composingSentText.length);
      this.composingSentText = "";
      this.pending += text;
      this.render();
      return erase + (this.flushCompletedWord() ?? "");
    }
    this.pending += text;
    this.render();
    return this.flushCompletedWord();
  }

  // "pending": removed a char never sent anywhere — purely local, caller
  // does nothing further. "flushed": the removed char was already sent to
  // the PTY for real (word-boundary flush ran ahead of it) — caller must
  // still send a real backspace. `false`: nothing to remove.
  removeChar(): "pending" | "flushed" | false {
    if (!this.pending) return false;
    const source = this.pending.length > this.flushedOffset ? "pending" : "flushed";
    this.pending = this.pending.slice(0, -1);
    this.flushedOffset = Math.min(this.flushedOffset, this.pending.length);
    this.render();
    return source;
  }

  // `text` is the IME's current full composition (compositionupdate's own
  // `data`), a replacement of the in-progress text each call, not an
  // incremental delta — never appended to. Returns bytes the caller must
  // send to the PTY (a newly completed composed word, and/or backspaces
  // undoing a revision of already-sent text), or null.
  setComposing(text: string): string | null {
    this.composing = LocalEcho.normalizeSpaces(text);
    this.render();
    return this.flushComposition();
  }

  // Flushes the composition's completed words (everything through its last
  // space) to the PTY as they appear — for IMEs like Samsung's keyboard
  // that compose the entire message across spaces and commit only on
  // Enter, where waiting for the commit (Gboard's per-word cadence) means
  // nothing ever flushes and typing degrades to buffered-until-Enter.
  // Same anchorIsStable gate as flushCompletedWord, plus one more: every
  // committed char must already be flushed (flushedOffset at the end of
  // pending), or these bytes would arrive in the PTY ahead of committed
  // text that hasn't been sent yet.
  private flushComposition(): string | null {
    if (!this.anchorIsStable) return null;
    if (this.flushedOffset !== this.pending.length) return null;
    let out = "";
    if (!this.composing.startsWith(this.composingSentText)) {
      // The IME revised text we already sent (deleted into it, or an
      // autocorrect rewrite) — erase everything flushed and start over
      // from the current composition.
      out += "\x7f".repeat(this.composingSentText.length);
      this.composingSentText = "";
    }
    const lastSpace = this.composing.lastIndexOf(" ");
    if (lastSpace + 1 > this.composingSentText.length) {
      out += this.composing.slice(this.composingSentText.length, lastSpace + 1);
      this.composingSentText = this.composing.slice(0, lastSpace + 1);
    }
    return out || null;
  }

  // The composition ended (compositionend). Clears the transient preview —
  // never touches `pending`: the OS delivers the committed text through
  // the engine's normal onData path, which reaches `pending` (minus the
  // already-flushed prefix — see appendText) like any other typed burst.
  // Returns backspaces to send when the composition was cancelled outright
  // after part of it was flushed (its commit burst never arrived to
  // consume composingSentText, so those chars must be erased from the
  // PTY), or null in the normal commit flow. An engine whose commit
  // arrives AFTER its compositionend (xterm defers its through a timer)
  // hits this too — the erase and the burst's own re-flush then reconcile
  // to the same final PTY state, just less efficiently.
  clearComposing(): string | null {
    const orphaned = this.composingSentText;
    this.composingSentText = "";
    if (!this.composing) return orphaned ? "\x7f".repeat(orphaned.length) : null;
    this.composing = "";
    this.render();
    return orphaned ? "\x7f".repeat(orphaned.length) : null;
  }

  clear(): void {
    this.pending = "";
    this.flushedOffset = 0;
    this.composing = "";
    this.composingSentText = "";
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

  // Greedy word-wrap matching Ink's own box (confirmed live: it never
  // splits a word across rows, unlike a naive per-column wrap — which put
  // the overlay's wrap point wherever `cols` fell mid-word, several
  // columns off from the real terminal's, garbling every row after the
  // first divergence). Continuation rows re-indent to `startCol`, not 0:
  // Ink hangs wrapped input under the first row's text, not under the
  // "❯ " marker (confirmed live — the real wrapped row starts two columns
  // in, exactly matching the prompt prefix's width).
  private static wrapPositions(
    text: string,
    startCol: number,
    startRow: number,
    cols: number,
  ): { row: number; col: number }[] {
    const positions: { row: number; col: number }[] = [];
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
    let col = startCol;
    let row = startRow;
    for (const token of tokens) {
      // Only wrap-before-token if the token isn't the first thing on this
      // row (a token wider than the whole row would loop forever waiting
      // for space that never comes) and it doesn't fit in what's left.
      if (col > startCol && col + token.length > edge) {
        col = startCol;
        row++;
      }
      for (let j = 0; j < token.length; j++) {
        if (col >= edge) {
          col = startCol;
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
        col = startCol;
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
    const { width, height } = this.cellMetrics;
    const cols = this.adapter.cols;
    const frag = document.createDocumentFragment();
    const positions = LocalEcho.wrapPositions(text, anchor.col, anchor.row, cols);
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
