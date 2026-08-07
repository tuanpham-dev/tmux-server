import { Fragment, useEffect, useRef, useState } from "react";
import { setContextKey } from "../contextKeys";
import {
  getRootDecorations,
  setExplorerPanelFocusBridge,
  setProjectsFocusBridge,
  setSidebarTabsBridge,
  type RegisteredSidebarPanel,
  type RegisteredWindowAction,
} from "../extensions";
import { formatBinding, type Keybinding } from "../keybindings";
import { moveId } from "../lib/tabs";
import type {
  ExtensionInfo,
  MenuItem,
  Project,
  RegistrySourceResult,
  TmuxSession,
  TmuxWindow,
} from "../types";
import ExtensionsPanel from "./ExtensionsPanel";
import FileTree from "./FileTree";
import Icon from "./Icon";
import ProjectList, { type ProjectListHandle } from "./ProjectList";
import SidebarTabStrip, { type SidebarTabInfo } from "./SidebarTabStrip";

// Built-in ids are the literal union below; an extension panel's id is
// whatever registerSidebarPanel namespaced it to (ext.<extensionId>.<id>),
// so the type widens to string — PANEL_IDS stays the source of truth for
// "is this one of the built-ins".
type PanelId = string;

interface PanelState {
  order: PanelId[];
  collapsed: Record<PanelId, boolean>;
  // Relative flex-grow weights for expanded panels. Values are seeded from
  // measured pixel heights on resize, but any positive number works — flex
  // only cares about the ratio between siblings, not the absolute value.
  sizes: Record<PanelId, number>;
}

const PANEL_IDS: PanelId[] = ["projects", "files"];
const MIN_PANEL_HEIGHT = 60;
const PANELS_KEY = "sidebarPanels";

// The PORTS accordion section's id before it was extracted into the
// bundled ports extension — loadPanelState rewrites it in stored state so
// each user's accustomed order/collapse/size carries over to the
// extension's namespaced panel id.
const LEGACY_PORTS_PANEL_ID = "ports";
// The PROJECTS section's id before the SESSIONS pane was sunset in its
// favor (plans/projects-not-sessions.md) — loadPanelState rewrites it the
// same way as the ports id below, keeping order/collapse/size.
const LEGACY_SESSIONS_PANEL_ID = "sessions";
const PORTS_EXT_PANEL_ID = "ext.tmux-server.ports.ports";
const TASKS_EXT_PANEL_ID = "ext.tmux-server.tasks.tasks";

// One-shot stored-state migrations that must NOT re-run (unlike the
// idempotent legacy-ports id rewrite below): re-applying an ordering
// migration would fight a user who deliberately dragged the sections back.
// Kept as a separate key so the ordinary panelState save can't drop the
// applied-set.
const PANEL_MIGRATIONS_KEY = "sidebarPanelMigrations";

