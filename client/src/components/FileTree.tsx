import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { FsEntry, GitFileStatus, MenuItem } from "../types";
import FileIcon from "./FileIcon";
import Icon from "./Icon";
import { getFileIconResult, getFolderIconResult, useIconThemeVersion } from "../utils/iconThemes";
import { isSecondaryClick } from "../utils/platform";


interface Props {
  rootDir: string | null;
  // Off = request listings with git=0, skipping the server's status scan
  // (badges and row colors disappear; the branch pill stays).
  showGitStatus: boolean;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  refreshKey: number;
  onOpenFile: (path: string) => void;
  onPreviewFile: (path: string) => void;
  // Registry-driven replacement for the old fileKinds.ts extension tables —
  // true if some registered extension viewer claims this path in "preview"
  // mode (see extensions.ts's findFileViewerFor), gating the hover icon.
  isPreviewable: (path: string) => boolean;
  onBranchChange: (branch: string | null) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  fileMenuItems: (path: string, isDir: boolean, rootDir: string) => MenuItem[];
  fileTreeRootMenuItems: (rootDir: string) => MenuItem[];
  fileMultiMenuItems: (entries: { path: string; isDir: boolean }[]) => MenuItem[];
  // Backs the Delete key, mirroring the same single/bulk split fileMenuItems'
  // and fileMultiMenuItems' own "Delete" items use.
  deleteFileEntry: (path: string, isDir: boolean) => void;
  deleteFileEntries: (entries: { path: string; isDir: boolean }[]) => void;
  prunePath: { paths: string[] } | null;
}

const GIT_STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
  ignored: "",
};

function GitStatusBadge({ status }: { status?: GitFileStatus }) {
  // "ignored" is conveyed by dimming the row alone; a badge letter would be
  // noise for something that's neither a change nor actionable.
  if (!status || status === "ignored") return null;
  return (
    <span className="file-tree-git-badge" title={status}>
      {GIT_STATUS_LABEL[status]}
    </span>
  );
}

