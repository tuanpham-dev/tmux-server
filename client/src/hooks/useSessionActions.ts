import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import { bumpRecent, projectName, sessionNameForProject } from "../lib/projects";
import { isRealTab, tabVirtualPath } from "../lib/tabs";
import type { SplitDirection } from "../lib/splits";
import type { AppSettings } from "../settings";
import type { MenuItem, Project, Tab, TmuxSession, TmuxWindow } from "../types";

// createWindow's server call returns void (see server/src/tmux.ts), so the
// window it just created isn't known until the next session list fetch —
// unlike openProject, whose own create call already carries the fresh
// session's windows. A direct fetch rather than waiting on the `sessions`
// prop: that's React state, still stale within this same callback
// invocation right after refresh() resolves.
async function findActiveWindowIndex(sessionName: string): Promise<number | undefined> {
  const freshSessions = await api.fetchSessions();
  return freshSessions.find((s) => s.name === sessionName)?.windows.find((w) => w.active)?.index;
}

// Session/window CRUD, project open/close/pin/recents (the projects
// registry — see plans/projects-not-sessions.md), and the context menus
// built on top of them (sessionMenuItems/deadProjectMenuItems/
// windowMenuItems/tabMenuItems/recentProjectMenuItems). Takes the
// tab-closing primitives (closeTab/closeOtherTabs) and
// openWindowTab/openAllWindows/projects state as explicit parameters rather
// than reaching into those hooks directly. Sessions have no rename action
// anywhere — a project's name is its folder's, and session names are
// cosmetic (sessionNameForProject), so renaming would only make labels
// diverge.
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
  projects: Project[],
  setProjects: Dispatch<SetStateAction<Project[]>>,
  splitGroup: (direction: SplitDirection, tabId?: string) => Promise<void>,
  moveTabToAdjacentGroup: (tabId: string, direction: "next" | "previous") => void,
  // The FILES tree's resolved root (App.tsx's resolvedFilesRootDir) — the
  // base tabMenuItems' "Copy Relative Path" resolves against, matching the
  // tree's own copyFileRelativePath semantics.
  filesRootDir: string | null,
) {
  // Opens the project rooted in `cwd`: focuses the live session already
  // rooted there, or creates one — named after the folder, started in
  // exactly that folder (exactCwd) so session_path round-trips and the
  // panel's cwd matching holds. Every open (not a failed create) records
  // the folder into the recents registry via bumpRecent.
  const openProject = useCallback(
    async (cwd: string) => {
      try {
        const live = sessions.find((s) => s.path === cwd);
        if (live) {
          setProjects((prev) => bumpRecent(prev, cwd));
          const activeIndex =
            live.windows.find((w) => w.active)?.index ?? live.windows[0]?.index;
          if (activeIndex !== undefined) await openWindowTab(live.name, activeIndex);
          return;
        }
        const created = await api.createSession(
          sessionNameForProject(cwd, sessions.map((s) => s.name)),
          cwd,
          true,
        );
        setProjects((prev) => bumpRecent(prev, cwd));
        await refresh();
        const activeIndex = created.windows.find((w) => w.active)?.index;
        if (activeIndex !== undefined) await openWindowTab(created.name, activeIndex);
      } catch (err) {
        showError(err);
      }
    },
    [sessions, refresh, openWindowTab, showError, setProjects],
  );

  // Pins/unpins the project a session's folder belongs to (keyed by
  // session_path — rename-proof). Pinning a session in a folder that was
  // never opened as a project registers it; unpinning keeps the entry in
  // recents, it only stops surviving session death.
  const togglePinSession = useCallback(
    (name: string) => {
      const path = sessions.find((s) => s.name === name)?.path;
      if (!path) return;
      setProjects((prev) => {
        const existing = prev.find((p) => p.cwd === path);
        if (existing) return prev.map((p) => (p.cwd === path ? { ...p, pinned: !p.pinned } : p));
        return [...prev, { cwd: path, pinned: true, lastOpened: Date.now() }];
      });
    },
    [sessions, setProjects],
  );

  const unpinProject = useCallback(
    (cwd: string) => {
      setProjects((prev) => prev.map((p) => (p.cwd === cwd ? { ...p, pinned: false } : p)));
    },
    [setProjects],
  );

  // Forgets a folder entirely (recents entry and pin alike) — the recent
  // dropdown's per-entry trailing action.
  const removeRecentProject = useCallback(
    (cwd: string) => {
      setProjects((prev) => prev.filter((p) => p.cwd !== cwd));
    },
    [setProjects],
  );

  const clearRecentProjects = useCallback(() => {
    setProjects((prev) => prev.filter((p) => p.pinned));
  }, [setProjects]);

  // The unconfirmed kill: tmux kill + the window-tab cascade + tab cleanup.
  // Split out from killSession below so a caller that has already confirmed a
  // larger destructive action reuses this exact cleanup instead of prompting
  // twice — notably ctx.app.killSession (extensions.ts), whose contract is
  // caller-confirms. A raw `tmux kill-session` is *not* equivalent: window-tabs
  // attach to synthetic grouped tmuxserver-view-* sessions whose shared windows
  // outlive the real session, so without closeWindowTab they linger as live but
  // orphaned tabs (viewSweeper only reaps them after 24h *unattached*).
  const killSessionNow = useCallback(
    async (name: string) => {
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
    [refresh, showError, tabs, setTabs],
  );

  // Closes the whole project a session belongs to: every live session
  // rooted in the same folder dies (a pathless session is just itself).
  // Confirm wording scales with what's actually being closed.
  const closeProject = useCallback(
    async (name: string) => {
      const target = sessions.find((s) => s.name === name);
      const members =
        target?.path !== undefined && target.path !== ""
          ? sessions.filter((s) => s.path === target.path)
          : target
            ? [target]
            : [];
      if (members.length === 0) return;
      const label = target!.path ? projectName(target!.path) : name;
      const terminals = members.reduce((n, s) => n + s.windows.length, 0);
      const detail =
        members.length > 1
          ? `${terminals} terminals across ${members.length} sessions will be closed.`
          : terminals === 1
            ? "Its terminal will be closed."
            : `Its ${terminals} terminals will be closed.`;
      if (
        settingsRef.current.confirmBeforeKill &&
        !(await confirmDialog(`Close project "${label}"? ${detail}`, "Close Project"))
      )
        return;
      for (const s of members) await killSessionNow(s.name);
    },
    [confirmDialog, killSessionNow, settingsRef, sessions],
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
      const newName = (await promptDialog("New terminal name", win.name))?.trim();
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
      const winName = sessions.find((s) => s.name === session)?.windows.find((w) => w.index === index)?.name;
      if (
        settingsRef.current.confirmBeforeKill &&
        !(await confirmDialog(
          `Close terminal "${winName ?? index}"?`,
          "Close Terminal",
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
    [refresh, showError, confirmDialog, tabs, closeTab, settingsRef, sessions],
  );

  // Menu for a live session row. Pin state is the project registry's flag
  // for the session's folder (session_path) — see togglePinSession above.
  const sessionMenuItems = useCallback(
    (name: string): MenuItem[] => {
      const path = sessions.find((s) => s.name === name)?.path;
      const pinned = path !== undefined && projects.some((p) => p.cwd === path && p.pinned);
      return [
        { label: "Open All Terminals", onClick: () => openAllWindows(name) },
        { label: "New Terminal", onClick: () => createWindow(name) },
        pinned
          ? { label: "Unpin Project", onClick: () => togglePinSession(name) }
          : { label: "Pin Project", onClick: () => togglePinSession(name) },
        { label: "Close Project", danger: true, onClick: () => closeProject(name) },
      ];
    },
    [
      sessions,
      projects,
      togglePinSession,
      openAllWindows,
      createWindow,
      closeProject,
    ],
  );

  // Menu for a dead pinned-project row: no live tmux state to act on, so
  // only open/unpin/forget apply.
  const deadProjectMenuItems = useCallback(
    (cwd: string): MenuItem[] => [
      { label: "Open Project", onClick: () => openProject(cwd) },
      { label: "Unpin Project", onClick: () => unpinProject(cwd) },
      { label: "Remove from Recent", onClick: () => removeRecentProject(cwd) },
    ],
    [openProject, unpinProject, removeRecentProject],
  );

  // The recent-projects header dropdown: every registered folder MRU-first,
  // each row opening its project and carrying a trailing "forget" action;
  // footer offers the folder picker and the bulk clear (which keeps pins).
  const recentProjectMenuItems = useCallback(
    (openFolderPicker: () => void): MenuItem[] => {
      const items: MenuItem[] = [...projects]
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .map((p) => ({
          label: `${projectName(p.cwd)} — ${p.cwd}`,
          icon: p.pinned ? "pinned" : "folder",
          onClick: () => openProject(p.cwd),
          trailing: {
            icon: "close",
            title: "Remove from Recent",
            onClick: () => removeRecentProject(p.cwd),
          },
        }));
      if (items.length === 0) {
        items.push({ label: "No recent projects", disabled: true, onClick: () => {} });
      }
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Open Folder…", onClick: openFolderPicker });
      if (projects.some((p) => !p.pinned)) {
        items.push({ label: "Clear Recently Opened", onClick: clearRecentProjects });
      }
      return items;
    },
    [projects, openProject, removeRecentProject, clearRecentProjects],
  );

  const windowMenuItems = useCallback(
    (session: string, win: TmuxWindow): MenuItem[] => [
      { label: "Select Terminal", onClick: () => selectWindowInSession(session, win.index) },
      { label: "New Terminal", onClick: () => createWindow(session) },
      { label: "Rename Terminal…", onClick: () => renameWindow(session, win) },
      {
        label: "Close Terminal",
        danger: true,
        onClick: () => killWindow(session, win.index),
      },
    ],
    [selectWindowInSession, createWindow, renameWindow, killWindow],
  );

  const tabMenuItems = useCallback(
    (tab: Tab): MenuItem[] => {
      // Splits always duplicate `tab` specifically (not whatever's active),
      // matching VS Code's own tab-context-menu split items — see
      // useTabs.ts's duplicateTabToGroup for what each tab kind duplicates
      // into the new group.
      const splitItems: MenuItem[] = [
        { label: "Split Up", onClick: () => splitGroup("up", tab.id) },
        { label: "Split Down", onClick: () => splitGroup("down", tab.id) },
        { label: "Split Left", onClick: () => splitGroup("left", tab.id) },
        { label: "Split Right", onClick: () => splitGroup("right", tab.id) },
        {
          label: "Move into Next Group",
          onClick: () => moveTabToAdjacentGroup(tab.id, "next"),
        },
      ];
      const closeItems: MenuItem[] = [
        { label: "Close Tab", onClick: () => closeTab(tab.id) },
        { label: "Close Other Tabs", onClick: () => closeOtherTabs(tab.id) },
      ];
      // A viewer tab shows a file, so its menu offers the same path copies
      // as the FILES tree's row menu (useFileActions), against the same
      // root. Falls back to the absolute path when the file lies outside
      // the current root — e.g. a preview left open after switching to a
      // session in another repo.
      const virtualPath = tabVirtualPath(tab);
      const pathItems: MenuItem[] =
        virtualPath === undefined
          ? []
          : [
              { label: "Copy Path", onClick: () => copyText(virtualPath).catch(showError) },
              {
                label: "Copy Relative Path",
                onClick: () => {
                  const rel =
                    filesRootDir && virtualPath.startsWith(filesRootDir + "/")
                      ? virtualPath.slice(filesRootDir.length + 1)
                      : virtualPath;
                  copyText(rel).catch(showError);
                },
              },
            ];
      // Virtual tabs (image/markdown preview) have no tmux session — New
      // Window/Close Project don’t apply.
      if (!isRealTab(tab)) return [...splitItems, ...closeItems, ...pathItems];
      return [
        ...splitItems,
        ...closeItems,
        { label: "New Terminal", onClick: () => createWindow(tab.sessionName) },
        {
          label: "Close Project",
          danger: true,
          onClick: () => closeProject(tab.sessionName),
        },
      ];
    },
    [
      closeTab,
      closeOtherTabs,
      createWindow,
      closeProject,
      splitGroup,
      moveTabToAdjacentGroup,
      filesRootDir,
      showError,
    ],
  );

  return {
    closeProject,
    killSessionNow,
    createWindow,
    selectWindowInSession,
    renameWindow,
    killWindow,
    togglePinSession,
    openProject,
    sessionMenuItems,
    deadProjectMenuItems,
    recentProjectMenuItems,
    windowMenuItems,
    tabMenuItems,
  };
}
