import { Fragment, useEffect, useRef, useState } from "react";
import { setContextKey } from "../contextKeys";
import {
  setSidebarTabsBridge,
  type RegisteredSidebarPanel,
  type RegisteredWindowAction,
} from "../extensions";
import { formatBinding, type Keybinding } from "../keybindings";
import { moveId } from "../lib/tabs";
import { sessionRowsWithPins } from "../lib/sessions";
import type {
  ExtensionInfo,
  MenuItem,
  PinnedSession,
  RegistrySourceResult,
  SidebarMode,
  TmuxSession,
  TmuxWindow,
} from "../types";
import ExtensionsPanel from "./ExtensionsPanel";
import FileTree from "./FileTree";
import Icon from "./Icon";
import PortsPanel from "./PortsPanel";
import SidebarTabStrip, { type SidebarTabInfo } from "./SidebarTabStrip";

// Built-in ids are the literal union below; an extension panel's id is
// whatever registerSidebarPanel namespaced it to (ext.<extensionId>.<id>),
// so the type widens to string — PANEL_IDS stays the source of truth for
// "is this one of the three built-ins".
type PanelId = string;

interface PanelState {
  order: PanelId[];
  collapsed: Record<PanelId, boolean>;
  // Relative flex-grow weights for expanded panels. Values are seeded from
  // measured pixel heights on resize, but any positive number works — flex
  // only cares about the ratio between siblings, not the absolute value.
  sizes: Record<PanelId, number>;
}

const PANEL_IDS: PanelId[] = ["sessions", "files", "ports"];
const MIN_PANEL_HEIGHT = 60;
const PANELS_KEY = "sidebarPanels";

const DEFAULT_PANEL_STATE: PanelState = {
  order: ["sessions", "files", "ports"],
  collapsed: { sessions: false, files: false, ports: true },
  sizes: { sessions: 1, files: 1, ports: 1 },
};

function loadPanelState(): PanelState {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PANEL_STATE };
    // Any string id is accepted here so an id from before extension panels
    // moved out of the accordion into their own tab survives a reload — it's
    // simply excluded at render time (see visibleOrder) since it's no
    // longer one of the 3 built-ins.
    const order: PanelId[] =
      Array.isArray(parsed.order) && parsed.order.every((id: unknown) => typeof id === "string")
        ? [...(parsed.order as PanelId[])]
        : [...DEFAULT_PANEL_STATE.order];
    for (const id of PANEL_IDS) if (!order.includes(id)) order.push(id);
    return {
      order,
      collapsed: { ...DEFAULT_PANEL_STATE.collapsed, ...parsed.collapsed },
      sizes: { ...DEFAULT_PANEL_STATE.sizes, ...parsed.sizes },
    };
  } catch {
    return { ...DEFAULT_PANEL_STATE };
  }
}

// The sidebar's activity-bar-style tab strip (plans/sidebar-tabs.md): a
// fixed "explorer" tab holds the accordion below (sessions/files/ports),
// a fixed "extensions-view" tab holds the Extensions browser/manager, and
// every registered extension sidebar panel — e.g. git-scm's Source Control —
// gets its own full-height tab instead of joining the accordion.
export const EXPLORER_TAB_ID = "explorer";
// Deliberately not "extensions" — that could collide with a future
// extension-registered panel id (which are namespaced ext.<id>.<panelId>,
// but a bare "extensions" is still worth avoiding for clarity).
export const EXTENSIONS_TAB_ID = "extensions-view";
// Both fixed tabs share every special-case below with EXPLORER_TAB_ID, which
// stays exported/used directly at each site since it's also the fallback
// "always exists" tab.
const CORE_TAB_IDS: readonly string[] = [EXPLORER_TAB_ID, EXTENSIONS_TAB_ID];
const TABS_KEY = "sidebarTabs";

interface TabsState {
  order: string[];
  active: string;
}

const DEFAULT_TABS_STATE: TabsState = {
  order: [EXPLORER_TAB_ID, EXTENSIONS_TAB_ID],
  active: EXPLORER_TAB_ID,
};

