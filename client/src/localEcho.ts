// Zero-lag local echo overlay (plans/codeman-mobile-features.md Phase 2):
// while typing is buffered until Enter, render it instantly as absolutely-
// positioned spans over the terminal instead of waiting on a PTY round
// trip. Framework-free and engine-agnostic — takes a narrow adapter shaped
// exactly like TerminalEngineHandle's five LocalEcho primitives (T2a) so it
// works unchanged against either engine, and is unit-testable without one.

export interface LocalEchoAdapter {
  readLine(row: number): string;
  getCursor(): { col: number; row: number };
  isScrolledUp(): boolean;
  getCellMetrics(): { width: number; height: number };
  onRender(cb: () => void): () => void;
}

// Matched by shape (glyph + trailing space), not a fixed string — Claude
// Code's and Codex's prompts differ, and either could change between
// versions (LESSONS 2026-07-12: parse structure, not known strings).
const PROMPT_GLYPHS = ["❯", ">"];

export class LocalEcho {
  private readonly adapter: LocalEchoAdapter;
  private readonly container: HTMLDivElement;
  private readonly unsubRender: () => void;
  private cellMetrics: { width: number; height: number };
  private pending = "";
  // The word currently being IME-composed (Gboard/predictive keyboards),
  // shown but not yet committed by the OS — never part of `pending` and
  // never sent. Predictive keyboards deliver nothing at all through the
  // normal onData path until a word commits (space, punctuation, or a
  // suggestion tap), so without this a phone typing a sentence shows
  // nothing on screen for the whole word, not just zero lag on the
  // individual keystroke — indistinguishable from "typing doesn't work"
  // even though the real terminal round trip was never the bottleneck.
  // Tracked separately so a mid-word Enter (composition auto-commits
  // first on every tested platform, but if it somehow didn't) can never
  // send an unconfirmed composition.
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

  addChar(ch: string): void {
    this.pending += ch;
    this.render();
  }

  appendText(text: string): void {
    this.pending += text;
    this.render();
  }

  removeChar(): void {
    if (!this.pending) return;
    this.pending = this.pending.slice(0, -1);
    this.render();
  }

  // `text` is the IME's current full composition (compositionupdate's own
  // `data`, e.g. "h" → "he" → "hel"), a replacement of the in-progress
  // word each call, not an incremental delta — never appended to.
  setComposing(text: string): void {
    this.composing = text;
    this.render();
  }

  // The composition ended (compositionend). Only clears the transient
  // preview — never touches `pending`. The OS delivers the actual
  // committed text through the engine's normal onData path immediately
  // after, which reaches `pending` the same way any other typed burst
  // does; adding it here too would double it.
  clearComposing(): void {
    if (!this.composing) return;
    this.composing = "";
    this.render();
  }

  clear(): void {
    this.pending = "";
    this.composing = "";
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
      for (const glyph of PROMPT_GLYPHS) {
        const idx = line.indexOf(`${glyph} `);
        if (idx !== -1) return { col: idx + 2, row };
      }
    }
    return cursor;
  }

  private render(): void {
    this.container.replaceChildren();
    const text = this.pending + this.composing;
    if (!text || this.adapter.isScrolledUp()) return;
    const anchor = this.findAnchor();
    const { width, height } = this.cellMetrics;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < text.length; i++) {
      const span = document.createElement("span");
      // Composing (not-yet-committed) chars get their own class — matches
      // the underline convention native IME composition renders with, so
      // there's still a visible cue that this part hasn't committed yet.
      span.className = i < this.pending.length ? "local-echo-char" : "local-echo-char local-echo-char-composing";
      span.textContent = text[i];
      span.style.left = `${(anchor.col + i) * width}px`;
      span.style.top = `${anchor.row * height}px`;
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
