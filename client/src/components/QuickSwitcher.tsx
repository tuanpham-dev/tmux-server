import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { Tab, TmuxSession } from "../types";

interface Props {
  sessions: TmuxSession[];
  tabs: Tab[];
  filesRootDir: string | null;
  onActivateTab: (id: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onOpenSession: (name: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileSecondary: (path: string) => void;
  onClose: () => void;
}

interface Entry {
  key: string;
  label: string;
  group: "tab" | "window" | "session" | "file";
  // secondary is true for Shift+Enter/Shift+click. Only file entries branch
  // on it (see App.tsx's openFileOrViewerSecondary); tab/window/session
  // entries ignore the argument since they have no secondary action.
  run: (secondary: boolean) => void;
}

// Rendering unbounded fuzzy-matched results from a large repo would make
// typing feel laggy, so file matches are capped well below what a human
// scans through in a switcher anyway.
const MAX_FILE_MATCHES = 50;

// Subsequence match (VS Code Ctrl+P style): every query character must
// appear in the text in order, not necessarily contiguous, so "twsh" matches
// "tw-search:zsh".
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export default function QuickSwitcher({
  sessions,
  tabs,
  filesRootDir,
  onActivateTab,
  onOpenWindow,
  onOpenSession,
  onOpenFile,
  onOpenFileSecondary,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetched once when the switcher opens (the list is only as stale as that
  // moment, which is fine for a picker) rather than on every keystroke.
  useEffect(() => {
    if (!filesRootDir) return;
    setFilesLoading(true);
    api
      .listFiles(filesRootDir)
      .then((listing) => setFiles(listing.files))
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false));
  }, [filesRootDir]);

  // Group precedence (open tabs, then windows, then whole sessions) doubles
  // as the ranking: entries are built in that order and the filter is
  // stable, so it's preserved without extra scoring. Windows/sessions
  // already open as a tab are skipped — the tab entry above already reaches
  // them.
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const tab of tabs) {
      const virtualPath = tab.imagePath ?? tab.previewPath ?? tab.extViewerPath;
      const label =
        tab.extViewerTitle ??
        (virtualPath !== undefined
          ? virtualPath.slice(virtualPath.lastIndexOf("/") + 1)
          : tab.windowIndex === undefined
            ? tab.sessionName
            : `${tab.sessionName}:${
                sessions.find((s) => s.name === tab.sessionName)?.windows.find((w) => w.index === tab.windowIndex)
                  ?.name ?? `window ${tab.windowIndex}`
              }`);
      list.push({ key: `tab:${tab.id}`, label, group: "tab", run: () => onActivateTab(tab.id) });
    }
    for (const session of sessions) {
      for (const win of session.windows) {
        const alreadyOpen = tabs.some(
          (t) => t.sessionName === session.name && t.windowIndex === win.index,
        );
        if (alreadyOpen) continue;
        list.push({
          key: `window:${session.name}:${win.index}`,
          label: `${session.name}:${win.name}`,
          group: "window",
          run: () => onOpenWindow(session.name, win.index),
        });
      }
    }
    for (const session of sessions) {
      const alreadyOpen = tabs.some(
        (t) => t.sessionName === session.name && t.windowIndex === undefined,
      );
      if (alreadyOpen) continue;
      list.push({
        key: `session:${session.name}`,
        label: session.name,
        group: "session",
        run: () => onOpenSession(session.name),
      });
    }
    return list;
  }, [sessions, tabs, onActivateTab, onOpenWindow, onOpenSession]);

  // Files only show up once a query narrows them down — an empty query
  // would otherwise drown the tabs/windows/sessions list under thousands of
  // rows. Ranked after those groups and capped so a big repo can't make
  // rendering feel sluggish.
  const fileEntries = useMemo<Entry[]>(() => {
    if (!query || !filesRootDir) return [];
    const matched: Entry[] = [];
    for (const rel of files) {
      if (matched.length >= MAX_FILE_MATCHES) break;
      if (!fuzzyMatch(query, rel)) continue;
      matched.push({
        key: `file:${rel}`,
        label: rel,
        group: "file",
        run: (secondary) => (secondary ? onOpenFileSecondary : onOpenFile)(`${filesRootDir}/${rel}`),
      });
    }
    return matched;
  }, [files, query, filesRootDir, onOpenFile, onOpenFileSecondary]);

  const filtered = useMemo(
    () => [...entries.filter((e) => fuzzyMatch(query, e.label)), ...fileEntries],
    [entries, fileEntries, query],
  );

  const showFilesLoading = filesRootDir !== null && query.length > 0 && filesLoading;

  // Filtering can shrink the list out from under a selection made against a
  // longer one — clamp rather than let it point past the end.
  const clampedSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  useEffect(() => {
    listRef.current?.children[clampedSelected]?.scrollIntoView({ block: "nearest" });
  }, [clampedSelected]);

  const runEntry = (entry: Entry | undefined, secondary: boolean) => {
    if (!entry) return;
    onClose();
    entry.run(secondary);
  };

  return (
    <div className="quick-switcher-overlay" onMouseDown={onClose}>
      <div className="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-switcher-input"
          placeholder="Go to tab, window, or session…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runEntry(filtered[clampedSelected], e.shiftKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-switcher-list" ref={listRef}>
          {filtered.length === 0 && !showFilesLoading && (
            <div className="quick-switcher-empty">No matches</div>
          )}
          {filtered.map((entry, i) => (
            <div
              key={entry.key}
              className={`quick-switcher-item${i === clampedSelected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={(e) => runEntry(entry, e.shiftKey)}
            >
              <span className={`quick-switcher-tag quick-switcher-tag-${entry.group}`}>
                {entry.group}
              </span>
              <span className="quick-switcher-label">{entry.label}</span>
            </div>
          ))}
          {showFilesLoading && (
            <div className="quick-switcher-item quick-switcher-loading">loading files…</div>
          )}
        </div>
      </div>
    </div>
  );
}