function appliedPanelMigrations(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_MIGRATIONS_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

// loadPanelState runs as a useState initializer, which StrictMode's dev
// double-invoke calls twice: without this memo the first call consumes the
// migration flag and the second (whose result React keeps) sees "already
// applied" and skips the move. True only while the current page load has
// itself applied the migration, so re-running it stays idempotent; a real
// reload re-evaluates the module and the persisted flag alone decides.
let tasksOrderMigratedThisLoad = false;

const DEFAULT_PANEL_STATE: PanelState = {
  order: ["projects", "files"],
  collapsed: { projects: false, files: false },
  sizes: { projects: 1, files: 1 },
};

function loadPanelState(): PanelState {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PANEL_STATE };
    // Any string id is accepted here so an id from before extension panels
    // moved out of the accordion into their own tab survives a reload — it's
    // simply excluded at render time (see visibleOrder) since its extension
    // isn't registered as an explorer section.
    const order: PanelId[] =
      Array.isArray(parsed.order) && parsed.order.every((id: unknown) => typeof id === "string")
        ? [...(parsed.order as PanelId[])]
        : [...DEFAULT_PANEL_STATE.order];
    // The sunset SESSIONS pane's id rewrites to "projects" BEFORE the
    // missing-id backfill below — otherwise the backfill would append a
    // second "projects" at the end and the stored slot would be lost.
    const legacySessionsIdx = order.indexOf(LEGACY_SESSIONS_PANEL_ID);
    if (legacySessionsIdx !== -1 && !order.includes("projects")) {
      order[legacySessionsIdx] = "projects";
    }
    for (const id of PANEL_IDS) if (!order.includes(id)) order.push(id);
    const collapsed = { ...DEFAULT_PANEL_STATE.collapsed, ...parsed.collapsed };
    const sizes = { ...DEFAULT_PANEL_STATE.sizes, ...parsed.sizes };
    // One-time migration: the pre-extraction PORTS id maps to the ports
    // extension's namespaced panel id, keeping its slot/collapse/size. The
    // rewritten state persists via the ordinary save effect.
    const legacyIdx = order.indexOf(LEGACY_PORTS_PANEL_ID);
    if (legacyIdx !== -1 && !order.includes(PORTS_EXT_PANEL_ID)) {
      order[legacyIdx] = PORTS_EXT_PANEL_ID;
    }
    if (LEGACY_PORTS_PANEL_ID in collapsed && !(PORTS_EXT_PANEL_ID in collapsed)) {
      collapsed[PORTS_EXT_PANEL_ID] = collapsed[LEGACY_PORTS_PANEL_ID];
    }
    if (LEGACY_PORTS_PANEL_ID in sizes && !(PORTS_EXT_PANEL_ID in sizes)) {
      sizes[PORTS_EXT_PANEL_ID] = sizes[LEGACY_PORTS_PANEL_ID];
    }
    delete collapsed[LEGACY_PORTS_PANEL_ID];
    delete sizes[LEGACY_PORTS_PANEL_ID];
    // Collapse/size carry-over for the sunset SESSIONS pane → PROJECTS (the
    // order rewrite already happened above, ahead of the id backfill).
    // Checked against the *stored* object, not the default-merged one —
    // DEFAULT_PANEL_STATE always carries a "projects" key, so the merged
    // maps can never lack it.
    const storedCollapsed: Record<string, unknown> = parsed.collapsed ?? {};
    const storedSizes: Record<string, unknown> = parsed.sizes ?? {};
    if (LEGACY_SESSIONS_PANEL_ID in storedCollapsed && !("projects" in storedCollapsed)) {
      collapsed.projects = collapsed[LEGACY_SESSIONS_PANEL_ID];
    }
    if (LEGACY_SESSIONS_PANEL_ID in storedSizes && !("projects" in storedSizes)) {
      sizes.projects = sizes[LEGACY_SESSIONS_PANEL_ID];
    }
    delete collapsed[LEGACY_SESSIONS_PANEL_ID];
    delete sizes[LEGACY_SESSIONS_PANEL_ID];
    // One-time reorder: builds that predate declared panel order (see
    // RegisteredSidebarPanel.order) appended TASKS after PORTS in plain
    // registration order. Guarded by PANEL_MIGRATIONS_KEY — rerunning would
    // fight a user who has since dragged PORTS back above TASKS. Marked
    // applied even when there's nothing to move: for state without both ids
    // the ordered insertion in the reconciliation effect places TASKS
    // correctly on its own.
    const migrations = appliedPanelMigrations();
    if (!migrations.includes("tasks-above-ports") || tasksOrderMigratedThisLoad) {
      const tasksIdx = order.indexOf(TASKS_EXT_PANEL_ID);
      const portsIdx = order.indexOf(PORTS_EXT_PANEL_ID);
      if (portsIdx !== -1 && tasksIdx > portsIdx) {
        order.splice(tasksIdx, 1);
        order.splice(portsIdx, 0, TASKS_EXT_PANEL_ID);
      }
      if (!migrations.includes("tasks-above-ports")) {
        localStorage.setItem(
          PANEL_MIGRATIONS_KEY,
          JSON.stringify([...migrations, "tasks-above-ports"]),
        );
      }
      tasksOrderMigratedThisLoad = true;
    }
    return { order: order.filter((id) => id !== LEGACY_PORTS_PANEL_ID && id !== LEGACY_SESSIONS_PANEL_ID), collapsed, sizes };
  } catch {
    return { ...DEFAULT_PANEL_STATE };
  }
}