function loadTabsState(): TabsState {
  try {
    const parsed = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TABS_STATE };
    const order: string[] =
      Array.isArray(parsed.order) && parsed.order.every((id: unknown) => typeof id === "string")
        ? [...(parsed.order as string[])]
        : [...DEFAULT_TABS_STATE.order];
    if (!order.includes(EXPLORER_TAB_ID)) order.unshift(EXPLORER_TAB_ID);
    if (!order.includes(EXTENSIONS_TAB_ID)) {
      order.splice(order.indexOf(EXPLORER_TAB_ID) + 1, 0, EXTENSIONS_TAB_ID);
    }
    const active = typeof parsed.active === "string" ? parsed.active : EXPLORER_TAB_ID;
    return { order, active };
  } catch {
    return { ...DEFAULT_TABS_STATE };
  }
}

interface Props {
  width: number;
  sessions: TmuxSession[];
  activeSessionName: string | null;
  // The window a window-tab is pinned to, when the active tab is one — used
  // to highlight that exact row instead of tmux's own (possibly diverged)
  // active-window flag.
  activeWindow: { sessionName: string; index: number } | null;
  onOpenAllWindows: (session: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onCreate: (name?: string) => void;
  onKillWindow: (session: string, index: number) => void;
  onNewWindowInSession: (session: string) => void;
  onNewWindowInDir: (cwd: string) => void;
  onOpenLazygit: () => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  sessionMenuItems: (name: string, dead: boolean) => MenuItem[];
  windowMenuItems: (session: string, window: TmuxWindow) => MenuItem[];
  pinnedSessions: PinnedSession[];
  onRestorePinned: (name: string, cwd: string) => void;
  onOpenSettings: () => void;
  // The bottom terminal panel's toggle lives up here with the app's other
  // global chrome toggles (hide-sidebar below), not in a TabBar's actions —
  // that bar is rendered per editor group, so the button would duplicate in
  // every split pane.
  panelVisible: boolean;
  onTogglePanel: () => void;
  showGitStatus: boolean;
  onCollapse: () => void;
  filesRootDir: string | null;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  filesRefreshKey: number;
  onFilesRefresh: () => void;
  onOpenFile: (path: string) => void;
  onPreviewFile: (path: string) => void;
  isPreviewable: (path: string) => boolean;
  fileMenuItems: (path: string, isDir: boolean, rootDir: string) => MenuItem[];
  fileTreeRootMenuItems: (rootDir: string) => MenuItem[];
  fileMultiMenuItems: (entries: { path: string; isDir: boolean }[]) => MenuItem[];
  deleteFileEntry: (path: string, isDir: boolean) => void;
  deleteFileEntries: (entries: { path: string; isDir: boolean }[]) => void;
  renameFileEntry: (path: string) => void;
  // Backs FileTree's files.findInFolder/newFile/newFolder/copyPath/
  // copyRelativePath keyboard dispatch (see FileTree.tsx's own prop docs).
  onFindInFolder: (path: string, rootDir: string) => void;
  onCreateFile: (dirPath: string) => void;
  onCreateFolder: (dirPath: string) => void;
  onCopyPath: (paths: string[]) => void;
  onCopyRelativePath: (paths: string[], rootDir: string) => void;
  prunePath: { paths: string[] } | null;
  cutPaths: Set<string> | null;
  onCopyEntries: (paths: string[]) => void;
  onCutEntries: (paths: string[]) => void;
  onPasteInto: (destDir: string) => void;
  onClearClipboard: () => void;
  // FILES-tree drag-and-drop: drag = move, Ctrl+drag = copy. Independent of
  // the clipboard props above — a drag never touches the cut/copy clipboard.
  onTransferEntries: (paths: string[], destDir: string, mode: "move" | "copy") => void;
  extensionPanels: RegisteredSidebarPanel[];
  extensionWindowActions: RegisteredWindowAction[];
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionRegistries: string[];
  onExtensionRegistriesChange: (registries: string[]) => void;
  registryCatalog: RegistrySourceResult[];
  registryLoading: boolean;
  onEnsureRegistryLoaded: () => void;
  onRefreshRegistry: (refresh: boolean) => void;
  onOpenExtensionPage: (id: string, source?: string) => void;
  extensionUpdatesCount: number;
  // Live-resolved (defaults + user overrides) keybindings map, keyed by
  // command id — used to append each tab's current shortcut to its tooltip
  // (see tabInfos below) so a rebind in Settings shows up immediately.
  resolvedBindings: Record<string, Keybinding[]>;
  // Threaded down to PortsPanel's Kill process action.
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>;
}

export default function Sidebar({
  width,
  sessions,
  activeSessionName,
  activeWindow,
  onOpenAllWindows,
  onOpenWindow,
  onCreate,
  onKillWindow,
  onNewWindowInSession,
  onNewWindowInDir,
  onOpenLazygit,
  onShowMenu,
  sessionMenuItems,
  windowMenuItems,
  pinnedSessions,
  onRestorePinned,
  onOpenSettings,
  panelVisible,
  onTogglePanel,
  showGitStatus,
  onCollapse,
  filesRootDir,
  onDropFiles,
  filesRefreshKey,
  onFilesRefresh,
  onOpenFile,
  onPreviewFile,
  isPreviewable,
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
  prunePath,
  cutPaths,
  onCopyEntries,
  onCutEntries,
  onPasteInto,
  onClearClipboard,
  onTransferEntries,
  extensionPanels,
  extensionWindowActions,
  extensions,
  onReloadExtensions,
  extensionRegistries,
  onExtensionRegistriesChange,
  registryCatalog,
  registryLoading,
  onEnsureRegistryLoaded,
  onRefreshRegistry,
  onOpenExtensionPage,
  extensionUpdatesCount,
  resolvedBindings,
  confirmDialog,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<SidebarMode>(
    () => (localStorage.getItem("sidebarMode") as SidebarMode) ?? "sessions",
  );
  const [collapsedWindows, setCollapsedWindows] = useState<Set<string>>(new Set());
  const [panelState, setPanelState] = useState<PanelState>(loadPanelState);
  const [tabsState, setTabsState] = useState<TabsState>(loadTabsState);
  // Teardown for an in-progress splitter drag's window listeners — invoked by
  // both the drag's own pointerup/pointercancel AND, as a safety net, by the
  // unmount effect below if Sidebar unmounts mid-drag (e.g. the whole sidebar
  // is hidden) so the listeners/body-class never outlive the component.
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => panelResizeCleanupRef.current?.();
  }, []);

