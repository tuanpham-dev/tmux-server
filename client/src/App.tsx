import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import BottomPanel from "./components/BottomPanel";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import ExtensionPageView from "./components/ExtensionPageView";
import Icon from "./components/Icon";
import KeyboardShortcutsView from "./components/KeyboardShortcutsView";
import QuickSwitcher, { type PaletteCommand } from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SplitLayout from "./components/SplitLayout";
import TerminalView from "./components/TerminalView";
import { EXPLORER_TAB_ID, EXTENSIONS_TAB_ID } from "./components/Sidebar";
import { getContextGetter, setContextKey } from "./contextKeys";
import { focusSidebarTab, setSidebarVisibleHandler, useExtensionRegistry } from "./extensions";
import { useDialogs } from "./hooks/useDialogs";
import { useFileActions } from "./hooks/useFileActions";
import { useFileOpeners } from "./hooks/useFileOpeners";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";
import { COMMANDS, formatBinding } from "./keybindings";
import { DEFAULT_SETTINGS } from "./settings";
import { evaluateWhen } from "./whenClause";
import { useBottomPanel } from "./hooks/useBottomPanel";
import { useSessionActions } from "./hooks/useSessionActions";
import { useSessions } from "./hooks/useSessions";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTabGroups } from "./hooks/useTabGroups";
import { useTabs } from "./hooks/useTabs";
import { useThemeAssets } from "./hooks/useThemeAssets";
import type { MenuItem, MenuState, RegistrySourceResult } from "./types";
import { groupKeyForTab, isRealTab } from "./lib/tabs";
import { leaves } from "./lib/splits";
import { compareVersions } from "./lib/version";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

// The server templates the real app name (see APP_NAME in server/.env) into
// index.html's <title> before this module ever loads, so capturing it here
// — before the effect below overwrites it — picks up any custom name.
const APP_NAME = document.title;

