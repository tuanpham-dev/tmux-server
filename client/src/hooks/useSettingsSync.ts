import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { RegisteredCommand } from "../extensions";
import { resolveBindings, type Command, type KeybindingOverrides } from "../keybindings";
import {
  DEFAULT_SETTINGS,
  loadExtensionSettings,
  loadKeybindingOverrides,
  loadPinnedSessions,
  loadSettings,
  migrateSettings,
  saveExtensionSettings,
  saveKeybindingOverrides,
  savePinnedSessions,
  saveSettings,
  type AppSettings,
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

  // Keybinding overrides (command id → serialized combo), resolved over the
  // defaults in keybindings.ts. Same localStorage flow as settings above,
  // including the skip-initial-persist rationale.
  const [keybindingOverrides, setKeybindingOverrides] =
    useState<KeybindingOverrides>(loadKeybindingOverrides);
  // Extension-registered commands (extensions.ts) — join the built-in list
  // (always "global" scope in v1, namespaced ext.<extensionId>.<cmd> so they
  // can't collide with a built-in id).
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
          setKeybindingOverrides(doc.keybindings);
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
        }))
        .catch(() => ({
          settings,
          keybindings: keybindingOverrides,
          extensionSettings,
          pinnedSessions,
        }))
        .then((doc) => api.putSettingsDoc(doc))
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings, keybindingOverrides, extensionSettings, pinnedSessions]);

  return {
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
    pinnedSessions,
    setPinnedSessions,
  };
}
