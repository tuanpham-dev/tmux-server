import { createContext, useContext } from "react";
import type { KeybindingOverrides } from "../../keybindings";
import type { AppSettings, ExtensionSettingsValues } from "../../settings";
import type { ExtensionInfo } from "../../types";

export interface SettingsContextValue {
  settings: AppSettings;
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSettingsChange: (settings: AppSettings) => void;
  keybindingOverrides: KeybindingOverrides;
  onKeybindingOverridesChange: (overrides: KeybindingOverrides) => void;
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionSettings: ExtensionSettingsValues;
  onExtensionSettingsChange: (values: ExtensionSettingsValues) => void;
}

// Scoped to the Settings dialog only — the codebase's one and only context
// (see plans/client-structure-split.md), not a pattern to reach for
// elsewhere. Section components read shared settings/extensions state
// through this instead of threading 8+ individual props down from
// SettingsView; genuinely section-specific inputs (e.g. KeyboardSection's
// `active` prop) still pass as plain props.
const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettingsContext must be used within SettingsView's provider");
  return ctx;
}

export const SettingsProvider = SettingsContext.Provider;
