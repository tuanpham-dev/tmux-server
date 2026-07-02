import { useEffect, useState } from "react";
import type { MenuItem, SidebarMode, TmuxSession, TmuxWindow } from "../types";

interface Props {
  width: number;
  sessions: TmuxSession[];
  activeSessionName: string | null;
  onOpen: (name: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onCreate: (name?: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  sessionMenuItems: (name: string) => MenuItem[];
  windowMenuItems: (session: string, window: TmuxWindow) => MenuItem[];
  onOpenSettings: () => void;
  onCollapse: () => void;
}

export default function Sidebar({
  width,
  sessions,
  activeSessionName,
  onOpen,
  onOpenWindow,
  onCreate,
  onShowMenu,
  sessionMenuItems,
  windowMenuItems,
  onOpenSettings,
  onCollapse,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<SidebarMode>(
    () => (localStorage.getItem("sidebarMode") as SidebarMode) ?? "sessions",
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    localStorage.setItem("sidebarMode", mode);
  }, [mode]);

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submitCreate = () => {
    setCreating(false);
    onCreate(newName.trim() || undefined);
    setNewName("");
  };

  const chevron = (key: string) => (
    <span
      className="chevron"
      onClick={(e) => {
        e.stopPropagation();
        toggleCollapsed(key);
      }}
    >
      {collapsed.has(key) ? "▸" : "▾"}
    </span>
  );

  const windowRow = (s: TmuxSession, w: TmuxWindow, label: string, showCwd: boolean) => (
    <button
      key={`${s.name}:${w.index}`}
      className={`window-item${w.active ? " active-window" : ""}`}
      title={`${s.name}:${w.index} ${w.name} — ${w.cwd}${w.activity ? " (new output)" : ""}`}
      onClick={() => onOpenWindow(s.name, w.index)}
      onContextMenu={(e) => {
        e.preventDefault();
        onShowMenu(e.clientX, e.clientY, windowMenuItems(s.name, w));
      }}
    >
      {w.activity && <span className="activity-dot" />}
      <span className="window-label">{label}</span>
      {showCwd && <span className="item-cwd">{w.cwd}</span>}
    </button>
  );

  const sessionsTree = (
    <ul className="session-list">
      {sessions.map((s) => {
        const activeWin = s.windows.find((w) => w.active);
        return (
          <li key={s.name}>
            <button
              className={`session-item${s.name === activeSessionName ? " active" : ""}`}
              title={activeWin ? activeWin.cwd : s.name}
              onClick={() => onOpen(s.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                onShowMenu(e.clientX, e.clientY, sessionMenuItems(s.name));
              }}
            >
              {chevron(s.name)}
              <span className={`session-dot${s.attached > 0 ? " attached" : ""}`} />
              <span className="session-name">{s.name}</span>
              {activeWin && <span className="item-cwd">{activeWin.cwd}</span>}
            </button>
            {!collapsed.has(s.name) &&
              s.windows.map((w) => windowRow(s, w, `${w.index} ${w.name}`, true))}
          </li>
        );
      })}
      {sessions.length === 0 && <li className="session-empty">No tmux sessions</li>}
    </ul>
  );

  const dirGroups = new Map<string, { session: TmuxSession; window: TmuxWindow }[]>();
  for (const s of sessions) {
    for (const w of s.windows) {
      const group = dirGroups.get(w.cwd) ?? [];
      group.push({ session: s, window: w });
      dirGroups.set(w.cwd, group);
    }
  }

  const dirsTree = (
    <ul className="session-list">
      {[...dirGroups.keys()].sort().map((dir) => (
        <li key={dir}>
          <button
            className="session-item dir-item"
            title={dir}
            onClick={() => toggleCollapsed(dir)}
          >
            {chevron(dir)}
            <span className="session-name">{dir}</span>
          </button>
          {!collapsed.has(dir) &&
            dirGroups
              .get(dir)!
              .map(({ session, window }) =>
                windowRow(
                  session,
                  window,
                  `${session.name} · ${window.index} ${window.name}`,
                  false,
                ),
              )}
        </li>
      ))}
      {dirGroups.size === 0 && <li className="session-empty">No tmux sessions</li>}
    </ul>
  );

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">
          {mode === "sessions" ? "Sessions" : "Directories"}
        </span>
        <div className="sidebar-actions">
          <button
            className={`icon-button mode-button${mode === "sessions" ? " active" : ""}`}
            title="Group by session"
            onClick={() => setMode("sessions")}
          >
            ≣
          </button>
          <button
            className={`icon-button mode-button${mode === "dirs" ? " active" : ""}`}
            title="Group by directory"
            onClick={() => setMode("dirs")}
          >
            ▤
          </button>
          <button
            className="icon-button"
            title="New session"
            onClick={() => setCreating(true)}
          >
            +
          </button>
          <button className="icon-button" title="Settings" onClick={onOpenSettings}>
            ⚙
          </button>
          <button
            className="icon-button"
            title="Hide sidebar (Ctrl+B)"
            onClick={onCollapse}
          >
            «
          </button>
        </div>
      </div>
      {creating && (
        <input
          autoFocus
          className="new-session-input"
          placeholder="session name (blank = auto)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={submitCreate}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCreate();
            if (e.key === "Escape") {
              setCreating(false);
              setNewName("");
            }
          }}
        />
      )}
      {mode === "sessions" ? sessionsTree : dirsTree}
    </aside>
  );
}
