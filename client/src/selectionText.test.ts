import { describe, expect, it } from "vitest";
import { joinedSelectionText, type SelectionBufferLine, type SelectionTextTerminal } from "./selectionText";

// xterm-flavored fake line over per-cell strings: a normal cell is one
// char, an unwritten cell is " " in translateToString output but "" via
// getCell, and a wide char occupies two cells — its char then a width-0
// spacer ("" in the cells array) that contributes "" to the string.
function line(cells: string[], isWrapped = false): SelectionBufferLine {
  return {
    isWrapped,
    translateToString(trimRight = false, startColumn = 0, endColumn = cells.length) {
      const text = cells.slice(startColumn, endColumn).join("");
      return trimRight ? text.replace(/\s+$/, "") : text;
    },
    getCell(x) {
      if (x < 0 || x >= cells.length) return undefined;
      return { getChars: () => cells[x], getWidth: () => (cells[x] === "" ? 0 : 1) };
    },
  };
}

// ghostty-flavored fake: no getCell, and translateToString yields "" (not
// " ") for cells past the written length — the shape that regressed live.
function ghosttyLine(text: string, isWrapped = false): SelectionBufferLine {
  return {
    isWrapped,
    translateToString(trimRight = false, startColumn = 0, endColumn = text.length) {
      const t = [...text].slice(startColumn, endColumn).join("");
      return trimRight ? t.replace(/\s+$/, "") : t;
    },
  };
}

function cellsOf(text: string, cols: number): string[] {
  const cells = [...text];
  while (cells.length < cols) cells.push(" ");
  return cells;
}

function term(cols: number, lines: (SelectionBufferLine | undefined)[]): SelectionTextTerminal {
  return { cols, buffer: { active: { getLine: (y) => lines[y] } } };
}

function fullSelection(t: SelectionTextTerminal, rows: number): string {
  return joinedSelectionText(t, { startX: 0, startY: 0, endX: t.cols, endY: rows - 1 });
}

describe("joinedSelectionText", () => {
  it("joins a full-width row to the next even without isWrapped (tmux redraw lost the flag)", () => {
    const t = term(10, [line(cellsOf("0123456789", 10)), line(cellsOf("abc", 10))]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });

  it("joins on isWrapped", () => {
    const t = term(10, [line(cellsOf("0123456789", 10)), line(cellsOf("abc", 10), true)]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });

  it("emits a newline after a short row and right-trims it", () => {
    const t = term(10, [line(cellsOf("abc", 10)), line(cellsOf("def", 10))]);
    expect(fullSelection(t, 2)).toBe("abc\ndef");
  });

  it("clamps start and end columns to the selection", () => {
    const t = term(10, [line(cellsOf("abcdefghij", 10)), line(cellsOf("klmnopqrst", 10))]);
    expect(joinedSelectionText(t, { startX: 2, startY: 0, endX: 4, endY: 1 })).toBe("abcdefghijklmn".slice(2));
  });

  it("returns a plain slice for a single-row selection", () => {
    const t = term(10, [line(cellsOf("abcdef", 10))]);
    expect(joinedSelectionText(t, { startX: 1, startY: 0, endX: 4, endY: 0 })).toBe("bcd");
  });

  it("treats a wide-char placeholder in the last column as filled", () => {
    // "ab" + wide char spanning cols 2-3 (placeholder cell contributes "").
    const t = term(4, [line(["a", "b", "宽", ""]), line(cellsOf("cd", 4))]);
    expect(fullSelection(t, 2)).toBe("ab宽cd");
  });

  it("tolerates missing buffer lines", () => {
    const t = term(10, [line(cellsOf("abc", 10)), undefined, line(cellsOf("def", 10))]);
    expect(fullSelection(t, 3)).toBe("abc\ndef");
  });

  it("does not join a hard newline between two short rows selected mid-row", () => {
    const t = term(10, [line(cellsOf("hello", 10)), line(cellsOf("world", 10))]);
    expect(joinedSelectionText(t, { startX: 0, startY: 0, endX: 3, endY: 1 })).toBe("hello\nwor");
  });

  it("does not join ghostty-style short rows whose unwritten tail reads as empty string", () => {
    const t = term(10, [ghosttyLine("abc"), ghosttyLine("def")]);
    expect(fullSelection(t, 2)).toBe("abc\ndef");
  });

  it("joins a ghostty-style full-width row", () => {
    const t = term(10, [ghosttyLine("0123456789"), ghosttyLine("abc")]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });
});
