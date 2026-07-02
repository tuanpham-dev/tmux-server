import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import ContextMenu from "./components/ContextMenu";
import Dialog, { type DialogRequest } from "./components/Dialog";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/TerminalView";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import type { MenuItem, MenuState, Tab, TmuxSession, TmuxWindow } from "./types";
import { collectDropped, uploadAll, type DroppedItems } from "./upload";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

function loadStoredTabs(): Tab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabs") ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  // Restored tabs whose session no longer exists self-heal: attaching to a
  // dead session makes tmux exit immediately, the server relays "exit", and
  // the normal onExit handler closes that tab — no separate validation pass
  // needed here.
  const [tabs, setTabs] = useState<Tab[]>(loadStoredTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => localStorage.getItem("activeTabId"),
  );

  useEffect(() => {
    localStorage.setItem("tabs", JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    if (activeTabId) localStorage.setItem("activeTabId", activeTabId);
    else localStorage.removeItem("activeTabId");
  }, [activeTabId]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Skip persisting on the initial mount: loadSettings() already merged in
  // whatever DEFAULT_SETTINGS shipped, and writing that back immediately
  // would lock a returning visitor onto today's defaults forever — any
  // future default change (e.g. adding a fallback font) would then never
  // reach them, since their localStorage entry would already have every key.
  const settingsMounted = useRef(false);
  useEffect(() => {
    if (!settingsMounted.current) {
      settingsMounted.current = true;
      return;
    }
    saveSettings(settings);
  }, [settings]);

  // Capture phase so this wins over xterm's own key handling; Ctrl+B inside a
  // terminal stays the tmux prefix unless the settings override is on.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyB") return;
      const inTerminal = (e.target as HTMLElement)?.closest?.(".terminal-host");
      if (inTerminal && !settingsRef.current.ctrlBInTerminal) return;
      e.preventDefault();
      e.stopPropagation();
      setSidebarVisible((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Chrome/Firefox bind Ctrl+Shift+C to "inspect element", stealing it before
  // it can be used as an in-app shortcut. Calling preventDefault in a capture
  // listener suppresses that browser default (unlike F12, which can't be
  // suppressed this way).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyC") return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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

  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  const confirmDialog = useCallback(
    (message: string, confirmLabel = "OK") =>
      new Promise<boolean>((res) => {
        setDialog({
          type: "confirm",
          message,
          danger: true,
          confirmLabel,
          resolve: (v) => {
            setDialog(null);
            res(Boolean(v));
          },
        });
      }),
    [],
  );

  const promptDialog = useCallback(
    (message: string, defaultValue = "") =>
      new Promise<string | null>((res) => {
        setDialog({
          type: "prompt",
          message,
          defaultValue,
          resolve: (v) => {
            setDialog(null);
            res(v === null || v === false ? null : String(v));
          },
        });
      }),
    [],
  );

  const [uploadProgress, setUploadProgress] = useState<{
    currentName: string;
    loadedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);

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

  const showError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.fetchSessions());
    } catch (err) {
      showError(err);
    }
  }, [showError]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const openSession = useCallback((name: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.sessionName === name);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const tab: Tab = { id: crypto.randomUUID(), sessionName: name };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((current) => {
        if (current !== id) return current;
        const neighbor = next[Math.min(idx, next.length - 1)];
        return neighbor ? neighbor.id : null;
      });
      return next;
    });
  }, []);

  const closeOtherTabs = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id === id));
    setActiveTabId(id);
  }, []);

  const createSession = useCallback(
    async (name?: string) => {
      try {
        const created = await api.createSession(name);
        await refresh();
        openSession(created.name);
      } catch (err) {
        showError(err);
      }
    },
    [refresh, openSession, showError],
  );

  const killSession = useCallback(
    async (name: string) => {
      if (!(await confirmDialog(`Kill tmux session "${name}"?`, "Kill Session"))) return;
      try {
        await api.killSession(name);
        setTabs((prev) => prev.filter((t) => t.sessionName !== name));
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, confirmDialog],
  );

  const renameSession = useCallback(
    async (name: string) => {
      const newName = (await promptDialog("New session name", name))?.trim();
      if (!newName || newName === name) return;
      try {
        await api.renameSession(name, newName);
        setTabs((prev) =>
          prev.map((t) => (t.sessionName === name ? { ...t, sessionName: newName } : t)),
        );
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, promptDialog],
  );

  const createWindow = useCallback(
    async (session: string) => {
      try {
        await api.createWindow(session);
        await refresh();
      } catch (err) {
        showError(err);
        return;
      }
      // tmux makes a freshly created window the active one, so opening the
      // session's tab is enough to land on it.
      openSession(session);
    },
    [refresh, openSession, showError],
  );

  const openWindow = useCallback(
    async (session: string, index: number) => {
      try {
        await api.selectWindow(session, index);
      } catch (err) {
        showError(err);
        return;
      }
      openSession(session);
    },
    [openSession, showError],
  );

  const renameWindow = useCallback(
    async (session: string, win: TmuxWindow) => {
      const newName = (await promptDialog("New window name", win.name))?.trim();
      if (!newName || newName === win.name) return;
      try {
        await api.renameWindow(session, win.index, newName);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, promptDialog],
  );

  const killWindow = useCallback(
    async (session: string, index: number) => {
      if (
        !(await confirmDialog(
          `Kill window ${index} of session "${session}"?`,
          "Kill Window",
        ))
      )
        return;
      try {
        await api.killWindow(session, index);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, confirmDialog],
  );

  const showMenu = useCallback((x: number, y: number, items: MenuItem[]) => {
    setMenu({ x, y, items });
  }, []);

  const sessionMenuItems = useCallback(
    (name: string): MenuItem[] => [
      { label: "Open", onClick: () => openSession(name) },
      { label: "New Window", onClick: () => createWindow(name) },
      { label: "Rename Session…", onClick: () => renameSession(name) },
      { label: "Kill Session", danger: true, onClick: () => killSession(name) },
    ],
    [openSession, createWindow, renameSession, killSession],
  );

  const windowMenuItems = useCallback(
    (session: string, win: TmuxWindow): MenuItem[] => [
      { label: "Select Window", onClick: () => openWindow(session, win.index) },
      { label: "New Window", onClick: () => createWindow(session) },
      { label: "Rename Window…", onClick: () => renameWindow(session, win) },
      {
        label: "Kill Window",
        danger: true,
        onClick: () => killWindow(session, win.index),
      },
    ],
    [openWindow, createWindow, renameWindow, killWindow],
  );

  const tabMenuItems = useCallback(
    (tab: Tab): MenuItem[] => [
      { label: "Close Tab", onClick: () => closeTab(tab.id) },
      { label: "Close Other Tabs", onClick: () => closeOtherTabs(tab.id) },
      { label: "New Window", onClick: () => createWindow(tab.sessionName) },
      { label: "Rename Session…", onClick: () => renameSession(tab.sessionName) },
      {
        label: "Kill Session",
        danger: true,
        onClick: () => killSession(tab.sessionName),
      },
    ],
    [closeTab, closeOtherTabs, createWindow, renameSession, killSession],
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeSession = sessions.find((s) => s.name === activeTab?.sessionName) ?? null;
  const filesRootDir = activeSession?.windows.find((w) => w.active)?.cwd ?? null;

  const handleUpload = useCallback(
    async (items: DroppedItems, destDir: string) => {
      if (items.files.length === 0 && items.dirs.length === 0) return;
      setUploadProgress({
        currentName: "",
        loadedBytes: 0,
        totalBytes: items.files.reduce((sum, f) => sum + f.file.size, 0),
      });
      const result = await uploadAll(items, destDir, settingsRef.current.uploadConflict, {
        onProgress: (loadedBytes, totalBytes, currentName) => {
          setUploadProgress({ currentName, loadedBytes, totalBytes });
        },
        onConflict: (relativePath) =>
          confirmDialog(`"${relativePath}" already exists. Overwrite?`, "Overwrite"),
      });
      setUploadProgress(null);
      setFilesRefreshKey((k) => k + 1);
      if (result.errors.length === 1) {
        showError(`Upload failed: ${result.errors[0].relativePath} — ${result.errors[0].message}`);
      } else if (result.errors.length > 1) {
        showError(`${result.errors.length} files failed to upload`);
      }
    },
    [confirmDialog, showError],
  );

  // Folder drops target a specific FILES-panel folder; the drop's DataTransfer
  // is read synchronously (before any await) since browsers invalidate it once
  // the event handler yields.
  const handleFileTreeDrop = useCallback(
    (destDir: string, dataTransfer: DataTransfer) => {
      collectDropped(dataTransfer)
        .then((items) => handleUpload(items, destDir))
        .catch(showError);
    },
    [handleUpload, showError],
  );

  const handleFilesRefresh = useCallback(() => {
    setFilesRefreshKey((k) => k + 1);
  }, []);

  const openFileInSession = useCallback(
    async (filePath: string) => {
      if (!activeTab) return;
      try {
        await api.openFile(activeTab.sessionName, filePath);
      } catch (err) {
        showError(err);
      }
    },
    [activeTab, showError],
  );

  useEffect(() => {
    document.title = activeTab ? `${activeTab.sessionName} — tmux` : "tmux";
  }, [activeTab]);

  return (
    <div className="app">
      {sidebarVisible ? (
        <>
          <Sidebar
            width={sidebarWidth}
            sessions={sessions}
            activeSessionName={activeTab?.sessionName ?? null}
            onOpen={openSession}
            onOpenWindow={openWindow}
            onCreate={createSession}
            onShowMenu={showMenu}
            sessionMenuItems={sessionMenuItems}
            windowMenuItems={windowMenuItems}
            onOpenSettings={() => setShowSettings(true)}
            onCollapse={() => setSidebarVisible(false)}
            filesRootDir={filesRootDir}
            onDropFiles={handleFileTreeDrop}
            filesRefreshKey={filesRefreshKey}
            onFilesRefresh={handleFilesRefresh}
            onOpenFile={openFileInSession}
          />
          <div className="resize-handle" onMouseDown={startSidebarResize} />
        </>
      ) : (
        <div
          className="sidebar-reopen"
          title="Show sidebar (Ctrl+B)"
          onClick={() => setSidebarVisible(true)}
        />
      )}
      <main className="main">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onShowMenu={showMenu}
          tabMenuItems={tabMenuItems}
        />
        <div className="terminals">
          {tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              sessionName={tab.sessionName}
              active={tab.id === activeTabId}
              settings={settings}
              onExit={() => closeTab(tab.id)}
            />
          ))}
          {tabs.length === 0 && (
            <div className="placeholder">
              Select a session from the sidebar to open a terminal
            </div>
          )}
        </div>
      </main>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {dialog && <Dialog dialog={dialog} />}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
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
