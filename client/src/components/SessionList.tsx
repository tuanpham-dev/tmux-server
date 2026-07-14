import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getContextGetter } from "../contextKeys";
import type { RegisteredWindowAction } from "../extensions";
import { useListNavigation } from "../hooks/useListNavigation";
import { bindingMatches, recorderState, serializeEvent, type Keybinding } from "../keybindings";
import { sessionRowsWithPins } from "../lib/sessions";
import type { MenuItem, PinnedSession, SidebarMode, TmuxSession, TmuxWindow } from "../types";
import Icon from "./Icon";

export interface SessionListHandle {
  // Reveals the "new session" inline input — called by Sidebar's header "+"
  // button, which owns expanding the accordion panel itself (that's
  // panelState, outside this component).
  startCreating: () => void;
  // Moves keyboard focus onto the focused-or-first row — called by
  // sessions.focus (see extensions.ts's sessionsFocusBridge) after the
  // caller has ensured the sidebar is visible, the Explorer tab is active,
  // and the SESSIONS panel isn't collapsed.
  focusList: () => void;
}

interface Props {
  mode: SidebarMode;
  sessions: TmuxSession[];
  activeSessionName: string | null;
  activeWindow: { sessionName: string; index: number } | null;
  pinnedSessions: PinnedSession[];
  onOpenAllWindows: (session: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onCreate: (name?: string) => void;
  onKillWindow: (session: string, index: number) => void;
  onKillSession: (name: string) => void;
  onRenameSession: (name: string) => void;
  onRenameWindow: (session: string, win: TmuxWindow) => void;
  onTogglePinSession: (name: string) => void;
  onNewWindowInSession: (session: string) => void;
  onNewWindowInDir: (cwd: string) => void;
  onRestorePinned: (name: string, cwd: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  sessionMenuItems: (name: string, dead: boolean) => MenuItem[];
  windowMenuItems: (session: string, win: TmuxWindow) => MenuItem[];
  extensionWindowActions: RegisteredWindowAction[];
  resolvedBindings: Record<string, Keybinding[]>;
}

// A single flattened, keyboard-navigable row — sessions mode nests window
// rows under their session; dirs mode nests them under their cwd group.
// `parentId` backs ArrowLeft on a window row (jump to its parent), which
// useListNavigation's generic onCollapse can't derive on its own since it
// has no notion of tree depth.
type Row =
  | { kind: "dead"; id: string; name: string; cwd: string }
  | { kind: "session"; id: string; session: TmuxSession; pinned: boolean }
  | { kind: "window"; id: string; session: TmuxSession; window: TmuxWindow; label: string; showCwd: boolean; parentId: string }
  | { kind: "dir"; id: string; dir: string };

const windowRowId = (sessionName: string, index: number) => `window:${sessionName}:${index}`;

// The sessions/dirs trees + window rows extracted from Sidebar.tsx, plus
// roving-tabindex keyboard navigation (useListNavigation), rebindable
// sessions.* operation shortcuts, and menu-key context menus — see
// plans/keyboard-nav-context-menus-sessions-search-git.md.
const SessionList = forwardRef<SessionListHandle, Props>(function SessionList(
  {
    mode,
    sessions,
    activeSessionName,
    activeWindow,
    pinnedSessions,
    onOpenAllWindows,
    onOpenWindow,
    onCreate,
    onKillWindow,
    onKillSession,
    onRenameSession,
    onRenameWindow,
    onTogglePinSession,
    onNewWindowInSession,
    onNewWindowInDir,
    onRestorePinned,
    onShowMenu,
    sessionMenuItems,
    windowMenuItems,
    extensionWindowActions,
    resolvedBindings,
  },
  ref,
) {
  const [collapsedWindows, setCollapsedWindows] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleWindowCollapsed = (key: string) => {
    setCollapsedWindows((prev) => {
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

  const sessionRows = sessionRowsWithPins(sessions, pinnedSessions);

  const dirGroups = useMemo(() => {
    const groups = new Map<string, { session: TmuxSession; window: TmuxWindow }[]>();
    for (const s of sessions) {
      for (const w of s.windows) {
        const group = groups.get(w.cwd) ?? [];
        group.push({ session: s, window: w });
        groups.set(w.cwd, group);
      }
    }
    return groups;
  }, [sessions]);

  // Flattened in the exact visual order sessionsTree/dirsTree render below —
  // kept in sync by construction since both this and the JSX walk the same
  // sessionRows/dirGroups/collapsedWindows.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (mode === "sessions") {
      for (const row of sessionRows) {
        if (row.dead) {
          out.push({ kind: "dead", id: `dead:${row.name}`, name: row.name, cwd: row.cwd });
          continue;
        }
        const s = row.session;
        const sessionId = `session:${s.name}`;
        out.push({ kind: "session", id: sessionId, session: s, pinned: row.pinned });
        if (!collapsedWindows.has(s.name)) {
          for (const w of s.windows) {
            out.push({
              kind: "window",
              id: windowRowId(s.name, w.index),
              session: s,
              window: w,
              label: `${w.index} ${w.name}`,
              showCwd: true,
              parentId: sessionId,
            });
          }
        }
      }
    } else {
      for (const dir of [...dirGroups.keys()].sort()) {
        const dirId = `dir:${dir}`;
        out.push({ kind: "dir", id: dirId, dir });
        if (!collapsedWindows.has(dir)) {
          for (const { session: s, window: w } of dirGroups.get(dir)!) {
            out.push({
              kind: "window",
              id: windowRowId(s.name, w.index),
              session: s,
              window: w,
              label: `${s.name} · ${w.index} ${w.name}`,
              showCwd: false,
              parentId: dirId,
            });
          }
        }
      }
    }
    return out;
  }, [mode, sessionRows, dirGroups, collapsedWindows]);

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  // Set right after useListNavigation below (same render) — lets onCollapse
  // move focus to a window row's parent without a circular reference to the
  // hook it's passed into, same ref-indirection useGlobalKeybindings uses
  // for globalCommandsRef.
  const focusRowRef = useRef<(id: string) => void>(() => {});

  const onActivate = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "dead") onRestorePinned(row.name, row.cwd);
      else if (row.kind === "session") onOpenAllWindows(row.session.name);
      else if (row.kind === "window") onOpenWindow(row.session.name, row.window.index);
      else toggleWindowCollapsed(row.dir);
    },
    [rowsById, onRestorePinned, onOpenAllWindows, onOpenWindow],
  );

