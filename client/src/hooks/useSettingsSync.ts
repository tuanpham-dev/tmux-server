import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { RegisteredCommand } from "../extensions";
import { migrateKeybindingOverrides, resolveBindings, type Command, type KeybindingOverrides } from "../keybindings";
import {
  DEFAULT_SETTINGS,
  loadCommandUsage,
  loadExtensionRegistries,
  loadExtensionSettings,
  loadKeybindingOverrides,
  loadPinnedSessions,
  loadSettings,
  loadSidebarTabsOrder,
  migrateSettings,
  saveCommandUsage,
  saveExtensionRegistries,
  saveExtensionSettings,
  saveKeybindingOverrides,
  savePinnedSessions,
  saveSettings,
  saveSidebarTabsOrder,
  type AppSettings,
  type CommandUsage,
  type ExtensionSettingsValues,
} from "../settings";
import type { PinnedSession } from "../types";

// Owns settings/keybindingOverrides/extensionSettings: localStorage-first
// load, skip-initial-persist write-back, and the server-doc GET (server
// wins once fetched) + debounced read-merge-write-back. extCommands comes
// from useExtensionRegistry() in App (shared with the global command
// dispatcher and file-opener wiring), so keybindings can resolve extension-
// contributed commands without duplicating that registry subscription here.
export function useSettingsSync(extCommands: RegisteredCommand[]) {
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

  // Keybinding overrides (command id → its full replacement binding set),
  // resolved over the defaults in keybindings.ts. Same localStorage flow as
  // settings above, including the skip-initial-persist rationale.
  const [keybindingOverrides, setKeybindingOverrides] =
    useState<KeybindingOverrides>(loadKeybindingOverrides);
  // Extension-registered commands (extensions.ts) — join the built-in list
  // (always "global" scope in v1, namespaced ext.<extensionId>.<cmd> so they
  // can't collide with a built-in id). The public extension API still
  // registers a single defaultBinding string; multi-binding is a built-in-
  // command-only capability for now.
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBindings: c.defaultBinding ? [{ key: c.defaultBinding }] : [],
    scope: "global",
  }));
  const resolvedBindings = resolveBindings(keybindingOverrides, extCommandDefs);
  const bindingsRef = useRef(resolvedBindings);
  bindingsRef.current = resolvedBindings;
  // Raw overrides (not the merged resolvedBindings above) — the global
  // dispatcher's pickCommand needs to know whether a match came from a
  // user's own rebind or a still-default binding (see keybindings.ts'
  // BindingMatch precedence).
  const overridesRef = useRef(keybindingOverrides);
  overridesRef.current = keybindingOverrides;

  const keybindingsMounted = useRef(false);
  useEffect(() => {
    if (!keybindingsMounted.current) {
      keybindingsMounted.current = true;
      return;
    }
    saveKeybindingOverrides(keybindingOverrides);
  }, [keybindingOverrides]);

  // Sparse per-extension setting overrides (extensionId -> key -> value) —
  // same localStorage flow as settings/keybindings above, including the
  // skip-initial-persist rationale.
  const [extensionSettings, setExtensionSettings] =
    useState<ExtensionSettingsValues>(loadExtensionSettings);
  const extensionSettingsRef = useRef(extensionSettings);
  extensionSettingsRef.current = extensionSettings;

  const extensionSettingsMounted = useRef(false);
  useEffect(() => {
    if (!extensionSettingsMounted.current) {
      extensionSettingsMounted.current = true;
      return;
    }
    saveExtensionSettings(extensionSettings);
  }, [extensionSettings]);

  // Pinned sessions — same localStorage-first + skip-initial-persist +
  // server-doc flow as the three states above, but stored as its own
  // top-level doc key rather than inside AppSettings (see settings.ts).
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>(loadPinnedSessions);
  const pinnedSessionsMounted = useRef(false);
  useEffect(() => {
    if (!pinnedSessionsMounted.current) {
      pinnedSessionsMounted.current = true;
      return;
    }
    savePinnedSessions(pinnedSessions);
  }, [pinnedSessions]);

  // Extension registry sources — same localStorage-first + skip-initial-
  // persist + server-doc flow as pinnedSessions above, and its own top-level
  // doc key for the same reason: a settings reset must not drop a user's
  // configured registries.
  const [extensionRegistries, setExtensionRegistries] = useState<string[]>(loadExtensionRegistries);
  const extensionRegistriesMounted = useRef(false);
  useEffect(() => {
    if (!extensionRegistriesMounted.current) {
      extensionRegistriesMounted.current = true;
      return;
    }
    saveExtensionRegistries(extensionRegistries);
  }, [extensionRegistries]);

  // Sidebar tab order (Sidebar.tsx's activity-bar strip) — same
  // localStorage-first + skip-initial-persist + server-doc flow as
  // extensionRegistries above. Starts empty (see loadSidebarTabsOrder) and
  // only ever gets set by Sidebar.tsx's own reorderTabs, i.e. an explicit
  // user drag — Sidebar keeps building its own richer default order locally
  // whenever this is empty, so a device that's never synced doesn't get that
  // default overwritten by nothing.
  const [sidebarTabsOrder, setSidebarTabsOrder] = useState<string[]>(loadSidebarTabsOrder);
  const sidebarTabsOrderMounted = useRef(false);
  useEffect(() => {
    if (!sidebarTabsOrderMounted.current) {
      sidebarTabsOrderMounted.current = true;
      return;
    }
    saveSidebarTabsOrder(sidebarTabsOrder);
  }, [sidebarTabsOrder]);

  // Command palette usage stats (count/last per command id) — same
  // localStorage-first + skip-initial-persist + server-doc flow as
  // pinnedSessions above, and for the same reason: its own top-level doc key
  // outside AppSettings so a settings reset can't erase it.
  const [commandUsage, setCommandUsage] = useState<CommandUsage>(loadCommandUsage);
  const commandUsageMounted = useRef(false);
  useEffect(() => {
    if (!commandUsageMounted.current) {
      commandUsageMounted.current = true;
      return;
    }
    saveCommandUsage(commandUsage);
  }, [commandUsage]);

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
          setSettings(migrateSettings({ ...DEFAULT_SETTINGS, ...(doc.settings as Partial<AppSettings>) }));
        }
        if (doc.keybindings && typeof doc.keybindings === "object") {
          setKeybindingOverrides(migrateKeybindingOverrides(doc.keybindings));
        }
        if (
          doc.extensionSettings &&
          typeof doc.extensionSettings === "object" &&
          !Array.isArray(doc.extensionSettings)
        ) {
          setExtensionSettings(doc.extensionSettings as ExtensionSettingsValues);
        }
        if (Array.isArray(doc.pinnedSessions)) {
          setPinnedSessions(
            doc.pinnedSessions.filter(
              (p): p is PinnedSession =>
                typeof p === "object" &&
                p !== null &&
                typeof (p as PinnedSession).name === "string" &&
                typeof (p as PinnedSession).cwd === "string",
            ),
          );
        }
        if (Array.isArray(doc.extensionRegistries)) {
          setExtensionRegistries(doc.extensionRegistries.filter((s): s is string => typeof s === "string"));
        }
        // Unlike the arrays above, an empty synced order is left alone
        // (rather than applied) — it means "never dragged on any device",
        // and Sidebar.tsx's own local default order should stay in charge
        // rather than being wiped out by nothing (see loadSidebarTabsOrder).
        if (Array.isArray(doc.sidebarTabsOrder) && doc.sidebarTabsOrder.length > 0) {
          setSidebarTabsOrder(doc.sidebarTabsOrder.filter((s): s is string => typeof s === "string"));
        }
        if (doc.commandUsage && typeof doc.commandUsage === "object" && !Array.isArray(doc.commandUsage)) {
          const usage: CommandUsage = {};
          for (const [id, entry] of Object.entries(doc.commandUsage as Record<string, unknown>)) {
            if (
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { count?: unknown }).count === "number" &&
              typeof (entry as { last?: unknown }).last === "number"
            ) {
              usage[id] = entry as { count: number; last: number };
            }
          }
          setCommandUsage(usage);
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

  // Debounced write-back of the whole doc. Read-merge-write: fetches the
  // current doc first and preserves any top-level key this client doesn't
  // own (e.g. extensionSettings written by a newer client while an older
  // tab is still open) instead of blindly overwriting it — falls back to
  // writing just the three known keys if the pre-fetch fails. Last-write-
  // wins across devices for the keys this client does own — accepted for a
  // single-user tool. Errors are swallowed: localStorage already has the
  // change, and a persistent server failure would otherwise toast on every
  // keystroke in a settings input.
  useEffect(() => {
    if (!serverSyncReady.current) return;
    const timer = window.setTimeout(() => {
      api
        .fetchSettingsDoc()
        .then((doc) => ({
          ...doc,
          settings,
          keybindings: keybindingOverrides,
          extensionSettings,
          pinnedSessions,
          commandUsage,
          extensionRegistries,
          sidebarTabsOrder,
        }))
        .catch(() => ({
          settings,
          keybindings: keybindingOverrides,
          extensionSettings,
          pinnedSessions,
          commandUsage,
          extensionRegistries,
          sidebarTabsOrder,
        }))
        .then((doc) => api.putSettingsDoc(doc))
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    settings,
    keybindingOverrides,
    extensionSettings,
    pinnedSessions,
    commandUsage,
    extensionRegistries,
    sidebarTabsOrder,
  ]);

  return {
    settings,
    setSettings,
    settingsRef,
    keybindingOverrides,
    setKeybindingOverrides,
    resolvedBindings,
    bindingsRef,
    overridesRef,
    extensionSettings,
    setExtensionSettings,
    extensionSettingsRef,
    pinnedSessions,
    setPinnedSessions,
    commandUsage,
    setCommandUsage,
    extensionRegistries,
    setExtensionRegistries,
    sidebarTabsOrder,
    setSidebarTabsOrder,
  };
}
