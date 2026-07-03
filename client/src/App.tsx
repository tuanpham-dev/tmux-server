import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { copyText } from "./clipboard";
import ContextMenu from "./components/ContextMenu";
import Dialog, { type DialogRequest } from "./components/Dialog";
import QuickSwitcher from "./components/QuickSwitcher";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/TerminalView";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import type { MenuItem, MenuState, Tab, TmuxSession, TmuxWindow } from "./types";
import { collectDropped, uploadAll, type DroppedItems } from "./upload";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

// Keeps tabs pointed at the right session/window across an out-of-band
// rename or renumber (another terminal, not this app). Matches by stable
// tmux id first — falls back to name/index only for a tab whose ids haven't
// resolved yet (freshly opened, or restored from localStorage before
// id-keying shipped), which then adopts the id it finds for next time. A
// session/window that's gone entirely is left alone here; the attach's own
// "exit" message (or the window-tab cleanup effect below) closes that tab.
function reconcileTabs(tabs: Tab[], sessions: TmuxSession[]): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const session = tab.sessionId
      ? sessions.find((s) => s.id === tab.sessionId)
      : sessions.find((s) => s.name === tab.sessionName);
    if (!session) return tab;

    let updated = tab;
    if (updated.sessionId !== session.id || updated.sessionName !== session.name) {
      changed = true;
      updated = {
        ...updated,
        sessionId: session.id,
        sessionName: session.name,
        // attachName tracks the base session's name only for a whole-session
        // tab; a window-tab's attachName is its own synthetic session name
        // and must never follow a rename of the base session.
        attachName: updated.windowIndex === undefined ? session.name : updated.attachName,
      };
    }

    if (updated.windowIndex !== undefined) {
      const win = updated.windowId
        ? session.windows.find((w) => w.id === updated.windowId)
        : session.windows.find((w) => w.index === updated.windowIndex);
      if (win && (updated.windowId !== win.id || updated.windowIndex !== win.index)) {
        changed = true;
        updated = { ...updated, windowId: win.id, windowIndex: win.index };
      }
    }

    return updated;
  });
  return changed ? next : tabs;
}