// The sidebar's activity-bar-style tab strip (plans/sidebar-tabs.md): a
// fixed "explorer" tab holds the accordion below (sessions/files + any
// extension panel registered with location "explorer"), a fixed "run-view"
// tab holds a second accordion of location "run" panels (ports, tasks), a
// fixed "extensions-view" tab holds the Extensions browser/manager, and
// every registered extension sidebar panel — e.g. git-scm's Source Control —
// gets its own full-height tab instead of joining an accordion.
export const EXPLORER_TAB_ID = "explorer";
// Deliberately not "extensions" — that could collide with a future
// extension-registered panel id (which are namespaced ext.<id>.<panelId>,
// but a bare "extensions" is still worth avoiding for clarity).
export const EXTENSIONS_TAB_ID = "extensions-view";
// Unlike Explorer, this tab has no built-in sections: it only appears in the
// strip while some extension contributes a visible run panel (see
// visibleTabOrder). The literal must stay in sync with extensions.ts's own
// copy (importing it back would be circular).
export const RUN_TAB_ID = "run-view";
// Same contract as the Run tab: no built-in sections, appears only while an
// extension contributes a visible "commands" panel (command-history,
// snippets). The literal must stay in sync with extensions.ts's own copy.
export const COMMANDS_TAB_ID = "commands-view";
// All fixed tabs share every special-case below with EXPLORER_TAB_ID,
// which stays exported/used directly at each site since it's also the
// fallback "always exists" tab.
const CORE_TAB_IDS: readonly string[] = [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID];
const TABS_KEY = "sidebarTabs";

interface TabsState {
  order: string[];
  active: string;
}

const DEFAULT_TABS_STATE: TabsState = {
  order: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID],
  active: EXPLORER_TAB_ID,
};

// Guarantees all core tabs are present (Explorer → Run → Commands →
// Extensions) — shared by loadTabsState below and the synced-order-from-
// server apply effect, since neither localStorage nor the settings doc is
// guaranteed to have been written by a build that already knew about every
// core id.
function sanitizeTabsOrder(order: string[]): string[] {
  const next = [...order];
  if (!next.includes(EXPLORER_TAB_ID)) next.unshift(EXPLORER_TAB_ID);
  if (!next.includes(EXTENSIONS_TAB_ID)) {
    next.splice(next.indexOf(EXPLORER_TAB_ID) + 1, 0, EXTENSIONS_TAB_ID);
  }
  // Insertion order is the reverse of the target layout: each missing id
  // lands right after Explorer, so an order stored before these tabs
  // existed ends up on the default Explorer → Run → Commands → Extensions.
  if (!next.includes(COMMANDS_TAB_ID)) {
    next.splice(next.indexOf(EXPLORER_TAB_ID) + 1, 0, COMMANDS_TAB_ID);
  }
  if (!next.includes(RUN_TAB_ID)) {
    next.splice(next.indexOf(EXPLORER_TAB_ID) + 1, 0, RUN_TAB_ID);
  }
  return next;
}

