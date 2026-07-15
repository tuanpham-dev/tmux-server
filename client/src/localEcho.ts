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

  constructor(overlayHost: HTMLElement, adapter: LocalEchoAdapter) {
    this.adapter = adapter;
    this.cellMetrics = adapter.getCellMetrics();
    this.container = document.createElement("div");
    this.container.className = "local-echo-overlay";
    overlayHost.appendChild(this.container);
    // Only re-renders while text is pending: the terminal's own cursor
    // can't move from typing alone (nothing is sent to the PTY until
    // Enter), but real output (a Claude response streaming in) still
    // repaints underneath, so the overlay needs to redraw on top of it.
    this.unsubRender = adapter.onRender(() => {
      if (this.pending) this.render();
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

  clear(): void {
    this.pending = "";
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
    if (!this.pending || this.adapter.isScrolledUp()) return;
    const anchor = this.findAnchor();
    const { width, height } = this.cellMetrics;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.pending.length; i++) {
      const span = document.createElement("span");
      span.className = "local-echo-char";
      span.textContent = this.pending[i];
      span.style.left = `${(anchor.col + i) * width}px`;
      span.style.top = `${anchor.row * height}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      frag.appendChild(span);
    }
    this.container.appendChild(frag);
  }
}
