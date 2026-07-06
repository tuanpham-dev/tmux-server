import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import QuickSwitcher from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/TerminalView";
import { useExtensionRegistry } from "./extensions";
import { useDialogs } from "./hooks/useDialogs";
import { useFileActions } from "./hooks/useFileActions";
import { useFileOpeners } from "./hooks/useFileOpeners";
import { useSessionActions } from "./hooks/useSessionActions";
import { useSessions } from "./hooks/useSessions";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTabGroups } from "./hooks/useTabGroups";
import { useTabs } from "./hooks/useTabs";
import { useThemeAssets } from "./hooks/useThemeAssets";
import { recorderState, serializeEvent } from "./keybindings";
import type { MenuItem, MenuState } from "./types";
import { groupKeyForTab } from "./lib/tabs";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

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
    closeTab,
    cycleTab,
    moveTab,
    closeOtherTabs,
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

  const { tabGroupState, toggleGroupCollapsed, closeGroupTabs, groupMenuItems, renameGroup } = useTabGroups(
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

  const [showSwitcher, setShowSwitcher] = useState(false);

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

  // Every global shortcut in one capture-phase dispatcher, driven by the
  // rebindable keybindings map (keybindings.ts). A matched combo gets
  // preventDefault + stopPropagation so it wins over both browser defaults
  // (Ctrl+P print; Ctrl+Tab/Ctrl+W are overridable only in the installed
  // PWA) and xterm's own key handling — Ctrl+Tab reaching tmux would feed it
  // a literal Tab, Ctrl+W would send ^W to the shell. The terminal.* combos
  // are dispatched inside TerminalView's xterm handler instead, with one
  // exception: whatever combo terminal.copy is bound to gets a window-level
  // preventDefault (no stop — the event must still reach xterm, which does
  // the actual copy) to suppress Chrome/Firefox's Ctrl+Shift+C "inspect
  // element" default. Freshness via refs so the mount-once listener always
  // sees current bindings and handlers.
  const globalCommandsRef = useRef<Record<string, () => void>>({});
  globalCommandsRef.current = {
    "sidebar.toggle": () => setSidebarVisible((v) => !v),
    "quickSwitcher.toggle": () => setShowSwitcher((v) => !v),
    "tab.next": () => cycleTab(1),
    "tab.previous": () => cycleTab(-1),
    "tab.close": () => {
      if (activeTabId) closeTab(activeTabId);
    },
    "settings.open": openSettingsTab,
    ...Object.fromEntries(extCommands.map((c) => [c.id, c.run])),
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The Keyboard settings recorder owns the keyboard while capturing a
      // chord — recording Ctrl+W must not also close the tab.
      if (recorderState.recording) return;
      const combo = serializeEvent(e);
      if (!combo) return;
      const bindings = bindingsRef.current;
      if (combo === bindings["terminal.copy"]) {
        e.preventDefault();
        return;
      }
      for (const [id, run] of Object.entries(globalCommandsRef.current)) {
        if (bindings[id] === combo) {
          e.preventDefault();
          e.stopPropagation();
          run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
    openSession,
    closeTab,
    closeOtherTabs,
    renameGroup,
  );

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

  // A tmux-native cross-session pick (choose-tree, Ctrl+B s) — the server
  // already switched the client back to the tab's own session. Surface the
  // target, preferring a tab pinned to the exact window the pick landed on
  // over the whole-session tab.
  useEffect(() => {
    document.title = activeTab ? `${tabLabel(activeTab)} — tmux` : "tmux";
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
            onOpen={openSession}
            onOpenWindow={openWindowTab}
            onCreate={createSession}
            onKillWindow={killWindow}
            onNewWindowInSession={createWindow}
            onNewWindowInDir={newWindowInDir}
            onOpenLazygit={openLazygit}
            onShowMenu={showMenu}
            sessionMenuItems={sessionMenuItems}
            windowMenuItems={windowMenuItems}
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
      {showSwitcher && (
        <QuickSwitcher
          sessions={sessions}
          tabs={tabs}
          filesRootDir={filesRootDir}
          onActivateTab={setActiveTabId}
          onOpenWindow={openWindowTab}
          onOpenSession={openSession}
          onOpenFile={openFileOrViewer}
          onOpenFileSecondary={openFileOrViewerSecondary}
          onClose={() => setShowSwitcher(false)}
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