  // Hiding the sidebar unmounts it (App.tsx's conditional render) without
  // firing a blur event on whatever was focused inside it — clear the
  // sidebarFocus context key directly so a when-clause bound to it doesn't
  // stay stuck true.
  useEffect(() => {
    return () => setContextKey("sidebarFocus", false);
  }, []);

  const panelRefs = useRef<Record<PanelId, HTMLDivElement | null>>({
    sessions: null,
    files: null,
    ports: null,
  });
  const [portsRefreshKey, setPortsRefreshKey] = useState(0);

  // Keeps tabsState in sync as extensions register sidebar panels: appends
  // any newly-registered panel id to the tab order. Purely additive and
  // idempotent — it must never remove an id, however things look at the
  // moment it happens to run.
  //
  // Extension activation is async (App.tsx's loadExtensions), so on every
  // mount `extensionPanels` is transiently `[]` before an extension's
  // panel(s) register, and (under StrictMode's dev-only double effect
  // invocation) this can run an unpredictable number of times with
  // different extIds before things settle. An earlier version of the
  // accordion's equivalent effect pruned stored order down to just the ids
  // visible in extIds at the time — which reliably discarded a dragged
  // panel's saved position on *some* reloads and not others, since it
  // depended on exactly when each run happened to fire. The fix is to never
  // prune here at all — a disabled/uninstalled extension's stale tab id is
  // filtered out at render time instead (see visibleTabOrder below), so
  // keeping it around in storage is harmless and the reconciliation itself
  // can't race.
  useEffect(() => {
    setTabsState((prev) => {
      const order = [...prev.order];
      for (const panel of extensionPanels) if (!order.includes(panel.id)) order.push(panel.id);
      return { ...prev, order };
    });
  }, [extensionPanels]);
  const [dragPanelId, setDragPanelId] = useState<PanelId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: PanelId; edge: "top" | "bottom" } | null>(
    null,
  );
  const [filesBranch, setFilesBranch] = useState<string | null>(null);
  // Per-panel header actions container, keyed by panel id — the portal
  // target an extension panel renders its header-row buttons into (mirrors
  // TabBar's actionsRef/tabActionsEl for file-viewer toolbars). State (not
  // a plain ref) so a newly-mounted header re-renders the panel content
  // with the now-available DOM node.
  const [extPanelActionsEls, setExtPanelActionsEls] = useState<Record<PanelId, HTMLDivElement | null>>({});
  // A fresh inline `ref={(el) => ...}` closure every render makes React
  // detach+reattach the ref on every render (ref identity changed), which
  // re-triggered setExtPanelActionsEls every time and looped forever
  // ("Maximum update depth exceeded") — caught via a live browser check,
  // not by type-checking. Caching one stable callback per panel id avoids
  // the identity churn.
  const actionsRefCallbacks = useRef<Record<PanelId, (el: HTMLDivElement | null) => void>>({});
  const getActionsRefCallback = (id: PanelId) => {
    let cb = actionsRefCallbacks.current[id];
    if (!cb) {
      cb = (el) => {
        setExtPanelActionsEls((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }));
      };
      actionsRefCallbacks.current[id] = cb;
    }
    return cb;
  };

  useEffect(() => {
    localStorage.setItem("sidebarMode", mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panelState));
  }, [panelState]);

  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabsState));
  }, [tabsState]);

  const extPanelIds = new Set(extensionPanels.map((p) => p.id));
  // Filters out a stale tab id (its extension disabled/uninstalled, or one
  // still activating on this render) — same "don't mutate storage, just
  // don't render it" approach as the accordion's visibleOrder.
  const visibleTabOrder = tabsState.order.filter(
    (id) => CORE_TAB_IDS.includes(id) || extPanelIds.has(id),
  );
  const activeTabId = visibleTabOrder.includes(tabsState.active) ? tabsState.active : EXPLORER_TAB_ID;

  const selectTab = (id: string) => {
    setTabsState((prev) => ({ ...prev, active: id }));
  };

  // Lets core code outside Sidebar (the FILES-tree "Find in Folder…" menu
  // item, and every "Sidebar: Focus <tab>" shortcut) force-activate a
  // sidebar tab, or read which one is active — see extensions.ts's
  // selectSidebarTab/focusSidebarTab/setSidebarTabsBridge. Re-registered
  // whenever activeTabId changes (selectTab is a fresh closure each render
  // regardless) so getActive always reflects the current tab.
  useEffect(() => {
    setSidebarTabsBridge({ select: selectTab, getActive: () => activeTabId });
    return () => setSidebarTabsBridge(null);
  }, [selectTab, activeTabId]);

  const reorderTabs = (draggedId: string, toIndex: number) => {
    setTabsState((prev) => {
      // Stale ids (currently unregistered) ride along, appended after the
      // reordered visible tabs, so a reorder can never look like a prune.
      const stale = prev.order.filter((id) => !CORE_TAB_IDS.includes(id) && !extPanelIds.has(id));
      const nextVisible = moveId(visibleTabOrder, draggedId, toIndex);
      return { ...prev, order: [...nextVisible, ...stale] };
    });
  };

  // Appends " (Ctrl+Shift+E)" etc. to a tab's tooltip from its "Sidebar:
  // Focus <tab>" command's first binding — empty string (no-op) if that
  // command has no binding, e.g. an extension panel registered without a
  // focusBinding (see registerSidebarPanel).
  const shortcutSuffix = (commandId: string): string => {
    const key = resolvedBindings[commandId]?.[0]?.key;
    return key ? ` (${formatBinding(key)})` : "";
  };

  const tabInfos: SidebarTabInfo[] = visibleTabOrder.map((id) => {
    if (id === EXPLORER_TAB_ID) {
      return { id, title: `Explorer${shortcutSuffix("sidebar.focusExplorer")}`, icon: "files" };
    }
    if (id === EXTENSIONS_TAB_ID) {
      return {
        id,
        title: `Extensions${shortcutSuffix("sidebar.focusExtensions")}`,
        icon: "extensions",
        badge: extensionUpdatesCount,
      };
    }
    const panel = extensionPanels.find((p) => p.id === id);
    return {
      id,
      title: `${panel?.title ?? id}${shortcutSuffix(`${id}.focus`)}`,
      icon: panel?.icon ?? "extensions",
      badge: panel?.badge,
    };
  });

  const toggleWindowCollapsed = (key: string) => {
    setCollapsedWindows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const togglePanelCollapsed = (id: PanelId) => {
    setPanelState((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [id]: !prev.collapsed[id] },
    }));
  };

  const startCreating = () => {
    // A collapsed SESSIONS panel needs to expand for the inline input to be
    // visible at all — mirrors code-server's "clicking an activity icon
    // reveals its panel" behavior.
    setPanelState((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, sessions: false },
    }));
    setCreating(true);
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
        toggleWindowCollapsed(key);
      }}
    >
      <Icon name={collapsedWindows.has(key) ? "chevron-right" : "chevron-down"} />
    </span>
  );

  const windowRow = (s: TmuxSession, w: TmuxWindow, label: string, showCwd: boolean) => {
    const isActive =
      activeWindow !== null
        ? activeWindow.sessionName === s.name && activeWindow.index === w.index
        : w.active;
    return (
      <div
        key={`${s.name}:${w.index}`}
        role="button"
        tabIndex={0}
        className={`window-item${isActive ? " active-window" : ""}`}
        title={`${s.name}:${w.index} ${w.name} — ${w.cwd}${w.activity ? " (new output)" : ""}`}
        onClick={() => onOpenWindow(s.name, w.index)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenWindow(s.name, w.index);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onShowMenu(e.clientX, e.clientY, windowMenuItems(s.name, w));
        }}
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

  const sessionRows = sessionRowsWithPins(sessions, pinnedSessions);

  const sessionsTree = (
    <ul className="session-list">
      {sessionRows.map((row) => {
        if (row.dead) {
          return (
            <li key={`dead:${row.name}`}>
              <div className="session-row">
                <button
                  className="session-item dead-session-item"
                  title={`${row.cwd} (not running — click to restore)`}
                  onClick={() => onRestorePinned(row.name, row.cwd)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onShowMenu(e.clientX, e.clientY, sessionMenuItems(row.name, true));
                  }}
                >
                  <Icon name="pinned" className="pin-indicator" />
                  <span className="session-name">{row.name}</span>
                  <span className="item-cwd">{row.cwd}</span>
                </button>
                <button
                  className="row-add-button"
                  title="New window"
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
        return (
          <li key={s.name}>
            <div className={`session-row${s.name === activeSessionName ? " active" : ""}`}>
              <button
                className={`session-item${s.name === activeSessionName ? " active" : ""}`}
                title={activeWin ? activeWin.cwd : s.name}
                onClick={() => onOpenAllWindows(s.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onShowMenu(e.clientX, e.clientY, sessionMenuItems(s.name, false));
                }}
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
                onClick={() => onNewWindowInSession(s.name)}
              >
                <Icon name="add" />
              </button>
            </div>
            {!collapsedWindows.has(s.name) &&
              s.windows.map((w) => windowRow(s, w, `${w.index} ${w.name}`, true))}
          </li>
        );
      })}
      {sessionRows.length === 0 && <li className="session-empty">No tmux sessions</li>}
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
          <div className="session-row">
            <button
              className="session-item dir-item"
              title={dir}
              onClick={() => toggleWindowCollapsed(dir)}
            >
              {chevron(dir)}
              <span className="session-name">{dir}</span>
            </button>
            <button
              className="row-add-button"
              title="New window in current session"
              onClick={() => onNewWindowInDir(dir)}
            >
              <Icon name="add" />
            </button>
          </div>
          {!collapsedWindows.has(dir) &&
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

  const panelTitle = (id: PanelId): string => {
    if (id === "sessions") return mode === "sessions" ? "Sessions" : "Directories";
    if (id === "ports") return "Ports";
    return filesRootDir ?? "Files";
  };

  const panelActions = (id: PanelId) => {
    if (id === "sessions") {
      return (
        <>
          <button
            className={`icon-button mode-button${mode === "sessions" ? " active" : ""}`}
            title="Group by session"
            onClick={() => setMode("sessions")}
          >
            <Icon name="list-flat" />
          </button>
          <button
            className={`icon-button mode-button${mode === "dirs" ? " active" : ""}`}
            title="Group by directory"
            onClick={() => setMode("dirs")}
          >
            <Icon name="list-tree" />
          </button>
          <button className="icon-button" title="New session" onClick={startCreating}>
            <Icon name="add" />
          </button>
        </>
      );
    }
    if (id === "ports") {
      return (
        <button
          className="icon-button"
          title="Refresh"
          onClick={() => setPortsRefreshKey((k) => k + 1)}
        >
          <Icon name="refresh" />
        </button>
      );
    }
    if (id === "files") {
      return (
        <button className="icon-button" title="Refresh" onClick={onFilesRefresh}>
          <Icon name="refresh" />
        </button>
      );
    }
    return null;
  };

  const panelContent = (id: PanelId) => {
    if (id === "sessions") {
      return (
        <>
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
        </>
      );
    }
    if (id === "ports") {
      return <PortsPanel refreshKey={portsRefreshKey} confirmDialog={confirmDialog} />;
    }
    if (id === "files") {
      return (
        <FileTree
          rootDir={filesRootDir}
          showGitStatus={showGitStatus}
          onDropFiles={onDropFiles}
          refreshKey={filesRefreshKey}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
          isPreviewable={isPreviewable}
          onBranchChange={setFilesBranch}
          onShowMenu={onShowMenu}
          fileMenuItems={fileMenuItems}
          fileTreeRootMenuItems={fileTreeRootMenuItems}
          fileMultiMenuItems={fileMultiMenuItems}
          deleteFileEntry={deleteFileEntry}
          deleteFileEntries={deleteFileEntries}
          renameFileEntry={renameFileEntry}
          onFindInFolder={onFindInFolder}
          onCreateFile={onCreateFile}
          onCreateFolder={onCreateFolder}
          onCopyPath={onCopyPath}
          onCopyRelativePath={onCopyRelativePath}
          resolvedBindings={resolvedBindings}
          prunePath={prunePath}
          cutPaths={cutPaths}
          onCopyEntries={onCopyEntries}
          onCutEntries={onCutEntries}
          onPasteInto={onPasteInto}
          onClearClipboard={onClearClipboard}
          onTransferEntries={onTransferEntries}
        />
      );
    }
    return null;
  };

  // Converts a pointer drag into flex-grow weights for the two panels
  // straddling the splitter. Weights are seeded from measured pixel heights
  // at drag start, clamped so neither panel shrinks below MIN_PANEL_HEIGHT;
  // only these two panels' weights change, so any other expanded panel's
  // share of the remaining space is undisturbed.
  const startPanelResize = (e: React.PointerEvent, aId: PanelId, bId: PanelId) => {
    e.preventDefault();
    const aEl = panelRefs.current[aId];
    const bEl = panelRefs.current[bId];
    if (!aEl || !bEl) return;
    const startHeightA = aEl.getBoundingClientRect().height;
    const startHeightB = bEl.getBoundingClientRect().height;
    const totalHeight = startHeightA + startHeightB;
    const startY = e.clientY;
    const pointerId = e.pointerId;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      const newHeightA = Math.min(
        totalHeight - MIN_PANEL_HEIGHT,
        Math.max(MIN_PANEL_HEIGHT, startHeightA + dy),
      );
      const newHeightB = totalHeight - newHeightA;
      setPanelState((prev) => ({
        ...prev,
        sizes: { ...prev.sizes, [aId]: newHeightA, [bId]: newHeightB },
      }));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing-row");
      panelResizeCleanupRef.current = null;
    };
    document.body.classList.add("resizing-row");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    panelResizeCleanupRef.current = () => end({ pointerId } as PointerEvent);
  };

  const PANEL_DRAG_TYPE = "application/x-tmux-panel";

  const headerDragHandlers = (id: PanelId) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(PANEL_DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      setDragPanelId(id);
    },
    onDragEnd: () => {
      setDragPanelId(null);
      setDropIndicator(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE) || !dragPanelId || dragPanelId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge: "top" | "bottom" = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
      setDropIndicator({ id, edge });
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDropIndicator(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE)) return;
      e.preventDefault();
      const draggedId = e.dataTransfer.getData(PANEL_DRAG_TYPE) as PanelId;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge: "top" | "bottom" = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
      setDropIndicator(null);
      setDragPanelId(null);
      if (!draggedId || draggedId === id) return;
      setPanelState((prev) => {
        const withoutDragged = prev.order.filter((p) => p !== draggedId);
        const targetIdx = withoutDragged.indexOf(id);
        const insertAt = edge === "top" ? targetIdx : targetIdx + 1;
        const next = [...withoutDragged];
        next.splice(insertAt, 0, draggedId);
        return { ...prev, order: next };
      });
    },
  });

  const renderPanel = (id: PanelId, nextId: PanelId | null) => {
    const isCollapsed = panelState.collapsed[id];
    const showSplitterAfter = !isCollapsed && nextId !== null && !panelState.collapsed[nextId];
    const indicatorClass =
      dropIndicator?.id === id ? ` drop-indicator-${dropIndicator.edge}` : "";

    return (
      <Fragment key={id}>
        <div
          ref={(el) => {
            panelRefs.current[id] = el;
          }}
          className={`sidebar-panel${isCollapsed ? " collapsed" : ""}`}
          style={isCollapsed ? undefined : { flex: `${panelState.sizes[id] ?? 1} 1 0px` }}
        >
          <div
            className={`panel-header${indicatorClass}${dragPanelId === id ? " dragging" : ""}`}
            onClick={() => togglePanelCollapsed(id)}
            {...headerDragHandlers(id)}
          >
            <span className="chevron">
              <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} />
            </span>
            <span className="sidebar-title" title={id === "files" ? panelTitle(id) : undefined}>
              {panelTitle(id)}
            </span>
            {id === "files" && filesBranch && (
              <button
                className="branch-pill"
                title={`Branch: ${filesBranch} — click to open lazygit`}
                onClick={(e) => {
                  // The header's own click toggles panel collapse.
                  e.stopPropagation();
                  onOpenLazygit();
                }}
              >
                {filesBranch}
              </button>
            )}
            <div
              className="sidebar-actions"
              ref={getActionsRefCallback(id)}
              onClick={(e) => e.stopPropagation()}
            >
              {panelActions(id)}
            </div>
          </div>
          {!isCollapsed && <div className="panel-content">{panelContent(id)}</div>}
        </div>
        {showSplitterAfter && (
          <div
            className="panel-splitter"
            onPointerDown={(e) => startPanelResize(e, id, nextId!)}
          />
        )}
      </Fragment>
    );
  };

  // panelState.order may still contain an id from before extension panels
  // moved out into their own tab — filtering to just the 3 built-ins here
  // (rather than mutating storage) makes that id inert without a migration.
  const visibleOrder = panelState.order.filter((id) => PANEL_IDS.includes(id));

  const renderExtensionTab = (panel: RegisteredSidebarPanel) => {
    const PanelComponent = panel.component;
    return (
      <div className="sidebar-ext-tab">
        <div className="panel-header ext-tab-header">
          <span className="sidebar-title">{panel.title}</span>
          <div
            className="sidebar-actions"
            ref={getActionsRefCallback(panel.id)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        <div className="panel-content ext-tab-content">
          <PanelComponent actionsTarget={extPanelActionsEls[panel.id] ?? null} showMenu={onShowMenu} />
        </div>
      </div>
    );
  };

  const activeExtPanel =
    CORE_TAB_IDS.includes(activeTabId) ? undefined : extensionPanels.find((p) => p.id === activeTabId);

  return (
    <aside
      className="sidebar"
      style={{ width }}
      onFocusCapture={() => setContextKey("sidebarFocus", true)}
      onBlurCapture={(e) => {
        // relatedTarget is null when focus leaves the document entirely
        // (e.g. to the browser chrome) — treat that as "left the sidebar"
        // too, so the key can't get stuck true.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setContextKey("sidebarFocus", false);
        }
      }}
    >
      <div className="sidebar-topbar">
        <SidebarTabStrip tabs={tabInfos} activeId={activeTabId} onSelect={selectTab} onReorder={reorderTabs} />
        <button className="icon-button" title={`Settings${shortcutSuffix("settings.open")}`} onClick={onOpenSettings}>
          <Icon name="gear" />
        </button>
        <button
          className={`icon-button${panelVisible ? " active" : ""}`}
          title={`Toggle terminal panel${shortcutSuffix("panel.toggle")}`}
          aria-pressed={panelVisible}
          onClick={onTogglePanel}
        >
          <Icon name="layout-panel" />
        </button>
        <button
          className="icon-button"
          title={`Hide sidebar${shortcutSuffix("sidebar.toggle")}`}
          onClick={onCollapse}
        >
          <Icon name="layout-sidebar-left-off" />
        </button>
      </div>
      {activeTabId === EXPLORER_TAB_ID ? (
        <div className="sidebar-panels">
          {visibleOrder.map((id, idx) => renderPanel(id, visibleOrder[idx + 1] ?? null))}
        </div>
      ) : activeTabId === EXTENSIONS_TAB_ID ? (
        <ExtensionsPanel
          extensions={extensions}
          onReloadExtensions={onReloadExtensions}
          registries={extensionRegistries}
          onRegistriesChange={onExtensionRegistriesChange}
          registryCatalog={registryCatalog}
          registryLoading={registryLoading}
          onEnsureRegistryLoaded={onEnsureRegistryLoaded}
          onRefreshRegistry={onRefreshRegistry}
          onOpenExtensionPage={onOpenExtensionPage}
        />
      ) : (
        activeExtPanel && renderExtensionTab(activeExtPanel)
      )}
    </aside>
  );
}