  const onExpand = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "session" && collapsedWindows.has(row.session.name)) {
        toggleWindowCollapsed(row.session.name);
      } else if (row.kind === "dir" && collapsedWindows.has(row.dir)) {
        toggleWindowCollapsed(row.dir);
      }
    },
    [rowsById, collapsedWindows],
  );

  const onCollapse = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "session" && !collapsedWindows.has(row.session.name)) {
        toggleWindowCollapsed(row.session.name);
      } else if (row.kind === "dir" && !collapsedWindows.has(row.dir)) {
        toggleWindowCollapsed(row.dir);
      } else if (row.kind === "window") {
        focusRowRef.current(row.parentId);
      }
    },
    [rowsById, collapsedWindows],
  );

  const onContextMenuKey = useCallback(
    (id: string, rect: DOMRect) => {
      const row = rowsById.get(id);
      if (!row) return;
      const items =
        row.kind === "dead"
          ? sessionMenuItems(row.name, true)
          : row.kind === "session"
            ? sessionMenuItems(row.session.name, false)
            : row.kind === "window"
              ? windowMenuItems(row.session.name, row.window)
              : null;
      if (items) onShowMenu(rect.left + 8, rect.bottom, items);
    },
    [rowsById, sessionMenuItems, windowMenuItems, onShowMenu],
  );

  const nav = useListNavigation({
    rowIds,
    onActivate,
    onExpand,
    onCollapse,
    onContextMenuKey,
  });
  focusRowRef.current = nav.focusRow;

  useImperativeHandle(
    ref,
    () => ({
      startCreating: () => setCreating(true),
      focusList: () => {
        const target = nav.focusedId ?? rowIds[0];
        if (target) nav.focusRow(target);
      },
    }),
    [nav, rowIds],
  );

  // sessions.* operation commands (rebindable) — dispatched here, ahead of
  // the hook's own onKeyDown, exactly the split FileTree.tsx uses for
  // files.*: list-widget keys (arrows/Enter/Space, handled by
  // useListNavigation below) stay hardcoded, operations go through the live
  // resolvedBindings map so a Settings rebind takes effect without a
  // remount.
  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (!recorderState.recording) {
      const combo = serializeEvent(e.nativeEvent);
      if (combo) {
        const get = getContextGetter(e.nativeEvent);
        const matches = (id: string) => bindingMatches(resolvedBindings[id], combo, get);
        const row = nav.focusedId ? rowsById.get(nav.focusedId) : undefined;

        if (row && matches("sessions.kill")) {
          e.preventDefault();
          if (row.kind === "window") onKillWindow(row.session.name, row.window.index);
          else if (row.kind === "session") onKillSession(row.session.name);
          return;
        }
        if (row && matches("sessions.rename")) {
          e.preventDefault();
          if (row.kind === "window") onRenameWindow(row.session.name, row.window);
          else if (row.kind === "session") onRenameSession(row.session.name);
          return;
        }
        if (row && matches("sessions.newWindow")) {
          const sessionName = row.kind === "window" || row.kind === "session" ? row.session.name : null;
          if (sessionName) {
            e.preventDefault();
            onNewWindowInSession(sessionName);
            return;
          }
        }
        if (row && matches("sessions.togglePin")) {
          const sessionName = row.kind === "window" || row.kind === "session" ? row.session.name : null;
          if (sessionName) {
            e.preventDefault();
            onTogglePinSession(sessionName);
            return;
          }
        }
      }
    }
    nav.onKeyDown(e);
  };

  const chevron = (key: string) => (
    <span
      className="chevron"
      onClick={(e) => {
        e.stopPropagation();
        toggleWindowCollapsed(key);
      }}
    >
      <Icon name={collapsedWindows.has(key) ? "chevron-right" : "chevron-down"} />
    </span>
  );

  const renderWindowRow = (row: Extract<Row, { kind: "window" }>) => {
    const { session: s, window: w, label, showCwd } = row;
    const isActive =
      activeWindow !== null
        ? activeWindow.sessionName === s.name && activeWindow.index === w.index
        : w.active;
    const rowProps = nav.getRowProps(row.id);
    return (
      <div
        key={row.id}
        role="button"
        className={`window-item${isActive ? " active-window" : ""}`}
        title={`${s.name}:${w.index} ${w.name} — ${w.cwd}${w.activity ? " (new output)" : ""}`}
        onClick={() => onOpenWindow(s.name, w.index)}
        onContextMenu={(e) => {
          e.preventDefault();
          nav.focusRow(row.id);
          onShowMenu(e.clientX, e.clientY, windowMenuItems(s.name, w));
        }}
        tabIndex={rowProps.tabIndex}
        ref={rowProps.ref}
        onFocus={rowProps.onFocus}
      >
        {w.activity && <span className="activity-dot" />}
        <span className="window-label">{label}</span>
        {showCwd && <span className="item-cwd">{w.cwd}</span>}
        {extensionWindowActions
          .filter((action) =>
            action.isVisible({ sessionName: s.name, windowIndex: w.index, cwd: w.cwd, command: w.command }),
          )
          .map((action) => (
            <button
              key={action.id}
              className="window-action-button"
              title={action.title}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick({ sessionName: s.name, windowIndex: w.index, cwd: w.cwd, command: w.command });
              }}
            >
              <Icon name={action.icon} />
            </button>
          ))}
        <button
          className="window-kill-button"
          title="Kill window"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onKillWindow(s.name, w.index);
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    );
  };

  const sessionsTree = (
    <ul className="session-list-ul">
      {sessionRows.map((row) => {
        if (row.dead) {
          const id = `dead:${row.name}`;
          const rowProps = nav.getRowProps(id);
          return (
            <li key={id}>
              <div className="session-row">
                <button
                  className="session-item dead-session-item"
                  title={`${row.cwd} (not running — click to restore)`}
                  onClick={() => onRestorePinned(row.name, row.cwd)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    nav.focusRow(id);
                    onShowMenu(e.clientX, e.clientY, sessionMenuItems(row.name, true));
                  }}
                  tabIndex={rowProps.tabIndex}
                  ref={rowProps.ref}
                  onFocus={rowProps.onFocus}
                >
                  <Icon name="pinned" className="pin-indicator" />
                  <span className="session-name">{row.name}</span>
                  <span className="item-cwd">{row.cwd}</span>
                </button>
                <button
                  className="row-add-button"
                  title="New window"
                  tabIndex={-1}
                  onClick={() => onRestorePinned(row.name, row.cwd)}
                >
                  <Icon name="add" />
                </button>
              </div>
            </li>
          );
        }
        const s = row.session;
        const activeWin = s.windows.find((w) => w.active);
        const id = `session:${s.name}`;
        const rowProps = nav.getRowProps(id);
        return (
          <li key={s.name}>
            <div className={`session-row${s.name === activeSessionName ? " active" : ""}`}>
              <button
                className={`session-item${s.name === activeSessionName ? " active" : ""}`}
                title={activeWin ? activeWin.cwd : s.name}
                onClick={() => onOpenAllWindows(s.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  nav.focusRow(id);
                  onShowMenu(e.clientX, e.clientY, sessionMenuItems(s.name, false));
                }}
                tabIndex={rowProps.tabIndex}
                ref={rowProps.ref}
                onFocus={rowProps.onFocus}
              >
                {chevron(s.name)}
                <span className={`session-dot${s.attached > 0 ? " attached" : ""}`} />
                {row.pinned && <Icon name="pinned" className="pin-indicator" />}
                <span className="session-name">{s.name}</span>
                {activeWin && <span className="item-cwd">{activeWin.cwd}</span>}
              </button>
              <button
                className="row-add-button"
                title="New window"
                tabIndex={-1}
                onClick={() => onNewWindowInSession(s.name)}
              >
                <Icon name="add" />
              </button>
            </div>
            {!collapsedWindows.has(s.name) &&
              s.windows.map((w) => renderWindowRow({ kind: "window", id: windowRowId(s.name, w.index), session: s, window: w, label: `${w.index} ${w.name}`, showCwd: true, parentId: id }))}
          </li>
        );
      })}
      {sessionRows.length === 0 && <li className="session-empty">No tmux sessions</li>}
    </ul>
  );

  const dirsTree = (
    <ul className="session-list-ul">
      {[...dirGroups.keys()].sort().map((dir) => {
        const dirId = `dir:${dir}`;
        const rowProps = nav.getRowProps(dirId);
        return (
          <li key={dir}>
            <div className="session-row">
              <button
                className="session-item dir-item"
                title={dir}
                onClick={() => toggleWindowCollapsed(dir)}
                tabIndex={rowProps.tabIndex}
                ref={rowProps.ref}
                onFocus={rowProps.onFocus}
              >
                {chevron(dir)}
                <span className="session-name">{dir}</span>
              </button>
              <button
                className="row-add-button"
                title="New window in current session"
                tabIndex={-1}
                onClick={() => onNewWindowInDir(dir)}
              >
                <Icon name="add" />
              </button>
            </div>
            {!collapsedWindows.has(dir) &&
              dirGroups
                .get(dir)!
                .map(({ session, window }) =>
                  renderWindowRow({
                    kind: "window",
                    id: windowRowId(session.name, window.index),
                    session,
                    window,
                    label: `${session.name} · ${window.index} ${window.name}`,
                    showCwd: false,
                    parentId: dirId,
                  }),
                )}
          </li>
        );
      })}
      {dirGroups.size === 0 && <li className="session-empty">No tmux sessions</li>}
    </ul>
  );

  return (
    <div className="session-list" ref={containerRef} onKeyDown={handleKeyDown}>
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
    </div>
  );
});

export default SessionList;
