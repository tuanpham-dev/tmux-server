import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { isRealTab } from "../lib/tabs";
import type { AppSettings } from "../settings";
import type { MenuItem, Tab, TmuxWindow } from "../types";

// Session/window CRUD (create/rename/kill) and the context menus built on
// top of them (sessionMenuItems/windowMenuItems/tabMenuItems). Takes the
// tab-closing primitives (closeTab/closeOtherTabs) and renameGroup from
// useTabs/useTabGroups as explicit parameters rather than reaching into
// those hooks directly.
export function useSessionActions(
  refresh: () => Promise<void>,
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>,
  settingsRef: MutableRefObject<AppSettings>,
  tabs: Tab[],
  setTabs: Dispatch<SetStateAction<Tab[]>>,
  openSession: (name: string) => void,
  closeTab: (id: string) => Promise<void>,
  closeOtherTabs: (id: string) => Promise<void>,
  renameGroup: (oldName: string, newName: string) => void,
) {
  const createSession = useCallback(
    async (name?: string) => {
      try {
        const created = await api.createSession(name, settingsRef.current.newSessionCwd);
        await refresh();
        openSession(created.name);
      } catch (err) {
        showError(err);
      }
    },
    [refresh, openSession, showError, settingsRef],
  );

  const killSession = useCallback(
    async (name: string) => {
      if (
        settingsRef.current.confirmBeforeKill &&
        !(await confirmDialog(`Kill tmux session "${name}"?`, "Kill Session"))
      )
        return;
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
    [refresh, showError, confirmDialog, tabs, setTabs, settingsRef],
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
        renameGroup(name, newName);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, promptDialog, setTabs, renameGroup],
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
        settingsRef.current.confirmBeforeKill &&
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
    [refresh, showError, confirmDialog, tabs, closeTab, settingsRef],
  );

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
    (tab: Tab): MenuItem[] => {
      const closeItems: MenuItem[] = [
        { label: "Close Tab", onClick: () => closeTab(tab.id) },
        { label: "Close Other Tabs", onClick: () => closeOtherTabs(tab.id) },
      ];
      // Virtual tabs (image/markdown preview) have no tmux session — New
      // Window/Rename/Kill Session don't apply.
      if (!isRealTab(tab)) return closeItems;
      return [
        ...closeItems,
        { label: "New Window", onClick: () => createWindow(tab.sessionName) },
        { label: "Rename Session…", onClick: () => renameSession(tab.sessionName) },
        {
          label: "Kill Session",
          danger: true,
          onClick: () => killSession(tab.sessionName),
        },
      ];
    },
    [closeTab, closeOtherTabs, createWindow, renameSession, killSession],
  );

  return {
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
  };
}