function loadStoredTabs(): Tab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabs") ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Tabs stored before per-window tabs shipped won't have attachName —
    // every tab back then was a whole-session tab, where it always equals
    // sessionName.
    return parsed.map((t) => ({ ...t, attachName: t.attachName ?? t.sessionName }));
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

  // Capture phase so this wins over xterm's own key handling. Shift
  // distinguishes it from tmux's Ctrl+B prefix, so it's safe to fire even
  // when the terminal is focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyB") return;
      e.preventDefault();
      e.stopPropagation();
      setSidebarVisible((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const [showSwitcher, setShowSwitcher] = useState(false);

  // Capture phase + preventDefault to suppress the browser's print dialog,
  // which owns Ctrl+P by default. Works in mainstream browsers; in a
  // browser that refuses to let a page override it, the installed PWA
  // (which reserves the combo for the app, same as Ctrl+Tab/Ctrl+W) is the
  // guaranteed-clean path.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyP") return;
      e.preventDefault();
      e.stopPropagation();
      setShowSwitcher((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Right-click anywhere without a dedicated context menu (empty terminal
  // space, tab bar gaps, etc.) would otherwise show the browser's native
  // menu, which has no useful actions in this app.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Chrome/Firefox bind Ctrl+Shift+C to "inspect element", stealing it before
  // it can be used as an in-app shortcut. Calling preventDefault in a capture
  // listener suppresses that browser default (unlike F12, which can't be
  // suppressed this way). No stopPropagation: the event still needs to reach
  // xterm's own key handler in TerminalView, which does the actual copy.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyC") return;
      e.preventDefault();
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
  // Set whenever a delete/rename lands, so FileTree can drop the now-stale
  // path (and its descendants) from its expanded/dirCache state instead of
  // waiting for a refetch to notice it's gone.
  const [prunePath, setPrunePath] = useState<{ path: string } | null>(null);

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

  // Guards the window-tab cleanup effect below against the very first
  // render, where `sessions` is still its initial [] — without this, every
  // restored window-tab would look "gone" and get closed before the first
  // fetch even completes.
  const sessionsLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.fetchSessions());
      sessionsLoadedRef.current = true;
    } catch (err) {
      showError(err);
    }
    // Piggybacks on the session poll so git status badges in the FILES
    // panel stay live (e.g. after a commit or save in the terminal)
    // without a second timer.
    setFilesRefreshKey((k) => k + 1);
  }, [showError]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const openSession = useCallback((name: string) => {
    setTabs((prev) => {
      // Only match a whole-session tab — a window-tab for this session
      // shares the same sessionName but must never be treated as it.
      const existing = prev.find((t) => t.sessionName === name && t.windowIndex === undefined);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const tab: Tab = { id: crypto.randomUUID(), sessionName: name, attachName: name };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const openWindowTab = useCallback(
    async (session: string, index: number) => {
      const existing = tabs.find((t) => t.sessionName === session && t.windowIndex === index);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      try {
        const { attachName } = await api.openWindowTab(session, index);
        const tab: Tab = { id: crypto.randomUUID(), sessionName: session, attachName, windowIndex: index };
        setTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
      } catch (err) {
        showError(err);
      }
    },
    [tabs, showError],
  );

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab?.windowIndex !== undefined) {
        api.closeWindowTab(tab.attachName).catch(() => {});
      }
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
    },
    [tabs],
  );

  // Tab switching/closing. Unlike the shortcuts above, these must never
  // reach xterm — Ctrl+Tab would otherwise feed a literal Tab to tmux and
  // Ctrl+W would send ^W to the shell in addition to closing the tab — so
  // both preventDefault and stopPropagation are needed. Only works in the
  // installed PWA: a regular browser tab reserves all three combos for
  // itself and preventDefault can't override that.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (tabs.length < 2 || !activeTabId) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx === -1) return;
        const delta = e.shiftKey ? -1 : 1;
        const next = tabs[(idx + delta + tabs.length) % tabs.length];
        setActiveTabId(next.id);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        if (activeTabId) closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [tabs, activeTabId, closeTab]);

  const moveTab = useCallback((draggedId: string, toIndex: number) => {
    setTabs((prev) => {
      const draggedIdx = prev.findIndex((t) => t.id === draggedId);
      if (draggedIdx === -1) return prev;
      const dragged = prev[draggedIdx];
      const without = prev.filter((t) => t.id !== draggedId);
      const clamped = Math.max(0, Math.min(toIndex, without.length));
      const next = [...without];
      next.splice(clamped, 0, dragged);
      return next;
    });
  }, []);

  const closeOtherTabs = useCallback(
    (id: string) => {
      for (const t of tabs) {
        if (t.id !== id && t.windowIndex !== undefined) {
          api.closeWindowTab(t.attachName).catch(() => {});
        }
      }
      setTabs((prev) => prev.filter((t) => t.id === id));
      setActiveTabId(id);
    },
    [tabs],
  );

  // Runs every poll: rewrites any tab whose session/window drifted from an
  // out-of-band rename or renumber. See reconcileTabs above.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    setTabs((prev) => reconcileTabs(prev, sessions));
  }, [sessions]);

  // A window-tab's pinned window can disappear for reasons we can't
  // explicitly intercept client-side — nvim exiting closes the window it
  // was the sole command of, a shell's own "exit", someone killing it from
  // a real terminal. Left alone, the tab would silently start showing
  // whatever adjacent window tmux falls back to (same root cause as the
  // explicit "Kill Window" cascade above, but for every other trigger).
  // This is deliberately generic rather than another explicit cascade: it
  // catches all of the above, including the vanished-real-session edge case
  // noted in plans/per-window-tabs.md, from the poll we already run.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    for (const tab of tabs) {
      if (tab.windowIndex === undefined) continue;
      // id first: an out-of-band rename/renumber must not read as the
      // window having disappeared (see reconcileTabs above this effect).
      const session = tab.sessionId
        ? sessions.find((s) => s.id === tab.sessionId)
        : sessions.find((s) => s.name === tab.sessionName);
      const stillExists = tab.windowId
        ? (session?.windows.some((w) => w.id === tab.windowId) ?? false)
        : (session?.windows.some((w) => w.index === tab.windowIndex) ?? false);
      if (!stillExists) closeTab(tab.id);
    }
  }, [sessions, tabs, closeTab]);

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
        for (const t of tabs) {
          if (t.sessionName === name && t.windowIndex !== undefined) {
            api.closeWindowTab(t.attachName).catch(() => {});
          }
        }
        setTabs((prev) => prev.filter((t) => t.sessionName !== name));
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, confirmDialog, tabs],
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
    async (session: string, cwd?: string) => {
      try {
        await api.createWindow(session, cwd);
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

  // Switches which window the *shared* session tab follows (distinct from
  // openWindowTab, which pins a dedicated tab to one specific window).
  const selectWindowInSession = useCallback(
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
        // The tab pinned to this exact window would otherwise silently
        // start showing whatever adjacent window tmux falls back to.
        // closeTab handles the window-tab cascade + neighbor-aware
        // activeTabId update in one place.
        const pinned = tabs.find(
          (t) => t.sessionName === session && t.windowIndex === index,
        );
        if (pinned) closeTab(pinned.id);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, confirmDialog, tabs, closeTab],
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
      { label: "Select Window", onClick: () => selectWindowInSession(session, win.index) },
      { label: "New Window", onClick: () => createWindow(session) },
      { label: "Rename Window…", onClick: () => renameWindow(session, win) },
      {
        label: "Kill Window",
        danger: true,
        onClick: () => killWindow(session, win.index),
      },
    ],
    [selectWindowInSession, createWindow, renameWindow, killWindow],
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

  const renameFileEntry = useCallback(
    async (entryPath: string) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      const newName = (await promptDialog("New name", base))?.trim();
      if (!newName || newName === base) return;
      try {
        await api.renameEntry(entryPath, newName);
        setPrunePath({ path: entryPath });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError],
  );

  const deleteFileEntry = useCallback(
    async (entryPath: string, isDir: boolean) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      if (!(await confirmDialog(`Delete ${isDir ? "folder" : "file"} "${base}"?`, "Delete")))
        return;
      try {
        await api.deleteEntry(entryPath);
        setPrunePath({ path: entryPath });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [confirmDialog, showError],
  );

  const createFileInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New file name"))?.trim();
      if (!name) return;
      try {
        await api.createFile(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError],
  );

  const createFolderInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New folder name"))?.trim();
      if (!name) return;
      try {
        await api.makeDir(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError],
  );

  const copyFilePath = useCallback(
    (entryPath: string) => {
      copyText(entryPath).catch(showError);
    },
    [showError],
  );

  const copyFileRelativePath = useCallback(
    (entryPath: string, rootDir: string) => {
      const rel = entryPath.startsWith(rootDir + "/")
        ? entryPath.slice(rootDir.length + 1)
        : entryPath === rootDir
          ? "."
          : entryPath;
      copyText(rel).catch(showError);
    },
    [showError],
  );

  const downloadFileEntry = useCallback((entryPath: string) => {
    const a = document.createElement("a");
    a.href = api.downloadUrl(entryPath);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const fileMenuItems = useCallback(
    (entryPath: string, isDir: boolean, rootDir: string): MenuItem[] => {
      const items: MenuItem[] = [];
      if (isDir) {
        items.push(
          { label: "New File…", onClick: () => createFileInDir(entryPath) },
          { label: "New Folder…", onClick: () => createFolderInDir(entryPath) },
        );
      }
      items.push(
        { label: "Rename…", onClick: () => renameFileEntry(entryPath) },
        { label: "Copy Path", onClick: () => copyFilePath(entryPath) },
        { label: "Copy Relative Path", onClick: () => copyFileRelativePath(entryPath, rootDir) },
        { label: "Download", onClick: () => downloadFileEntry(entryPath) },
        { label: "Delete", danger: true, onClick: () => deleteFileEntry(entryPath, isDir) },
      );
      return items;
    },
    [
      createFileInDir,
      createFolderInDir,
      renameFileEntry,
      copyFilePath,
      copyFileRelativePath,
      downloadFileEntry,
      deleteFileEntry,
    ],
  );

  const fileTreeRootMenuItems = useCallback(
    (rootDir: string): MenuItem[] => [
      { label: "New File…", onClick: () => createFileInDir(rootDir) },
      { label: "New Folder…", onClick: () => createFolderInDir(rootDir) },
    ],
    [createFileInDir, createFolderInDir],
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeSession = sessions.find((s) => s.name === activeTab?.sessionName) ?? null;
  // A window-tab is pinned to a specific window, which may not be the
  // session's own tmux-level active window (their current-window pointers
  // diverge independently once a window-tab exists) — look it up by index
  // rather than falling back to whatever the session considers active.
  const activeWindow =
    activeTab?.windowIndex !== undefined
      ? activeSession?.windows.find((w) => w.index === activeTab.windowIndex)
      : activeSession?.windows.find((w) => w.active);
  const filesRootDir = activeWindow?.cwd ?? null;

  const newWindowInDir = (cwd: string) => {
    if (!activeTab) return;
    createWindow(activeTab.sessionName, cwd);
  };

  // Branch pill in the FILES panel header: find-or-create the active
  // session's lazygit window (started in the file tree's root when created)
  // and bring it up as a window tab.
  const openLazygit = async () => {
    if (!activeTab) return;
    try {
      const { index } = await api.openLazygit(activeTab.sessionName, filesRootDir ?? undefined);
      // Refresh before opening the tab: the vanished-window sweep below
      // closes any window-tab whose window isn't in `sessions` yet, and a
      // just-created lazygit window won't be until the next poll otherwise.
      await refresh();
      await openWindowTab(activeTab.sessionName, index);
    } catch (err) {
      showError(err);
    }
  };

  const tabLabel = useCallback(
    (tab: Tab): string => {
      if (tab.windowIndex === undefined) return tab.sessionName;
      const session = sessions.find((s) => s.name === tab.sessionName);
      const win = session?.windows.find((w) => w.index === tab.windowIndex);
      return `${tab.sessionName}:${win?.name ?? `window ${tab.windowIndex}`}`;
    },
    [sessions],
  );

  // Suppressed on the active tab — you're already looking at it, a dot
  // there would just be noise. A window tab reflects its one window; a
  // whole-session tab reflects "any window in it has new output".
  const tabActivity = useCallback(
    (tab: Tab): boolean => {
      if (tab.id === activeTabId) return false;
      const session = sessions.find((s) => s.name === tab.sessionName);
      if (!session) return false;
      if (tab.windowIndex !== undefined) {
        return session.windows.find((w) => w.index === tab.windowIndex)?.activity ?? false;
      }
      return session.windows.some((w) => w.activity);
    },
    [sessions, activeTabId],
  );

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
        // attachName so a window-tab opens the file against the exact
        // pinned window, not whichever window the real session's own
        // (independently-diverged) current-window pointer happens to be on.
        const { windowIndex, deferredPane } = await api.openFile(activeTab.attachName, filePath);
        if (windowIndex !== null) {
          // Either a busy pane got a fresh nvim window, or an nvim already
          // running in another window was reused — either way, surface that
          // window's tab (activating it if already open) rather than
          // leaving the user to hunt for it in the sidebar. activeTab.sessionName
          // (the real session), not attachName, since that's what window-tabs
          // are keyed on.
          await refresh();
          await openWindowTab(activeTab.sessionName, windowIndex);
        }
        if (deferredPane) {
          // The found nvim's RPC socket wasn't reachable, so the server held
          // off injecting keystrokes until its window's tab was visible —
          // complete it now.
          await api.openFile(activeTab.attachName, filePath, deferredPane);
        }
      } catch (err) {
        showError(err);
      }
    },
    [activeTab, showError, refresh, openWindowTab],
  );

  // A tmux-native cross-session pick (choose-tree, Ctrl+B s) — the server
  // already switched the client back to the tab's own session. Surface the
  // target, preferring a tab pinned to the exact window the pick landed on
  // over the whole-session tab.
  const openSwitchedSession = useCallback(
    (session: string, windowIndex: number) => {
      const existing = tabs.find(
        (t) => t.sessionName === session && t.windowIndex === windowIndex,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      openSession(session);
    },
    [tabs, openSession],
  );

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
            activeSessionName={activeTab?.sessionName ?? null}
            activeWindow={
              activeTab?.windowIndex !== undefined
                ? { sessionName: activeTab.sessionName, index: activeTab.windowIndex }
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
            onOpenSettings={() => setShowSettings(true)}
            onCollapse={() => setSidebarVisible(false)}
            filesRootDir={filesRootDir}
            onDropFiles={handleFileTreeDrop}
            filesRefreshKey={filesRefreshKey}
            onFilesRefresh={handleFilesRefresh}
            onOpenFile={openFileInSession}
            fileMenuItems={fileMenuItems}
            fileTreeRootMenuItems={fileTreeRootMenuItems}
            prunePath={prunePath}
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
        />
        <div className="terminals">
          {tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              attachName={tab.attachName}
              active={tab.id === activeTabId}
              settings={settings}
              onExit={() => closeTab(tab.id)}
              onError={showError}
              // A tmux-native window switch inside this window tab — the
              // server already reverted the synthetic session to its pin;
              // surface the window the user actually picked.
              onWindowSwitch={(windowIndex) => openWindowTab(tab.sessionName, windowIndex)}
              onSessionSwitch={openSwitchedSession}
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
      {showSwitcher && (
        <QuickSwitcher
          sessions={sessions}
          tabs={tabs}
          onActivateTab={setActiveTabId}
          onOpenWindow={openWindowTab}
          onOpenSession={openSession}
          onClose={() => setShowSwitcher(false)}
        />
      )}
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