// Commands that exist for Settings → Keyboard (rebindable) and their own
// component's direct dispatch, but make no sense as a palette entry to
// "run" — see paletteCommands' comment below.
const NON_PALETTE_IDS = new Set([
  "quickSwitcher.selectNext",
  "quickSwitcher.selectPrevious",
  ...Array.from({ length: 9 }, (_, i) => `tab.focus${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `group.focus${i + 1}`),
]);

export default function App() {
  // Declared first so useSessions (which needs showError) and the files
  // concern below (filesRefreshKey, piggybacked on the session poll) are
  // both available before that hook call.
  const [error, setError] = useState<string | null>(null);
  const showError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // refreshClipboardMirror itself comes from useFileActions, called much
  // later in this component (it needs setFilesRefreshKey, declared here) —
  // a ref bridges that ordering gap, same pattern as useBottomPanel's
  // panelRef: populated every render, read from the stable callback below.
  const refreshClipboardMirrorRef = useRef<() => void>(() => {});
  // Piggybacks on the session poll so git status badges in the FILES panel
  // (and, via the ref above, the FILES-tree cut-clipboard mirror) stay live
  // without a second timer. Must be a stable useCallback, not an inline
  // arrow — an unstable identity here would change useSessions' internal
  // `refresh` callback's identity every render, retriggering its mount
  // effect (and firing a fresh fetch) on every render instead of once every
  // 3s.
  const onSessionsRefreshed = useCallback(() => {
    setFilesRefreshKey((k) => k + 1);
    refreshClipboardMirrorRef.current();
  }, []);

  const { sessions, refresh, sessionsLoadedRef } = useSessions(showError, onSessionsRefreshed);

  const [menu, setMenu] = useState<MenuState | null>(null);
  // Each editor group's own TabBar right-side actions container — an image
  // tab portals its zoom toolbar into its own group's bar while active (VS
  // Code/code-server editor-actions placement). State (not a plain ref)
  // because the portaling viewer needs to re-render once its group's element
  // becomes non-null on first mount. Keyed by groupId — mirrors Sidebar.tsx's
  // extPanelActionsEls/getActionsRefCallback pattern for the same reason: a
  // fresh inline ref closure per render would re-trigger the state update
  // every render and loop forever (caught live there, not by inspection).
  const [groupActionsEls, setGroupActionsEls] = useState<Record<string, HTMLDivElement | null>>({});
  const groupActionsRefCallbacks = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  const getGroupActionsRef = useCallback((groupId: string) => {
    let cb = groupActionsRefCallbacks.current[groupId];
    if (!cb) {
      cb = (el) => {
        setGroupActionsEls((prev) => (prev[groupId] === el ? prev : { ...prev, [groupId]: el }));
      };
      groupActionsRefCallbacks.current[groupId] = cb;
    }
    return cb;
  }, []);
  // Each editor group's own content-area rect, in viewport pixels — every
  // tab's actual content component (terminal/viewer/settings) renders in a
  // flat, never-reshaping list (see the tabs.map(...) below) positioned via
  // this rect, rather than nested inside SplitLayout's recursive tree.
  // SplitLayout's tree reshapes (leaf <-> branch) as groups split/merge,
  // which changes the rendered element TYPE at that tree position — React
  // can't reconcile across a type change, so it unmounts and rebuilds the
  // whole subtree, and even a stable DOM node "identity" (e.g. a portal
  // target inside that subtree) doesn't survive since the node itself gets
  // destroyed. Content therefore only ever lives in App's own flat list,
  // and .split-leaf-content (still nested in the tree) is a pure layout
  // spacer we measure, not a mount point — caught live via a dirty CSV
  // tab's edit resetting on its very first split, not by inspection.
  const [groupContentRects, setGroupContentRects] = useState<Record<string, DOMRect | null>>({});
  const groupContentObservers = useRef<Record<string, ResizeObserver>>({});
  // Cached per groupId, same as getGroupActionsRef above — a fresh inline
  // ref closure every render makes React detach+reattach the ref (identity
  // changed) on every render, which re-triggers the ResizeObserver
  // setup/measure below every time and loops forever (caught live as a
  // "Maximum update depth exceeded" crash, not by inspection).
  const groupContentSlotRefCallbacks = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  const getGroupContentSlotRef = useCallback((groupId: string) => {
    let cb = groupContentSlotRefCallbacks.current[groupId];
    if (!cb) {
      cb = (el) => {
        groupContentObservers.current[groupId]?.disconnect();
        delete groupContentObservers.current[groupId];
        if (!el) {
          setGroupContentRects((prev) => (prev[groupId] == null ? prev : { ...prev, [groupId]: null }));
          return;
        }
        const measure = () => {
          setGroupContentRects((prev) => ({ ...prev, [groupId]: el.getBoundingClientRect() }));
        };
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        groupContentObservers.current[groupId] = observer;
        measure();
      };
      groupContentSlotRefCallbacks.current[groupId] = cb;
    }
    return cb;
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("sidebarWidth"));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : 260;
  });

  useEffect(() => {
    localStorage.setItem("sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  const [sidebarVisible, setSidebarVisible] = useState(
    () => localStorage.getItem("sidebarVisible") !== "false",
  );

  useEffect(() => {
    localStorage.setItem("sidebarVisible", String(sidebarVisible));
  }, [sidebarVisible]);

  // Lets focusSidebarTab (driven by sidebar.focusExplorer and every
  // extension panel's own focusBinding command) reveal a hidden sidebar, or
  // hide it again when re-pressed on the already-active tab. A ref keeps
  // isVisible() fresh for the mount-once-registered handler, matching
  // useGlobalKeybindings' bindingsRef freshness pattern.
  const sidebarVisibleRef = useRef(sidebarVisible);
  useEffect(() => {
    sidebarVisibleRef.current = sidebarVisible;
  }, [sidebarVisible]);

  // Keep the app exactly as tall as the visible viewport. dvh plus the
  // interactive-widget meta should do this alone, but on Android they
  // don't dependably shrink when the on-screen keyboard opens (notably in
  // installed PWAs) — the app then paints taller than the screen: prompt
  // and touch key bar behind the keyboard until something else forces a
  // re-layout. visualViewport is authoritative everywhere, so mirror its
  // height into --app-height (consumed by .app) and undo any pan the
  // browser applied to reveal the focused field — this is a fixed layout
  // that must stay pinned at 0,0.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      // height × scale recovers the layout-viewport height, so a
      // pinch-zoom leaves the app alone while the keyboard/URL-bar case
      // (scale 1) tracks the visible height exactly. No scale bail-out: a
      // device stuck at a not-quite-1 scale would otherwise never get the
      // variable set at all.
      const h = Math.round(vv.height * vv.scale);
      document.documentElement.style.setProperty("--app-height", `${h}px`);
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // Some browsers move the keyboard/orientation resize through window
    // resize without a matching visualViewport event — listen to both.
    window.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  // A fast horizontal flick anywhere toggles the sidebar on touch devices
  // (where the sidebar.toggle keybinding isn't reachable): left→right
  // opens, right→left closes. Deliberately a passive observer — slower
  // horizontal drags keep belonging to whatever they're over (terminal
  // hscroll, tree marquee, tab drag); the velocity gate is what separates
  // a flick from those. Capture phase so the decision still sees the
  // touchend the terminal swallows after one of its own scrolls.
  useEffect(() => {
    const MIN_DX_PX = 60;
    const MIN_VELOCITY_PX_PER_MS = 0.6;
    let start: { x: number; y: number; t: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      start =
        e.touches.length === 1
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() }
          : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const g = start;
      start = null;
      // Only a clean single-finger gesture counts: no fingers left down,
      // exactly one lifted.
      if (!g || e.touches.length > 0 || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - g.x;
      const dy = e.changedTouches[0].clientY - g.y;
      const dt = Math.max(1, performance.now() - g.t);
      if (Math.abs(dx) < MIN_DX_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * 2) return;
      if (Math.abs(dx) / dt < MIN_VELOCITY_PX_PER_MS) return;
      if (dx > 0 && !sidebarVisibleRef.current) setSidebarVisible(true);
      else if (dx < 0 && sidebarVisibleRef.current) setSidebarVisible(false);
    };
    const onTouchCancel = () => {
      start = null;
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", onTouchCancel, true);
    return () => {
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchCancel, true);
    };
  }, []);

  useEffect(() => {
    setSidebarVisibleHandler({
      isVisible: () => sidebarVisibleRef.current,
      setVisible: setSidebarVisible,
    });
    return () => setSidebarVisibleHandler(null);
  }, []);

  // Extension-registered commands/viewers/panels (extensions.ts) — commands
  // join the built-in list inside useSettingsSync (always "global" scope in
  // v1, namespaced ext.<extensionId>.<cmd> so they can't collide with a
  // built-in id); fileViewers/sidebarPanels are consumed further down.
  const {
    commands: extCommands,
    fileViewers: extFileViewers,
    sidebarPanels: extSidebarPanels,
    windowActions: extWindowActions,
  } = useExtensionRegistry();

  const {
    settings,
    setSettings,
    settingsRef,
    keybindingOverrides,
    setKeybindingOverrides,
    resolvedBindings,
    bindingsRef,
    overridesRef,
    extensionSettings,
    setExtensionSettings,
    extensionSettingsRef,
    pinnedSessions,
    setPinnedSessions,
    commandUsage,
    setCommandUsage,
    extensionRegistries,
    setExtensionRegistries,
  } = useSettingsSync(extCommands);

  const { extensions, reloadExtensions, activeTerminalTheme, fontsVersion } =
    useThemeAssets(settings, extensionSettings, extensionSettingsRef);

  // Extension registry catalog (server/src/registry.ts) — fetched lazily on
  // the Extensions sidebar tab's first activation (see ensureRegistryLoaded)
  // rather than eagerly here, so a session that never opens that tab never
  // pays for it. Lives at this App level (not inside ExtensionsPanel) so the
  // extension detail-page tab below can read the same fetched catalog
  // without a second, redundant request for the same data.
  const [registryCatalog, setRegistryCatalog] = useState<RegistrySourceResult[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const registryFetchedRef = useRef(false);

  // `sourcesOverride` lets a just-added/removed registry source refresh
  // immediately against the list being persisted, not extensionRegistries'
  // current (pre-edit) closure value — see ExtensionsPanel's addRegistry and
  // api.fetchRegistry's doc comment.
  const refreshRegistry = useCallback((refresh: boolean, sourcesOverride?: string[]) => {
    setRegistryLoading(true);
    api
      .fetchRegistry(refresh, sourcesOverride ?? extensionRegistries)
      .then((sources) => {
        setRegistryCatalog(sources);
        registryFetchedRef.current = true;
      })
      .catch(() => {})
      .finally(() => setRegistryLoading(false));
  }, [extensionRegistries]);

  const ensureRegistryLoaded = useCallback(() => {
    if (registryFetchedRef.current) return;
    refreshRegistry(false);
  }, [refreshRegistry]);

  // Available-updates count (registry version > installed version) — the
  // Extensions tab's badge, visible even before that tab is ever opened this
  // session as long as registryCatalog has already been fetched. Scoped to
  // extensionRegistries' current membership so a just-removed source's
  // still-cached catalog entries (stale until the next refetch) can't keep
  // counting toward the badge — mirrors ExtensionsPanel's liveRegistryCatalog.
  const extensionUpdatesCount = useMemo(() => {
    let count = 0;
    for (const src of registryCatalog) {
      if (!extensionRegistries.includes(src.source)) continue;
      for (const entry of src.entries) {
        const installed = extensions.find((e) => e.id === entry.id);
        if (installed && compareVersions(entry.version, installed.version) > 0) count++;
      }
    }
    return count;
  }, [registryCatalog, extensions, extensionRegistries]);

  // The extension detail page's "Extension Settings" shortcut — see
  // SettingsView's pendingFocusExtensionId prop doc.
  const [pendingFocusExtensionId, setPendingFocusExtensionId] = useState<string | null>(null);

  const { dialog, confirmDialog, promptDialog } = useDialogs();

  // Any editor-side activation — a tab opened from the sidebar/palette, a tab
  // bar click, a group-focus chord — hands keyboard focus back to the editor,
  // even when the bottom panel currently holds it. A pointer-down straight
  // into an editor pane is already covered by the content hosts' own handler;
  // this catches every path that activates a tab *without* clicking into it,
  // which would otherwise open a terminal in the editor while the user's
  // keystrokes kept going to the panel (caught live in QA, not by inspection).
  // Nothing on the panel side touches activeTabId/activeGroupId, so a change
  // here is always editor-driven.
  const editorSelectionRef = useRef<string | null>(null);

  const {
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    lastRealTabIdRef,
    mruTabIdsRef,
    dirtyTabsRef,
    insertTab,
    openSession,
    openExtViewerTab,
    openSettingsTab,
    openKeyboardShortcutsTab,
    openExtensionPageTab,
    openWindowTab,
    openAllWindows,
    closeTab,
    cycleTab,
    moveTab,
    closeOtherTabs,
    reopenClosedTab,
    activeTab,
    activeRealTab,
    activeSession,
    activeWindow,
    filesRootDir,
    tabLabel,
    tabActivity,
    openSwitchedSession,
    activeGroupTabs,
    splitTree,
    activeGroupId,
    groupActive,
    focusGroup,
    resizeBranch,
    splitGroup,
    moveTabToGroup,
    moveTabToAdjacentGroup,
    splitGroupAndMoveTab,
  } = useTabs(
    sessions,
    sessionsLoadedRef,
    showError,
    confirmDialog,
    settingsRef,
    extFileViewers,
    extensions,
    registryCatalog,
  );

  // Extension window-action buttons for a group's own active tab, rendered
  // in that group's tab bar (see TabBar.tsx's extras slot) — the tab-bar
  // counterpart to the SESSIONS-row icon (Sidebar.tsx), reusing the exact
  // same isVisible(ctx)/onClick(ctx) registration, just gated on
  // showInTabBar and evaluated against whichever window the group's active
  // tab currently points at instead of a row. A whole-session tab (no
  // windowIndex) resolves to that session's tmux-active window, mirroring
  // useTabs' own activeWindow fallback. Plain per-render computation, not
  // memoized against a ref — cheap (a handful of tabs/windows), and unlike
  // getGroupActionsRef above this returns nodes, not a DOM ref callback, so
  // there's no re-render-loop risk from a fresh closure identity.
  const tabExtrasFor = useCallback(
    (groupId: string): React.ReactNode => {
      if (extWindowActions.length === 0) return null;
      const activeId = groupActive[groupId];
      const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
      if (!tab || !isRealTab(tab)) return null;
      const session = sessions.find((s) => s.name === tab.sessionName);
      if (!session) return null;
      const window =
        tab.windowIndex !== undefined
          ? session.windows.find((w) => w.index === tab.windowIndex)
          : session.windows.find((w) => w.active);
      if (!window) return null;
      const ctx = { sessionName: session.name, windowIndex: window.index, cwd: window.cwd, command: window.command };
      const actions = extWindowActions.filter((a) => a.showInTabBar && a.isVisible(ctx));
      if (actions.length === 0) return null;
      return (
        <>
          {actions.map((action) => (
            <button
              key={action.id}
              className="tab-bar-window-action"
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(ctx);
              }}
            >
              <Icon name={action.icon} />
            </button>
          ))}
        </>
      );
    },
    [extWindowActions, groupActive, tabs, sessions],
  );

  // A merged-away editor group's DOM node unmounting already disconnects its
  // ResizeObserver and nulls its rect (getGroupContentSlotRef's ref callback
  // above), but the callback closure itself and the null rect entry are never
  // removed — without this, groupContentSlotRefCallbacks/groupContentRects
  // grow by one dead entry per group id ever created for the page's
  // lifetime. Deletes only ids no longer in the live tree, so surviving
  // groups' ref-callback identities stay stable (required — see
  // getGroupContentSlotRef's comment on the re-render loop that an unstable
  // identity would cause).
  useEffect(() => {
    const live = new Set(leaves(splitTree));
    for (const groupId of Object.keys(groupContentSlotRefCallbacks.current)) {
      if (live.has(groupId)) continue;
      groupContentObservers.current[groupId]?.disconnect();
      delete groupContentObservers.current[groupId];
      delete groupContentSlotRefCallbacks.current[groupId];
    }
    setGroupContentRects((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [groupId, rect] of Object.entries(prev)) {
        if (live.has(groupId)) next[groupId] = rect;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [splitTree]);

  const {
    openPreviewViewerTab,
    isPreviewable,
    openFileInSession,
    openFileOrViewer,
    openFileOrViewerSecondary,
  } = useFileOpeners(
    activeRealTab,
    extFileViewers,
    showError,
    refresh,
    openWindowTab,
    setActiveTabId,
    openExtViewerTab,
    setFilesRefreshKey,
  );

  const { tabGroupState, toggleGroupCollapsed, closeGroupTabs, groupMenuItems, renameGroup, moveGroup } = useTabGroups(
    tabs,
    tabsRef,
    setTabs,
    activeTabId,
    setActiveTabId,
    mruTabIdsRef,
    dirtyTabsRef,
    sessions,
    sessionsLoadedRef,
    settingsRef,
    settings.tabGroupsBySession,
    confirmDialog,
  );

  // The bottom terminal panel (plans/bottom-terminal-panel.md) — its own state
  // model, separate from the editor's tabs/split tree, since it only ever
  // holds terminals and only ever splits side-by-side.
  const {
    panel,
    panelFocused,
    setPanelFocused,
    togglePanel,
    showPanel,
    hidePanel,
    setHeight: setPanelHeight,
    selectTab: selectPanelTab,
    selectPane: selectPanelPane,
    resizePanes: resizePanelPanes,
    newTerminal,
    newTerminalInFreshSession,
    splitActivePane,
    closeTab: closePanelTab,
    removePane: removePanelPane,
  } = useBottomPanel(sessions, sessionsLoadedRef, showError);

  // See editorSelectionRef's comment above. Skips its own first run, so the
  // panel keeps focus across a reload that restores it.
  useEffect(() => {
    const selection = `${activeGroupId}:${activeTabId ?? ""}`;
    if (editorSelectionRef.current === null) {
      editorSelectionRef.current = selection;
      return;
    }
    if (editorSelectionRef.current === selection) return;
    editorSelectionRef.current = selection;
    setPanelFocused(false);
  }, [activeGroupId, activeTabId, setPanelFocused]);

  // null = closed; otherwise the string to seed the switcher's input with —
  // "" for a plain tab/window/session switch, ">" for the command palette.
  const [switcherQuery, setSwitcherQuery] = useState<string | null>(null);

  // Right-click anywhere without a dedicated context menu (empty terminal
  // space, tab bar gaps, etc.) would otherwise show the browser's native
  // menu, which has no useful actions in this app.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Only the FILES panel is a real drop target; it calls preventDefault +
  // stopPropagation on valid drops, so this never runs for those. Without it,
  // a file dropped anywhere else (terminal, tab bar, sidebar top bar) hits no
  // handler at all and the browser falls back to its default action —
  // navigating the whole tab away to the dropped file.
  useEffect(() => {
    const blockStrayFileDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", blockStrayFileDrop);
    window.addEventListener("drop", blockStrayFileDrop);
    return () => {
      window.removeEventListener("dragover", blockStrayFileDrop);
      window.removeEventListener("drop", blockStrayFileDrop);
    };
  }, []);

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const showMenu = useCallback((x: number, y: number, items: MenuItem[]) => {
    setMenu({ x, y, items });
  }, []);

  // Opens a panel terminal, resolving which session its new tmux window goes
  // in: the active real tab's session when there is one, otherwise a picker at
  // `anchor` (the + button, or the panel's own top-left for the keyboard
  // command) — the panel never guesses a session on the user's behalf.
  const requestPanelTerminal = useCallback(
    (anchor: { x: number; y: number }) => {
      if (activeRealTab) {
        newTerminal(activeRealTab.sessionName);
        return;
      }
      const items: MenuItem[] = [
        ...sessions.map((s) => ({
          label: s.name,
          onClick: () => newTerminal(s.name),
        })),
        { label: "New Session…", onClick: () => newTerminalInFreshSession() },
      ];
      showMenu(anchor.x, anchor.y, items);
    },
    [activeRealTab, sessions, newTerminal, newTerminalInFreshSession, showMenu],
  );

  const {
    createSession,
    killSession,
    renameSession,
    createWindow,
    selectWindowInSession,
    renameWindow,
    killWindow,
    togglePinSession,
    restorePinnedSession,
    sessionMenuItems,
    windowMenuItems,
    tabMenuItems,
  } = useSessionActions(
    refresh,
    showError,
    confirmDialog,
    promptDialog,
    settingsRef,
    tabs,
    setTabs,
    sessions,
    openSession,
    openWindowTab,
    openAllWindows,
    closeTab,
    closeOtherTabs,
    renameGroup,
    pinnedSessions,
    setPinnedSessions,
    splitGroup,
    moveTabToAdjacentGroup,
  );

  // Session/window commands need an active real tab (a session/window, not a
  // settings/viewer tab) to act on; window.* additionally needs the derived
  // active window (see useTabs' activeWindow — falls back to the session's
  // own active window when the tab isn't pinned to one specific window).
  // Both the keyboard dispatcher (handlers below) and the palette (built
  // further down) share these same guards, so a bound chord fired with no
  // context and a palette row with no context behave identically: a no-op.
  const globalHandlers = useMemo<Record<string, () => void>>(
    () => ({
      "sidebar.toggle": () => setSidebarVisible((v) => !v),
      "sidebar.focusExplorer": () => focusSidebarTab(EXPLORER_TAB_ID),
      "sidebar.focusExtensions": () => focusSidebarTab(EXTENSIONS_TAB_ID),
      "quickSwitcher.toggle": () => setSwitcherQuery((q) => (q === null ? "" : null)),
      "commandPalette.toggle": () => setSwitcherQuery((q) => (q === null ? ">" : null)),
      "tab.next": () => cycleTab(1),
      "tab.previous": () => cycleTab(-1),
      "tab.close": () => {
        if (activeTabId) closeTab(activeTabId);
      },
      "tab.closeOthers": () => {
        if (activeTabId) closeOtherTabs(activeTabId);
      },
      "settings.open": openSettingsTab,
      "settings.openKeyboardShortcuts": openKeyboardShortcutsTab,
      "session.new": () => createSession(),
      "session.kill": () => {
        if (activeRealTab) killSession(activeRealTab.sessionName);
      },
      "session.rename": () => {
        if (activeRealTab) renameSession(activeRealTab.sessionName);
      },
      "session.togglePin": () => {
        if (activeRealTab) togglePinSession(activeRealTab.sessionName);
      },
      "window.new": () => {
        if (activeRealTab) createWindow(activeRealTab.sessionName);
      },
      "window.kill": () => {
        if (activeRealTab && activeWindow) killWindow(activeRealTab.sessionName, activeWindow.index);
      },
      "window.rename": () => {
        if (activeRealTab && activeWindow) renameWindow(activeRealTab.sessionName, activeWindow);
      },
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `tab.focus${i + 1}`,
          () => {
            const t = activeGroupTabs[i];
            if (t) setActiveTabId(t.id);
          },
        ]),
      ),
      "tab.moveLeft": () => {
        if (!activeTabId) return;
        // moveTab's toIndex is relative to the dragged tab's own editor
        // group, not the flat tabs array — see useTabs.ts's moveTab.
        const idx = activeGroupTabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) moveTab(activeTabId, idx - 1);
      },
      "tab.moveRight": () => {
        if (!activeTabId) return;
        const idx = activeGroupTabs.findIndex((t) => t.id === activeTabId);
        if (idx !== -1 && idx < activeGroupTabs.length - 1) moveTab(activeTabId, idx + 1);
      },
      "tab.reopenClosed": reopenClosedTab,
      "terminal.fontSizeIncrease": () => {
        setSettings((prev) => ({ ...prev, fontSize: Math.min(32, prev.fontSize + 1) }));
      },
      "terminal.fontSizeDecrease": () => {
        setSettings((prev) => ({ ...prev, fontSize: Math.max(8, prev.fontSize - 1) }));
      },
      "terminal.fontSizeReset": () => {
        setSettings((prev) => ({ ...prev, fontSize: DEFAULT_SETTINGS.fontSize }));
      },
      "split.right": () => splitGroup("right"),
      "split.down": () => splitGroup("down"),
      "split.left": () => splitGroup("left"),
      "split.up": () => splitGroup("up"),
      "group.focusNext": () => {
        const order = leaves(splitTree);
        const idx = order.indexOf(activeGroupId);
        if (idx === -1 || order.length < 2) return;
        focusGroup(order[(idx + 1) % order.length]);
      },
      "group.focusPrevious": () => {
        const order = leaves(splitTree);
        const idx = order.indexOf(activeGroupId);
        if (idx === -1 || order.length < 2) return;
        focusGroup(order[(idx - 1 + order.length) % order.length]);
      },
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `group.focus${i + 1}`,
          () => {
            const groupId = leaves(splitTree)[i];
            if (groupId) focusGroup(groupId);
          },
        ]),
      ),
      "tab.moveToNextGroup": () => {
        if (!activeTabId) return;
        moveTabToAdjacentGroup(activeTabId, "next");
      },
      "tab.moveToPreviousGroup": () => {
        if (!activeTabId) return;
        moveTabToAdjacentGroup(activeTabId, "previous");
      },
      "panel.toggle": togglePanel,
      "panel.new": () => {
        // Reveals first, so the picker (when there's no active session) has a
        // panel to anchor against — its own top-left corner, since the +
        // button it would otherwise anchor to may not be on screen yet.
        showPanel();
        requestPanelTerminal({ x: sidebarVisible ? sidebarWidth : 0, y: window.innerHeight - panel.height });
      },
      "panel.split": splitActivePane,
    }),
    [
      activeRealTab,
      activeWindow,
      activeTabId,
      activeGroupTabs,
      activeGroupId,
      splitTree,
      setActiveTabId,
      moveTab,
      reopenClosedTab,
      setSettings,
      closeTab,
      closeOtherTabs,
      cycleTab,
      openSettingsTab,
      openKeyboardShortcutsTab,
      createSession,
      killSession,
      renameSession,
      togglePinSession,
      createWindow,
      killWindow,
      renameWindow,
      splitGroup,
      focusGroup,
      moveTabToAdjacentGroup,
      togglePanel,
      showPanel,
      splitActivePane,
      requestPanelTerminal,
      panel.height,
      sidebarVisible,
      sidebarWidth,
    ],
  );

  // Mirrors this component's own state into the module-level context-key
  // store (contextKeys.ts) so when-clause bindings can read it from the
  // dispatchers below, which live outside React (mount-once listeners).
  useEffect(() => {
    setContextKey("sidebarVisible", sidebarVisible);
  }, [sidebarVisible]);
  useEffect(() => {
    setContextKey("panelFocus", panelFocused);
  }, [panelFocused]);
  useEffect(() => {
    setContextKey("quickSwitcherOpen", switcherQuery !== null);
    // Only the switcher's initial mode is tracked — typing/deleting the ">"
    // prefix inside an already-open switcher doesn't update this, since the
    // live query isn't lifted up to App.
    setContextKey("commandPaletteOpen", switcherQuery?.startsWith(">") ?? false);
  }, [switcherQuery]);
  useEffect(() => {
    setContextKey("activeSession", activeRealTab !== null);
  }, [activeRealTab]);
  useEffect(() => {
    setContextKey("activeWindow", activeWindow !== undefined);
  }, [activeWindow]);

  useGlobalKeybindings(bindingsRef, overridesRef, globalHandlers, extCommands);

  // Formatted "sidebar.toggle" binding for the collapsed sidebar's reopen
  // strip's tooltip (below) — Sidebar.tsx formats its own copy of this same
  // binding for the button shown while expanded.
  const sidebarToggleBinding = formatBinding(resolvedBindings["sidebar.toggle"]?.[0]?.key ?? "");

  // Bumps commandUsage[id] on every palette-invoked run (not chord
  // dispatches — see paletteCommands' comment on recording scope). Read by
  // the memo below for the always-on "pin last-used to row 1" behavior and
  // the opt-in paletteSortByUsage sort.
  const recordCommandUsage = useCallback(
    (id: string) => {
      setCommandUsage((prev) => ({
        ...prev,
        [id]: { count: (prev[id]?.count ?? 0) + 1, last: Date.now() },
      }));
    },
    [setCommandUsage],
  );

  // Palette entries mirror globalHandlers 1:1 for the built-in commands, plus
  // extension commands — terminal.* is excluded since those are dispatched
  // from the terminal's own key handler (see useGlobalKeybindings' module comment)
  // and make no sense invoked from an overlay that has stolen focus.
  // quickSwitcher.selectNext/Previous are excluded for the same reason: they
  // only mean anything as a keypress while the switcher's own input owns
  // focus (QuickSwitcher compares its `bindings` prop directly — see its
  // onKeyDown), so "running" them from the list they navigate would be a
  // no-op with no globalHandlers entry to back it.
  //
  // Ordering: only palette-invoked runs are recorded (a chord-run favorite
  // shouldn't crowd out what you actually pick from the list), so usage
  // reflects palette habits specifically. The single most-recently-run
  // command always pins to row 0 — ties on `last` (only possible via a
  // hand-edited settings doc) break by higher `count`, then static order.
  // paletteSortByUsage additionally reorders everything else by `count` desc
  // (stable, so ties keep the static COMMANDS order).
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const hasSession = activeRealTab !== null;
    const hasWindow = activeWindow !== undefined;
    // Render-fresh for activeSession/activeWindow: the context-key store's
    // mirroring effects run after render, so reading it for these two here
    // would be one render stale right when it matters most (opening the
    // palette immediately after creating/killing a session or window).
    // Everything else falls through to the store.
    const storeGet = getContextGetter();
    const paletteGet = (key: string) => {
      if (key === "activeSession") return hasSession;
      if (key === "activeWindow") return hasWindow;
      return storeGet(key);
    };
    const builtins = COMMANDS.filter((c) => c.scope === "global" && !NON_PALETTE_IDS.has(c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id]?.[0]?.key ?? ""),
      enabled: c.enablement ? evaluateWhen(c.enablement, paletteGet) : true,
      run: () => {
        recordCommandUsage(c.id);
        globalHandlers[c.id]?.();
      },
    }));
    const extEntries = extCommands.map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id]?.[0]?.key ?? ""),
      enabled: true,
      run: () => {
        recordCommandUsage(c.id);
        c.run();
      },
    }));
    const all = [...builtins, ...extEntries];

    const sorted = settings.paletteSortByUsage
      ? [...all].sort((a, b) => (commandUsage[b.id]?.count ?? 0) - (commandUsage[a.id]?.count ?? 0))
      : all;

    let lastUsedIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
      const usage = commandUsage[sorted[i].id];
      if (!usage) continue;
      if (lastUsedIndex === -1) {
        lastUsedIndex = i;
        continue;
      }
      const best = commandUsage[sorted[lastUsedIndex].id];
      if (
        usage.last > best.last ||
        (usage.last === best.last && usage.count > best.count)
      ) {
        lastUsedIndex = i;
      }
    }
    if (lastUsedIndex <= 0) return sorted;
    const lastUsed = sorted[lastUsedIndex];
    return [lastUsed, ...sorted.slice(0, lastUsedIndex), ...sorted.slice(lastUsedIndex + 1)];
  }, [
    activeRealTab,
    activeWindow,
    resolvedBindings,
    globalHandlers,
    extCommands,
    commandUsage,
    settings.paletteSortByUsage,
    recordCommandUsage,
  ]);

  const newWindowInDir = (cwd: string) => {
    if (!activeRealTab) return;
    createWindow(activeRealTab.sessionName, cwd);
  };

  // Branch pill in the FILES panel header: find-or-create the active
  // session's lazygit window (started in the file tree's root when created)
  // and bring it up as a window tab.
  const openLazygit = async () => {
    if (!activeRealTab) return;
    try {
      const { index } = await api.openLazygit(activeRealTab.sessionName, filesRootDir ?? undefined);
      // Refresh before opening the tab: the vanished-window sweep below
      // closes any window-tab whose window isn't in `sessions` yet, and a
      // just-created lazygit window won't be until the next poll otherwise.
      await refresh();
      await openWindowTab(activeRealTab.sessionName, index);
    } catch (err) {
      showError(err);
    }
  };

  const {
    uploadProgress,
    prunePath,
    fsClipboard,
    handleUpload,
    handleFileTreeDrop,
    handleFilesRefresh,
    fileTreeRootMenuItems,
    fileMenuItems,
    fileMultiMenuItems,
    deleteFileEntry,
    deleteFileEntries,
    renameFileEntry,
    findInFolder,
    createFileInDir,
    createFolderInDir,
    copyFilePaths,
    copyFileRelativePaths,
    copyEntries,
    cutEntries,
    pasteIntoDir,
    clearClipboard,
    refreshClipboardMirror,
    transferEntries,
  } = useFileActions(
    showError,
    confirmDialog,
    promptDialog,
    settingsRef,
    setFilesRefreshKey,
    extFileViewers,
    openFileInSession,
    openPreviewViewerTab,
  );
  refreshClipboardMirrorRef.current = refreshClipboardMirror;
  const cutPaths = fsClipboard?.mode === "cut" ? new Set(fsClipboard.paths) : null;

  useEffect(() => {
    document.title = activeTab ? `${tabLabel(activeTab)} — ${APP_NAME}` : APP_NAME;
  }, [activeTab, tabLabel]);

  return (
    <div className="app">
      {sidebarVisible ? (
        <>
          <Sidebar
            width={sidebarWidth}
            sessions={sessions}
            activeSessionName={activeRealTab?.sessionName ?? null}
            activeWindow={
              activeRealTab?.windowIndex !== undefined
                ? { sessionName: activeRealTab.sessionName, index: activeRealTab.windowIndex }
                : null
            }
            onOpenAllWindows={openAllWindows}
            onOpenWindow={openWindowTab}
            onCreate={createSession}
            onKillWindow={killWindow}
            onNewWindowInSession={createWindow}
            onNewWindowInDir={newWindowInDir}
            onOpenLazygit={openLazygit}
            onShowMenu={showMenu}
            sessionMenuItems={sessionMenuItems}
            windowMenuItems={windowMenuItems}
            pinnedSessions={pinnedSessions}
            onRestorePinned={restorePinnedSession}
            onOpenSettings={openSettingsTab}
            panelVisible={panel.visible}
            onTogglePanel={togglePanel}
            showGitStatus={settings.fileTreeGitStatus}
            onCollapse={() => setSidebarVisible(false)}
            filesRootDir={filesRootDir}
            onDropFiles={handleFileTreeDrop}
            filesRefreshKey={filesRefreshKey}
            onFilesRefresh={handleFilesRefresh}
            onOpenFile={openFileOrViewer}
            onPreviewFile={openPreviewViewerTab}
            isPreviewable={isPreviewable}
            fileMenuItems={fileMenuItems}
            fileTreeRootMenuItems={fileTreeRootMenuItems}
            fileMultiMenuItems={fileMultiMenuItems}
            deleteFileEntry={deleteFileEntry}
            deleteFileEntries={deleteFileEntries}
            renameFileEntry={renameFileEntry}
            onFindInFolder={findInFolder}
            onCreateFile={createFileInDir}
            onCreateFolder={createFolderInDir}
            onCopyPath={copyFilePaths}
            onCopyRelativePath={copyFileRelativePaths}
            prunePath={prunePath}
            cutPaths={cutPaths}
            onCopyEntries={copyEntries}
            onCutEntries={cutEntries}
            onPasteInto={pasteIntoDir}
            onClearClipboard={clearClipboard}
            onTransferEntries={transferEntries}
            extensionPanels={extSidebarPanels}
            extensionWindowActions={extWindowActions}
            extensions={extensions}
            onReloadExtensions={reloadExtensions}
            extensionRegistries={extensionRegistries}
            onExtensionRegistriesChange={setExtensionRegistries}
            registryCatalog={registryCatalog}
            registryLoading={registryLoading}
            onEnsureRegistryLoaded={ensureRegistryLoaded}
            onRefreshRegistry={refreshRegistry}
            onOpenExtensionPage={openExtensionPageTab}
            extensionUpdatesCount={extensionUpdatesCount}
            resolvedBindings={resolvedBindings}
            confirmDialog={confirmDialog}
          />
          <div className="resize-handle" onMouseDown={startSidebarResize} />
        </>
      ) : (
        <div
          className="sidebar-reopen"
          title={`Show sidebar${sidebarToggleBinding ? ` (${sidebarToggleBinding})` : ""}`}
          onClick={() => setSidebarVisible(true)}
        />
      )}
      <main className="main">
        <SplitLayout
          tree={splitTree}
          tabs={tabs}
          activeGroupId={activeGroupId}
          groupActive={groupActive}
          label={tabLabel}
          activity={tabActivity}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onShowMenu={showMenu}
          tabMenuItems={tabMenuItems}
          onReorder={moveTab}
          onMoveTabToGroup={moveTabToGroup}
          onSplitAndMoveTab={splitGroupAndMoveTab}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          groupingEnabled={settings.tabGroupsBySession}
          groupKey={groupKeyForTab}
          groupState={tabGroupState}
          onToggleGroupCollapsed={toggleGroupCollapsed}
          groupMenuItems={groupMenuItems}
          onReorderGroup={moveGroup}
          onFocusGroup={focusGroup}
          onResizeBranch={resizeBranch}
          actionsRefFor={getGroupActionsRef}
          tabExtrasFor={tabExtrasFor}
          contentSlotRefFor={getGroupContentSlotRef}
        />
        {tabs.map((tab) => {
          if (tab.groupId === undefined) return null;
          const groupId = tab.groupId;
          const rect = groupContentRects[groupId];
          if (!rect) return null;
          const visible = groupActive[groupId] === tab.id;
          // The bottom panel's terminals compete for the same keyboard focus,
          // so an editor terminal only claims it while the panel doesn't hold
          // it (see useBottomPanel's panelFocused).
          const focused = visible && groupId === activeGroupId && !panelFocused;
          let content: React.ReactNode;
          if (tab.settingsView) {
            content = (
              <SettingsView
                active={visible}
                settings={settings}
                onSettingsChange={setSettings}
                extensions={extensions}
                onReloadExtensions={reloadExtensions}
                extensionSettings={extensionSettings}
                onExtensionSettingsChange={setExtensionSettings}
                pendingFocusExtensionId={pendingFocusExtensionId}
                onFocusExtensionHandled={() => setPendingFocusExtensionId(null)}
                onOpenKeyboardShortcuts={openKeyboardShortcutsTab}
              />
            );
          } else if (tab.keyboardView) {
            content = (
              <KeyboardShortcutsView
                active={visible}
                keybindingOverrides={keybindingOverrides}
                onKeybindingOverridesChange={setKeybindingOverrides}
              />
            );
          } else if (tab.extensionPageId !== undefined) {
            content = (
              <ExtensionPageView
                active={visible}
                extensionId={tab.extensionPageId}
                source={tab.extensionPageSource}
                extensions={extensions}
                registryCatalog={registryCatalog}
                onReloadExtensions={reloadExtensions}
                onOpenExtensionSettings={(id) => {
                  setPendingFocusExtensionId(id);
                  openSettingsTab();
                }}
              />
            );
          } else if (tab.extViewerPath !== undefined) {
            // The registered viewer that opened this tab may have been
            // unregistered since (extension disabled/uninstalled) — the tab
            // still exists but has nothing left to render.
            const viewer = extFileViewers.find((v) => v.id === tab.extViewerId);
            if (!viewer) {
              content = (
                <div className={`settings-host${visible ? "" : " hidden"}`}>
                  <div className="file-tree-empty">This viewer's extension is no longer active.</div>
                </div>
              );
            } else {
              const ViewerComponent = viewer.component;
              content = (
                <ViewerComponent
                  filePath={tab.extViewerPath}
                  active={visible}
                  toolbarTarget={groupActionsEls[groupId] ?? null}
                  openInEditor={openFileInSession}
                  showMenu={showMenu}
                  fontSize={settings.fontSize}
                  setDirty={(dirty) => {
                    if (dirty) dirtyTabsRef.current.add(tab.id);
                    else dirtyTabsRef.current.delete(tab.id);
                  }}
                />
              );
            }
          } else if (tab.imagePath !== undefined || tab.previewPath !== undefined) {
            // A legacy imagePath/previewPath tab restored from localStorage
            // before this extraction shipped, not yet converted to
            // extViewerId/extViewerPath by the migration effect above —
            // resolves itself once extension activation populates the
            // registry (see the plan's "accept the flash" decision).
            content = (
              <div className={`settings-host${visible ? "" : " hidden"}`}>
                <div className="file-tree-empty">Loading…</div>
              </div>
            );
          } else {
            content = (
              <TerminalView
                attachName={tab.attachName}
                visible={visible}
                focused={focused}
                settings={settings}
                theme={activeTerminalTheme}
                fontsVersion={fontsVersion}
                bindings={resolvedBindings}
                onExit={() => closeTab(tab.id)}
                onError={showError}
                // A tmux-native window switch inside this window tab — the
                // server already reverted the synthetic session to its pin;
                // surface the window the user actually picked.
                onWindowSwitch={(windowIndex) => openWindowTab(tab.sessionName, windowIndex)}
                onSessionSwitch={openSwitchedSession}
                onOpenFile={openFileOrViewer}
                onOpenFileSecondary={openFileOrViewerSecondary}
              />
            );
          }
          return (
            <div
              key={tab.id}
              className="split-content-host"
              style={{
                position: "fixed",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                display: visible ? undefined : "none",
              }}
              onPointerDownCapture={() => {
                focusGroup(groupId);
                setPanelFocused(false);
              }}
            >
              {content}
            </div>
          );
        })}
        {tabs.length === 0 &&
          leaves(splitTree).map((groupId) => {
            const rect = groupContentRects[groupId];
            if (!rect) return null;
            return (
              <div
                key={`placeholder-${groupId}`}
                className="split-content-host"
                style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                onPointerDownCapture={() => {
                  focusGroup(groupId);
                  setPanelFocused(false);
                }}
              >
                <div className="placeholder">Select a session from the sidebar to open a terminal</div>
              </div>
            );
          })}
        {panel.visible && (
          <BottomPanel
            panel={panel}
            panelFocused={panelFocused}
            sessions={sessions}
            settings={settings}
            theme={activeTerminalTheme}
            fontsVersion={fontsVersion}
            bindings={resolvedBindings}
            onSelectTab={selectPanelTab}
            onSelectPane={selectPanelPane}
            onCloseTab={closePanelTab}
            onResizePanes={resizePanelPanes}
            // The attach is already gone (shell exited, or the window was
            // killed) — drop the pane without a detach call.
            onPaneExit={(tabId, paneId) => removePanelPane(tabId, paneId, false)}
            onRequestTerminal={requestPanelTerminal}
            onSplit={splitActivePane}
            onHide={hidePanel}
            onSetHeight={setPanelHeight}
            onError={showError}
            onOpenFile={openFileOrViewer}
            onOpenFileSecondary={openFileOrViewerSecondary}
            // A tmux-native switch inside a panel pane surfaces the picked
            // window in the *editor* area; the pane itself snaps back to the
            // window it's pinned to (the server already reverted it).
            onWindowSwitch={(session, windowIndex) => openWindowTab(session, windowIndex)}
            onSessionSwitch={openSwitchedSession}
          />
        )}
      </main>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} resolvedBindings={resolvedBindings} />
      )}
      {dialog && <Dialog dialog={dialog} />}
      {switcherQuery !== null && (
        <QuickSwitcher
          sessions={sessions}
          tabs={tabs}
          filesRootDir={filesRootDir}
          initialQuery={switcherQuery}
          commands={paletteCommands}
          bindings={resolvedBindings}
          onActivateTab={setActiveTabId}
          onOpenWindow={openWindowTab}
          onOpenSession={openSession}
          onOpenFile={openFileOrViewer}
          onOpenFileSecondary={openFileOrViewerSecondary}
          onClose={() => setSwitcherQuery(null)}
        />
      )}
      {uploadProgress && (
        <div className="upload-banner">
          <div className="upload-banner-label">
            Uploading{uploadProgress.currentName ? ` — ${uploadProgress.currentName}` : "…"}
          </div>
          <div className="upload-banner-track">
            <div
              className="upload-banner-fill"
              style={{
                width: `${
                  uploadProgress.totalBytes > 0
                    ? Math.min(100, (uploadProgress.loadedBytes / uploadProgress.totalBytes) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}
