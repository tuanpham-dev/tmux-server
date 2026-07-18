import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { getContextGetter } from "../contextKeys";
import { getFileDecoration, useExtensionRegistryVersion, type FileDecoration } from "../extensions";
import { bindingMatches, recorderState, serializeEvent, type Keybinding } from "../keybindings";
import type { FsEntry, MenuItem } from "../types";
import FileIcon from "./FileIcon";
import Icon from "./Icon";
import { getFileIconResult, getFolderIconResult, useIconThemeVersion } from "../utils/iconThemes";
import { useMarqueeSelection } from "../hooks/useMarqueeSelection";
import { subscribePollTick } from "../lib/pollTick";


interface Props {
  rootDir: string | null;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  refreshKey: number;
  onOpenFile: (path: string) => void;
  onPreviewFile: (path: string) => void;
  // Registry-driven replacement for the old fileKinds.ts extension tables —
  // true if some registered extension viewer claims this path in "preview"
  // mode (see extensions.ts's findFileViewerFor), gating the hover icon.
  isPreviewable: (path: string) => boolean;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  fileMenuItems: (path: string, isDir: boolean, rootDir: string) => MenuItem[];
  fileTreeRootMenuItems: (rootDir: string) => MenuItem[];
  fileMultiMenuItems: (entries: { path: string; isDir: boolean }[]) => MenuItem[];
  // Backs the Delete key, mirroring the same single/bulk split fileMenuItems'
  // and fileMultiMenuItems' own "Delete" items use.
  deleteFileEntry: (path: string, isDir: boolean) => void;
  deleteFileEntries: (entries: { path: string; isDir: boolean }[]) => void;
  // Backs F2 (and the context menu's "Rename…"). Single-row only — see the F2
  // case in handleTreeKeyDown.
  renameFileEntry: (path: string) => void;
  // Backs files.findInFolder/newFile/newFolder/copyPath/copyRelativePath —
  // all otherwise reachable only from the context menu (useFileActions.ts).
  onFindInFolder: (path: string, rootDir: string) => void;
  onCreateFile: (dirPath: string) => void;
  onCreateFolder: (dirPath: string) => void;
  onCopyPath: (paths: string[]) => void;
  onCopyRelativePath: (paths: string[], rootDir: string) => void;
  // Live keybinding map (keybindings.ts's resolveBindings) — handleTreeKeyDown
  // dispatches every files.* command from this instead of hardcoded key
  // checks, so Settings → Keyboard Shortcuts rebinds apply without a remount.
  resolvedBindings: Record<string, Keybinding[]>;
  prunePath: { paths: string[] } | null;
  // Paths currently on the clipboard in "cut" mode (dimmed rows) — null when
  // the clipboard is empty or in "copy" mode. Backs Ctrl/Cmd+C/X/V, mirroring
  // the Delete key's single/bulk split.
  cutPaths: Set<string> | null;
  onCopyEntries: (paths: string[]) => void;
  onCutEntries: (paths: string[]) => void;
  onPasteInto: (destDir: string) => void;
  onClearClipboard: () => void;
  // Drag-and-drop within the tree: plain drag moves, Ctrl+drag copies (VS Code
  // Explorer's convention). Routes to a dedicated server endpoint, NOT through
  // the copy/cut clipboard above — a drag must leave a pending cut intact.
  onTransferEntries: (paths: string[], destDir: string, mode: "move" | "copy") => void;
}

// Marks a drag as originating from this tree (vs. an OS file drag, which the
// browser marks with the "Files" type). The dragged paths ride along as JSON,
// so a drag between two windows of the same server works too — but the payload
// is unreadable during "dragover" (only `types` is exposed until drop), which
// is why dragPathsRef mirrors it for the live validity/highlight checks.
const INTERNAL_DRAG_TYPE = "application/x-tmux-files";

// Distance from the tree's top/bottom edge at which a drag starts autoscrolling
// it, and how far each "dragover" pulse scrolls by.
const DRAG_SCROLL_EDGE_PX = 24;
const DRAG_SCROLL_STEP_PX = 12;

function DecorationBadge({ decoration }: { decoration?: FileDecoration }) {
  if (!decoration?.badge) return null;
  return (
    <span className="file-tree-git-badge" title={decoration.tooltip ?? decoration.badge}>
      {decoration.badge}
    </span>
  );
}

interface DirState {
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
}

// Same-length, same-order, same-fields comparison — the two responses being
// compared always come from the same "/api/fs" listing (server sorts
// deterministically), so this never needs to tolerate reordering.
function entriesEqual(a: FsEntry[], b: FsEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].dir !== b[i].dir) {
      return false;
    }
  }
  return true;
}

