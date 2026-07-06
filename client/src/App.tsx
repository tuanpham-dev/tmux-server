import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { copyText } from "./clipboard";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import QuickSwitcher from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/TerminalView";
import {
  findFileViewerFor,
  setActiveContext,
  setOpenFileTabHandler,
  setOpenViewerTabHandler,
  setRefreshFilesHandler,
  useExtensionRegistry,
} from "./extensions";
import { useDialogs } from "./hooks/useDialogs";
import { useSessions } from "./hooks/useSessions";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useThemeAssets } from "./hooks/useThemeAssets";
import { recorderState, serializeEvent } from "./keybindings";
import type { MenuItem, MenuState, Tab, TabGroupState, TmuxWindow } from "./types";
import { collectDropped, uploadAll, type DroppedItems } from "./upload";
import { GROUP_COLORS, nextAutoColor } from "./utils/groupColor";
import {
  groupKeyForTab,
  isRealTab,
  loadStoredTabGroupState,
  loadStoredTabs,
  normalizeTabGroups,
  reconcileTabs,
  tabVirtualPath,
} from "./lib/tabs";

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
  // here (rather than by the activeRealTab derivation that reads it below)
  // so openExtViewerTab can pin a new viewer tab's origin session to it too.
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

  // Chrome-style tab-group UI state (color/collapsed), keyed by session
  // name — see groupKeyForTab above and plans/tab-groups-by-session.md.
  const [tabGroupState, setTabGroupState] = useState<Record<string, TabGroupState>>(
    loadStoredTabGroupState,
  );
  useEffect(() => {
    localStorage.setItem("tabGroupState", JSON.stringify(tabGroupState));
  }, [tabGroupState]);

  // Keeps tabGroupState in sync with which sessions actually have tabs open:
  // prunes entries for sessions with no tab left (forgets color/collapsed,
  // same as Chrome forgetting a closed group), and — only while grouping is
  // enabled — auto-assigns a fresh palette color to any session that gained
  // tabs without one yet.
  useEffect(() => {
    setTabGroupState((prev) => {
      const sessionNames = new Set(tabs.filter(isRealTab).map((t) => t.sessionName));
      let changed = false;
      const next: Record<string, TabGroupState> = {};
      for (const [name, state] of Object.entries(prev)) {
        if (sessionNames.has(name)) next[name] = state;
        else changed = true;
      }
      if (settingsRef.current.tabGroupsBySession) {
        let colorCount = Object.keys(next).length;
        for (const name of sessionNames) {
          if (!next[name]) {
            next[name] = { color: nextAutoColor(colorCount), collapsed: false };
            colorCount++;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [tabs, settings.tabGroupsBySession]);

  // Enforces group contiguity while grouping is enabled — reorders `tabs` so
  // each session's tabs sit adjacent to each other (see normalizeTabGroups).
  // A no-op (same array reference) once already normalized, so this can't
  // loop: setTabs bails on an unchanged reference.
  useEffect(() => {
    if (!settings.tabGroupsBySession) return;
    setTabs((prev) => normalizeTabGroups(prev));
  }, [tabs, settings.tabGroupsBySession]);

  // A tab activated while its group is collapsed must not stay hidden
  // behind its own chip — expand its group so the active tab is always
  // reachable (quick switcher, sidebar, tab cycling, dedupe-activation all
  // funnel through setActiveTabId, so this one effect covers every path).
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const key = tab ? groupKeyForTab(tab) : null;
    if (!key) return;
    setTabGroupState((prev) => {
      const state = prev[key];
      if (!state?.collapsed) return prev;
      return { ...prev, [key]: { ...state, collapsed: false } };
    });
  }, [activeTabId, tabs]);

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

  const { dialog, confirmDialog, promptDialog } = useDialogs();

  const [uploadProgress, setUploadProgress] = useState<{
    currentName: string;
    loadedBytes: number;
    totalBytes: number;
  } | null>(null);
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
  }, []);

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

  // The "Preview" escape hatch (hover icon / context-menu item / Shift+Enter)
  // for a path some "preview"-mode viewer claims — markdown/json/yaml/csv
  // today. A no-op if no such viewer is registered (extension disabled, or
  // called before activation finishes).
  const openPreviewViewerTab = useCallback(
    (filePath: string) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "preview");
      if (viewer) openExtViewerTab(viewer.id, filePath);
    },
    [extFileViewers, openExtViewerTab],
  );

  // Gates FileTree's hover preview icon — registry-driven replacement for
  // the old fileKinds.ts isPreviewablePath.
  const isPreviewable = useCallback(
    (filePath: string) => findFileViewerFor(filePath, extFileViewers, "preview") !== null,
    [extFileViewers],
  );

  // One-time migration for tabs restored from localStorage before this
  // extraction shipped — old imagePath/previewPath tabs become extViewerId/
  // extViewerPath tabs against whichever registered viewer now claims that
  // path, in the equivalent mode. Runs whenever the registry changes (i.e.
  // once activation completes); a tab whose viewer never shows up (its
  // extension got removed) is left as-is and falls through to the "loading"
  // placeholder in the render switch below.
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
    [tabs, confirmDialog],
  );

  const cycleTab = (delta: number) => {
    if (tabs.length < 2 || !activeTabId) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx === -1) return;
    setActiveTabId(tabs[(idx + delta + tabs.length) % tabs.length].id);
  };

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

  // Toggles a group's collapsed state. Collapsing the group holding the
  // active tab hands activation to the MRU tab outside it (same fallback
  // order as closeTab), falling back to the nearest tab outside the group;
  // if the group contains every open tab, there's nothing to hand off to —
  // silent no-op rather than stranding the active tab with no visible tab.
  const toggleGroupCollapsed = useCallback((sessionName: string) => {
    setTabGroupState((prev) => {
      const state = prev[sessionName];
      if (!state) return prev;
      const collapsing = !state.collapsed;
      if (collapsing) {
        const memberIds = new Set(
          tabsRef.current.filter((t) => groupKeyForTab(t) === sessionName).map((t) => t.id),
        );
        const hasOutside = tabsRef.current.some((t) => !memberIds.has(t.id));
        if (!hasOutside) return prev;
        setActiveTabId((current) => {
          if (!current || !memberIds.has(current)) return current;
          const previous = mruTabIdsRef.current.find(
            (tid) => !memberIds.has(tid) && tabsRef.current.some((t) => t.id === tid),
          );
          if (previous) return previous;
          const neighbor = tabsRef.current.find((t) => !memberIds.has(t.id));
          return neighbor ? neighbor.id : current;
        });
      }
      return { ...prev, [sessionName]: { ...state, collapsed: collapsing } };
    });
  }, []);

  const closeGroupTabs = useCallback(
    async (sessionName: string) => {
      const toClose = tabs.filter((t) => groupKeyForTab(t) === sessionName);
      if (toClose.length === 0) return;
      const anyDirty = toClose.some((t) => dirtyTabsRef.current.has(t.id));
      if (anyDirty) {
        const ok = await confirmDialog("Some tabs have unsaved changes. Close this group anyway?", "Close Group");
        if (!ok) return;
      }
      const closedIds = new Set(toClose.map((t) => t.id));
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => !closedIds.has(tid));
      setTabs((prev) => {
        const idx = prev.findIndex((t) => closedIds.has(t.id));
        const next = prev.filter((t) => !closedIds.has(t.id));
        setActiveTabId((current) => {
          if (!current || !closedIds.has(current)) return current;
          if (settingsRef.current.tabCloseActivation === "recent") {
            const previous = mruTabIdsRef.current.find(
              (tid) => tid !== current && next.some((t) => t.id === tid),
            );
            if (previous) return previous;
          }
          const neighbor = next[Math.min(idx, next.length - 1)];
          return neighbor ? neighbor.id : null;
        });
        return next;
      });
    },
    [tabs, confirmDialog],
  );

  const groupMenuItems = useCallback(
    (sessionName: string): MenuItem[] => {
      const state = tabGroupState[sessionName];
      const collapsed = state?.collapsed ?? false;
      return [
        {
          label: collapsed ? "Expand Group" : "Collapse Group",
          onClick: () => toggleGroupCollapsed(sessionName),
        },
        {
          label: "",
          onClick: () => {},
          swatches: {
            colors: GROUP_COLORS.map((c) => ({ key: c.key, hex: c.hex })),
            selected: state?.color ?? GROUP_COLORS[0].key,
            onPick: (color) =>
              setTabGroupState((prev) => {
                const s = prev[sessionName];
                if (!s) return prev;
                return { ...prev, [sessionName]: { ...s, color } };
              }),
          },
        },
        { label: "Close Group", danger: true, onClick: () => closeGroupTabs(sessionName) },
      ];
    },
    [tabGroupState, toggleGroupCollapsed, closeGroupTabs],
  );

  // Runs every poll: rewrites any tab whose session/window drifted from an
  // out-of-band rename or renumber. See reconcileTabs above.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    // An out-of-band rename (detected via stable session id, same as
    // reconcileTabs itself) also carries the group's color/collapsed state
    // along — computed from tabsRef rather than adding `tabs` as a
    // dependency, so this effect keeps running only on the sessions poll.
    const renames = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!tab.sessionId) continue;
      const session = sessions.find((s) => s.id === tab.sessionId);
      if (session && session.name !== tab.sessionName) renames.set(tab.sessionName, session.name);
    }
    if (renames.size > 0) {
      setTabGroupState((prev) => {
        const next: Record<string, TabGroupState> = {};
        for (const [name, state] of Object.entries(prev)) {
          next[renames.get(name) ?? name] = state;
        }
        return next;
      });
    }
    setTabs((prev) => {
      const reconciled = reconcileTabs(prev, sessions);
      // A viewer tab's originSessionName (see openExtViewerTab) follows the
      // same rename — otherwise it'd silently drop out of its group the
      // instant the session it was opened from gets renamed.
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
  }, [sessions]);

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
    [refresh, openSession, showError],
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
        setTabGroupState((prev) => {
          const state = prev[name];
          if (!state) return prev;
          const { [name]: _moved, ...rest } = prev;
          return { ...rest, [newName]: state };
        });
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

  const fileTreeRootMenuItems = useCallback(
    (rootDir: string): MenuItem[] => [
      { label: "New File…", onClick: () => createFileInDir(rootDir) },
      { label: "New Folder…", onClick: () => createFolderInDir(rootDir) },
    ],
    [createFileInDir, createFolderInDir],
  );

  // activeTab/lastRealTabIdRef are declared earlier (right after
  // activeTabIdRef) so openExtViewerTab can also read lastRealTabIdRef.
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
  // panel and lazygit pill already trust (see the comment above
  // activeRealTab), so an extension sees the same "current session/window"
  // a virtual tab (image/preview/settings/another ext viewer) doesn't
  // collapse to.
  useEffect(() => {
    setActiveContext({
      sessionName: activeRealTab?.sessionName ?? null,
      windowIndex: activeWindow?.index ?? null,
      cwd: filesRootDir,
    });
  }, [activeRealTab, activeWindow, filesRootDir]);

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
    async (filePath: string, line?: number) => {
      if (!activeRealTab) return;
      try {
        // attachName so a window-tab opens the file against the exact
        // pinned window, not whichever window the real session's own
        // (independently-diverged) current-window pointer happens to be on.
        const { windowIndex, deferredPane } = await api.openFile(activeRealTab.attachName, filePath, undefined, line);
        if (windowIndex !== null) {
          // Either a busy pane got a fresh nvim window, or an nvim already
          // running in another window was reused — either way, surface that
          // window's tab (activating it if already open) rather than
          // leaving the user to hunt for it in the sidebar. activeRealTab.sessionName
          // (the real session), not attachName, since that's what window-tabs
          // are keyed on.
          await refresh();
          await openWindowTab(activeRealTab.sessionName, windowIndex);
        } else {
          // null means the file opened directly in activeRealTab's own
          // window (an editor/shell already there). That's normally also
          // the tab on screen, but if an image tab is the one currently
          // active (see activeRealTab above), switch to activeRealTab so the
          // edit is actually visible instead of landing silently offscreen.
          setActiveTabId(activeRealTab.id);
        }
        if (deferredPane) {
          // The found nvim's RPC socket wasn't reachable, so the server held
          // off injecting keystrokes until its window's tab was visible —
          // complete it now (same line, so the deferred keystroke-based
          // open still jumps to it).
          await api.openFile(activeRealTab.attachName, filePath, deferredPane, line);
        }
      } catch (err) {
        showError(err);
      }
    },
    [activeRealTab, showError, refresh, openWindowTab],
  );

  // FILES-tree click dispatch: any path a "default"-mode viewer claims
  // (image/media/pdf today) opens directly in its viewer tab — nvim on
  // binary content is useless. Everything else (including markdown/json/
  // yaml/csv, "preview"-mode viewers) keeps opening in nvim as before,
  // reached via the hover icon / "Preview" menu item instead. `line`
  // (terminal ctrl+click on a "file:line" link) is ignored by the viewer-tab
  // branch — it has no line-jump concept.
  const openFileOrViewer = useCallback(
    (filePath: string, line?: number) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "default");
      if (viewer) {
        openExtViewerTab(viewer.id, filePath);
        return;
      }
      openFileInSession(filePath, line);
    },
    [extFileViewers, openExtViewerTab, openFileInSession],
  );

  // ctx.app.openFileTab(path) (extensions.ts) routes through the exact same
  // dispatch a FILES-tree click uses, so an extension command that opens a
  // file gets identical built-in-viewer-first behavior.
  useEffect(() => {
    setOpenFileTabHandler(openFileOrViewer);
  }, [openFileOrViewer]);

  // ctx.app.openViewerTab/refreshFiles (extensions.ts) — see
  // openExtViewerTab's title param and filesRefreshKey above.
  useEffect(() => {
    setOpenViewerTabHandler(openExtViewerTab);
    setRefreshFilesHandler(() => setFilesRefreshKey((k) => k + 1));
  }, [openExtViewerTab]);

  // Quick switcher's Shift+Enter action (also terminal ctrl+shift+click —
  // see TerminalView's onOpenFileSecondary). Mirrors the "Preview" escape
  // hatch for markdown/json/yaml/csv (see fileMenuItems); images/media/PDFs
  // have no secondary action here — they always land on their viewer
  // regardless of the modifier, unlike the FILES-tree context menu's image
  // "Open in Editor" item.
  const openFileOrViewerSecondary = useCallback(
    (filePath: string, line?: number) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "preview");
      if (viewer) {
        openExtViewerTab(viewer.id, filePath);
        return;
      }
      openFileOrViewer(filePath, line);
    },
    [extFileViewers, openExtViewerTab, openFileOrViewer],
  );

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
      );
      // Images/media/PDFs open in their viewer by default (see
      // openFileOrViewer) — editorFallback is the escape hatch to edit e.g.
      // an SVG's source in nvim; media/PDF opt out of it (nvim on binary
      // content isn't useful) via their own registration.
      const defaultViewer = !isDir ? findFileViewerFor(entryPath, extFileViewers, "default") : null;
      if (defaultViewer?.editorFallback) {
        items.push({ label: "Open in Editor", onClick: () => openFileInSession(entryPath) });
      }
      // Markdown/JSON/YAML/CSV open in nvim by default (unchanged) — Preview
      // is the opt-in path to the rendered view, mirroring the hover icon in
      // FileTree.
      if (!isDir && findFileViewerFor(entryPath, extFileViewers, "preview")) {
        items.push({ label: "Preview", onClick: () => openPreviewViewerTab(entryPath) });
      }
      items.push({ label: "Delete", danger: true, onClick: () => deleteFileEntry(entryPath, isDir) });
      return items;
    },
    [
      createFileInDir,
      createFolderInDir,
      renameFileEntry,
      copyFilePath,
      copyFileRelativePath,
      downloadFileEntry,
      openFileInSession,
      openPreviewViewerTab,
      deleteFileEntry,
      extFileViewers,
    ],
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
