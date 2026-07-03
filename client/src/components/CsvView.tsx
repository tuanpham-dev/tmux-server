import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import * as api from "../api";
import { copyText } from "../clipboard";
import type { MenuItem } from "../types";
import Icon from "./Icon";

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget: HTMLDivElement | null;
  onOpenInEditor: (path: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  // Reported on every dirty/clean transition so App's closeTab/closeOtherTabs
  // can confirm before discarding unsaved edits.
  onDirtyChange: (dirty: boolean) => void;
}

const ROW_HEIGHT = 32;
const VIRT_BUFFER = 25;
const ROW_NUM_MIN_W = 44;
const DEFAULT_COL_W = 120;
const MAX_HISTORY = 100;

type SortDir = "asc" | "desc" | null;
type CellPos = { row: number; col: number };
type CellRange = { anchor: CellPos; focus: CellPos };
type Bounds = { minRow: number; maxRow: number; minCol: number; maxCol: number };
type Snapshot = { rows: string[][]; headers: string[] };

function getBounds(sel: CellRange, maxRow: number, maxCol: number): Bounds {
  return {
    minRow: Math.max(0, Math.min(sel.anchor.row, sel.focus.row)),
    maxRow: Math.min(maxRow, Math.max(sel.anchor.row, sel.focus.row)),
    minCol: Math.max(0, Math.min(sel.anchor.col, sel.focus.col)),
    maxCol: Math.min(maxCol, Math.max(sel.anchor.col, sel.focus.col)),
  };
}
function inBounds(row: number, col: number, b: Bounds) {
  return row >= b.minRow && row <= b.maxRow && col >= b.minCol && col <= b.maxCol;
}
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Approximate column width from content (char-based estimation).
function calcColWidths(hdrs: string[], dataRows: string[][]): Record<number, number> {
  const CHAR_W = 7.5;
  const PAD = 40;
  const MIN_W = 60;
  const MAX_W = 320;
  const SAMPLE = Math.min(dataRows.length, 300);
  const result: Record<number, number> = {};
  hdrs.forEach((h, ci) => {
    let maxChars = h.length + 3;
    for (let ri = 0; ri < SAMPLE; ri++) {
      const cell = dataRows[ri]?.[ci] ?? "";
      const len = cell.includes("\n") ? cell.split("\n").reduce((m, l) => Math.max(m, l.length), 0) : cell.length;
      if (len > maxChars) maxChars = len;
    }
    result[ci] = Math.max(MIN_W, Math.min(MAX_W, Math.round(maxChars * CHAR_W + PAD)));
  });
  return result;
}

// ── Editable cell ─────────────────────────────────────────────────────────

function EditableCell({
  value, rowIdx, colIdx, selStyle, findHighlight, isEditing, draft, showFillHandle,
  onMouseDown, onDoubleClick, onMouseEnter, onDraftChange, onCommitAndMove, onCancel, onFillHandleMouseDown,
}: {
  value: string; rowIdx: number; colIdx: number;
  selStyle: "anchor" | "range" | "fill" | null;
  findHighlight: "current" | "match" | null;
  isEditing: boolean; draft: string; showFillHandle: boolean;
  onMouseDown: (r: number, c: number, e: React.MouseEvent) => void;
  onDoubleClick: (r: number, c: number) => void;
  onMouseEnter: (r: number, c: number) => void;
  onDraftChange: (v: string) => void;
  onCommitAndMove: (r: number, c: number, v: string, dir: "down" | "right" | "left" | "none") => void;
  onCancel: () => void;
  onFillHandleMouseDown: (e: React.MouseEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      const len = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const cellClass = [
    "csv-cell",
    selStyle ? `csv-cell-${selStyle}` : "",
    findHighlight ? `csv-cell-find-${findHighlight}` : "",
  ].join(" ").trim();

  return (
    <div className="csv-cell-wrap">
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={() => onCommitAndMove(rowIdx, colIdx, draft, "none")}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onCommitAndMove(rowIdx, colIdx, draft, "down"); }
            else if (e.key === "Tab") { e.preventDefault(); onCommitAndMove(rowIdx, colIdx, draft, e.shiftKey ? "left" : "right"); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          className="csv-cell-input"
        />
      ) : (
        <div
          onMouseDown={(e) => onMouseDown(rowIdx, colIdx, e)}
          onDoubleClick={() => onDoubleClick(rowIdx, colIdx)}
          onMouseEnter={() => onMouseEnter(rowIdx, colIdx)}
          className={cellClass}
        >
          {value || <span className="csv-cell-empty">—</span>}
        </div>
      )}
      {showFillHandle && !isEditing && (
        <div onMouseDown={onFillHandleMouseDown} className="csv-fill-handle" title="Drag to fill down" />
      )}
    </div>
  );
}

// ── Editable header cell ─────────────────────────────────────────────────

