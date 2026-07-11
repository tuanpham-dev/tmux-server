import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import QuickSwitcher, { type PaletteCommand } from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
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
  // TabBar's right-side actions container — an image tab portals its zoom
  // toolbar into this while active (VS Code/code-server editor-actions
  // placement). State (not a plain ref) because the portaling viewer needs
  // to re-render once it becomes non-null on first mount.
  const [tabActionsEl, setTabActionsEl] = useState<HTMLDivElement | null>(null);
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
            const t = tabs[i];
            if (t) setActiveTabId(t.id);
          },
        ]),
      ),
      "tab.moveLeft": () => {
        if (!activeTabId) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) moveTab(activeTabId, idx - 1);
      },
      "tab.moveRight": () => {
        if (!activeTabId) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx !== -1 && idx < tabs.length - 1) moveTab(activeTabId, idx + 1);
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
    }),
    [
      activeRealTab,
      activeWindow,
      activeTabId,
      tabs,
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
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          label={tabLabel}
          activity={tabActivity}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onShowMenu={showMenu}
          tabMenuItems={tabMenuItems}
          onReorder={moveTab}
          actionsRef={setTabActionsEl}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          groupingEnabled={settings.tabGroupsBySession}
          groupKey={groupKeyForTab}
          groupState={tabGroupState}
          onToggleGroupCollapsed={toggleGroupCollapsed}
          groupMenuItems={groupMenuItems}
          onReorderGroup={moveGroup}
        />
        <div className="terminals">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            if (tab.settingsView) {
              return (
                <SettingsView
                  key={tab.id}
                  active={active}
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
            }
            if (tab.extViewerPath !== undefined) {
              // The registered viewer that opened this tab may have been
              // unregistered since (extension disabled/uninstalled) — the
              // tab still exists but has nothing left to render.
              const viewer = extFileViewers.find((v) => v.id === tab.extViewerId);
              if (!viewer) {
                return (
                  <div key={tab.id} className={`settings-host${active ? "" : " hidden"}`}>
                    <div className="file-tree-empty">
                      This viewer's extension is no longer active.
                    </div>
                  </div>
                );
              }
              const ViewerComponent = viewer.component;
              return (
                <ViewerComponent
                  key={tab.id}
                  filePath={tab.extViewerPath}
                  active={active}
                  toolbarTarget={tabActionsEl}
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
            // A legacy imagePath/previewPath tab restored from localStorage
            // before this extraction shipped, not yet converted to
            // extViewerId/extViewerPath by the migration effect above —
            // resolves itself once extension activation populates the
            // registry (see the plan's "accept the flash" decision).
            if (tab.imagePath !== undefined || tab.previewPath !== undefined) {
              return (
                <div key={tab.id} className={`settings-host${active ? "" : " hidden"}`}>
                  <div className="file-tree-empty">Loading…</div>
                </div>
              );
            }
            return (
              <TerminalView
                key={tab.id}
                attachName={tab.attachName}
                active={active}
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
          })}
          {tabs.length === 0 && (
            <div className="placeholder">
              Select a session from the sidebar to open a terminal
            </div>
          )}
        </div>
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
