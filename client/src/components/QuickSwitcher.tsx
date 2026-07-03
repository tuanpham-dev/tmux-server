import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab, TmuxSession } from "../types";

interface Props {
  sessions: TmuxSession[];
  tabs: Tab[];
  onActivateTab: (id: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onOpenSession: (name: string) => void;
  onClose: () => void;
}

interface Entry {
  key: string;
  label: string;
  group: "tab" | "window" | "session";
  run: () => void;
}

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
  onActivateTab,
  onOpenWindow,
  onOpenSession,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Group precedence (open tabs, then windows, then whole sessions) doubles
  // as the ranking: entries are built in that order and the filter is
  // stable, so it's preserved without extra scoring. Windows/sessions
  // already open as a tab are skipped — the tab entry above already reaches
  // them.
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const tab of tabs) {
      const label =
        tab.imagePath !== undefined
          ? tab.imagePath.slice(tab.imagePath.lastIndexOf("/") + 1)
          : tab.windowIndex === undefined
            ? tab.sessionName
            : `${tab.sessionName}:${
                sessions.find((s) => s.name === tab.sessionName)?.windows.find((w) => w.index === tab.windowIndex)
                  ?.name ?? `window ${tab.windowIndex}`
              }`;
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

  const filtered = useMemo(
    () => entries.filter((e) => fuzzyMatch(query, e.label)),
    [entries, query],
  );

  // Filtering can shrink the list out from under a selection made against a
  // longer one — clamp rather than let it point past the end.
  const clampedSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  useEffect(() => {
    listRef.current?.children[clampedSelected]?.scrollIntoView({ block: "nearest" });
  }, [clampedSelected]);

  const runEntry = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
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
              runEntry(filtered[clampedSelected]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-switcher-list" ref={listRef}>
          {filtered.length === 0 && <div className="quick-switcher-empty">No matches</div>}
          {filtered.map((entry, i) => (
            <div
              key={entry.key}
              className={`quick-switcher-item${i === clampedSelected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runEntry(entry)}
            >
              <span className={`quick-switcher-tag quick-switcher-tag-${entry.group}`}>
                {entry.group}
              </span>
              <span className="quick-switcher-label">{entry.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