// One row in on-screen order — mirrors exactly what renderEntries below
// walks (dirCache + expanded), kept as a separate flat structure purely for
// keyboard navigation and range-selection math. renderEntries stays
// recursive and untouched: the nested per-folder wrapper divs it produces
// are load-bearing for drag-over targeting (stopPropagation lets a deeper
// hovered folder win over its ancestors), so this list is additive, not a
// replacement for how the tree actually renders.
interface VisibleRow {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

// The spec says "dragover" should fire on a roughly-350ms timer for as long
// as the pointer stays over a target, even without movement — but in
// practice many browser/OS combinations only fire it on actual pointer
// movement, so a perfectly still hover can go a full second or more between
// pulses. This has to stay comfortably longer than HOVER_EXPAND_MS: it only
// exists to clean up a truly stalled/abandoned drag, and must never be the
// thing that races the hover-to-expand timer and cancels it early.
const DRAG_CLEAR_MS = 1800;
// Time hovering a collapsed folder before it auto-expands, matching the
// common file-manager / VS Code Explorer drag-hover-to-expand convention.
const HOVER_EXPAND_MS = 1000;

export default function FileTree({
  rootDir,
  onDropFiles,
  refreshKey,
  onOpenFile,
  onPreviewFile,
  isPreviewable,
  onShowMenu,
  fileMenuItems,
  fileTreeRootMenuItems,
  fileMultiMenuItems,
  deleteFileEntry,
  deleteFileEntries,
  renameFileEntry,
  onFindInFolder,
  onCreateFile,
  onCreateFolder,
  onCopyPath,
  onCopyRelativePath,
  resolvedBindings,
  prunePath,
  cutPaths,
  onCopyEntries,
  onCutEntries,
  onPasteInto,
  onClearClipboard,
  onTransferEntries,
}: Props) {
  // Unused value — subscribing is enough to re-render on icon-theme change,
  // since getFileIconResult/getFolderIconResult read module state directly.
  useIconThemeVersion();
  // Same subscribe-only pattern for decoration providers: re-render when a
  // provider registers/unregisters or refresh()es its cached answers.
  useExtensionRegistryVersion();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Rows currently being dragged out of the tree — dims them for the duration
  // of the drag. The ref is the source of truth during the drag itself (the
  // DataTransfer payload can't be read on "dragover"); the state exists purely
  // to re-render the dimming.
  const dragPathsRef = useRef<string[] | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<Set<string> | null>(null);
  // Roving-tabindex focus target; null falls back to the first visible row
  // (see effectiveFocusedPath below) so an empty tree never has a stuck ref.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // Fixed endpoint a Shift+click/Shift+Arrow range is measured from — does
  // NOT move on a shift-extend, only on a plain or Ctrl/Cmd click (or
  // keyboard move without Shift), matching VS Code Explorer.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const treeContainerRef = useRef<HTMLDivElement>(null);
  // Selection snapshotted the instant a marquee drag arms, so an additive
  // (Ctrl/Cmd-held) drag unions with it and a canceled (Escape) drag can
  // restore it exactly — see useMarqueeSelection's onStart contract.
  const marqueeSnapshotRef = useRef<Set<string>>(new Set());
  const dragClearTimer = useRef<number | undefined>(undefined);
  const expandTimer = useRef<{ path: string; timer: number } | null>(null);
  // Read at fetch-resolve time so a response that raced a root change (or
  // belongs to an expanded subfolder) can be told apart from the root's own.
  const rootDirRef = useRef(rootDir);
  rootDirRef.current = rootDir;
  // Mirrors `expanded` for the poll-tick background refetch below, which
  // (like rootDirRef above) needs a mount-stable callback that still always
  // sees the live set without being rebuilt on every expand/collapse.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Tracks the last prunePath object already applied, so an unrelated
  // refreshKey bump (a mutation action — see the effect below) doesn't
  // re-run the prune scan twice for the same prune.
  const lastPrunedRef = useRef<{ paths: string[] } | null>(null);
  // Dedupes the poll-tick background refetch against a fetch already in
  // flight for the same dir (foreground callers — toggle, root change,
  // mutation refresh — always proceed regardless, since those must never
  // silently no-op a user action). A background fetch landing on a dir a
  // foreground caller is already fetching is harmless either way (idempotent
  // GET); this only trims the common case of the poll re-requesting a dir
  // its own previous tick is still waiting on.
  const inFlightDirsRef = useRef<Set<string>>(new Set());

  const fetchDir = useCallback((dirPath: string, opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    if (background && inFlightDirsRef.current.has(dirPath)) return;
    inFlightDirsRef.current.add(dirPath);
    if (!background) {
      setDirCache((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? [], loading: true, error: null });
        return next;
      });
    }
    api
      .listDir(dirPath)
      .then((listing) => {
        inFlightDirsRef.current.delete(dirPath);
        setDirCache((prev) => {
          const current = prev.get(dirPath);
          // Identical to what's already cached (common case for a
          // background poll tick with nothing actually changed) — keep the
          // same Map identity so nothing downstream re-renders over it.
          if (current && !current.loading && !current.error && entriesEqual(current.entries, listing.entries)) {
            return prev;
          }
          return new Map(prev).set(dirPath, { entries: listing.entries, loading: false, error: null });
        });
      })
      .catch((err) => {
        inFlightDirsRef.current.delete(dirPath);
        setDirCache((prev) => new Map(prev).set(dirPath, {
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
  }, []);

  // New root: forget prior expansion/cache/selection and load the root
  // listing fresh.
  useEffect(() => {
    setExpanded(new Set());
    setDirCache(new Map());
    setFocusedPath(null);
    setSelectedPaths(new Set());
    setAnchorPath(null);
    if (rootDir) fetchDir(rootDir);
  }, [rootDir, fetchDir]);

  // Bumped after an upload lands: refetch whatever is currently visible. A
  // delete/rename bumps refreshKey together with prunePath (same action, same
  // render), so pruning runs first and the fetch loop below never re-requests
  // the very path that was just removed.
  useEffect(() => {
    if (!rootDir) return;
    let liveExpanded = expanded;
    if (prunePath && prunePath !== lastPrunedRef.current) {
      lastPrunedRef.current = prunePath;
      const { paths: stalePaths } = prunePath;
      const isPruned = (p: string) => stalePaths.some((stale) => p === stale || p.startsWith(`${stale}/`));
      liveExpanded = new Set([...expanded].filter((p) => !isPruned(p)));
      if (liveExpanded.size !== expanded.size) setExpanded(liveExpanded);
      setDirCache((prev) => {
        const next = new Map([...prev].filter(([p]) => !isPruned(p)));
        return next.size === prev.size ? prev : next;
      });
      setSelectedPaths((prev) => {
        const next = new Set([...prev].filter((p) => !isPruned(p)));
        return next.size === prev.size ? prev : next;
      });
      setFocusedPath((prev) => (prev && isPruned(prev) ? null : prev));
      setAnchorPath((prev) => (prev && isPruned(prev) ? null : prev));
    }
    fetchDir(rootDir);
    for (const dirPath of liveExpanded) fetchDir(dirPath);
    // Only react to refreshKey/prunePath changes — rootDir/expanded changes
    // are already handled by their own effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, prunePath]);

  // Piggybacks on the 3s sessions poll (see lib/pollTick.ts) to keep git
  // badges live without a second timer — mirrors what refreshKey used to do
  // for this same tick before it moved off App state (see App.tsx's
  // onSessionsRefreshed). Reads rootDir/expanded via refs so this callback
  // stays mount-stable (registered once) while always seeing their current
  // values; background: true skips the loading flicker and keeps unchanged
  // responses from touching dirCache's identity (see fetchDir).
  const refetchVisibleBackground = useCallback(() => {
    const dir = rootDirRef.current;
    if (!dir) return;
    fetchDir(dir, { background: true });
    for (const dirPath of expandedRef.current) fetchDir(dirPath, { background: true });
  }, [fetchDir]);

  useEffect(() => subscribePollTick(refetchVisibleBackground), [refetchVisibleBackground]);

  const cancelExpandTimer = () => {
    if (expandTimer.current) {
      window.clearTimeout(expandTimer.current.timer);
      expandTimer.current = null;
    }
  };

  // Fires from the inactivity timeout only. Deliberately leaves the pending
  // expand timer alone: that heuristic ("no dragover pulse in a while") is
  // ambiguous between "the drag really ended" and "the pointer just hasn't
  // moved", and the expand timer is a real elapsed-time countdown that
  // doesn't need further pulses to keep ticking — killing it here would
  // cancel a legitimate hold-still hover right before it was due to fire.
  const clearHighlightOnly = useCallback(() => {
    setDragOverPath(null);
  }, []);

  // Clears the highlight and cancels both timers. Used only for definitive
  // "the drag is over" signals — an actual drop, or a pointer genuinely
  // leaving a target/the window — never for the inactivity fallback above.
  const clearDragState = useCallback(() => {
    window.clearTimeout(dragClearTimer.current);
    setDragOverPath(null);
    cancelExpandTimer();
  }, []);

  // Neither "dragend" nor "dragleave" reliably fires for a drag whose source
  // is outside the browser (a native OS file drag): "dragend" only targets
  // the drag's source node, which doesn't exist in our document, and
  // "dragleave" depends on the OS/browser still routing pointer events to us
  // right up to the moment the drag stops. A stalled drag (dropped elsewhere,
  // cancelled with Escape, dragged out of the window) just stops producing
  // "dragover" pulses — so a self-refreshing timeout is the one signal that
  // works in every case, with "dragend"/window "drop" kept as a faster clear
  // when the browser does happen to fire them.
  // Forgets what was being dragged *from* the tree. Deliberately separate from
  // clearDragState (which owns the drop-target highlight): dragging out of the
  // tree and back in fires "dragleave" → clearDragState, but the drag itself is
  // still very much alive, and dropping the source paths there would break both
  // the dimming and the drop-target validity checks that read them.
  const clearDragSource = useCallback(() => {
    dragPathsRef.current = null;
    setDraggingPaths(null);
  }, []);

  const endDrag = useCallback(() => {
    clearDragState();
    clearDragSource();
  }, [clearDragState, clearDragSource]);

  useEffect(() => {
    window.addEventListener("dragend", endDrag);
    window.addEventListener("drop", endDrag);
    return () => {
      window.removeEventListener("dragend", endDrag);
      window.removeEventListener("drop", endDrag);
      window.clearTimeout(dragClearTimer.current);
      cancelExpandTimer();
    };
  }, [endDrag]);

  const toggle = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        if (!dirCache.has(dirPath)) fetchDir(dirPath);
      }
      return next;
    });
  };

  // Same walk order as renderEntries below (dirCache entries, recursing into
  // expanded dirs) — kept in sync by construction since both read the same
  // dirCache/expanded state. A dir with an error or not-yet-fetched state
  // simply contributes no children, matching renderEntries' own early return.
  const visibleRows = useMemo(() => {
    const out: VisibleRow[] = [];
    const walk = (dirPath: string, depth: number) => {
      const state = dirCache.get(dirPath);
      if (!state || state.error) return;
      for (const entry of state.entries) {
        const entryPath = `${dirPath}/${entry.name}`;
        out.push({ path: entryPath, name: entry.name, isDir: entry.dir, depth });
        if (entry.dir && expanded.has(entryPath)) walk(entryPath, depth + 1);
      }
    };
    if (rootDir) walk(rootDir, 0);
    return out;
  }, [rootDir, dirCache, expanded]);

  // Falls back to the first row so an empty focusedPath (initial mount, or a
  // just-pruned focus target) still gives roving tabindex a real landing
  // spot instead of no row being reachable by Tab at all.
  const effectiveFocusedPath = focusedPath ?? visibleRows[0]?.path ?? null;
  const indexOf = (path: string | null) => (path ? visibleRows.findIndex((r) => r.path === path) : -1);

  // Imperative DOM focus (not just the roving-tabindex state) — the target
  // row already exists in the DOM for every caller of this function (see the
  // ArrowRight case below for the one case that deliberately avoids calling
  // it into not-yet-rendered children).
  const focusRow = (path: string) => {
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  };

  // Rubber-band drag-to-select: press in empty tree space (not on a row)
  // and drag over rows to select them. Ctrl/Cmd held at drag start makes it
  // additive (unions with whatever was selected when the drag armed);
  // otherwise it replaces the selection. See useMarqueeSelection's own
  // header comment for the shared mechanics (threshold, autoscroll,
  // Escape-cancel, click suppression).
  const { marqueeRect, onMarqueeMouseDown } = useMarqueeSelection({
    containerRef: treeContainerRef,
    getRows: () =>
      visibleRows.flatMap((row) => {
        const el = rowRefs.current.get(row.path);
        return el ? [{ id: row.path, el }] : [];
      }),
    onStart: () => {
      marqueeSnapshotRef.current = selectedPaths;
    },
    onMarquee: (ids, additive) => {
      setSelectedPaths(additive ? new Set([...marqueeSnapshotRef.current, ...ids]) : new Set(ids));
    },
    onEnd: (canceled, nearestId) => {
      if (canceled) {
        setSelectedPaths(marqueeSnapshotRef.current);
        return;
      }
      if (nearestId) {
        setAnchorPath(nearestId);
        focusRow(nearestId);
      }
    },
  });

  const selectRange = (fromPath: string, toPath: string) => {
    const from = indexOf(fromPath);
    const to = indexOf(toPath);
    if (from === -1 || to === -1) {
      setSelectedPaths(new Set([toPath]));
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelectedPaths(new Set(visibleRows.slice(lo, hi + 1).map((r) => r.path)));
  };

  // Shared by both row kinds (native <button> for dirs, div role="button"
  // for files). Checked in this order: Ctrl/Cmd+Shift+click on a file is the
  // secondary (preview) action — checked FIRST, ahead of the bare-Ctrl
  // toggle-select branch below, since the two would otherwise collide. It's
  // the escape hatch for opening the secondary action while a selection is
  // active, since bare Shift+click means range-select at that point
  // (directories have no secondary action so this combo behaves like a
  // plain click for them). Then Ctrl/Cmd+click alone always means
  // toggle-select (even on mac, where Cmd is also the secondary-click
  // modifier elsewhere in the app — the tree reserves Cmd for selection,
  // matching the platform's own multi-select convention). Then bare
  // Shift+click: with nothing currently selected it's the secondary-action
  // shortcut (same modifier as everywhere else in the app) — and
  // deliberately does NOT select the row, so selectedPaths stays empty and
  // the very next bare Shift+click (anywhere in the tree) hits this same
  // quick-peek path again, no Escape needed in between. Once a selection
  // exists, Shift+click reverts to its usual range-select meaning, since at
  // that point the user is clearly mid multi-select and a stray Shift+click
  // shouldn't hijack it into opening a preview instead (use Ctrl+Shift+click
  // above to open the secondary action mid-selection). Otherwise the
  // existing plain-click behavior (open a file, expand/collapse a dir).
  const handleRowClick = (e: React.MouseEvent, path: string, isDir: boolean, name: string) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const openSecondary = () => {
      setSelectedPaths(new Set([path]));
      setAnchorPath(path);
      focusRow(path);
      if (!isDir) {
        if (isPreviewable(name)) onPreviewFile(path);
        else onOpenFile(path);
      } else {
        toggle(path);
      }
    };
    if (!isDir && ctrlOrCmd && e.shiftKey) {
      openSecondary();
      return;
    }
    if (ctrlOrCmd) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchorPath(path);
      focusRow(path);
      return;
    }
    if (e.shiftKey) {
      if (selectedPaths.size === 0) {
        // Deliberately doesn't select the row — this is a quick-peek
        // shortcut, not a selection gesture. Leaving selectedPaths empty
        // means the very next bare Shift+click (on any row) hits this same
        // branch again, so it stays reusable without an Escape in between.
        focusRow(path);
        if (!isDir) {
          if (isPreviewable(name)) onPreviewFile(path);
          else onOpenFile(path);
        } else {
          toggle(path);
        }
        return;
      }
      selectRange(anchorPath ?? effectiveFocusedPath ?? path, path);
      focusRow(path);
      return;
    }
    setSelectedPaths(new Set([path]));
    setAnchorPath(path);
    focusRow(path);
    if (isDir) toggle(path);
    else onOpenFile(path);
  };

  // Right-clicking a row that's part of a live multi-selection (2+) shows
  // the bulk menu for the whole selection; right-clicking anything else
  // (an unselected row, or a lone selected row) collapses selection to just
  // that row first, matching VS Code Explorer's right-click behavior.
  const handleRowContextMenu = (e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (selectedPaths.has(path) && selectedPaths.size > 1) {
      const entries = visibleRows
        .filter((r) => selectedPaths.has(r.path))
        .map((r) => ({ path: r.path, isDir: r.isDir }));
      onShowMenu(e.clientX, e.clientY, fileMultiMenuItems(entries));
      return;
    }
    setSelectedPaths(new Set([path]));
    setAnchorPath(path);
    focusRow(path);
    onShowMenu(e.clientX, e.clientY, fileMenuItems(path, isDir, rootDir!));
  };

  // Shared by files.paste/newFile/newFolder dispatch below and by
  // handleTreePaste. Deliberately reads focusedPath, not effectiveFocusedPath:
  // that fallback exists for keyboard roving-tabindex, which needs *some*
  // landing row even after a click-to-deselect clears the visible selection —
  // but focusedPath itself is untouched by that click, so an operation right
  // after deselecting still correctly targets the folder last focused.
  // Falling through to visibleRows[0] instead would silently redirect to
  // whatever the first *visible* row happens to be (often a file, whose
  // parent is rootDir) any time nothing has ever been focused — rootDir is
  // the honest default for that case, and is exactly what's wanted right
  // after a click on empty tree space (which clears focusedPath below).
  const pasteDestDir = (): string | null => {
    const idx = indexOf(focusedPath);
    const r = idx !== -1 ? visibleRows[idx] : null;
    return r ? (r.isDir ? r.path : r.path.slice(0, r.path.lastIndexOf("/"))) : rootDir;
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    if (visibleRows.length === 0) return;
    if (!rootDir) return;
    const currentPath = effectiveFocusedPath;
    const idx = indexOf(currentPath);
    const row = idx !== -1 ? visibleRows[idx] : null;

    // Every files.* operation dispatches here, driven by the live keybinding
    // map (resolvedBindings) so a Settings → Keyboard Shortcuts rebind takes
    // effect without remounting the tree — mirrors TerminalView's
    // attachCustomKeyEventHandler dispatch for terminal.* commands. Bails
    // while the Keyboard Shortcuts recorder owns the keyboard, same as the
    // global dispatcher. Runs before the hardcoded navigation switch below:
    // arrows/Home/End/Enter/Space/Escape stay hardcoded list-widget behavior,
    // not file operations — same split VS Code makes.
    if (!recorderState.recording) {
      const combo = serializeEvent(e.nativeEvent);
      if (combo) {
        const get = getContextGetter(e.nativeEvent);
        const matches = (id: string) => bindingMatches(resolvedBindings[id], combo, get);
        const selectionOrFocused = () =>
          selectedPaths.size > 0 ? visibleRows.filter((r) => selectedPaths.has(r.path)) : row ? [row] : [];

        if (matches("files.copy")) {
          const targets = selectionOrFocused();
          if (targets.length > 0) {
            e.preventDefault();
            onCopyEntries(targets.map((t) => t.path));
            return;
          }
        }
        if (matches("files.cut")) {
          const targets = selectionOrFocused();
          if (targets.length > 0) {
            e.preventDefault();
            onCutEntries(targets.map((t) => t.path));
            return;
          }
        }
        if (matches("files.paste")) {
          // The default binding IS the browser's own paste gesture
          // (ctrl+KeyV / meta+KeyV) — that exact combo must fall through
          // un-prevented so the native "paste" event still fires (see
          // handleTreePaste below), the only path that can deliver OS-file
          // paste (a DataTransfer with real File objects). A combo the user
          // rebound onto files.paste has no such native event to defer to,
          // so it pastes the internal server-held clipboard directly —
          // rebinding paste away from Ctrl+V does not disable native Ctrl+V
          // paste, since that OS gesture carries OS-file paste too and the
          // "paste" event has no key info to filter on.
          if (combo !== "ctrl+KeyV" && combo !== "meta+KeyV") {
            e.preventDefault();
            const destDir = pasteDestDir();
            if (destDir) onPasteInto(destDir);
          }
          return;
        }
        if (matches("files.delete")) {
          const targets = selectionOrFocused();
          if (targets.length > 0) {
            e.preventDefault();
            if (targets.length === 1) deleteFileEntry(targets[0].path, targets[0].isDir);
            else deleteFileEntries(targets.map((t) => ({ path: t.path, isDir: t.isDir })));
            return;
          }
        }
        if (matches("files.rename")) {
          // No selection fallback, unlike copy/cut/delete above: a rename
          // prompts for one new name, meaningless across a multi-selection.
          // Acts on the focused row only, exactly as the context menu's
          // "Rename…" does (not offered for a multi-selection either).
          if (row) {
            e.preventDefault();
            renameFileEntry(row.path);
            return;
          }
        }
        if (matches("files.findInFolder")) {
          if (row) {
            e.preventDefault();
            const folder = row.isDir ? row.path : row.path.slice(0, row.path.lastIndexOf("/"));
            onFindInFolder(folder, rootDir);
            return;
          }
        }
        if (matches("files.newFile")) {
          e.preventDefault();
          const destDir = pasteDestDir();
          if (destDir) onCreateFile(destDir);
          return;
        }
        if (matches("files.newFolder")) {
          e.preventDefault();
          const destDir = pasteDestDir();
          if (destDir) onCreateFolder(destDir);
          return;
        }
        if (matches("files.copyPath")) {
          const targets = selectionOrFocused();
          if (targets.length > 0) {
            e.preventDefault();
            onCopyPath(targets.map((t) => t.path));
            return;
          }
        }
        if (matches("files.copyRelativePath")) {
          const targets = selectionOrFocused();
          if (targets.length > 0) {
            e.preventDefault();
            onCopyRelativePath(targets.map((t) => t.path), rootDir);
            return;
          }
        }
      }
    }

    const moveFocus = (newIdx: number, extendSelection: boolean) => {
      const clamped = Math.max(0, Math.min(visibleRows.length - 1, newIdx));
      const target = visibleRows[clamped];
      if (!target) return;
      if (extendSelection) {
        const anchor = anchorPath ?? currentPath ?? target.path;
        setAnchorPath(anchor);
        selectRange(anchor, target.path);
      } else {
        setSelectedPaths(new Set([target.path]));
        setAnchorPath(target.path);
      }
      focusRow(target.path);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(idx === -1 ? 0 : idx + 1, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(idx === -1 ? 0 : idx - 1, e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        moveFocus(0, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        moveFocus(visibleRows.length - 1, e.shiftKey);
        return;
      case "ArrowRight": {
        if (!row) return;
        e.preventDefault();
        if (!row.isDir) return;
        if (!expanded.has(row.path)) {
          toggle(row.path);
          return;
        }
        // Already expanded: move into its first child, if it has one loaded.
        const child = visibleRows[idx + 1];
        if (child && child.depth > row.depth) moveFocus(idx + 1, false);
        return;
      }
      case "ArrowLeft": {
        if (!row) return;
        e.preventDefault();
        if (row.isDir && expanded.has(row.path)) {
          toggle(row.path);
          return;
        }
        for (let i = idx - 1; i >= 0; i--) {
          if (visibleRows[i].depth < row.depth) {
            moveFocus(i, false);
            break;
          }
        }
        return;
      }
      case "Enter":
      case " ":
        if (!row) return;
        // Also suppresses a focused dir <button>'s own native Enter/Space
        // activation, which would otherwise double-toggle it via onClick.
        e.preventDefault();
        if (row.isDir) toggle(row.path);
        else onOpenFile(row.path);
        return;
      case "Escape":
        // Clears back to the "no selection" state so the next Shift+click
        // is free to act as the secondary (preview) shortcut again, instead
        // of extending a range from a leftover anchor. Also abandons a
        // pending cut (if any) — Escape is the conventional way to cancel a
        // cut/paste in a file manager.
        if (cutPaths) onClearClipboard();
        if (selectedPaths.size === 0 && anchorPath === null) return;
        e.preventDefault();
        setSelectedPaths(new Set());
        setAnchorPath(null);
        return;
      case "ContextMenu":
      case "F10": {
        // Keyboard path to the same menus handleRowContextMenu's mouse path
        // opens — anchored under the focused row's own rect instead of a
        // click point, same bulk-vs-single selection rule.
        if (!row) return;
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const rect = rowRefs.current.get(row.path)?.getBoundingClientRect();
        if (!rect) return;
        if (selectedPaths.has(row.path) && selectedPaths.size > 1) {
          const entries = visibleRows
            .filter((r) => selectedPaths.has(r.path))
            .map((r) => ({ path: r.path, isDir: r.isDir }));
          onShowMenu(rect.left + 8, rect.bottom, fileMultiMenuItems(entries));
          return;
        }
        onShowMenu(rect.left + 8, rect.bottom, fileMenuItems(row.path, row.isDir, rootDir!));
        return;
      }
      // Copy/Cut/Paste/Delete/Rename/Find in Folder/New File/New Folder/Copy
      // Path/Copy Relative Path all dispatch above, from the live
      // resolvedBindings map — not hardcoded here (see the block preceding
      // this switch).
      default:
        return;
    }
  };

  // The single entry point for Ctrl/Cmd+V — both OS-file paste (files
  // physically copied in the OS file manager, which the browser surfaces as
  // real File objects on clipboardData) and the internal server-side
  // clipboard route through here, so they can't double-fire against a
  // keydown handler for the same combo. clipboardData *is* a DataTransfer,
  // so the OS-file branch reuses the existing drop pipeline unchanged.
  const handleTreePaste = (e: React.ClipboardEvent) => {
    const destDir = pasteDestDir();
    if (!destDir) return;
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      onDropFiles(destDir, e.clipboardData);
      return;
    }
    e.preventDefault();
    onPasteInto(destDir);
  };

  // Called on every "dragover" pulse for a collapsed folder: the first pulse
  // for a given path arms a 1s timer; as long as the same folder keeps
  // getting hovered, later pulses are no-ops (the timer isn't restarted), so
  // it fires once, exactly 1s after the folder was first entered.
  const scheduleExpand = (dirPath: string) => {
    if (expanded.has(dirPath) || expandTimer.current?.path === dirPath) return;
    cancelExpandTimer();
    const timer = window.setTimeout(() => {
      setExpanded((prev) => new Set(prev).add(dirPath));
      fetchDir(dirPath);
      expandTimer.current = null;
    }, HOVER_EXPAND_MS);
    expandTimer.current = { path: dirPath, timer };
  };

  // Starts an internal drag. Mirrors handleRowContextMenu's selection rule: a
  // row inside a live multi-selection drags the whole selection; anything else
  // collapses the selection to itself first, so what's dragged is always what's
  // visibly selected.
  const handleRowDragStart = (e: React.DragEvent, path: string) => {
    let paths: string[];
    if (selectedPaths.has(path) && selectedPaths.size > 1) {
      paths = visibleRows.filter((r) => selectedPaths.has(r.path)).map((r) => r.path);
    } else {
      paths = [path];
      setSelectedPaths(new Set([path]));
      setAnchorPath(path);
    }
    // Drop anything nested under another dragged folder: moving/copying the
    // parent already carries its descendants, and transferring both would race
    // against a source path that no longer exists by the time its turn comes.
    paths = paths.filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)));
    dragPathsRef.current = paths;
    setDraggingPaths(new Set(paths));
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  // A drop target is invalid when it IS one of the dragged paths, or sits
  // inside one of the dragged folders — movePath/copyPath reject both anyway,
  // but catching it here means the browser paints a "no drop" cursor instead of
  // accepting a drop that can only fail.
  const isInvalidTarget = (dirPath: string, paths: string[]) =>
    paths.some((p) => dirPath === p || dirPath.startsWith(`${p}/`));

  // Autoscrolls the tree when a drag hovers near its top/bottom edge, so a drop
  // target scrolled out of view is still reachable without dropping first.
  const autoScrollOnDrag = (clientY: number) => {
    const el = treeContainerRef.current;
    if (!el) return;
    const { top, bottom } = el.getBoundingClientRect();
    if (clientY < top + DRAG_SCROLL_EDGE_PX) el.scrollTop -= DRAG_SCROLL_STEP_PX;
    else if (clientY > bottom - DRAG_SCROLL_EDGE_PX) el.scrollTop += DRAG_SCROLL_STEP_PX;
  };

  // Attached to a folder's wrapper div (not just its header row) so hovering
  // anywhere inside an expanded folder — including over its files — targets
  // that folder; a deeper nested folder's own handlers win via stopPropagation.
  // Handles both drag kinds: an OS file drag (always an upload/copy) and an
  // internal row drag (move, or copy with Ctrl held at drop time).
  const dragHandlers = (dirPath: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const internal = e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
      if (!internal && !e.dataTransfer.types.includes("Files")) return;
      // dragPathsRef is null for a drag from another window — nothing to
      // validate against locally, so the server has the final say (its own
      // movePath/copyPath guards reject a self-nesting drop).
      const dragged = dragPathsRef.current;
      if (internal && dragged && isInvalidTarget(dirPath, dragged)) {
        // stopPropagation, not a bare return: these handlers sit on nested
        // folder wrappers, so an un-stopped event keeps bubbling until some
        // *ancestor* folder accepts it — dropping a folder on its own child
        // would silently land in an ancestor instead of showing "no drop".
        // Swallowing it here means nothing calls preventDefault, which is what
        // makes the browser paint the not-allowed cursor and withhold the drop.
        e.stopPropagation();
        setDragOverPath(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Read live on every pulse, so pressing/releasing Ctrl mid-drag flips the
      // cursor between move and copy without the user restarting the drag.
      e.dataTransfer.dropEffect = internal ? (e.ctrlKey ? "copy" : "move") : "copy";
      setDragOverPath(dirPath);
      autoScrollOnDrag(e.clientY);
      window.clearTimeout(dragClearTimer.current);
      dragClearTimer.current = window.setTimeout(clearHighlightOnly, DRAG_CLEAR_MS);
      // Never auto-expand a folder that's being dragged: the isInvalidTarget
      // gate above already returns early for it, but this stands on its own so
      // a future change there can't quietly resurrect a source folder popping
      // open underneath its own drag.
      if (dirPath !== rootDir && !dragged?.includes(dirPath)) scheduleExpand(dirPath);
    },
    onDrop: (e: React.DragEvent) => {
      const internal = e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
      if (!internal && !e.dataTransfer.types.includes("Files")) return;
      // Mirrors the dragover gate above: an invalid target must not let the
      // drop bubble to an ancestor folder. In practice the browser won't even
      // fire a drop here (dragover refused it), but a stray one must not be
      // quietly rerouted upward.
      const draggedNow = dragPathsRef.current;
      if (internal && draggedNow && isInvalidTarget(dirPath, draggedNow)) {
        e.stopPropagation();
        endDrag();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (internal) {
        // getData is only readable now (not during dragover) and is what makes
        // a cross-window drag work; the ref is the same-window fallback.
        const raw = e.dataTransfer.getData(INTERNAL_DRAG_TYPE);
        let paths: string[] = dragPathsRef.current ?? [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) paths = parsed;
          } catch {
            // Malformed payload — fall back to the ref (same-window drag).
          }
        }
        const ctrl = e.ctrlKey;
        endDrag();
        if (paths.length === 0 || isInvalidTarget(dirPath, paths)) return;
        onTransferEntries(paths, dirPath, ctrl ? "copy" : "move");
        return;
      }
      endDrag();
      onDropFiles(dirPath, e.dataTransfer);
    },
  });

