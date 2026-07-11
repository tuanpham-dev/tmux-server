import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import QuickSwitcher, { type PaletteCommand } from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SplitLayout from "./components/SplitLayout";
import TerminalView from "./components/TerminalView";
import { EXPLORER_TAB_ID } from "./components/Sidebar";
import { focusSidebarTab, setSidebarVisibleHandler, useExtensionRegistry } from "./extensions";
import { useDialogs } from "./hooks/useDialogs";
import { useFileActions } from "./hooks/useFileActions";
import { useFileOpeners } from "./hooks/useFileOpeners";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";
import { COMMANDS, formatBinding } from "./keybindings";
import { DEFAULT_SETTINGS } from "./settings";
import { useSessionActions } from "./hooks/useSessionActions";
import { useSessions } from "./hooks/useSessions";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTabGroups } from "./hooks/useTabGroups";
import { useTabs } from "./hooks/useTabs";
import { useThemeAssets } from "./hooks/useThemeAssets";
import type { MenuItem, MenuState } from "./types";
import { groupKeyForTab } from "./lib/tabs";
import { leaves } from "./lib/splits";

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
  // Piggybacks on the session poll so git status badges in the FILES panel
  // stay live (e.g. after a commit or save in the terminal) without a
  // second timer. Must be a stable useCallback, not an inline arrow — an
  // unstable identity here would change useSessions' internal `refresh`
  // callback's identity every render, retriggering its mount effect (and
  // firing a fresh fetch) on every render instead of once every 3s.
  const onSessionsRefreshed = useCallback(() => setFilesRefreshKey((k) => k + 1), []);

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
  const { commands: extCommands, fileViewers: extFileViewers, sidebarPanels: extSidebarPanels } =
    useExtensionRegistry();

  const {
    settings,
    setSettings,
    settingsRef,
    keybindingOverrides,
    setKeybindingOverrides,
    resolvedBindings,
    bindingsRef,
    extensionSettings,
    setExtensionSettings,
    extensionSettingsRef,
    pinnedSessions,
    setPinnedSessions,
    commandUsage,
    setCommandUsage,
  } = useSettingsSync(extCommands);

  const { dialog, confirmDialog, promptDialog } = useDialogs();

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
  } = useTabs(sessions, sessionsLoadedRef, showError, confirmDialog, settingsRef, extFileViewers);

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

  const { extensions, reloadExtensions, activeTerminalTheme, fontsVersion } =
    useThemeAssets(settings, extensionSettings, extensionSettingsRef);

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
    ],
  );

  useGlobalKeybindings(bindingsRef, globalHandlers, extCommands);

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
  // from xterm's own key handler (see useGlobalKeybindings' module comment)
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
    const contextRequirement: Record<string, boolean> = {
      "session.kill": hasSession,
      "session.rename": hasSession,
      "session.togglePin": hasSession,
      "window.new": hasSession,
      "window.kill": hasSession && hasWindow,
      "window.rename": hasSession && hasWindow,
    };
    const builtins = COMMANDS.filter((c) => c.scope === "global" && !NON_PALETTE_IDS.has(c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id] ?? ""),
      enabled: contextRequirement[c.id] ?? true,
      run: () => {
        recordCommandUsage(c.id);
        globalHandlers[c.id]?.();
      },
    }));
    const extEntries = extCommands.map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id] ?? ""),
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
    handleUpload,
    handleFileTreeDrop,
    handleFilesRefresh,
    fileTreeRootMenuItems,
    fileMenuItems,
    fileMultiMenuItems,
    deleteFileEntry,
    deleteFileEntries,
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
            prunePath={prunePath}
            extensionPanels={extSidebarPanels}
          />
          <div className="resize-handle" onMouseDown={startSidebarResize} />
        </>
      ) : (
        <div
          className="sidebar-reopen"
          title="Show sidebar (Ctrl+Shift+B)"
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
          contentSlotRefFor={getGroupContentSlotRef}
        />
        {tabs.map((tab) => {
          if (tab.groupId === undefined) return null;
          const groupId = tab.groupId;
          const rect = groupContentRects[groupId];
          if (!rect) return null;
          const visible = groupActive[groupId] === tab.id;
          const focused = visible && groupId === activeGroupId;
          let content: React.ReactNode;
          if (tab.settingsView) {
            content = (
              <SettingsView
                active={visible}
                settings={settings}
                onSettingsChange={setSettings}
                keybindingOverrides={keybindingOverrides}
                onKeybindingOverridesChange={setKeybindingOverrides}
                extensions={extensions}
                onReloadExtensions={reloadExtensions}
                extensionSettings={extensionSettings}
                onExtensionSettingsChange={setExtensionSettings}
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
              onPointerDownCapture={() => focusGroup(groupId)}
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
                onPointerDownCapture={() => focusGroup(groupId)}
              >
                <div className="placeholder">Select a session from the sidebar to open a terminal</div>
              </div>
            );
          })}
      </main>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
