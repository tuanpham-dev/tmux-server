import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { copyText } from "./clipboard";
import ContextMenu from "./components/ContextMenu";
import Dialog, { type DialogRequest } from "./components/Dialog";
import QuickSwitcher from "./components/QuickSwitcher";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/TerminalView";
import {
  findFileViewerFor,
  loadExtensions,
  setActiveContext,
  setOpenFileTabHandler,
  useExtensionRegistry,
} from "./extensions";
import {
  recorderState,
  resolveBindings,
  serializeEvent,
  type Command,
  type KeybindingOverrides,
} from "./keybindings";
import {
  DEFAULT_SETTINGS,
  loadKeybindingOverrides,
  loadSettings,
  saveKeybindingOverrides,
  saveSettings,
  type AppSettings,
} from "./settings";
import {
  applyColorThemeCssVars,
  loadColorTheme,
  resolveColorThemeValue,
  terminalTheme as builtInTerminalTheme,
  type ResolvedColorTheme,
} from "./theme";
import type { ExtensionInfo, MenuItem, MenuState, Tab, TmuxSession, TmuxWindow } from "./types";
import { collectDropped, uploadAll, type DroppedItems } from "./upload";
import { applyExtensionFonts, useExtensionFontsVersion } from "./utils/fonts";
import { resolveIconThemeValue, setActiveIconTheme } from "./utils/iconThemes";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

// A "virtual" tab (image viewer, markdown preview, settings, …) has no tmux
// session behind it — sessionName/attachName are "". Centralized here so a
// future virtual-tab kind only needs to extend this one place, not every
// imagePath-only check that predates it.
function isRealTab(tab: Tab): boolean {
  return (
    tab.imagePath === undefined &&
    tab.previewPath === undefined &&
    tab.settingsView === undefined &&
    tab.extViewerPath === undefined
  );
}