  const renderEntries = (dirPath: string, depth: number) => {
    const state = dirCache.get(dirPath);
    if (!state) return null;
    if (state.error) {
      return (
        <div className="file-tree-error" style={{ paddingLeft: 8 + depth * 14 }}>
          {state.error}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const entryPath = `${dirPath}/${entry.name}`;
      // Row decoration (git status badge/colors) comes entirely from
      // extension providers — see extensions.ts's file-decoration point.
      const decoration = getFileDecoration(entryPath, entry.dir);
      const gitClass = decoration?.className ? ` ${decoration.className}` : "";
      const selectedClass = selectedPaths.has(entryPath) ? " selected" : "";
      const cutClass = cutPaths?.has(entryPath) ? " cut" : "";
      const draggingClass = draggingPaths?.has(entryPath) ? " dragging" : "";
      const rowTabIndex = entryPath === effectiveFocusedPath ? 0 : -1;
      const setRowRef = (el: HTMLElement | null) => {
        if (el) rowRefs.current.set(entryPath, el);
        else rowRefs.current.delete(entryPath);
      };
      if (entry.dir) {
        const isExpanded = expanded.has(entryPath);
        const folderIcon = getFolderIconResult(entry.name, isExpanded);
        return (
          <div key={entryPath} {...dragHandlers(entryPath)}>
            <button
              ref={setRowRef}
              role="treeitem"
              aria-expanded={isExpanded}
              aria-level={depth + 1}
              aria-selected={selectedPaths.has(entryPath)}
              tabIndex={rowTabIndex}
              draggable
              className={`file-tree-row file-tree-dir${
                dragOverPath === entryPath ? " drag-over" : ""
              }${gitClass}${selectedClass}${cutClass}${draggingClass}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={entryPath}
              onClick={(e) => handleRowClick(e, entryPath, true, entry.name)}
              onContextMenu={(e) => handleRowContextMenu(e, entryPath, true)}
              onDragStart={(e) => handleRowDragStart(e, entryPath)}
              onDragEnd={endDrag}
            >
              <span className="chevron">
                <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
              </span>
              <FileIcon className="file-tree-folder-icon" result={folderIcon} />
              <span className="file-tree-name">{entry.name}</span>
              <DecorationBadge decoration={decoration} />
            </button>
            {isExpanded && renderEntries(entryPath, depth + 1)}
          </div>
        );
      }
      // A <div role="treeitem"> rather than a native <button> — the preview
      // button needs to nest inside the row (a <button> can't contain
      // another <button>), so the whole row's hover background stays one
      // continuous element instead of two siblings with a gap between them.
      // Same accessible-div-as-button pattern as .window-item in Sidebar.
      const fileIcon = getFileIconResult(entry.name);
      return (
        <div
          key={entryPath}
          ref={setRowRef}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selectedPaths.has(entryPath)}
          tabIndex={rowTabIndex}
          draggable
          className={`file-tree-row file-tree-file${gitClass}${selectedClass}${cutClass}${draggingClass}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.name}
          onClick={(e) => handleRowClick(e, entryPath, false, entry.name)}
          onContextMenu={(e) => handleRowContextMenu(e, entryPath, false)}
          onDragStart={(e) => handleRowDragStart(e, entryPath)}
          onDragEnd={endDrag}
        >
          <span className="chevron-spacer" />
          <FileIcon className="file-tree-file-icon" result={fileIcon} />
          <span className="file-tree-name">{entry.name}</span>

          {/* Single flex item so it's pushed right as one unit — putting
              margin-left:auto on both the button and the badge separately
              would split the leftover space between them instead of
              pinning the button flush against the badge. */}
          <span className="file-tree-row-trailer">
            {isPreviewable(entry.name) && (
              <button
                className="file-tree-preview-button"
                title="Preview"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreviewFile(entryPath);
                }}
              >
                <Icon name="preview" />
              </button>
            )}
            <DecorationBadge decoration={decoration} />
          </span>
        </div>
      );
    });
  };

  if (!rootDir) {
    return <div className="file-tree-empty">Open a session to browse its files</div>;
  }

  const rootState = dirCache.get(rootDir);

  return (
    <div
      ref={treeContainerRef}
      role="tree"
      className={`file-tree${dragOverPath === rootDir ? " drag-over" : ""}`}
      onDragOver={dragHandlers(rootDir).onDragOver}
      onDrop={dragHandlers(rootDir).onDrop}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) clearDragState();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onShowMenu(e.clientX, e.clientY, fileTreeRootMenuItems(rootDir));
      }}
      onKeyDown={handleTreeKeyDown}
      onPaste={handleTreePaste}
      // A paste event is only delivered to whatever holds DOM focus. Rows are
      // focusable but this container wasn't, so clicking empty tree space left
      // focus wherever it already was (typically the terminal) — and Ctrl+V
      // then pasted into *that*, never reaching handleTreePaste at all. There
      // was no way to paste into the root. -1 keeps it out of the Tab order
      // while letting it hold focus when clicked; keyboard nav is unaffected,
      // since handleTreeKeyDown already lives on this same element and an arrow
      // key moves focus into a real row via effectiveFocusedPath's fallback.
      tabIndex={-1}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".file-tree-row, button, input")) return;
        treeContainerRef.current?.focus();
        onMarqueeMouseDown(e);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setSelectedPaths(new Set());
          setAnchorPath(null);
          // Drop the focused row too, so a paste right after clicking empty
          // space targets the root (see handleTreePaste) rather than silently
          // going to whichever folder was last touched.
          setFocusedPath(null);
        }
      }}
    >
      {marqueeRect && (
        <div
          className="marquee-rect"
          style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
        />
      )}
      {rootState?.loading && !rootState.entries.length && (
        <div className="file-tree-empty">Loading…</div>
      )}
      {!rootState?.loading && rootState?.entries.length === 0 && (
        <div className="file-tree-empty">Empty directory</div>
      )}
      {renderEntries(rootDir, 0)}
    </div>
  );
}