function loadTabsState(): TabsState {
  try {
    const parsed = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TABS_STATE };
    const order: string[] =
      Array.isArray(parsed.order) && parsed.order.every((id: unknown) => typeof id === "string")
        ? sanitizeTabsOrder(parsed.order as string[])
        : [...DEFAULT_TABS_STATE.order];
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
  onKillWindow: (session: string, index: number) => void;
  // Backs ProjectList's projects.kill/rename/togglePin keyboard dispatch —
  // the same functions App.tsx already wires to the global session.*
  // commands (which act on the active tab), here acting on whichever row
  // has keyboard focus in the list instead.
  onKillSession: (name: string) => void;
  onRenameWindow: (session: string, win: TmuxWindow) => void;
  onTogglePinSession: (name: string) => void;
  onNewWindowInSession: (session: string) => void;
  onOpenLazygit: () => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  sessionMenuItems: (name: string) => MenuItem[];
  deadProjectMenuItems: (cwd: string) => MenuItem[];
  windowMenuItems: (session: string, window: TmuxWindow) => MenuItem[];
  projects: Project[];
  // Opens (or creates) the session rooted in this folder — dead-row clicks
  // and the recent-projects dropdown both land here.
  onOpenProject: (cwd: string) => void;
  // Opens the folder-picker dialog (App owns it) — the panel header's "+".
  onAddProject: () => void;
  // Builds the recent-projects dropdown items on demand (App wires in the
  // folder-picker opener) — shown via onShowMenu from the header button.
  recentProjectsMenu: () => MenuItem[];
  onOpenSettings: () => void;
  // The bottom terminal panel's toggle lives up here with the app's other
  // global chrome toggles (hide-sidebar below), not in a TabBar's actions —
  // that bar is rendered per editor group, so the button would duplicate in
  // every split pane.
  panelVisible: boolean;
  onTogglePanel: () => void;
  onCollapse: () => void;
  filesRootDir: string | null;
  // FILES-tree root mode: the active project's fixed folder, or the active
  // terminal's live cwd (follows `cd`). Toggled by the panel-header switch;
  // owned by App since the resolved root also feeds quick-switcher search.
  filesRootMode: "project" | "cwd";
  onFilesRootModeChange: (mode: "project" | "cwd") => void;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  filesRefreshKey: number;
  onFilesRefresh: () => void;
  onOpenFile: (path: string) => void;
  onPreviewFile: (path: string) => void;
  onEditFile: (path: string) => void;
  isPreviewable: (path: string) => boolean;
  fileHoverAction: (path: string) => "preview" | "edit" | null;
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
  // The app's built-in default registry (or null if disabled) — shown as a
  // non-removable source in the Extensions panel; see ExtensionsPanel.
  defaultRegistry: string | null;
  // Server-synced tab order (useSettingsSync's sidebarTabsOrder) — empty
  // until the user has dragged a tab on some device (see loadTabsState in
  // settings.ts). Applied once, the first time it arrives non-empty; every
  // actual reorder flows the other way via onTabsOrderChange, called only
  // from reorderTabs below (a real user drag), not from routine reconciliation.
  syncedTabsOrder: string[];
  onTabsOrderChange: (order: string[]) => void;
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
  // Threaded down to extension panels (e.g. the ports panel's Kill process action).
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>;
}