function EditableHeaderCell({
  value, colIdx, sortDir, isSelected, onSelectColumn, onSort, onRename, onDelete,
}: {
  value: string; colIdx: number; sortDir: SortDir; isSelected: boolean;
  onSelectColumn: (c: number, shift: boolean, ctrl: boolean) => void;
  onSort: (c: number) => void; onRename: (c: number, v: string) => void; onDelete: (c: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  return (
    <div className={`csv-header-cell${isSelected ? " csv-header-cell-selected" : ""}`}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(colIdx, draft); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") {
              e.preventDefault();
              onRename(colIdx, draft);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="csv-header-input"
        />
      ) : (
        <button
          onClick={(e) => onSelectColumn(colIdx, e.shiftKey, e.ctrlKey || e.metaKey)}
          onDoubleClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}
          title="Click · Shift+Click range · Ctrl+Click multi-select · Double-click rename"
          className="csv-header-label-button"
        >
          <span className="csv-header-label">{value || `col${colIdx + 1}`}</span>
        </button>
      )}
      {!editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onSort(colIdx); }}
          title={sortDir === "asc" ? "Sorted ascending — click for descending" : sortDir === "desc" ? "Sorted descending — click to clear" : "Sort"}
          className="csv-header-sort"
        >
          {/* Base glyph reads as ascending; flipped to point the other way for
              descending — dropped when this was ported from dev-dashboard's
              rotate-180, leaving only a color change with no direction cue. */}
          <Icon name="chevron-down" className={[sortDir ? "csv-sort-active" : "", sortDir === "desc" ? "icon-flip-y" : ""].filter(Boolean).join(" ")} />
        </button>
      )}
      {!editing && (
        <button onClick={() => onDelete(colIdx)} title="Delete column" className="csv-header-delete">
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

const basenameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export default function CsvView({ filePath, active, toolbarTarget, onOpenInEditor, onShowMenu, onDirtyChange }: Props) {
  const basename = basenameOf(filePath);

  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState("auto");
  const detectedDelimiterRef = useRef(",");

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [parseWarning, setParseWarning] = useState<string | null>(null);

  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  const [selection, setSelection] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<CellPos | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [fillPreviewRow, setFillPreviewRow] = useState<number | null>(null);
  const isDraggingFillRef = useRef(false);
  const fillBoundsRef = useRef<Bounds | null>(null);
  const fillPreviewRowRef = useRef<number | null>(null);
  const isDraggingSelectRef = useRef(false);

  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [useRegexFind, setUseRegexFind] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const [ctrlSelectedCols, setCtrlSelectedCols] = useState<Set<number> | null>(null);
  const [pinnedCols, setPinnedCols] = useState<Set<number>>(new Set());
  const [hiddenCols, setHiddenCols] = useState<Set<number>>(new Set());
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const hiddenPanelRef = useRef<HTMLDivElement>(null);

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowNumColWRef = useRef(ROW_NUM_MIN_W);

  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const resizingColRef = useRef<number | null>(null);
  const resizeStartXRef = useRef(0);
  const resizeStartWRef = useRef(0);

  const [formulaBarFocused, setFormulaBarFocused] = useState(false);
  const [formulaBarDraft, setFormulaBarDraft] = useState("");
  const formulaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .fetchFileText(filePath)
      .then(setContent)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── History ────────────────────────────────────────────────────────────

  function pushHistory() {
    undoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setDirty(true);
  }
  function clearHistory() {
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }
  function undo() {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    setRows(snap.rows);
    setHeaders(snap.headers);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    setDirty(true);
  }
  function redo() {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    setRows(snap.rows);
    setHeaders(snap.headers);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    setDirty(true);
  }

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // ── Parse ──────────────────────────────────────────────────────────────

  function applyParsed(data: string[][], detectedDelim: string, errMsg: string | null) {
    detectedDelimiterRef.current = detectedDelim || ",";
    setParseWarning(errMsg);
    clearHistory();
    setDirty(false);
    if (!data.length) { setHeaders([]); setRows([]); setColWidths({}); return; }
    let newHeaders: string[];
    let newRows: string[][];
    if (hasHeader) {
      newHeaders = data[0].map((h) => h.trim());
      newRows = data.slice(1);
    } else {
      const colCount = Math.max(...data.map((r) => r.length));
      newHeaders = Array.from({ length: colCount }, (_, i) => `col${i + 1}`);
      newRows = data;
    }
    setHeaders(newHeaders);
    setRows(newRows);
    setColWidths(calcColWidths(newHeaders, newRows));
    setPinnedCols(new Set());
    setHiddenCols(new Set());
    setSelection(null);
    setEditingCell(null);
  }

  useEffect(() => {
    if (content === null) return;
    if (!content.trim()) { setHeaders([]); setRows([]); setParseWarning(null); clearHistory(); return; }
    const result = Papa.parse<string[]>(content, {
      delimiter: delimiter === "auto" ? "" : delimiter,
      skipEmptyLines: true,
      header: false,
    });
    const errs = result.errors.filter((e) => e.type !== "Delimiter");
    applyParsed(result.data as string[][], result.meta.delimiter, errs.length ? errs[0].message : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, hasHeader, delimiter]);

  // ── Save ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Original row order — sort (below) is a view-only transform via
      // sortedWithIdx, `rows` itself is never reordered by it, so this
      // never silently rewrites the file just because a sort is active.
      const activeDelimiter = delimiter === "auto" ? detectedDelimiterRef.current : delimiter;
      const csvText = Papa.unparse(hasHeader ? [headers, ...rows] : rows, { delimiter: activeDelimiter });
      await api.saveFileText(filePath, csvText);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [filePath, hasHeader, headers, rows, delimiter]);

  // ── Sort (view-only) ───────────────────────────────────────────────────

  const sortedWithIdx = useMemo(() => {
    const indexed = rows.map((row, idx) => ({ row, originalIdx: idx }));
    if (sortCol === null || sortDir === null) return indexed;
    return [...indexed].sort((a, b) => {
      const av = a.row[sortCol] ?? "", bv = b.row[sortCol] ?? "";
      const an = parseFloat(av), bn = parseFloat(bv);
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  const totalRows = sortedWithIdx.length;
  const maxRow = totalRows - 1;
  const maxCol = headers.length - 1;
  const hasData = rows.length > 0 || headers.length > 0;

  function handleSort(col: number) {
    if (sortCol !== col) { setSortCol(col); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortCol(null); setSortDir(null);
  }

  const selBounds = useMemo(() => (selection ? getBounds(selection, maxRow, maxCol) : null), [selection, maxRow, maxCol]);
  const isMultiSel = selBounds ? selBounds.minRow !== selBounds.maxRow || selBounds.minCol !== selBounds.maxCol : false;

  // ── Find ───────────────────────────────────────────────────────────────

  const regexError = useMemo(() => {
    if (!useRegexFind || !findQuery.trim()) return null;
    try { new RegExp(findQuery); return null; } catch (e) { return (e as Error).message; }
  }, [useRegexFind, findQuery]);

  const findMatches = useMemo<CellPos[]>(() => {
    const q = findQuery.trim();
    if (!q || regexError) return [];
    let test: (val: string) => boolean;
    if (useRegexFind) {
      const re = new RegExp(q, "i");
      test = (val) => re.test(val);
    } else {
      const lq = q.toLowerCase();
      test = (val) => val.toLowerCase().includes(lq);
    }
    const out: CellPos[] = [];
    sortedWithIdx.forEach(({ row }, ri) => row.forEach((val, ci) => { if (test(val)) out.push({ row: ri, col: ci }); }));
    return out;
  }, [findQuery, useRegexFind, regexError, sortedWithIdx]);

  const findMatchSet = useMemo(() => new Set(findMatches.map((m) => `${m.row},${m.col}`)), [findMatches]);
  const safeIdx = findMatches.length ? Math.min(findIdx, findMatches.length - 1) : 0;

  function openFind() { setShowFind(true); setShowReplace(false); setTimeout(() => findInputRef.current?.focus(), 0); }
  function openFindReplace() { setShowFind(true); setShowReplace(true); setTimeout(() => findInputRef.current?.focus(), 0); }
  function closeFind() { setShowFind(false); setShowReplace(false); setFindQuery(""); setFindIdx(0); scrollRef.current?.focus(); }

  function replaceCurrent() {
    if (!findMatches.length || regexError) return;
    const m = findMatches[safeIdx];
    const oi = sortedWithIdx[m.row]?.originalIdx;
    if (oi === undefined) return;
    const cell = sortedWithIdx[m.row]?.row[m.col] ?? "";
    const re = useRegexFind ? new RegExp(findQuery, "gi") : new RegExp(escapeRegex(findQuery), "gi");
    const newVal = cell.replace(re, replaceQuery);
    pushHistory();
    setRows((prev) => prev.map((r, i) => { if (i !== oi) return r; const c = [...r]; c[m.col] = newVal; return c; }));
    setFindIdx((idx) => Math.min(idx, Math.max(0, findMatches.length - 2)));
  }
  function replaceAll() {
    if (!findMatches.length || regexError) return;
    const re = useRegexFind ? new RegExp(findQuery, "gi") : new RegExp(escapeRegex(findQuery), "gi");
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      findMatches.forEach(({ row, col }) => {
        const oi = sortedWithIdx[row]?.originalIdx;
        if (oi === undefined) return;
        next[oi][col] = next[oi][col].replace(re, replaceQuery);
      });
      return next;
    });
    setFindIdx(0);
  }
  function jumpToMatch(idx: number) {
    if (!findMatches.length) return;
    const i = ((idx % findMatches.length) + findMatches.length) % findMatches.length;
    setFindIdx(i);
    const m = findMatches[i];
    setSelection({ anchor: m, focus: m });
    scrollToCell(m.row, m.col);
  }

  // ── Scroll ─────────────────────────────────────────────────────────────

  const scrollToCell = useCallback((row: number, col: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = row * ROW_HEIGHT;
    const rowBot = rowTop + ROW_HEIGHT;
    const usableH = el.clientHeight - ROW_HEIGHT;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBot > el.scrollTop + usableH) el.scrollTop = rowBot - usableH;
    const th = el.querySelector<HTMLElement>(`th[data-col-idx="${col}"]`);
    if (th) {
      const cr = el.getBoundingClientRect(), tr = th.getBoundingClientRect();
      if (tr.left - cr.left < rowNumColWRef.current) el.scrollLeft += tr.left - cr.left - rowNumColWRef.current;
      else if (tr.right - cr.left > el.clientWidth) el.scrollLeft += tr.right - cr.left - el.clientWidth;
    }
  }, []);

  const handleScroll = useCallback(() => { if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop); }, []);

  const visStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRT_BUFFER);
  const visEnd = Math.min(maxRow, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + VIRT_BUFFER);
  const topSpace = visStart * ROW_HEIGHT;
  const botSpace = Math.max(0, (totalRows - visEnd - 1) * ROW_HEIGHT);

  // ── Selection ──────────────────────────────────────────────────────────

  function setAnchorFocus(anchor: CellPos, focus: CellPos, scroll = true) {
    setSelection({ anchor, focus });
    setEditingCell(null);
    if (scroll) scrollToCell(focus.row, focus.col);
    scrollRef.current?.focus();
  }
  function selectCell(row: number, col: number) { setAnchorFocus({ row, col }, { row, col }); }
  function extendFocus(row: number, col: number) {
    if (!selection) { selectCell(row, col); return; }
    const nr = Math.max(0, Math.min(row, maxRow));
    const nc = Math.max(0, Math.min(col, maxCol));
    setSelection({ anchor: selection.anchor, focus: { row: nr, col: nc } });
    scrollToCell(nr, nc);
  }
  function selectRow(ri: number, shift: boolean) {
    if (shift && selection) setSelection({ anchor: { row: selection.anchor.row, col: 0 }, focus: { row: ri, col: maxCol } });
    else setAnchorFocus({ row: ri, col: 0 }, { row: ri, col: maxCol }, false);
    scrollRef.current?.focus();
  }
  function selectColumn(ci: number, shift: boolean, ctrl = false) {
    if (ctrl) {
      setCtrlSelectedCols((prev) => {
        let next: Set<number>;
        if (prev === null) {
          next = new Set<number>();
          if (selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow) {
            for (let c = selBounds.minCol; c <= selBounds.maxCol; c++) next.add(c);
          }
        } else {
          next = new Set(prev);
        }
        next.has(ci) ? next.delete(ci) : next.add(ci);
        return next.size === 0 ? null : next;
      });
      scrollRef.current?.focus();
      return;
    }
    setCtrlSelectedCols(null);
    if (shift && selection) setSelection({ anchor: { row: 0, col: selection.anchor.col }, focus: { row: maxRow, col: ci } });
    else setAnchorFocus({ row: 0, col: ci }, { row: maxRow, col: ci }, false);
    scrollRef.current?.focus();
  }

  function handleCellMouseDown(row: number, col: number, e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setCtrlSelectedCols(null);
    if (editingCell) commitRange(editDraft);
    if (e.shiftKey && selection) extendFocus(row, col);
    else setAnchorFocus({ row, col }, { row, col });
    isDraggingSelectRef.current = true;
  }
  function handleCellMouseEnter(row: number, col: number) {
    if (isDraggingSelectRef.current && selection) setSelection({ anchor: selection.anchor, focus: { row, col } });
  }

  // ── Editing ────────────────────────────────────────────────────────────

  function startEdit(row: number, col: number, initial?: string) {
    setSelection({ anchor: { row, col }, focus: { row, col } });
    setEditingCell({ row, col });
    setEditDraft(initial !== undefined ? initial : (sortedWithIdx[row]?.row[col] ?? ""));
  }
  function commitRange(val: string) {
    if (!selBounds) return;
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
        const oi = sortedWithIdx[ri]?.originalIdx;
        if (oi === undefined) continue;
        for (let ci = selBounds.minCol; ci <= selBounds.maxCol; ci++) next[oi][ci] = val;
      }
      return next;
    });
  }
  function commitAndMove(row: number, col: number, val: string, dir: "down" | "right" | "left" | "none") {
    if (isMultiSel && selBounds) {
      commitRange(val);
    } else {
      const oi = sortedWithIdx[row]?.originalIdx;
      if (oi !== undefined) {
        pushHistory();
        setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[col] = val; return c; })() : r)));
      }
    }
    setEditingCell(null);
    let nr = row, nc = col;
    if (dir === "down") nr = Math.min(row + 1, maxRow);
    else if (dir === "right") { nc = col < maxCol ? col + 1 : nc; if (col === maxCol && row < maxRow) { nr = row + 1; nc = 0; } }
    else if (dir === "left") { nc = col > 0 ? col - 1 : nc; if (col === 0 && row > 0) { nr = row - 1; nc = maxCol; } }
    setSelection({ anchor: { row: nr, col: nc }, focus: { row: nr, col: nc } });
    setTimeout(() => { scrollToCell(nr, nc); scrollRef.current?.focus(); }, 0);
  }
  function cancelEdit() { setEditingCell(null); scrollRef.current?.focus(); }

  function commitFormulaBar() {
    if (!anchorPos || !formulaBarFocused) { setFormulaBarFocused(false); return; }
    const oi = sortedWithIdx[anchorPos.row]?.originalIdx;
    if (oi !== undefined && formulaBarDraft !== anchorValue) {
      pushHistory();
      setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[anchorPos.col] = formulaBarDraft; return c; })() : r)));
    }
    setFormulaBarFocused(false);
    scrollRef.current?.focus();
  }

  // ── Copy / cut / paste ─────────────────────────────────────────────────

  function copyCells(cut = false) {
    if (!selBounds) return;
    const lines: string[] = [];
    for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
      const cells: string[] = [];
      for (let ci = selBounds.minCol; ci <= selBounds.maxCol; ci++) cells.push(sortedWithIdx[ri]?.row[ci] ?? "");
      lines.push(cells.join("\t"));
    }
    copyText(lines.join("\n")).catch(() => {});
    if (cut) commitRange("");
  }
  async function pasteCells() {
    if (!selection) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;
      const parsed = Papa.parse<string[]>(text, { delimiter: "\t" });
      const pastedRows = parsed.data as string[][];
      if (!pastedRows.length) return;
      pushHistory();
      const startRow = selection.anchor.row, startCol = selection.anchor.col;
      setRows((prev) => {
        const next = prev.map((r) => [...r]);
        pastedRows.forEach((pr, ri) => {
          const tdr = startRow + ri;
          if (tdr > maxRow) return;
          const oi = sortedWithIdx[tdr]?.originalIdx;
          if (oi === undefined) return;
          pr.forEach((val, ci) => { const tc = startCol + ci; if (tc < next[oi].length) next[oi][tc] = val; });
        });
        return next;
      });
    } catch { /* clipboard denied */ }
  }

  // ── Fill handle ────────────────────────────────────────────────────────

  function handleFillHandleMouseDown(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    if (!selBounds) return;
    isDraggingFillRef.current = true;
    fillBoundsRef.current = selBounds;
    fillPreviewRowRef.current = selBounds.maxRow;
    setFillPreviewRow(selBounds.maxRow);
  }
  function getRowFromMouseY(clientY: number): number | null {
    const el = scrollRef.current;
    if (!el) return null;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop - ROW_HEIGHT;
    return Math.max(0, Math.min(Math.floor(y / ROW_HEIGHT), maxRow));
  }
  function applyFillDown(bounds: Bounds, targetRow: number) {
    const { minRow, maxRow: srcMax, minCol, maxCol: srcMaxCol } = bounds;
    const pattern = sortedWithIdx.slice(minRow, srcMax + 1).map((x) => x.row.slice(minCol, srcMaxCol + 1));
    const patLen = pattern.length;
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      for (let di = srcMax + 1; di <= targetRow; di++) {
        const oi = sortedWithIdx[di]?.originalIdx;
        if (oi === undefined) continue;
        const pr = pattern[(di - srcMax - 1) % patLen];
        for (let ci = minCol; ci <= srcMaxCol; ci++) next[oi][ci] = pr[ci - minCol] ?? "";
      }
      return next;
    });
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!isDraggingFillRef.current) return;
      const ri = getRowFromMouseY(e.clientY);
      if (ri !== null && fillBoundsRef.current && ri > fillBoundsRef.current.maxRow) {
        fillPreviewRowRef.current = ri;
        setFillPreviewRow(ri);
      }
    }
    function onUp() {
      isDraggingSelectRef.current = false;
      if (isDraggingFillRef.current) {
        isDraggingFillRef.current = false;
        const bounds = fillBoundsRef.current;
        const targetRow = fillPreviewRowRef.current;
        if (bounds && targetRow !== null && targetRow > bounds.maxRow) {
          applyFillDown(bounds, targetRow);
          setSelection((sel) => (sel ? { anchor: sel.anchor, focus: { row: targetRow, col: bounds.maxCol } } : sel));
        }
        setFillPreviewRow(null);
        fillPreviewRowRef.current = null;
        fillBoundsRef.current = null;
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedWithIdx, rows]);

  // ── Row / column mutations ─────────────────────────────────────────────

  function renameHeader(col: number, val: string) { pushHistory(); setHeaders((h) => h.map((v, i) => (i === col ? val : v))); }
  function addRow() { pushHistory(); setRows((r) => [...r, Array(headers.length || (r[0]?.length ?? 1)).fill("")]); }
  function deleteRow(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx;
    if (oi === undefined) return;
    pushHistory();
    setRows((r) => r.filter((_, i) => i !== oi));
    setSelection(null);
  }
  function addColumn() {
    pushHistory();
    setHeaders((h) => [...h, `col${h.length + 1}`]);
    setRows((r) => r.map((row) => [...row, ""]));
  }
  function deleteColumn(colIdx: number) {
    pushHistory();
    setHeaders((h) => h.filter((_, i) => i !== colIdx));
    setRows((r) => r.map((row) => row.filter((_, i) => i !== colIdx)));
    if (sortCol === colIdx) { setSortCol(null); setSortDir(null); }
    const shiftDown = (prev: Set<number>) => {
      const next = new Set<number>();
      prev.forEach((ci) => { if (ci < colIdx) next.add(ci); else if (ci > colIdx) next.add(ci - 1); });
      return next;
    };
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (ki < colIdx) next[ki] = v; else if (ki > colIdx) next[ki - 1] = v; });
      return next;
    });
    setPinnedCols(shiftDown);
    setHiddenCols(shiftDown);
    setSelection(null);
  }
  function batchDeleteColumns(colIdxs: number[]) {
    if (!colIdxs.length) return;
    const toDelete = new Set(colIdxs);
    const newIdx = (old: number) => old - [...toDelete].filter((d) => d < old).length;
    pushHistory();
    setHeaders((h) => h.filter((_, i) => !toDelete.has(i)));
    setRows((r) => r.map((row) => row.filter((_, i) => !toDelete.has(i))));
    if (sortCol !== null) {
      if (toDelete.has(sortCol)) { setSortCol(null); setSortDir(null); } else setSortCol(newIdx(sortCol));
    }
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (!toDelete.has(ki)) next[newIdx(ki)] = v; });
      return next;
    });
    const adjustSet = (prev: Set<number>) => {
      const next = new Set<number>();
      prev.forEach((ci) => { if (!toDelete.has(ci)) next.add(newIdx(ci)); });
      return next;
    };
    setPinnedCols(adjustSet);
    setHiddenCols(adjustSet);
    setSelection(null);
  }
  function insertColumnAt(colIdx: number) {
    pushHistory();
    const newName = `col${headers.length + 1}`;
    setHeaders((h) => [...h.slice(0, colIdx), newName, ...h.slice(colIdx)]);
    setRows((r) => r.map((row) => [...row.slice(0, colIdx), "", ...row.slice(colIdx)]));
    const shiftUp = (prev: Set<number>) => { const next = new Set<number>(); prev.forEach((ci) => next.add(ci < colIdx ? ci : ci + 1)); return next; };
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (ki < colIdx) next[ki] = v; else next[ki + 1] = v; });
      next[colIdx] = DEFAULT_COL_W;
      return next;
    });
    setPinnedCols(shiftUp);
    setHiddenCols(shiftUp);
    setSelection(null);
  }
  function insertRowAt(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx ?? 0;
    pushHistory();
    setRows((r) => [...r.slice(0, oi), Array(headers.length).fill(""), ...r.slice(oi)]);
    setSelection(null);
  }
  function insertRowAfterIdx(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx ?? rows.length - 1;
    pushHistory();
    setRows((r) => [...r.slice(0, oi + 1), Array(headers.length).fill(""), ...r.slice(oi + 1)]);
    setSelection(null);
  }
  function deleteSelectedRows() {
    if (!selBounds) return;
    const oiSet = new Set<number>();
    for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
      const oi = sortedWithIdx[ri]?.originalIdx;
      if (oi !== undefined) oiSet.add(oi);
    }
    pushHistory();
    setRows((r) => r.filter((_, i) => !oiSet.has(i)));
    setSelection(null);
  }
  function resizeColToFit(ci: number) {
    const w = calcColWidths([headers[ci] ?? ""], rows.map((r) => [r[ci] ?? ""]));
    setColWidths((prev) => ({ ...prev, [ci]: w[0] }));
  }

  // ── Copy whole CSV ─────────────────────────────────────────────────────

  function exportToCSV() {
    const activeDelimiter = delimiter === "auto" ? detectedDelimiterRef.current : delimiter;
    return Papa.unparse(hasHeader ? [headers, ...sortedWithIdx.map((x) => x.row)] : sortedWithIdx.map((x) => x.row), { delimiter: activeDelimiter });
  }
  function handleCopyAll() {
    copyText(exportToCSV()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // ── Column drag resize ─────────────────────────────────────────────────

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (resizingColRef.current === null) return;
      const delta = e.clientX - resizeStartXRef.current;
      const newW = Math.max(50, resizeStartWRef.current + delta);
      setColWidths((w) => ({ ...w, [resizingColRef.current!]: newW }));
    }
    function onUp() { resizingColRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────

  const rowNumColW = Math.max(ROW_NUM_MIN_W, String(Math.max(totalRows, 1)).length * 8 + 16);
  rowNumColWRef.current = rowNumColW;
  const getColWidth = (ci: number) => colWidths[ci] ?? DEFAULT_COL_W;
  const getPinnedLeft = (ci: number): number => {
    let left = rowNumColW;
    for (let i = 0; i < ci; i++) if (pinnedCols.has(i) && !hiddenCols.has(i)) left += getColWidth(i);
    return left;
  };
  const nextVisCol = (from: number, dir: 1 | -1): number => {
    let c = from + dir;
    while (c >= 0 && c <= maxCol && hiddenCols.has(c)) c += dir;
    return Math.max(0, Math.min(maxCol, c));
  };

  const anchorPos = selection?.anchor ?? null;
  const anchorValue = anchorPos !== null ? (sortedWithIdx[anchorPos.row]?.row[anchorPos.col] ?? "") : "";
  const displayValue = formulaBarFocused ? formulaBarDraft : anchorValue;

  const isColFullySelected = (ci: number) =>
    ctrlSelectedCols?.has(ci) || (!!selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow && ci >= selBounds.minCol && ci <= selBounds.maxCol);
  const isRowFullySelected = (ri: number) =>
    !!selBounds && selBounds.minCol === 0 && selBounds.maxCol === maxCol && ri >= selBounds.minRow && ri <= selBounds.maxRow;

  const statusText = (() => {
    if (!selection || !selBounds) return hasData ? `${rows.length.toLocaleString()} rows × ${headers.length} cols` : "No data";
    const rCount = selBounds.maxRow - selBounds.minRow + 1;
    const cCount = selBounds.maxCol - selBounds.minCol + 1;
    if (rCount === 1 && cCount === 1) return `${headers[selBounds.minCol] || `col${selBounds.minCol + 1}`}, row ${selBounds.minRow + 1}`;
    return `${rCount} × ${cCount} selected`;
  })();

  useEffect(() => {
    if (!showHiddenPanel) return;
    function onDown(e: MouseEvent) { if (!hiddenPanelRef.current?.contains(e.target as Node)) setShowHiddenPanel(false); }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showHiddenPanel]);

  useEffect(() => {
    const el = formulaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, 160);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [displayValue]);

  // ── Keyboard ───────────────────────────────────────────────────────────

  function handleTableKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); handleSave(); return; }
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }

    if (editingCell) return;

    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (totalRows > 0 && headers.length > 0) setAnchorFocus({ row: 0, col: 0 }, { row: maxRow, col: maxCol }, false);
      return;
    }
    if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copyCells(false); return; }
    if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); copyCells(true); return; }
    if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteCells(); return; }
    if (mod && (e.key === "f" || e.key === "F")) { e.preventDefault(); openFind(); return; }
    if (mod && (e.key === "h" || e.key === "H")) { e.preventDefault(); openFindReplace(); return; }

    const anchor = selection?.anchor ?? null;
    if (!anchor) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab"].includes(e.key)) {
        e.preventDefault();
        if (totalRows > 0 && headers.length > 0) selectCell(0, 0);
      }
      return;
    }
    const { row, col } = anchor;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (e.shiftKey) extendFocus((selBounds?.minRow ?? row) - 1, selection?.focus.col ?? col);
        else selectCell(Math.max(0, row - 1), col);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (e.shiftKey) extendFocus((selBounds?.maxRow ?? row) + 1, selection?.focus.col ?? col);
        else selectCell(Math.min(maxRow, row + 1), col);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) extendFocus(selection?.focus.row ?? row, (selBounds?.minCol ?? col) - 1);
        else selectCell(row, nextVisCol(col, -1));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) extendFocus(selection?.focus.row ?? row, (selBounds?.maxCol ?? col) + 1);
        else selectCell(row, nextVisCol(col, 1));
        break;
      case "Tab": {
        e.preventDefault();
        const tabLeft = nextVisCol(col, -1), tabRight = nextVisCol(col, 1);
        if (e.shiftKey) { tabLeft !== col ? selectCell(row, tabLeft) : row > 0 && selectCell(row - 1, nextVisCol(maxCol + 1, -1)); }
        else { tabRight !== col ? selectCell(row, tabRight) : row < maxRow && selectCell(row + 1, nextVisCol(-1, 1)); }
        break;
      }
      case "Enter": case "F2": e.preventDefault(); startEdit(row, col); break;
      case "Delete": case "Backspace":
        e.preventDefault();
        if (isMultiSel && selBounds) commitRange("");
        else {
          const oi = sortedWithIdx[row]?.originalIdx;
          if (oi !== undefined) {
            pushHistory();
            setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[col] = ""; return c; })() : r)));
          }
        }
        break;
      case "Escape": e.preventDefault(); setSelection(null); setCtrlSelectedCols(null); break;
      default:
        if (e.key.length === 1 && !mod) startEdit(row, col);
    }
  }

  // ── Context menu ───────────────────────────────────────────────────────

  function showHeaderMenu(e: React.MouseEvent, ci: number) {
    e.preventDefault();
    const useCtrl = !!(ctrlSelectedCols && ctrlSelectedCols.size > 0 && ctrlSelectedCols.has(ci));
    const isMulti = useCtrl
      ? ctrlSelectedCols!.size > 1
      : !!(selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow && ci >= selBounds.minCol && ci <= selBounds.maxCol && selBounds.minCol !== selBounds.maxCol);
    const colRange = useCtrl
      ? [...ctrlSelectedCols!].sort((a, b) => a - b)
      : isMulti
        ? Array.from({ length: selBounds!.maxCol - selBounds!.minCol + 1 }, (_, i) => selBounds!.minCol + i)
        : [ci];
    const n = colRange.length;
    const allPinned = colRange.every((c) => pinnedCols.has(c));
    const label = (s: string) => (n > 1 ? `${s} (${n} cols)` : s);
    const items: MenuItem[] = [];
    if (!isMulti) {
      items.push({ label: "Sort A → Z", onClick: () => { setSortCol(ci); setSortDir("asc"); } });
      items.push({ label: "Sort Z → A", onClick: () => { setSortCol(ci); setSortDir("desc"); } });
    }
    // Sort is table-wide (one column at a time), so this is offered
    // regardless of which header was right-clicked, not just the currently
    // sorted one — otherwise clearing a sort you no longer remember the
    // column for means hunting for the active chevron first.
    if (sortCol !== null) {
      items.push({ label: "Clear sort", onClick: () => { setSortCol(null); setSortDir(null); } });
    }
    items.push({ label: label("Resize to fit"), onClick: () => colRange.forEach((c) => resizeColToFit(c)) });
    items.push({
      label: label(allPinned ? "Unpin" : "Pin"),
      onClick: () => setPinnedCols((prev) => {
        const next = new Set(prev);
        allPinned ? colRange.forEach((c) => next.delete(c)) : colRange.forEach((c) => next.add(c));
        return next;
      }),
    });
    items.push({
      label: label("Hide"),
      onClick: () => {
        setHiddenCols((prev) => new Set([...prev, ...colRange]));
        setPinnedCols((prev) => { const next = new Set(prev); colRange.forEach((c) => next.delete(c)); return next; });
      },
    });
    if (!isMulti) {
      items.push({ label: "Insert column left", onClick: () => insertColumnAt(ci) });
      items.push({ label: "Insert column right", onClick: () => insertColumnAt(ci + 1) });
    }
    items.push({ label: label("Delete column"), danger: true, onClick: () => (n > 1 ? batchDeleteColumns(colRange) : deleteColumn(ci)) });
    onShowMenu(e.clientX, e.clientY, items);
  }

  function showCellMenu(e: React.MouseEvent, ri: number, ci: number) {
    e.preventDefault();
    if (editingCell) return;
    if (!selBounds || !inBounds(ri, ci, selBounds)) selectCell(ri, ci);
    const isSingle = !selBounds || (selBounds.minRow === selBounds.maxRow && selBounds.minCol === selBounds.maxCol);
    const rowCount = selBounds ? selBounds.maxRow - selBounds.minRow + 1 : 1;
    const items: MenuItem[] = [];
    if (isSingle) items.push({ label: "Edit cell (Enter)", onClick: () => startEdit(ri, ci) });
    items.push({ label: "Copy (Ctrl+C)", onClick: () => copyCells(false) });
    items.push({ label: "Cut (Ctrl+X)", onClick: () => copyCells(true) });
    items.push({ label: "Paste (Ctrl+V)", onClick: () => pasteCells() });
    items.push({ label: isSingle ? "Clear cell" : "Clear selection", onClick: () => commitRange("") });
    items.push({ label: "Insert row above", onClick: () => insertRowAt(ri) });
    items.push({ label: "Insert row below", onClick: () => insertRowAfterIdx(ri) });
    items.push({ label: `Delete row${rowCount > 1 ? `s (${rowCount})` : ""}`, danger: true, onClick: () => deleteSelectedRows() });
    onShowMenu(e.clientX, e.clientY, items);
  }

  // ── Toolbar (portaled) ─────────────────────────────────────────────────

  const controls = (
    <>
      {dirty && <span className="csv-dirty-dot" title="Unsaved changes" />}
      <button className="icon-button" title={saveError ? `Save failed: ${saveError}` : "Save (Ctrl+S)"} disabled={saving} onClick={handleSave}>
        <Icon name="save" />
      </button>
      <button className="icon-button" title="Open in Editor" onClick={() => onOpenInEditor(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className={`csv-host${active ? "" : " hidden"}`}>
      {loadError && <div className="csv-status csv-status-error">Couldn't load {basename}</div>}
      {!loadError && content === null && <div className="csv-status">Loading…</div>}
      {!loadError && content !== null && (
        <div className="csv-body">
          <div className="csv-toolbar">
            <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" className="icon-button">
              <Icon name="redo" className="icon-flip-x" />
            </button>
            <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" className="icon-button">
              <Icon name="redo" />
            </button>
            <span className="csv-toolbar-sep" />
            <span className="csv-status-text" title={statusText}>{statusText}</span>

            <span className="csv-toolbar-spacer" />

            {hiddenCols.size > 0 && (
              <div ref={hiddenPanelRef} className="csv-hidden-panel-wrap">
                <button onClick={() => setShowHiddenPanel((v) => !v)} className="csv-hidden-badge" title="Hidden columns">
                  <Icon name="eye-closed" /> {hiddenCols.size}
                </button>
                {showHiddenPanel && (
                  <div className="csv-hidden-panel">
                    <button className="csv-hidden-panel-item" onClick={() => { setHiddenCols(new Set()); setShowHiddenPanel(false); }}>
                      <Icon name="eye" /> Show all columns
                    </button>
                    {[...hiddenCols].sort((a, b) => a - b).map((ci) => (
                      <button
                        key={ci}
                        className="csv-hidden-panel-item"
                        onClick={() => setHiddenCols((prev) => { const n = new Set(prev); n.delete(ci); return n; })}
                      >
                        <Icon name="eye" /> <span className="csv-hidden-panel-item-name">{headers[ci] ?? `col${ci + 1}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button onClick={openFind} title="Find (Ctrl+F)" className={`icon-button${showFind ? " csv-toolbar-btn-active" : ""}`}>
              <Icon name="search" />
            </button>
            <span className="csv-toolbar-sep" />
            <button onClick={addRow} disabled={!hasData} title="Add row" className="csv-text-button">
              <Icon name="add" /> Row
            </button>
            <button onClick={addColumn} disabled={!hasData} title="Add column" className="csv-text-button">
              <Icon name="add" /> Col
            </button>
            <span className="csv-toolbar-sep" />
            <label className="csv-header-toggle">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> Header
            </label>
            <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className="csv-delimiter-select">
              <option value="auto">Auto</option>
              <option value=",">, comma</option>
              <option value=";">; semi</option>
              <option value="&#9;">⇥ tab</option>
              <option value="|">| pipe</option>
            </select>
            <span className="csv-toolbar-sep" />
            <button onClick={handleCopyAll} disabled={!hasData} title="Copy whole CSV" className="csv-text-button">
              <Icon name="copy" /> {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          {showFind && (
            <div className="csv-find-bar">
              <div className="csv-find-row">
                <Icon name="search" />
                <input
                  ref={findInputRef}
                  value={findQuery}
                  onChange={(e) => { setFindQuery(e.target.value); setFindIdx(0); }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") jumpToMatch(safeIdx + (e.shiftKey ? -1 : 1));
                    if (e.key === "Escape") closeFind();
                    if (e.key === "Tab" && showReplace) { e.preventDefault(); replaceInputRef.current?.focus(); }
                  }}
                  placeholder="Find in cells…"
                  className={`csv-find-input${regexError ? " csv-find-input-error" : ""}`}
                />
                {regexError ? (
                  <span className="csv-find-error" title={regexError}>{regexError}</span>
                ) : findQuery ? (
                  <span className="csv-find-count">{findMatches.length === 0 ? "No results" : `${safeIdx + 1} / ${findMatches.length}`}</span>
                ) : null}
                <button onClick={() => { setUseRegexFind((v) => !v); setFindIdx(0); }} title="Use regular expression" className={`icon-button${useRegexFind ? " csv-toolbar-btn-active" : ""}`}>
                  <Icon name="regex" />
                </button>
                <button onClick={() => setShowReplace((v) => !v)} title="Toggle replace (Ctrl+H)" className={`icon-button${showReplace ? " csv-toolbar-btn-active" : ""}`}>
                  <Icon name="replace" />
                </button>
                <button onClick={() => jumpToMatch(safeIdx - 1)} disabled={!findMatches.length} title="Previous (Shift+Enter)" className="icon-button">
                  <Icon name="chevron-down" className="icon-flip-y" />
                </button>
                <button onClick={() => jumpToMatch(safeIdx + 1)} disabled={!findMatches.length} title="Next (Enter)" className="icon-button">
                  <Icon name="chevron-down" />
                </button>
                <button onClick={closeFind} title="Close (Esc)" className="icon-button">
                  <Icon name="close" />
                </button>
              </div>
              {showReplace && (
                <div className="csv-find-row csv-replace-row">
                  <input
                    ref={replaceInputRef}
                    value={replaceQuery}
                    onChange={(e) => setReplaceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") closeFind();
                      if (e.key === "Enter") replaceCurrent();
                      if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); findInputRef.current?.focus(); }
                    }}
                    placeholder="Replace with…"
                    className="csv-find-input"
                  />
                  <button onClick={replaceCurrent} disabled={!findMatches.length || !!regexError} className="csv-text-button" title="Replace current match (Enter)">
                    <Icon name="replace" /> Replace
                  </button>
                  <button onClick={replaceAll} disabled={!findMatches.length || !!regexError} className="csv-text-button" title="Replace all matches">
                    <Icon name="replace-all" /> Replace All
                  </button>
                </div>
              )}
            </div>
          )}

          {parseWarning && <div className="csv-warning">{parseWarning}</div>}

          {hasData && (
            <div className="csv-formula-bar">
              <span className="csv-formula-label">{anchorPos ? (headers[anchorPos.col] ?? `C${anchorPos.col + 1}`) : "value"}</span>
              <textarea
                ref={formulaRef}
                rows={1}
                value={displayValue}
                readOnly={!anchorPos}
                onFocus={() => { if (anchorPos !== null) { setFormulaBarFocused(true); setFormulaBarDraft(anchorValue); } }}
                onChange={(e) => setFormulaBarDraft(e.target.value)}
                onBlur={commitFormulaBar}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") { e.preventDefault(); setFormulaBarFocused(false); scrollRef.current?.focus(); }
                  else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitFormulaBar(); }
                }}
                placeholder={anchorPos ? "" : "Select a cell…"}
                className="csv-formula-input"
              />
            </div>
          )}

          {!hasData ? (
            <div className="csv-empty">Empty file</div>
          ) : (
            <div ref={scrollRef} tabIndex={0} onKeyDown={handleTableKeyDown} onScroll={handleScroll} className="csv-scroll">
              <table
                className="csv-table"
                style={{ width: rowNumColW + headers.reduce((s, _, ci) => (hiddenCols.has(ci) ? s : s + getColWidth(ci)), 0) + 32 }}
              >
                <colgroup>
                  <col style={{ width: rowNumColW }} />
                  {headers.map((_, ci) => (hiddenCols.has(ci) ? null : <col key={ci} style={{ width: getColWidth(ci) }} />))}
                  <col style={{ width: 32 }} />
                </colgroup>
                <thead className="csv-thead">
                  <tr>
                    <th className="csv-th csv-th-rownum" style={{ height: ROW_HEIGHT }}>
                      <button onClick={() => setAnchorFocus({ row: 0, col: 0 }, { row: maxRow, col: maxCol }, false)} title="Select all (Ctrl+A)" className="csv-th-rownum-button">
                        #
                      </button>
                    </th>
                    {headers.map((h, ci) => {
                      if (hiddenCols.has(ci)) return null;
                      const isPinned = pinnedCols.has(ci);
                      return (
                        <th
                          key={ci}
                          data-col-idx={ci}
                          className={`csv-th${isPinned ? " csv-th-pinned" : ""}${isColFullySelected(ci) ? " csv-th-selected" : ""}`}
                          style={{ height: ROW_HEIGHT, ...(isPinned ? { left: getPinnedLeft(ci) } : {}) }}
                          onContextMenu={(e) => showHeaderMenu(e, ci)}
                        >
                          <EditableHeaderCell
                            value={h}
                            colIdx={ci}
                            sortDir={sortCol === ci ? sortDir : null}
                            isSelected={isColFullySelected(ci)}
                            onSelectColumn={selectColumn}
                            onSort={handleSort}
                            onRename={renameHeader}
                            onDelete={deleteColumn}
                          />
                          <div
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); resizingColRef.current = ci; resizeStartXRef.current = e.clientX; resizeStartWRef.current = getColWidth(ci); }}
                            className="csv-col-resize-handle"
                          />
                        </th>
                      );
                    })}
                    <th className="csv-th csv-th-add" style={{ height: ROW_HEIGHT }}>
                      <button onClick={addColumn} title="Add column" className="icon-button">
                        <Icon name="add" />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topSpace > 0 && <tr><td colSpan={headers.length + 2} style={{ height: topSpace, padding: 0 }} /></tr>}
                  {sortedWithIdx.slice(visStart, visEnd + 1).map(({ row, originalIdx }, i) => {
                    const ri = visStart + i;
                    const rowFullySel = isRowFullySelected(ri);
                    return (
                      <tr key={originalIdx} className="csv-row" style={{ height: ROW_HEIGHT }}>
                        <td className={`csv-td csv-td-rownum${rowFullySel ? " csv-td-rownum-selected" : ""}`}>
                          <div className="csv-rownum-cell">
                            <button onClick={(e) => selectRow(ri, e.shiftKey)} title="Click to select row · Shift+click to extend" className={`csv-rownum-button${rowFullySel ? " csv-rownum-button-selected" : ""}`}>
                              {ri + 1}
                            </button>
                            <button onClick={() => deleteRow(ri)} title="Delete row" className="csv-rownum-delete">
                              <Icon name="trash" />
                            </button>
                          </div>
                        </td>
                        {headers.map((_, ci) => {
                          if (hiddenCols.has(ci)) return null;
                          const key = `${ri},${ci}`;
                          const isPinned = pinnedCols.has(ci);
                          const isAnchor = selection?.anchor.row === ri && selection?.anchor.col === ci && !editingCell;
                          const isInSel = selBounds ? inBounds(ri, ci, selBounds) : false;
                          const isFill = fillPreviewRow !== null && selBounds ? ri > selBounds.maxRow && ri <= fillPreviewRow && ci >= selBounds.minCol && ci <= selBounds.maxCol : false;
                          const selStyle: "anchor" | "range" | "fill" | null = isFill ? "fill" : isAnchor ? "anchor" : isInSel ? "range" : null;
                          const isCurrentMatch = findMatches[safeIdx]?.row === ri && findMatches[safeIdx]?.col === ci;
                          const findHighlight: "current" | "match" | null = isCurrentMatch ? "current" : findMatchSet.has(key) ? "match" : null;
                          const showFillHandle = !!selBounds && ri === selBounds.maxRow && ci === selBounds.maxCol && !editingCell;
                          return (
                            <td
                              key={ci}
                              className={`csv-td${isPinned ? " csv-td-pinned" : ""}`}
                              style={isPinned ? { left: getPinnedLeft(ci) } : undefined}
                              onContextMenu={(e) => showCellMenu(e, ri, ci)}
                            >
                              <EditableCell
                                value={row[ci] ?? ""}
                                rowIdx={ri}
                                colIdx={ci}
                                selStyle={selStyle}
                                findHighlight={findHighlight}
                                isEditing={editingCell?.row === ri && editingCell?.col === ci}
                                draft={editDraft}
                                showFillHandle={showFillHandle}
                                onMouseDown={handleCellMouseDown}
                                onDoubleClick={(r, c) => startEdit(r, c)}
                                onMouseEnter={handleCellMouseEnter}
                                onDraftChange={setEditDraft}
                                onCommitAndMove={commitAndMove}
                                onCancel={cancelEdit}
                                onFillHandleMouseDown={handleFillHandleMouseDown}
                              />
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    );
                  })}
                  {botSpace > 0 && <tr><td colSpan={headers.length + 2} style={{ height: botSpace, padding: 0 }} /></tr>}
                </tbody>
              </table>
              <div className="csv-add-row-bar">
                <button onClick={addRow} className="csv-text-button">
                  <Icon name="add" /> Add row
                </button>
              </div>
            </div>
          )}

          {hasData && !editingCell && (
            <div className="csv-hint-bar">
              Arrows · Shift+Arrows select range · Ctrl+A all · Enter/F2 edit · Ctrl+C/X/V copy/cut/paste · Ctrl+Z/Y undo/redo · Ctrl+F find · Ctrl+S save · Right-click for more
            </div>
          )}
        </div>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}