interface DirState {
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
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
  gitStatus?: GitFileStatus;
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
  showGitStatus,
  onDropFiles,
  refreshKey,
  onOpenFile,
  onPreviewFile,
  isPreviewable,
  onBranchChange,
  onShowMenu,
  fileMenuItems,
  fileTreeRootMenuItems,
  fileMultiMenuItems,
  deleteFileEntry,
  deleteFileEntries,
  prunePath,
}: Props) {
  // Unused value — subscribing is enough to re-render on icon-theme change,
  // since getFileIconResult/getFolderIconResult read module state directly.
  useIconThemeVersion();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Roving-tabindex focus target; null falls back to the first visible row
  // (see effectiveFocusedPath below) so an empty tree never has a stuck ref.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // Fixed endpoint a Shift+click/Shift+Arrow range is measured from — does
  // NOT move on a shift-extend, only on a plain or Ctrl/Cmd click (or
  // keyboard move without Shift), matching VS Code Explorer.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const dragClearTimer = useRef<number | undefined>(undefined);
  const expandTimer = useRef<{ path: string; timer: number } | null>(null);
  const onBranchChangeRef = useRef(onBranchChange);
  onBranchChangeRef.current = onBranchChange;
  // Read at fetch-resolve time so a response that raced a root change (or
  // belongs to an expanded subfolder) can be told apart from the root's own.
  const rootDirRef = useRef(rootDir);
  rootDirRef.current = rootDir;
  // Tracks the last prunePath object already applied, so an unrelated
  // refreshKey bump (e.g. the 3s session poll) doesn't re-run the prune scan.
  const lastPrunedRef = useRef<{ paths: string[] } | null>(null);
  // Read at fetch time (fetchDir is mount-stable) so a toggle applies to
  // every fetch from then on without rebuilding the callback.
  const showGitStatusRef = useRef(showGitStatus);
  showGitStatusRef.current = showGitStatus;

  const fetchDir = useCallback((dirPath: string) => {
    setDirCache((prev) => {
      const next = new Map(prev);
      next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? [], loading: true, error: null });
      return next;
    });
    api
      .listDir(dirPath, showGitStatusRef.current)
      .then((listing) => {
        setDirCache((prev) => new Map(prev).set(dirPath, {
          entries: listing.entries,
          loading: false,
          error: null,
        }));
        // Only the root's own listing may set the branch. Every "/api/fs"
        // call reports a branch, but for an expanded subfolder that's *its*
        // repo — a nested repo under a non-git root would otherwise light up
        // the pill. It also drops stale responses from a just-replaced root.
        if (dirPath === rootDirRef.current) onBranchChangeRef.current(listing.branch);
      })
      .catch((err) => {
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
    onBranchChangeRef.current(null);
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

  // Git-status setting flipped: refetch everything currently visible so
  // badges/colors appear or clear immediately, not on the next refresh.
  const gitToggleMounted = useRef(false);
  useEffect(() => {
    if (!gitToggleMounted.current) {
      gitToggleMounted.current = true;
      return;
    }
    if (!rootDir) return;
    fetchDir(rootDir);
    for (const dirPath of expanded) fetchDir(dirPath);
    // Refetch only on the toggle itself — rootDir/expanded changes are
    // handled by the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGitStatus]);

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
  useEffect(() => {
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState);
    return () => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState);
      window.clearTimeout(dragClearTimer.current);
      cancelExpandTimer();
    };
  }, [clearDragState]);

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
        out.push({ path: entryPath, name: entry.name, isDir: entry.dir, depth, gitStatus: entry.gitStatus });
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
  // toggle-select branch below, since the two would otherwise collide (this
  // is also the Ctrl+Shift+click fallback for window managers, e.g. XFCE/
  // GNOME/KDE, that grab plain Alt+click globally for window dragging;
  // directories have no secondary action so this combo behaves like a plain
  // click for them, same as Alt+click does below). Then Ctrl/Cmd+click alone
  // always means toggle-select (even on mac, where Cmd is also the
  // secondary-click modifier elsewhere in the app — the tree reserves Cmd
  // for selection, matching the platform's own multi-select convention).
  // Then bare Shift+click: with nothing currently selected it's an even
  // simpler secondary-action shortcut (no modifier chord at all beyond
  // Shift) — and deliberately does NOT select the row, so selectedPaths
  // stays empty and the very next bare Shift+click (anywhere in the tree)
  // hits this same quick-peek path again, no Escape needed in between. Once
  // a selection exists, Shift+click reverts to its usual range-select
  // meaning, since at that point the user is clearly mid multi-select and a
  // stray Shift+click shouldn't hijack it into opening a preview instead.
  // Then Alt+click on a file row for the secondary action; otherwise the
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
    if (!isDir && e.altKey) {
      if (isPreviewable(name)) onPreviewFile(path);
      else onOpenFile(path);
      return;
    }
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

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    if (visibleRows.length === 0) return;
    const currentPath = effectiveFocusedPath;
    const idx = indexOf(currentPath);
    const row = idx !== -1 ? visibleRows[idx] : null;

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
        // of extending a range from a leftover anchor.
        if (selectedPaths.size === 0 && anchorPath === null) return;
        e.preventDefault();
        setSelectedPaths(new Set());
        setAnchorPath(null);
        return;
      case "Delete": {
        // Same single/bulk split the context menu uses: an active multi-
        // selection deletes all of it, otherwise just the focused row.
        const targets =
          selectedPaths.size > 0
            ? visibleRows.filter((r) => selectedPaths.has(r.path))
            : row
              ? [row]
              : [];
        if (targets.length === 0) return;
        e.preventDefault();
        if (targets.length === 1) deleteFileEntry(targets[0].path, targets[0].isDir);
        else deleteFileEntries(targets.map((t) => ({ path: t.path, isDir: t.isDir })));
        return;
      }
      default:
        return;
    }
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

  // Attached to a folder's wrapper div (not just its header row) so hovering
  // anywhere inside an expanded folder — including over its files — targets
  // that folder; a deeper nested folder's own handlers win via stopPropagation.
  const dragHandlers = (dirPath: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDragOverPath(dirPath);
      window.clearTimeout(dragClearTimer.current);
      dragClearTimer.current = window.setTimeout(clearHighlightOnly, DRAG_CLEAR_MS);
      if (dirPath !== rootDir) scheduleExpand(dirPath);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      clearDragState();
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
      const gitClass = entry.gitStatus ? ` git-status-${entry.gitStatus}` : "";
      const selectedClass = selectedPaths.has(entryPath) ? " selected" : "";
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
              className={`file-tree-row file-tree-dir${
                dragOverPath === entryPath ? " drag-over" : ""
              }${gitClass}${selectedClass}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={entryPath}
              onClick={(e) => handleRowClick(e, entryPath, true, entry.name)}
              onContextMenu={(e) => handleRowContextMenu(e, entryPath, true)}
            >
              <span className="chevron">
                <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
              </span>
              <FileIcon className="file-tree-folder-icon" result={folderIcon} />
              <span className="file-tree-name">{entry.name}</span>
              <GitStatusBadge status={entry.gitStatus} />
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
          className={`file-tree-row file-tree-file${gitClass}${selectedClass}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.name}
          onClick={(e) => handleRowClick(e, entryPath, false, entry.name)}
          onContextMenu={(e) => handleRowContextMenu(e, entryPath, false)}
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
            <GitStatusBadge status={entry.gitStatus} />
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
    >
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