function tabVirtualPath(tab: Tab): string | undefined {
  return tab.imagePath ?? tab.previewPath ?? tab.extViewerPath;
}

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
  const [error, setError] = useState<string | null>(null);
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

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
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

  // Keybinding overrides (command id → serialized combo), resolved over the
  // defaults in keybindings.ts. Same localStorage flow as settings above,
  // including the skip-initial-persist rationale.
  const [keybindingOverrides, setKeybindingOverrides] =
    useState<KeybindingOverrides>(loadKeybindingOverrides);
  // Extension-registered commands/viewers/panels (extensions.ts) — commands
  // join the built-in list below (always "global" scope in v1, namespaced
  // ext.<extensionId>.<cmd> so they can't collide with a built-in id);
  // fileViewers/sidebarPanels are consumed further down.
  const { commands: extCommands, fileViewers: extFileViewers, sidebarPanels: extSidebarPanels } =
    useExtensionRegistry();
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBinding: c.defaultBinding ?? "",
    scope: "global",
  }));
  const resolvedBindings = resolveBindings(keybindingOverrides, extCommandDefs);
  const bindingsRef = useRef(resolvedBindings);
  bindingsRef.current = resolvedBindings;

  const keybindingsMounted = useRef(false);
  useEffect(() => {
    if (!keybindingsMounted.current) {
      keybindingsMounted.current = true;
      return;
    }
    saveKeybindingOverrides(keybindingOverrides);
  }, [keybindingOverrides]);

  // Server-side persistence (~/.config/tmux-server/settings.json via
  // /api/settings): localStorage renders instantly at mount, then the server
  // copy — the cross-device source of truth — wins once fetched. Write-backs
  // are held until that first GET resolves, so a stale localStorage snapshot
  // can never clobber the server doc.
  const serverSyncReady = useRef(false);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchSettingsDoc()
      .then((doc) => {
        if (cancelled) return;
        if (doc.settings && typeof doc.settings === "object") {
          setSettings({ ...DEFAULT_SETTINGS, ...(doc.settings as Partial<AppSettings>) });
        }
        if (doc.keybindings && typeof doc.keybindings === "object") {
          setKeybindingOverrides(doc.keybindings);
        }
        serverSyncReady.current = true;
      })
      .catch(() => {
        // Server unreachable (offline PWA) — localStorage stays authoritative
        // for this visit, and nothing gets pushed up.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced write-back of the whole doc. Last-write-wins across devices —
  // accepted for a single-user tool. Errors are swallowed: localStorage
  // already has the change, and a persistent server failure would otherwise
  // toast on every keystroke in a settings input.
  useEffect(() => {
    if (!serverSyncReady.current) return;
    const timer = window.setTimeout(() => {
      api.putSettingsDoc({ settings, keybindings: keybindingOverrides }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings, keybindingOverrides]);

  // Extensions: fetches the installed list and activates every enabled
  // client entry (commands/viewers/panels register themselves into
  // extensions.ts's module-level registries — see useExtensionRegistry).
  // reloadExtensions is re-called after install/uninstall/enable/disable in
  // the Settings dialog so this list and the color/icon theme dropdowns
  // stay current without a full page reload.
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const reloadExtensions = useCallback(() => {
    loadExtensions()
      .then(setExtensions)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reloadExtensions();
  }, [reloadExtensions]);

  // Active color theme: resolves settings.colorTheme against the installed
  // extension list, loads+parses the theme JSON (cached in theme.ts), then
  // applies its CSS vars to <html> and hands its terminal palette to every
  // TerminalView. "" or an unresolvable value both mean "built-in".
  const [colorTheme, setColorTheme] = useState<ResolvedColorTheme | null>(null);
  useEffect(() => {
    const target = resolveColorThemeValue(settings.colorTheme, extensions);
    if (!target) {
      setColorTheme(null);
      applyColorThemeCssVars(null);
      return;
    }
    let cancelled = false;
    loadColorTheme(target.extensionId, target.path)
      .then((resolved) => {
        if (cancelled) return;
        setColorTheme(resolved);
        applyColorThemeCssVars(resolved.cssVars);
      })
      .catch((err) => {
        console.error(`failed to load color theme "${settings.colorTheme}":`, err);
        if (!cancelled) {
          setColorTheme(null);
          applyColorThemeCssVars(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.colorTheme, extensions]);
  const activeTerminalTheme = colorTheme?.terminalTheme ?? builtInTerminalTheme;

  // Active icon theme: same resolve-against-installed-extensions shape as
  // color themes above, but applied through iconThemes.ts's own module
  // state (FileTree subscribes to it directly via useIconThemeVersion)
  // rather than App-level React state, since nothing here needs the result.
  useEffect(() => {
    setActiveIconTheme(resolveIconThemeValue(settings.iconTheme, extensions)).catch(() => {});
  }, [settings.iconTheme, extensions]);

  // Extension-contributed terminal fonts: loads only the families actually
  // present in settings.fontFamily (primary or fallback) — same selected-
  // only asset policy as the color/icon theme effects above. Reconciles on
  // both a font-picker change and an extension enable/disable/install/
  // uninstall, so a font's FontFace is added/removed through one path.
  // fontsVersion is handed to every TerminalView so it can force a re-
  // measure once a face it's configured to use actually finishes loading.
  useEffect(() => {
    applyExtensionFonts(extensions, settings.fontFamily).catch(() => {});
  }, [settings.fontFamily, extensions]);
  const fontsVersion = useExtensionFontsVersion();

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
        return [...prev, tab];
      });
    },
    [sessions],
  );

  // Activate-or-create, keyed on (viewerId, path) — viewerId is stored on
  // the tab so the render dispatch knows which registered component to use
  // without re-matching by extension (a second extension could register for
  // the same one later). Every built-in preview (image/media/pdf/markdown/
  // json/yaml/csv) is itself an extension-registered viewer now, so this is
  // the only virtual-file-tab opener — see findFileViewerFor for how a path
  // resolves to a viewer.
  const openExtViewerTab = useCallback((viewerId: string, filePath: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.extViewerId === viewerId && t.extViewerPath === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        sessionName: "",
        attachName: "",
        extViewerId: viewerId,
        extViewerPath: filePath,
      };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, []);

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
      try {
        const { attachName } = await api.openWindowTab(session, index);
        const tab: Tab = { id: crypto.randomUUID(), sessionName: session, attachName, windowIndex: index };
        setTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
      } catch (err) {
        showError(err);
      }
    },
    [tabs, sessions, showError],
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
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
      }
      setTabs((prev) => prev.filter((t) => t.id === id));
      setActiveTabId(id);
    },
    [tabs, confirmDialog],
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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // Virtual tabs (image/markdown preview) have no tmux session, so sidebar
  // context (the FILES tree root, the lazygit branch pill, "new window in
  // dir") keeps reflecting whichever real (terminal) tab was open most
  // recently instead of collapsing to empty while a virtual tab is active.
  // Mutated during render — same pattern as onBranchChangeRef in FileTree —
  // so it's always current without an effect's one-render lag.
  // Seeded from any real tab restored on this mount (useRef's initializer
  // only runs once) so a reload that lands back on a virtual tab doesn't
  // leave the sidebar empty until the user manually switches tabs.
  const lastRealTabIdRef = useRef<string | null>(
    tabs.find(isRealTab)?.id ?? null,
  );
  if (activeTab && isRealTab(activeTab)) {
    lastRealTabIdRef.current = activeTab.id;
  }
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