export default function Sidebar({
  width,
  sessions,
  activeSessionName,
  activeWindow,
  onOpenAllWindows,
  onOpenWindow,
  onKillWindow,
  onKillSession,
  onRenameWindow,
  onTogglePinSession,
  onNewWindowInSession,
  onOpenLazygit,
  onShowMenu,
  sessionMenuItems,
  deadProjectMenuItems,
  windowMenuItems,
  projects,
  onOpenProject,
  onAddProject,
  recentProjectsMenu,
  onOpenSettings,
  panelVisible,
  onTogglePanel,
  onCollapse,
  filesRootDir,
  filesRootMode,
  onFilesRootModeChange,
  onDropFiles,
  filesRefreshKey,
  onFilesRefresh,
  onOpenFile,
  onPreviewFile,
  onEditFile,
  isPreviewable,
  fileHoverAction,
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
  defaultRegistry,
  syncedTabsOrder,
  onTabsOrderChange,
  registryCatalog,
  registryLoading,
  onEnsureRegistryLoaded,
  onRefreshRegistry,
  onOpenExtensionPage,
  extensionUpdatesCount,
  resolvedBindings,
  confirmDialog,
}: Props) {
  const projectListRef = useRef<ProjectListHandle>(null);
  const [panelState, setPanelState] = useState<PanelState>(loadPanelState);
  const [tabsState, setTabsState] = useState<TabsState>(loadTabsState);
  // Applies the settings-doc-synced tab order once, the first time it shows
  // up non-empty — either a real cross-device restore (the server fetch in
  // useSettingsSync resolving with a previously-saved order) or a same-tab
  // echo of a drag this Sidebar instance just reported via onTabsOrderChange
  // (harmless: sameAsCurrent below no-ops it). Only fires once per mount so
  // it can't fight later local drags by re-applying a now-stale synced value.
  const appliedSyncedTabsOrderRef = useRef(false);
  useEffect(() => {
    if (appliedSyncedTabsOrderRef.current || syncedTabsOrder.length === 0) return;
    appliedSyncedTabsOrderRef.current = true;
    setTabsState((prev) => {
      const sameAsCurrent =
        prev.order.length === syncedTabsOrder.length &&
        prev.order.every((id, i) => id === syncedTabsOrder[i]);
      return sameAsCurrent ? prev : { ...prev, order: sanitizeTabsOrder(syncedTabsOrder) };
    });
  }, [syncedTabsOrder]);
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
    projects: null,
    files: null,
  });

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
  const tabPanels = extensionPanels.filter((p) => p.location === "tab");
  const explorerPanels = extensionPanels.filter((p) => p.location === "explorer");
  const runPanels = extensionPanels.filter((p) => p.location === "run");
  const commandsPanels = extensionPanels.filter((p) => p.location === "commands");
  // All accordions share one panelState (order/collapse/sizes keyed by the
  // panel's namespaced id) and one set of panel refs — each tab renders the
  // subset of that order belonging to its own location. Lookups that don't
  // care which accordion a section lives in (title, default collapse,
  // content) go through this combined list.
  const accordionPanels = [...explorerPanels, ...runPanels, ...commandsPanels];
  useEffect(() => {
    setTabsState((prev) => {
      const order = [...prev.order];
      for (const panel of tabPanels) if (!order.includes(panel.id)) order.push(panel.id);
      return { ...prev, order };
    });
    // Same never-prune reconciliation for accordion-located panels (both
    // tabs' sections) joining the shared order — see the tab effect's
    // comment above for why pruning here is a reload-race hazard. A panel
    // declaring `order` is inserted before same-location panels with a
    // greater (or no) declared order (undeclared sorts last), so the default
    // section ordering doesn't depend on async activation timing; ids
    // already stored never move — user drags win.
    setPanelState((prev) => {
      const order = [...prev.order];
      const panelsById = new Map(accordionPanels.map((p) => [p.id, p]));
      for (const panel of accordionPanels) {
        if (order.includes(panel.id)) continue;
        let at = order.length;
        if (panel.order !== undefined) {
          const idx = order.findIndex((id) => {
            const other = panelsById.get(id);
            return (
              other !== undefined &&
              other.location === panel.location &&
              (other.order === undefined || other.order > panel.order!)
            );
          });
          if (idx !== -1) at = idx;
        }
        order.splice(at, 0, panel.id);
      }
      return order.length === prev.order.length ? prev : { ...prev, order };
    });
    // tabPanels/accordionPanels are fresh arrays each render; extensionPanels
    // is the registry-tick-memoized source they derive from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionPanels]);
  const [dragPanelId, setDragPanelId] = useState<PanelId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: PanelId; edge: "top" | "bottom" } | null>(
    null,
  );
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
    localStorage.setItem(PANELS_KEY, JSON.stringify(panelState));
  }, [panelState]);

  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabsState));
  }, [tabsState]);

  const extPanelIds = new Set(tabPanels.map((p) => p.id));
  // The Run and Commands tabs carry no built-in sections, so an empty one
  // would be a dead strip icon: each shows only while some extension
  // contributes a section that isn't hidden (ctx.app.setSidebarPanelVisible).
  const hasVisibleRunPanel = runPanels.some((p) => !p.hidden);
  const hasVisibleCommandsPanel = commandsPanels.some((p) => !p.hidden);
  // Filters out a stale tab id (its extension disabled/uninstalled, or one
  // still activating on this render) — same "don't mutate storage, just
  // don't render it" approach as the accordion's visibleOrder.
  const visibleTabOrder = tabsState.order.filter((id) =>
    id === RUN_TAB_ID
      ? hasVisibleRunPanel
      : id === COMMANDS_TAB_ID
        ? hasVisibleCommandsPanel
        : CORE_TAB_IDS.includes(id) || extPanelIds.has(id),
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
      const nextVisible = moveId(visibleTabOrder, draggedId, toIndex);
      // Ids absent from the strip right now — a stale one (its extension
      // disabled/uninstalled) or the Run tab while it has no visible
      // sections — ride along at their stored index, so a reorder can
      // neither prune them nor silently relocate a Run tab that's about to
      // come back.
      const nextOrder = [...nextVisible];
      for (const id of prev.order) {
        if (nextOrder.includes(id)) continue;
        nextOrder.splice(Math.min(prev.order.indexOf(id), nextOrder.length), 0, id);
      }
      // Only an actual drag pushes to the synced store — not the
      // reconciliation effect below (a newly-enabled extension appending its
      // panel id shouldn't itself trigger a sync write on every load).
      onTabsOrderChange(nextOrder);
      return { ...prev, order: nextOrder };
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
    if (id === RUN_TAB_ID) {
      return { id, title: `Run${shortcutSuffix("sidebar.focusRun")}`, icon: "run-all" };
    }
    if (id === COMMANDS_TAB_ID) {
      return { id, title: `Commands${shortcutSuffix("sidebar.focusCommands")}`, icon: "terminal" };
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

  // Effective collapse state: an id with no stored entry falls back to the
  // extension panel's declared defaultCollapsed (the built-ins always have a
  // stored/default entry via DEFAULT_PANEL_STATE).
  const isPanelCollapsed = (id: PanelId): boolean =>
    panelState.collapsed[id] ?? accordionPanels.find((p) => p.id === id)?.defaultCollapsed ?? false;

  const togglePanelCollapsed = (id: PanelId) => {
    const next = !isPanelCollapsed(id);
    setPanelState((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [id]: next },
    }));
  };

  // Lets "Sidebar: Focus Projects" (App.tsx's globalHandlers, via
  // extensions.ts's focusProjectsPanel) expand this accordion panel and
  // hand off to ProjectList's own focusList — see setProjectsFocusBridge's
  // doc comment for why this lives in extensions.ts rather than being
  // called directly (App.tsx doesn't otherwise know about Sidebar's
  // internal panelState/ProjectList). Read via a ref (not the closed-over
  // panelState) since the bridge effect below only re-registers on mount.
  const panelStateRef = useRef(panelState);
  panelStateRef.current = panelState;
  // A collapsed panel unmounts ProjectList (panelContent's `!isCollapsed`
  // guard) — expanding it and calling focusList in the same tick would hit
  // a stale/null ref, since the DOM hasn't updated yet. Deferred here to the
  // next render where the panel is actually expanded and ProjectList has
  // (re)mounted.
  const pendingProjectsFocusRef = useRef(false);
  useEffect(() => {
    if (!panelState.collapsed.projects && pendingProjectsFocusRef.current) {
      pendingProjectsFocusRef.current = false;
      projectListRef.current?.focusList();
    }
  }, [panelState.collapsed.projects]);
  useEffect(() => {
    setProjectsFocusBridge({
      focus: () => {
        if (panelStateRef.current.collapsed.projects) {
          pendingProjectsFocusRef.current = true;
          setPanelState((prev) => ({ ...prev, collapsed: { ...prev.collapsed, projects: false } }));
        } else {
          projectListRef.current?.focusList();
        }
      },
    });
    return () => setProjectsFocusBridge(null);
  }, []);

  // Generic bridge for accordion-located extension panels' focus commands,
  // in either tab (panel ids are unique, and collapse state/panel refs are
  // shared): expand the section if collapsed, then move
  // focus onto the first focusable row inside its content. An extension
  // component can't expose an imperative focusList handle through the
  // generic render, so "first roving-tabindex stop" is the contract — the
  // same landing spot ProjectList/PortsPanel's own focusList pick when
  // nothing was focused yet. Expansion unmounts→mounts content, so the
  // focus is deferred one render, mirroring the sessions bridge above.
  const pendingExplorerFocusRef = useRef<string | null>(null);
  const focusExplorerPanelContent = (panelId: string) => {
    const content = panelRefs.current[panelId]?.querySelector<HTMLElement>(
      '.panel-content [tabindex="0"], .panel-content button, .panel-content [href], .panel-content input',
    );
    content?.focus();
  };
  useEffect(() => {
    const pending = pendingExplorerFocusRef.current;
    if (pending && panelState.collapsed[pending] === false) {
      pendingExplorerFocusRef.current = null;
      focusExplorerPanelContent(pending);
    }
  }, [panelState.collapsed]);
  useEffect(() => {
    setExplorerPanelFocusBridge({
      focus: (panelId) => {
        if (panelStateRef.current.collapsed[panelId] !== false) {
          pendingExplorerFocusRef.current = panelId;
          setPanelState((prev) => ({ ...prev, collapsed: { ...prev.collapsed, [panelId]: false } }));
        } else {
          focusExplorerPanelContent(panelId);
        }
      },
    });
    return () => setExplorerPanelFocusBridge(null);
  }, []);

  const panelTitle = (id: PanelId): string => {
    if (id === "projects") return "Projects";
    if (id === "files") return filesRootDir ?? "Files";
    return accordionPanels.find((p) => p.id === id)?.title ?? id;
  };

  const panelActions = (id: PanelId) => {
    if (id === "projects") {
      return (
        <>
          <button
            className="icon-button"
            title="Open Recent…"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onShowMenu(rect.left, rect.bottom + 4, recentProjectsMenu());
            }}
          >
            <Icon name="history" />
          </button>
          <button className="icon-button" title="New Project…" onClick={onAddProject}>
            <Icon name="add" />
          </button>
        </>
      );
    }
    if (id === "files") {
      return (
        <>
          <button
            className={`icon-button mode-button${filesRootMode === "project" ? " active" : ""}`}
            title="Files in project folder"
            onClick={() => onFilesRootModeChange("project")}
          >
            <Icon name="root-folder" />
          </button>
          <button
            className={`icon-button mode-button${filesRootMode === "cwd" ? " active" : ""}`}
            title="Files in terminal's folder (follows cd)"
            onClick={() => onFilesRootModeChange("cwd")}
          >
            <Icon name="terminal" />
          </button>
          <button className="icon-button" title="Refresh" onClick={onFilesRefresh}>
            <Icon name="refresh" />
          </button>
        </>
      );
    }
    // Extension accordion sections put their own header buttons into the
    // actions container via the actionsTarget portal instead.
    return null;
  };

  const panelContent = (id: PanelId) => {
    if (id === "projects") {
      return (
        <ProjectList
          ref={projectListRef}
          sessions={sessions}
          activeSessionName={activeSessionName}
          activeWindow={activeWindow}
          projects={projects}
          onOpenAllWindows={onOpenAllWindows}
          onOpenWindow={onOpenWindow}
          onKillWindow={onKillWindow}
          onKillSession={onKillSession}
          onRenameWindow={onRenameWindow}
          onTogglePinSession={onTogglePinSession}
          onNewWindowInSession={onNewWindowInSession}
          onOpenProject={onOpenProject}
          onShowMenu={onShowMenu}
          sessionMenuItems={sessionMenuItems}
          deadProjectMenuItems={deadProjectMenuItems}
          windowMenuItems={windowMenuItems}
          extensionWindowActions={extensionWindowActions}
          resolvedBindings={resolvedBindings}
        />
      );
    }
    if (id === "files") {
      return (
        <FileTree
          rootDir={filesRootDir}
          onDropFiles={onDropFiles}
          refreshKey={filesRefreshKey}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
          onEditFile={onEditFile}
          isPreviewable={isPreviewable}
          fileHoverAction={fileHoverAction}
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
    const extPanel = accordionPanels.find((p) => p.id === id);
    if (extPanel) {
      const PanelComponent = extPanel.component;
      return (
        <PanelComponent
          actionsTarget={extPanelActionsEls[id] ?? null}
          showMenu={onShowMenu}
          confirmDialog={confirmDialog}
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

  // The FILES header branch pill, sourced from extension root decorations
  // (git-scm's file-decoration provider) — the app re-renders on registry
  // notify (App's useExtensionRegistry tick feeds the extensionPanels prop),
  // so a provider refresh() lands here without a dedicated subscription.
  const filesBranch = filesRootDir ? (getRootDecorations(filesRootDir)[0]?.label ?? null) : null;

  const renderPanel = (id: PanelId, nextId: PanelId | null) => {
    const isCollapsed = isPanelCollapsed(id);
    const showSplitterAfter = !isCollapsed && nextId !== null && !isPanelCollapsed(nextId);
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

  // panelState.order is shared by both accordions and may contain stale ids
  // (a disabled extension's section, an id from before extension panels moved
  // into their own tab, or a section belonging to the other tab) — filtering
  // here (rather than mutating storage) makes them inert without a prune,
  // same rationale as visibleTabOrder. A `hidden` section is filtered the
  // same way: the extension asked for it to be absent, not forgotten.
  const explorerPanelIds = new Set(explorerPanels.filter((p) => !p.hidden).map((p) => p.id));
  const visibleOrder = panelState.order.filter(
    (id) => PANEL_IDS.includes(id) || explorerPanelIds.has(id),
  );
  const runPanelIds = new Set(runPanels.filter((p) => !p.hidden).map((p) => p.id));
  const visibleRunOrder = panelState.order.filter((id) => runPanelIds.has(id));
  const commandsPanelIds = new Set(commandsPanels.filter((p) => !p.hidden).map((p) => p.id));
  const visibleCommandsOrder = panelState.order.filter((id) => commandsPanelIds.has(id));

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
          <PanelComponent
            actionsTarget={extPanelActionsEls[panel.id] ?? null}
            showMenu={onShowMenu}
            confirmDialog={confirmDialog}
          />
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
          {/* Filled while the panel is open, outline while closed — same
              state convention as VS Code's own layout toggles. */}
          <Icon name={panelVisible ? "layout-panel" : "layout-panel-off"} />
        </button>
        <button
          className="icon-button"
          title={`Hide sidebar${shortcutSuffix("sidebar.toggle")}`}
          onClick={onCollapse}
        >
          {/* Always filled: this button only renders while the sidebar is
              open (the collapsed state's affordance is App's 4px
              .sidebar-reopen strip, which has no icon at all). */}
          <Icon name="layout-sidebar-left" />
        </button>
      </div>
      {activeTabId === EXPLORER_TAB_ID ? (
        <div className="sidebar-panels">
          {visibleOrder.map((id, idx) => renderPanel(id, visibleOrder[idx + 1] ?? null))}
        </div>
      ) : activeTabId === RUN_TAB_ID ? (
        <div className="sidebar-panels">
          {visibleRunOrder.map((id, idx) => renderPanel(id, visibleRunOrder[idx + 1] ?? null))}
        </div>
      ) : activeTabId === COMMANDS_TAB_ID ? (
        <div className="sidebar-panels">
          {visibleCommandsOrder.map((id, idx) => renderPanel(id, visibleCommandsOrder[idx + 1] ?? null))}
        </div>
      ) : activeTabId === EXTENSIONS_TAB_ID ? (
        <ExtensionsPanel
          extensions={extensions}
          onReloadExtensions={onReloadExtensions}
          registries={extensionRegistries}
          onRegistriesChange={onExtensionRegistriesChange}
          defaultRegistry={defaultRegistry}
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
