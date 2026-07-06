import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { isRealTab } from "../lib/tabs";
import type { AppSettings } from "../settings";
import type { MenuItem, PinnedSession, Tab, TmuxSession, TmuxWindow } from "../types";

// createWindow's server call returns void (see server/src/tmux.ts), so the
// window it just created isn't known until the next session list fetch —
// unlike createSession/restorePinnedSession, whose own return value already
// carries the fresh session's windows. A direct fetch rather than waiting on
// the `sessions` prop: that's React state, still stale within this same
// callback invocation right after refresh() resolves.
async function findActiveWindowIndex(sessionName: string): Promise<number | undefined> {
  const freshSessions = await api.fetchSessions();
  return freshSessions.find((s) => s.name === sessionName)?.windows.find((w) => w.active)?.index;
}

// Session/window CRUD (create/rename/kill), pinning, and the context menus
// built on top of them (sessionMenuItems/windowMenuItems/tabMenuItems).
// Takes the tab-closing primitives (closeTab/closeOtherTabs) and renameGroup
// from useTabs/useTabGroups, and openWindowTab/openAllWindows/pinnedSessions
// state, as explicit parameters rather than reaching into those hooks
// directly. See plans/session-open-all-and-pinned-sessions.md.
export function useSessionActions(
  refresh: () => Promise<void>,
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>,
  settingsRef: MutableRefObject<AppSettings>,
  tabs: Tab[],
  setTabs: Dispatch<SetStateAction<Tab[]>>,
  sessions: TmuxSession[],
  openSession: (name: string) => void,
  openWindowTab: (session: string, index: number) => Promise<string | null>,
  openAllWindows: (session: string) => Promise<void>,
  closeTab: (id: string) => Promise<void>,
  closeOtherTabs: (id: string) => Promise<void>,
  renameGroup: (oldName: string, newName: string) => void,
  pinnedSessions: PinnedSession[],
  setPinnedSessions: Dispatch<SetStateAction<PinnedSession[]>>,
) {
  // Every sidebar action that creates a session/window now ends by opening
  // that window as a window-tab (not the shared whole-session tab) — see the
  // plan's "Sidebar actions open window-tabs" decision. createSession and
  // restorePinnedSession get the fresh session's windows for free from their
  // own create call; createWindow needs findActiveWindowIndex's extra fetch.
  const createSession = useCallback(
    async (name?: string) => {
      try {
        const created = await api.createSession(name, settingsRef.current.newSessionCwd);
        await refresh();
        const activeIndex = created.windows.find((w) => w.active)?.index;
        if (activeIndex !== undefined) await openWindowTab(created.name, activeIndex);
      } catch (err) {
        showError(err);
      }
    },
    [refresh, openWindowTab, showError, settingsRef],
  );

  const togglePinSession = useCallback(
    (name: string) => {
      setPinnedSessions((prev) => {
        if (prev.some((p) => p.name === name)) return prev.filter((p) => p.name !== name);
        const cwd = sessions.find((s) => s.name === name)?.windows.find((w) => w.active)?.cwd ?? "";
        return [...prev, { name, cwd }];
      });
    },
    [sessions, setPinnedSessions],
  );

  const restorePinnedSession = useCallback(
    async (name: string, cwd: string) => {
      try {
        const created = await api.createSession(name, cwd);
        await refresh();
        const activeIndex = created.windows.find((w) => w.active)?.index;
        if (activeIndex !== undefined) await openWindowTab(created.name, activeIndex);
      } catch (err) {
        showError(err);
      }
    },
    [refresh, openWindowTab, showError],
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
        setPinnedSessions((prev) => prev.map((p) => (p.name === name ? { ...p, name: newName } : p)));
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, promptDialog, setTabs, renameGroup, setPinnedSessions],
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
      // tmux makes a freshly created window the active one; findActiveWindowIndex
      // fetches it fresh since createWindow's own response carries none.
      const activeIndex = await findActiveWindowIndex(session);
      if (activeIndex !== undefined) await openWindowTab(session, activeIndex);
    },
    [refresh, openWindowTab, showError],
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

  // `dead` (see lib/sessions.ts's SessionRow) selects the pinned-but-killed
  // variant: no live tmux state to act on, so only restore/unpin apply.
  const sessionMenuItems = useCallback(
    (name: string, dead: boolean): MenuItem[] => {
      const pin = pinnedSessions.find((p) => p.name === name);
      if (dead) {
        const cwd = pin?.cwd ?? "";
        return [
          { label: "Open", onClick: () => restorePinnedSession(name, cwd) },
          { label: "New Window", onClick: () => restorePinnedSession(name, cwd) },
          { label: "Unpin Session", onClick: () => togglePinSession(name) },
        ];
      }
      return [
        { label: "Open All Windows", onClick: () => openAllWindows(name) },
        { label: "New Window", onClick: () => createWindow(name) },
        { label: "Rename Session…", onClick: () => renameSession(name) },
        pin
          ? { label: "Unpin Session", onClick: () => togglePinSession(name) }
          : { label: "Pin Session", onClick: () => togglePinSession(name) },
        { label: "Kill Session", danger: true, onClick: () => killSession(name) },
      ];
    },
    [
      pinnedSessions,
      restorePinnedSession,
      togglePinSession,
      openAllWindows,
      createWindow,
      renameSession,
      killSession,
    ],
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
    togglePinSession,
    restorePinnedSession,
    sessionMenuItems,
    windowMenuItems,
    tabMenuItems,
  };
}
