// Copy-time selection extraction shared by both terminal engines via the
// @tmux-server/engine-support shim. tmux repaints attached clients with
// explicit cursor positioning, so the engines' buffers usually lack the
// isWrapped flags their own getSelection() relies on to join soft-wrapped
// rows — a redrawn wrapped line would copy with a hard "\n" at every wrap
// column. This rebuilds the text from the buffer and joins a row to the
// next when the buffer still says so (isWrapped) OR the row is filled to
// its last column (recovers the wraps tmux's redraw destroyed, same
// tradeoff as tmux's own `capture-pane -J`).

// 0-based, buffer-absolute coordinates with an EXCLUSIVE end column. The
// engines' getSelectionPosition() semantics differ (xterm 6: end.x
// exclusive despite its 1-based IBufferRange typing; ghostty-web 0.4:
// end.x inclusive), so each caller normalizes at its own edge.
export interface SelectionRangeExclusive {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

// Structural subset of both engines' buffer line — xterm's IBufferLine and
// ghostty-web's expose identical signatures.
export interface SelectionBufferCell {
  getChars(): string;
  getWidth(): number;
}

export interface SelectionBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(x: number): SelectionBufferCell | undefined;
}

export interface SelectionTextTerminal {
  readonly cols: number;
  buffer: {
    active: {
      getLine(y: number): SelectionBufferLine | null | undefined;
    };
  };
}

// A row continues onto the next when its final column holds real content.
// Prefer cell inspection: a width-0 cell is a wide char's spacer (the wide
// char spans INTO the last column — filled), and empty chars mean an
// unwritten cell (not filled) — xterm's translateToString can't make that
// distinction (it pads unwritten cells to " " but yields "" for spacers,
// while ghostty-web yields "" for unwritten cells too). The string
// fallback, for lines without getCell, therefore treats both "" and " "
// as not filled.
function rowFilledToEdge(line: SelectionBufferLine, cols: number): boolean {
  const cell = line.getCell?.(cols - 1);
  if (cell) {
    if (cell.getWidth() === 0) return true;
    const chars = cell.getChars();
    return chars !== "" && chars !== " ";
  }
  const tail = line.translateToString(false, cols - 1, cols);
  return tail !== "" && tail !== " ";
}

export function joinedSelectionText(term: SelectionTextTerminal, range: SelectionRangeExclusive): string {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const lines: string[] = [];
  let current = "";
  // Trailing whitespace is trimmed only at hard line ends (matching the
  // engines' own per-row trimming), never at a join point — a joined row is
  // full to the edge, so there is nothing to trim there anyway.
  const endLine = () => {
    lines.push(current.replace(/\s+$/, ""));
    current = "";
  };
  for (let y = range.startY; y <= range.endY; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const sx = y === range.startY ? range.startX : 0;
    const ex = y === range.endY ? range.endX : cols;
    current += line.translateToString(false, sx, ex);
    if (y === range.endY) break;
    const joined = buffer.getLine(y + 1)?.isWrapped || rowFilledToEdge(line, cols);
    if (!joined) endLine();
  }
  endLine();
  return lines.join("\n");
}
