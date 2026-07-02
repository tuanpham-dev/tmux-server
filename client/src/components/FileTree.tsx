import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { FsEntry, GitFileStatus } from "../types";

interface Props {
  rootDir: string | null;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  refreshKey: number;
  onOpenFile: (path: string) => void;
  onBranchChange: (branch: string | null) => void;
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
  onBranchChange,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const dragClearTimer = useRef<number | undefined>(undefined);
  const expandTimer = useRef<{ path: string; timer: number } | null>(null);
  const onBranchChangeRef = useRef(onBranchChange);
  onBranchChangeRef.current = onBranchChange;

  const fetchDir = useCallback((dirPath: string) => {
    setDirCache((prev) => {
      const next = new Map(prev);
      next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? [], loading: true, error: null });
      return next;
    });
    api
      .listDir(dirPath)
      .then((listing) => {
        setDirCache((prev) => new Map(prev).set(dirPath, {
          entries: listing.entries,
          loading: false,
          error: null,
        }));
        // Every "/api/fs" call reports the whole repo's branch, regardless
        // of which directory was fetched, so any of them can update it.
        onBranchChangeRef.current(listing.branch);
      })
      .catch((err) => {
        setDirCache((prev) => new Map(prev).set(dirPath, {
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
  }, []);

  // New root: forget prior expansion/cache and load the root listing fresh.
  useEffect(() => {
    setExpanded(new Set());
    setDirCache(new Map());
    onBranchChangeRef.current(null);
    if (rootDir) fetchDir(rootDir);
  }, [rootDir, fetchDir]);

  // Bumped after an upload lands: refetch whatever is currently visible.
  useEffect(() => {
    if (!rootDir) return;
    fetchDir(rootDir);
    for (const dirPath of expanded) fetchDir(dirPath);
    // Only react to refreshKey changes — rootDir/expanded changes are
    // already handled by their own effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

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
      if (entry.dir) {
        const isExpanded = expanded.has(entryPath);
        return (
          <div key={entryPath} {...dragHandlers(entryPath)}>
            <button
              className={`file-tree-row file-tree-dir${
                dragOverPath === entryPath ? " drag-over" : ""
              }${gitClass}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={entryPath}
              onClick={() => toggle(entryPath)}
            >
              <span className="chevron">{isExpanded ? "▾" : "▸"}</span>
              <span className="file-tree-name">{entry.name}</span>
              <GitStatusBadge status={entry.gitStatus} />
            </button>
            {isExpanded && renderEntries(entryPath, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={entryPath}
          className={`file-tree-row file-tree-file${gitClass}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.name}
          onClick={() => onOpenFile(entryPath)}
        >
          <span className="file-tree-name">{entry.name}</span>
          <GitStatusBadge status={entry.gitStatus} />
        </button>
      );
    });
  };

  if (!rootDir) {
    return <div className="file-tree-empty">Open a session to browse its files</div>;
  }

  const rootState = dirCache.get(rootDir);

  return (
    <div
      className={`file-tree${dragOverPath === rootDir ? " drag-over" : ""}`}
      onDragOver={dragHandlers(rootDir).onDragOver}
      onDrop={dragHandlers(rootDir).onDrop}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) clearDragState();
      }}
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
