import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getContextGetter } from "../contextKeys";
import { getWindowDecorations, useExtensionRegistryVersion } from "../extensions";
import type { RegisteredWindowAction } from "../extensions";
import { useGitRootDirs } from "../hooks/useGitRootDir";
import { useListNavigation } from "../hooks/useListNavigation";
import { useLongPressMenu } from "../hooks/useLongPressMenu";
import { bindingMatches, recorderState, serializeEvent, type Keybinding } from "../keybindings";
import { projectName, projectRows } from "../lib/projects";
import type { MenuItem, Project, TmuxSession, TmuxWindow } from "../types";
import Icon from "./Icon";

export interface ProjectListHandle {
  // Moves keyboard focus onto the focused-or-first row — called by
  // projects.focus (see extensions.ts's projectsFocusBridge) after the
  // caller has ensured the sidebar is visible, the Explorer tab is active,
  // and the PROJECTS panel isn't collapsed.
  focusList: () => void;
}

interface Props {
  sessions: TmuxSession[];
  activeSessionName: string | null;
  activeWindow: { sessionName: string; index: number } | null;
  projects: Project[];
  onOpenAllWindows: (session: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onKillWindow: (session: string, index: number) => void;
  onKillSession: (name: string) => void;
  onRenameWindow: (session: string, win: TmuxWindow) => void;
  onTogglePinSession: (name: string) => void;
  onNewWindowInSession: (session: string) => void;
  // Opens (or creates, for a dead pinned project) the session rooted in this
  // folder — see useSessionActions' openProject. Live project rows route
  // their click here too: it focuses the most-recent terminal.
  onOpenProject: (cwd: string) => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  sessionMenuItems: (name: string) => MenuItem[];
  deadProjectMenuItems: (cwd: string) => MenuItem[];
  windowMenuItems: (session: string, win: TmuxWindow) => MenuItem[];
  extensionWindowActions: RegisteredWindowAction[];
  resolvedBindings: Record<string, Keybinding[]>;
}

// A single flattened, keyboard-navigable row: live projects (their primary
// session plus any same-folder extras, merged) nest their terminal rows —
// one per tmux window across all of the project's sessions; a dead row is a
// pinned project with no live session rooted in its folder. `parentId`
// backs ArrowLeft on a terminal row (jump to its parent), which
// useListNavigation's generic onCollapse can't derive on its own since it
// has no notion of tree depth.
type Row =
  | { kind: "dead"; id: string; cwd: string }
  | { kind: "project"; id: string; session: TmuxSession; extraSessions: TmuxSession[]; pinned: boolean }
  | { kind: "window"; id: string; session: TmuxSession; window: TmuxWindow; parentId: string };

const windowRowId = (sessionName: string, index: number) => `window:${sessionName}:${index}`;
// Keyed by folder for pathed projects (stable across session renames), by
// session name for pathless ones — a path always starts with "/" or "~", so
// the two namespaces can't collide.
const projectRowId = (session: TmuxSession) => `project:${session.path || session.name}`;

// The PROJECTS panel's tree (live projects + dead pinned projects), plus
// roving-tabindex keyboard navigation (useListNavigation), rebindable
// projects.* operation shortcuts, and menu-key context menus — see
// plans/projects-not-sessions.md and plans/project-first-ui.md.
const ProjectList = forwardRef<ProjectListHandle, Props>(function ProjectList(
  {
    sessions,
    activeSessionName,
    activeWindow,
    projects,
    onOpenAllWindows,
    onOpenWindow,
    onKillWindow,
    onKillSession,
    onRenameWindow,
    onTogglePinSession,
    onNewWindowInSession,
    onOpenProject,
    onShowMenu,
    sessionMenuItems,
    deadProjectMenuItems,
    windowMenuItems,
    extensionWindowActions,
    resolvedBindings,
  },
  ref,
) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  // Touch/pen long-press → the same context menu right-click opens.
  const bindMenu = useLongPressMenu();
  // Re-render when a session-decoration provider registers or refresh()es —
  // getWindowDecorations below reads the registry imperatively per row.
  useExtensionRegistryVersion();

  const toggleProjectCollapsed = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const listRows = projectRows(sessions, projects);

  // Terminal rows show each window's cwd collapsed to its git repo root
  // (matching the FILES panel), falling back to the live cwd for windows not
  // inside a repo. rootOf resolves via a shared cache; the actual w.cwd is
  // still what's passed to extension decoration/action contexts below, which
  // must decorate the real path, not the project root.
  const allCwds = useMemo(() => sessions.flatMap((s) => s.windows.map((w) => w.cwd)), [sessions]);
  const { rootOf } = useGitRootDirs(allCwds);

  // A project row's label is its folder's name — the tmux session name is
  // backend detail, demoted to the tooltip. Pathless sessions (nothing to
  // derive from) keep their session name as the label.
  const rowLabel = (s: TmuxSession) => (s.path ? projectName(s.path) : s.name);

  // Flattened in the exact visual order the tree renders below — kept in
  // sync by construction since both this and the JSX walk the same
  // listRows/collapsedProjects.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const row of listRows) {
      if (row.dead) {
        out.push({ kind: "dead", id: `dead:${row.cwd}`, cwd: row.cwd });
        continue;
      }
      const id = projectRowId(row.session);
      out.push({ kind: "project", id, session: row.session, extraSessions: row.extraSessions, pinned: row.pinned });
      if (!collapsedProjects.has(id)) {
        for (const s of [row.session, ...row.extraSessions]) {
          for (const w of s.windows) {
            out.push({ kind: "window", id: windowRowId(s.name, w.index), session: s, window: w, parentId: id });
          }
        }
      }
    }
    return out;
  }, [listRows, collapsedProjects]);

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  // Set right after useListNavigation below (same render) — lets onCollapse
  // move focus to a terminal row's parent without a circular reference to
  // the hook it's passed into, same ref-indirection useGlobalKeybindings
  // uses for globalCommandsRef.
  const focusRowRef = useRef<(id: string) => void>(() => {});

  const onActivate = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "dead") onOpenProject(row.cwd);
      else if (row.kind === "project") {
        // Focus the project's most-recent terminal (openProject's live
        // branch) rather than tmux's open-every-window; Open All Terminals
        // stays in the context menu.
        if (row.session.path) onOpenProject(row.session.path);
        else onOpenAllWindows(row.session.name);
      } else onOpenWindow(row.session.name, row.window.index);
    },
    [rowsById, onOpenProject, onOpenAllWindows, onOpenWindow],
  );

  const onExpand = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "project" && collapsedProjects.has(row.id)) {
        toggleProjectCollapsed(row.id);
      }
    },
    [rowsById, collapsedProjects],
  );

  const onCollapse = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "project" && !collapsedProjects.has(row.id)) {
        toggleProjectCollapsed(row.id);
      } else if (row.kind === "window") {
        focusRowRef.current(row.parentId);
      }
    },
    [rowsById, collapsedProjects],
  );

  const onContextMenuKey = useCallback(
    (id: string, rect: DOMRect) => {
      const row = rowsById.get(id);
      if (!row) return;
      const items =
        row.kind === "dead"
          ? deadProjectMenuItems(row.cwd)
          : row.kind === "project"
            ? sessionMenuItems(row.session.name)
            : windowMenuItems(row.session.name, row.window);
      onShowMenu(rect.left + 8, rect.bottom, items);
    },
    [rowsById, sessionMenuItems, deadProjectMenuItems, windowMenuItems, onShowMenu],
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
      focusList: () => {
        const target = nav.focusedId ?? rowIds[0];
        if (target) nav.focusRow(target);
      },
    }),
    [nav, rowIds],
  );

  // projects.* operation commands (rebindable) — dispatched here, ahead of
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

        if (row && matches("projects.kill")) {
          e.preventDefault();
          if (row.kind === "window") onKillWindow(row.session.name, row.window.index);
          else if (row.kind === "project") onKillSession(row.session.name);
          return;
        }
        // Rename applies to terminal rows only — projects have no rename
        // (a project's name is its folder's; session names are cosmetic).
        if (row && matches("projects.rename")) {
          if (row.kind === "window") {
            e.preventDefault();
            onRenameWindow(row.session.name, row.window);
            return;
          }
        }
        if (row && matches("projects.newWindow")) {
          const sessionName = row.kind === "window" || row.kind === "project" ? row.session.name : null;
          if (sessionName) {
            e.preventDefault();
            onNewWindowInSession(sessionName);
            return;
          }
        }
        if (row && matches("projects.togglePin")) {
          const sessionName = row.kind === "window" || row.kind === "project" ? row.session.name : null;
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
        toggleProjectCollapsed(key);
      }}
    >
      <Icon name={collapsedProjects.has(key) ? "chevron-right" : "chevron-down"} />
    </span>
  );

  const renderWindowRow = (row: Extract<Row, { kind: "window" }>) => {
    const { session: s, window: w } = row;
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
        title={`${rowLabel(s)} · ${w.name} — ${w.cwd}${w.activity ? " (new output)" : ""} (tmux: ${s.name}:${w.index})`}
        onClick={() => onOpenWindow(s.name, w.index)}
        onContextMenu={(e) => {
          e.preventDefault();
          nav.focusRow(row.id);
          onShowMenu(e.clientX, e.clientY, windowMenuItems(s.name, w));
        }}
        {...bindMenu((x, y) => {
          nav.focusRow(row.id);
          onShowMenu(x, y, windowMenuItems(s.name, w));
        })}
        tabIndex={rowProps.tabIndex}
        ref={rowProps.ref}
        onFocus={rowProps.onFocus}
      >
        {w.activity && <span className="activity-dot" />}
        <span className="window-label">{w.name}</span>
        <span className="item-cwd">{rootOf(w.cwd)}</span>
        {getWindowDecorations({ sessionName: s.name, windowIndex: w.index, cwd: w.cwd, command: w.command }).map(
          ({ provider, decoration }) => (
            <button
              key={provider.id}
              className={`window-decoration-badge${decoration.className ? ` ${decoration.className}` : ""}`}
              title={decoration.tooltip ?? decoration.badge}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                provider.onClick?.(
                  (e.currentTarget as HTMLElement).getBoundingClientRect(),
                  { sessionName: s.name, windowIndex: w.index, cwd: w.cwd, command: w.command },
                );
              }}
            >
              {decoration.badge}
            </button>
          ),
        )}
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
          title="Close Terminal"
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

  return (
    <div className="session-list" ref={containerRef} onKeyDown={handleKeyDown}>
      <ul className="session-list-ul">
        {listRows.map((row) => {
          if (row.dead) {
            const id = `dead:${row.cwd}`;
            const rowProps = nav.getRowProps(id);
            return (
              <li key={id}>
                <div className="session-row">
                  <button
                    className="session-item dead-session-item"
                    title={`${row.cwd} (not running — click to open)`}
                    onClick={() => onOpenProject(row.cwd)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      nav.focusRow(id);
                      onShowMenu(e.clientX, e.clientY, deadProjectMenuItems(row.cwd));
                    }}
                    {...bindMenu((x, y) => {
                      nav.focusRow(id);
                      onShowMenu(x, y, deadProjectMenuItems(row.cwd));
                    })}
                    tabIndex={rowProps.tabIndex}
                    ref={rowProps.ref}
                    onFocus={rowProps.onFocus}
                  >
                    <Icon name="pinned" className="pin-indicator" />
                    <span className="session-name">{projectName(row.cwd)}</span>
                    <span className="item-cwd">{row.cwd}</span>
                  </button>
                  <button
                    className="row-add-button"
                    title="Open project"
                    tabIndex={-1}
                    onClick={() => onOpenProject(row.cwd)}
                  >
                    <Icon name="add" />
                  </button>
                </div>
              </li>
            );
          }
          const s = row.session;
          const id = projectRowId(s);
          const members = [s, ...row.extraSessions];
          const isActiveProject =
            activeSessionName !== null && members.some((m) => m.name === activeSessionName);
          const anyAttached = members.some((m) => m.attached > 0);
          const tooltip = `${s.path || s.name} (tmux: ${members.map((m) => m.name).join(", ")})`;
          const rowProps = nav.getRowProps(id);
          return (
            <li key={id}>
              <div className={`session-row${isActiveProject ? " active" : ""}`}>
                <button
                  className={`session-item${isActiveProject ? " active" : ""}`}
                  title={tooltip}
                  onClick={() => {
                    if (s.path) onOpenProject(s.path);
                    else onOpenAllWindows(s.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    nav.focusRow(id);
                    onShowMenu(e.clientX, e.clientY, sessionMenuItems(s.name));
                  }}
                  {...bindMenu((x, y) => {
                    nav.focusRow(id);
                    onShowMenu(x, y, sessionMenuItems(s.name));
                  })}
                  tabIndex={rowProps.tabIndex}
                  ref={rowProps.ref}
                  onFocus={rowProps.onFocus}
                >
                  {chevron(id)}
                  <span className={`session-dot${anyAttached ? " attached" : ""}`} />
                  {row.pinned && <Icon name="pinned" className="pin-indicator" />}
                  <span className="session-name">{rowLabel(s)}</span>
                  {s.path && <span className="item-cwd">{s.path}</span>}
                </button>
                <button
                  className="row-add-button"
                  title="New Terminal"
                  tabIndex={-1}
                  onClick={() => onNewWindowInSession(s.name)}
                >
                  <Icon name="add" />
                </button>
              </div>
              {!collapsedProjects.has(id) &&
                members.flatMap((m) =>
                  m.windows.map((w) =>
                    renderWindowRow({ kind: "window", id: windowRowId(m.name, w.index), session: m, window: w, parentId: id }),
                  ),
                )}
            </li>
          );
        })}
        {listRows.length === 0 && <li className="session-empty">No projects open</li>}
      </ul>
    </div>
  );
});

export default ProjectList;
