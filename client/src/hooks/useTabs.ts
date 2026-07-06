import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import * as api from "../api";
import { findFileViewerFor, setActiveContext, type RegisteredFileViewer } from "../extensions";
import {
  groupKeyForTab,
  isRealTab,
  loadStoredTabs,
  reconcileTabs,
  tabVirtualPath,
} from "../lib/tabs";
import type { AppSettings } from "../settings";
import type { Tab, TmuxSession } from "../types";

// Owns the tabs array and its whole lifecycle: persistence, open/close/move,
// window-tab and viewer-tab activation, the out-of-band reconcile/vanished-
// window/origin-clear sweeps, and the derived "active real tab" context the
// sidebar/FILES panel/extensions read. Takes sessions + a handful of small
// cross-hook dependencies as explicit parameters rather than reaching for
// module state, per plans/client-structure-split.md's Approach.
export function useTabs(
  sessions: TmuxSession[],
  sessionsLoadedRef: MutableRefObject<boolean>,
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  settingsRef: MutableRefObject<AppSettings>,
  extFileViewers: RegisteredFileViewer[],
) {
  // Restored tabs whose session no longer exists self-heal: attaching to a
  // dead session makes tmux exit immediately, the server relays "exit", and
  // the normal onExit handler closes that tab — no separate validation pass
  // needed here.
  const [tabs, setTabs] = useState<Tab[]>(loadStoredTabs);
  // Snapshot of `tabs` for effects/callbacks that must not themselves
  // depend on `tabs` (would either widen their run cadence or create a
  // stale closure) — same rationale as activeTabIdRef below.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => localStorage.getItem("activeTabId"),
  );
  // Mirror for insertTab below: every opener activates its new tab only
  // after computing where to insert it, so this ref still holds the
  // *previous* active tab at insertion time — exactly the anchor
  // "afterActive" placement wants. Same pattern as settingsRef.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // Virtual tabs (image/markdown preview) have no tmux session, so sidebar
  // context (the FILES tree root, the lazygit branch pill, "new window in
  // dir") keeps reflecting whichever real (terminal) tab was open most
  // recently instead of collapsing to empty while a virtual tab is active.
  // Mutated during render — same pattern as onBranchChangeRef in FileTree —
  // so it's always current without an effect's one-render lag. Declared
  // here (rather than by the activeRealTab derivation below) so
  // openExtViewerTab can pin a new viewer tab's origin session to it too.
  // Seeded from any real tab restored on this mount (useRef's initializer
  // only runs once) so a reload that lands back on a virtual tab doesn't
  // leave the sidebar empty until the user manually switches tabs.
  const lastRealTabIdRef = useRef<string | null>(tabs.find(isRealTab)?.id ?? null);
  if (activeTab && isRealTab(activeTab)) {
    lastRealTabIdRef.current = activeTab.id;
  }

  useEffect(() => {
    localStorage.setItem("tabs", JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    if (activeTabId) localStorage.setItem("activeTabId", activeTabId);
    else localStorage.removeItem("activeTabId");
  }, [activeTabId]);

  // Activation history, most recent first — closing the active tab returns
  // to the previously active tab (VS Code behavior) rather than a positional
  // neighbor. A ref: only read inside closeTab's state updater.
  const mruTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeTabId) return;
    mruTabIdsRef.current = [
      activeTabId,
      ...mruTabIdsRef.current.filter((tid) => tid !== activeTabId),
    ];
  }, [activeTabId]);

  // Inserts a newly opened tab per the newTabPlacement setting. `anchorId`
  // overrides the active-tab-ref anchor for callers that need to snapshot
  // it before an await (see openWindowTab) rather than reading it fresh at
  // insertion time; omit it to use activeTabIdRef.current.
  const insertTab = useCallback((prev: Tab[], tab: Tab, anchorId?: string | null): Tab[] => {
    if (settingsRef.current.newTabPlacement !== "afterActive") return [...prev, tab];
    const anchor = anchorId !== undefined ? anchorId : activeTabIdRef.current;
    const index = anchor ? prev.findIndex((t) => t.id === anchor) : -1;
    if (index === -1) return [...prev, tab];
    return [...prev.slice(0, index + 1), tab, ...prev.slice(index + 1)];
  }, [settingsRef]);

  const openSession = useCallback(
    (name: string) => {
      setTabs((prev) => {
        // Only match a whole-session tab — a window-tab for this session
        // shares the same sessionName but must never be treated as it.
        const existing = prev.find((t) => t.sessionName === name && t.windowIndex === undefined);
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        // A window-tab pinned to this session's currently active window
        // shows this exact same content under a different label — focus it
        // instead of opening a duplicate whole-session tab.
        const activeIndex = sessions.find((s) => s.name === name)?.windows.find((w) => w.active)?.index;
        const pinnedActive = prev.find((t) => t.sessionName === name && t.windowIndex === activeIndex);
        if (activeIndex !== undefined && pinnedActive) {
          setActiveTabId(pinnedActive.id);
          return prev;
        }
        const tab: Tab = { id: crypto.randomUUID(), sessionName: name, attachName: name };
        setActiveTabId(tab.id);
        return insertTab(prev, tab);
      });
    },
    [sessions, insertTab],
  );

  // Activate-or-create, keyed on (viewerId, path) — viewerId is stored on
  // the tab so the render dispatch knows which registered component to use
  // without re-matching by extension (a second extension could register for
  // the same one later). Every built-in preview (image/media/pdf/markdown/
  // json/yaml/csv) is itself an extension-registered viewer now, so this is
  // the only virtual-file-tab opener — see findFileViewerFor for how a path
  // resolves to a viewer.
  const openExtViewerTab = useCallback((viewerId: string, filePath: string, title?: string) => {
    // Pins the viewer tab to whichever real tab it was opened "from" — same
    // sticky lookup the FILES panel itself uses (lastRealTabIdRef), so a
    // preview opened while another viewer tab is active still attributes to
    // the last real session, not none — so it can join that session's tab
    // group (groupKeyForTab). Undefined origin (no real tab ever opened)
    // just means the tab stays ungrouped, same as today.
    const origin = tabsRef.current.find((t) => t.id === lastRealTabIdRef.current);
    setTabs((prev) => {
      const existing = prev.find((t) => t.extViewerId === viewerId && t.extViewerPath === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        // Re-opening an already-open viewer tab still applies a freshly
        // passed title — e.g. git-scm's diff viewer toggling Working Tree
        // <-> Staged on the same path.
        if (title !== undefined && existing.extViewerTitle !== title) {
          return prev.map((t) => (t.id === existing.id ? { ...t, extViewerTitle: title } : t));
        }
        return prev;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        sessionName: "",
        attachName: "",
        extViewerId: viewerId,
        extViewerPath: filePath,
        extViewerTitle: title,
        originSessionName: origin?.sessionName,
        originSessionId: origin?.sessionId,
      };
      setActiveTabId(tab.id);
      return insertTab(prev, tab);
    });
  }, [insertTab]);

  // One-time migration for tabs restored from localStorage before this
  // extraction shipped — old imagePath/previewPath tabs become extViewerId/
  // extViewerPath tabs against whichever registered viewer now claims that
  // path, in the equivalent mode. Runs whenever the registry changes (i.e.
  // once activation completes); a tab whose viewer never shows up (its
  // extension got removed) is left as-is and falls through to the "loading"
  // placeholder in App's render switch.
  useEffect(() => {
    if (extFileViewers.length === 0) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const legacyPath = tab.imagePath ?? tab.previewPath;
        if (legacyPath === undefined) return tab;
        const mode: "default" | "preview" = tab.imagePath !== undefined ? "default" : "preview";
        const viewer = findFileViewerFor(legacyPath, extFileViewers, mode);
        if (!viewer) return tab;
        changed = true;
        return {
          id: tab.id,
          sessionName: "",
          attachName: "",
          extViewerId: viewer.id,
          extViewerPath: legacyPath,
        };
      });
      return changed ? next : prev;
    });
  }, [extFileViewers]);

  // Singleton settings tab — the third virtual-tab kind. Activate-or-create
  // like openExtViewerTab, keyed on the marker itself since there's only one.
  const openSettingsTab = useCallback(() => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.settingsView);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const tab: Tab = { id: crypto.randomUUID(), sessionName: "", attachName: "", settingsView: true };
      setActiveTabId(tab.id);
      return insertTab(prev, tab);
    });
  }, [insertTab]);

  const openWindowTab = useCallback(
    async (session: string, index: number) => {
      const existing = tabs.find((t) => t.sessionName === session && t.windowIndex === index);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      // If this is the session's currently active window and a whole-session
      // tab is already open, that tab already shows this exact content —
      // focus it instead of spawning a duplicate grouped-session tab under a
      // different label.
      const isActiveWindow = sessions
        .find((s) => s.name === session)
        ?.windows.find((w) => w.index === index)?.active;
      if (isActiveWindow) {
        const wholeSessionTab = tabs.find((t) => t.sessionName === session && t.windowIndex === undefined);
        if (wholeSessionTab) {
          setActiveTabId(wholeSessionTab.id);
          return;
        }
      }
      // Snapshotted before the await below: if the user switches the active
      // tab while this request is in flight, the new tab still lands next to
      // whichever tab they initiated it from, not whatever became active
      // meanwhile.
      const anchorId = activeTabIdRef.current;
      try {
        const { attachName } = await api.openWindowTab(session, index);
        const tab: Tab = { id: crypto.randomUUID(), sessionName: session, attachName, windowIndex: index };
        setTabs((prev) => insertTab(prev, tab, anchorId));
        setActiveTabId(tab.id);
      } catch (err) {
        showError(err);
      }
    },
    [tabs, sessions, showError, insertTab],
  );

  // Tabs with unsaved edits (currently only csv-preview's editable grid
  // reports into this via setDirty — JSON's Format & Save is a one-shot
  // action, not an edit buffer). A plain ref, not state: membership changes
  // don't need to trigger a render on
  // their own, only the confirm check below reads it.
  const dirtyTabsRef = useRef<Set<string>>(new Set());

  const closeTab = useCallback(
    async (id: string) => {
      if (dirtyTabsRef.current.has(id)) {
        const ok = await confirmDialog("This tab has unsaved changes. Close anyway?", "Close");
        if (!ok) return;
        dirtyTabsRef.current.delete(id);
      }
      const tab = tabs.find((t) => t.id === id);
      if (tab?.windowIndex !== undefined) {
        api.closeWindowTab(tab.attachName).catch(() => {});
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => tid !== id);
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.filter((t) => t.id !== id);
        setActiveTabId((current) => {
          if (current !== id) return current;
          if (settingsRef.current.tabCloseActivation === "recent") {
            const previous = mruTabIdsRef.current.find(
              (tid) => tid !== id && next.some((t) => t.id === tid),
            );
            if (previous) return previous;
          }
          const neighbor = next[Math.min(idx, next.length - 1)];
          return neighbor ? neighbor.id : null;
        });
        return next;
      });
    },
    [tabs, confirmDialog, settingsRef],
  );

  const cycleTab = (delta: number) => {
    if (tabs.length < 2 || !activeTabId) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx === -1) return;
    setActiveTabId(tabs[(idx + delta + tabs.length) % tabs.length].id);
  };

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
    async (id: string) => {
      const toClose = tabs.filter((t) => t.id !== id);
      const anyDirty = toClose.some((t) => dirtyTabsRef.current.has(t.id));
      if (anyDirty) {
        const ok = await confirmDialog("Some tabs have unsaved changes. Close all others anyway?", "Close All");
        if (!ok) return;
      }
      const closedIds = new Set(toClose.map((t) => t.id));
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => !closedIds.has(tid));
      setTabs((prev) => prev.filter((t) => t.id === id));
      setActiveTabId(id);
    },
    [tabs, confirmDialog],
  );

  // Runs every poll: rewrites any tab whose session/window drifted from an
  // out-of-band rename or renumber (see reconcileTabs), and follows the same
  // rename for any viewer tab's originSessionName (see openExtViewerTab) —
  // otherwise it'd silently drop out of its group the instant the session it
  // was opened from gets renamed. tabGroupState's own key migration (App.tsx,
  // until it moves into useTabGroups) detects the same renames independently
  // from tabsRef rather than sharing this effect's computation, so the two
  // concerns don't need to reach into each other.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    const renames = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!tab.sessionId) continue;
      const session = sessions.find((s) => s.id === tab.sessionId);
      if (session && session.name !== tab.sessionName) renames.set(tab.sessionName, session.name);
    }
    setTabs((prev) => {
      const reconciled = reconcileTabs(prev, sessions);
      if (renames.size === 0) return reconciled;
      let changed = false;
      const next = reconciled.map((tab) => {
        const renamed = tab.originSessionName && renames.get(tab.originSessionName);
        if (!renamed) return tab;
        changed = true;
        return { ...tab, originSessionName: renamed };
      });
      return changed ? next : reconciled;
    });
  }, [sessions, sessionsLoadedRef]);

  // A window-tab's pinned window can disappear for reasons we can't
  // explicitly intercept client-side — nvim exiting closes the window it
  // was the sole command of, a shell's own "exit", someone killing it from
  // a real terminal. Left alone, the tab would silently start showing
  // whatever adjacent window tmux falls back to (same root cause as the
  // explicit "Kill Window" cascade in useSessionActions, but for every other
  // trigger). This is deliberately generic rather than another explicit
  // cascade: it catches all of the above, including the vanished-real-
  // session edge case noted in plans/per-window-tabs.md, from the poll we
  // already run.
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
  }, [sessions, tabs, sessionsLoadedRef, closeTab]);

  // A viewer tab's origin session (see openExtViewerTab) can go away —
  // killed, or its last real tab closed independently of the viewer tab.
  // The viewer tab itself has no live tmux process to lose, so it stays
  // open; it just ungroups (clears origin) rather than keeping a chip for a
  // session that no longer exists.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.originSessionName === undefined) return tab;
        const stillExists = tab.originSessionId
          ? sessions.some((s) => s.id === tab.originSessionId)
          : sessions.some((s) => s.name === tab.originSessionName);
        if (stillExists) return tab;
        changed = true;
        const { originSessionName: _n, originSessionId: _i, ...rest } = tab;
        return rest;
      });
      return changed ? next : prev;
    });
  }, [sessions, sessionsLoadedRef]);

  const activeRealTab =
    activeTab && isRealTab(activeTab)
      ? activeTab
      : (tabs.find((t) => t.id === lastRealTabIdRef.current) ?? null);

  const activeSession = sessions.find((s) => s.name === activeRealTab?.sessionName) ?? null;
  // A window-tab is pinned to a specific window, which may not be the
  // session's own tmux-level active window (their current-window pointers
  // diverge independently once a window-tab exists) — look it up by index
  // rather than falling back to whatever the session considers active.
  const activeWindow =
    activeRealTab?.windowIndex !== undefined
      ? activeSession?.windows.find((w) => w.index === activeRealTab.windowIndex)
      : activeSession?.windows.find((w) => w.active);
  const filesRootDir = activeWindow?.cwd ?? null;

  // Feeds ctx.app.getActiveContext()/onDidChangeContext() for extensions —
  // reuses the exact same activeRealTab/activeWindow derivation the FILES
  // panel and lazygit pill already trust, so an extension sees the same
  // "current session/window" a virtual tab (image/preview/settings/another
  // ext viewer) doesn't collapse to.
  useEffect(() => {
    setActiveContext({
      sessionName: activeRealTab?.sessionName ?? null,
      windowIndex: activeWindow?.index ?? null,
      cwd: filesRootDir,
    });
  }, [activeRealTab, activeWindow, filesRootDir]);

  const tabLabel = useCallback(
    (tab: Tab): string => {
      if (tab.settingsView) return "Settings";
      if (tab.extViewerTitle !== undefined) return tab.extViewerTitle;
      const virtualPath = tabVirtualPath(tab);
      if (virtualPath !== undefined) {
        return virtualPath.slice(virtualPath.lastIndexOf("/") + 1);
      }
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

  return {
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
  };
}
