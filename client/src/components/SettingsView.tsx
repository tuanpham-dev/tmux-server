import { useEffect, useState } from "react";
import { extensionSettingsComponents, useExtensionRegistryVersion } from "../extensions";
import { DEFAULT_SETTINGS, type AppSettings, type ExtensionSettingsValues } from "../settings";
import type { ExtensionInfo } from "../types";
import BehaviorSection from "./settings/BehaviorSection";
import { SettingsProvider } from "./settings/context";
import ExtensionConfigSection from "./settings/ExtensionConfigSection";
import TerminalSection from "./settings/TerminalSection";
import UiSection from "./settings/UiSection";

interface Props {
  active: boolean;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionSettings: ExtensionSettingsValues;
  onExtensionSettingsChange: (values: ExtensionSettingsValues) => void;
  // Set by the Extensions detail page's "Extension Settings" shortcut
  // (App.tsx) to jump straight to that extension's config section — reset
  // to null once applied (onFocusExtensionHandled) so clicking the same
  // shortcut twice in a row (with no navigation in between) still re-fires.
  pendingFocusExtensionId?: string | null;
  onFocusExtensionHandled?: () => void;
  // Keyboard Shortcuts moved out to its own dedicated tab (App.tsx's
  // keyboardView) to match VS Code — this nav entry hands off to it instead
  // of switching to an in-dialog section.
  onOpenKeyboardShortcuts: () => void;
}

// `ext:<id>` is a dynamic nav entry for one extension's declared
// contributes.configuration — see configurableExtensions below. Browsing,
// installing, and managing extensions themselves lives in the sidebar's
// Extensions tab (ExtensionsPanel), not here — see
// plans/extension-registry-and-extensions-tab.md.
type Section = "terminal" | "behavior" | "ui" | `ext:${string}`;

const SECTIONS: { id: Section; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "behavior", label: "Behavior" },
  { id: "ui", label: "UI" },
];

export default function SettingsView({
  active,
  settings,
  onSettingsChange,
  extensions,
  onReloadExtensions,
  extensionSettings,
  onExtensionSettingsChange,
  pendingFocusExtensionId,
  onFocusExtensionHandled,
  onOpenKeyboardShortcuts,
}: Props) {
  const [section, setSection] = useState<Section>("terminal");

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onSettingsChange({ ...settings, [key]: value });

  // Only enabled extensions with at least one normalized property get a nav
  // entry — a disabled extension's settings aren't in effect (parallels its
  // client entry not activating), so editing them would be misleading.
  // Re-render when an extension registers a custom settings component —
  // that alone earns it a settings section, even with no scalar properties.
  useExtensionRegistryVersion();
  const configurableExtensions = extensions.filter(
    (ext) =>
      ext.enabled &&
      (ext.configuration.length > 0 ||
        extensionSettingsComponents.some((c) => c.extensionId === ext.id)),
  );

  // If the active extension section's extension gets disabled/uninstalled
  // out from under it (in the Extensions tab, in another browser tab, or
  // after a reload), fall back to Terminal rather than rendering an empty/
  // stale panel.
  useEffect(() => {
    if (
      section.startsWith("ext:") &&
      !configurableExtensions.some((ext) => `ext:${ext.id}` === section)
    ) {
      setSection("terminal");
    }
  }, [section, configurableExtensions]);

  // Extension-page "Extension Settings" shortcut — see the Props doc above.
  useEffect(() => {
    if (!pendingFocusExtensionId) return;
    setSection(`ext:${pendingFocusExtensionId}`);
    onFocusExtensionHandled?.();
  }, [pendingFocusExtensionId, onFocusExtensionHandled]);

  const activeExtension = section.startsWith("ext:")
    ? configurableExtensions.find((ext) => `ext:${ext.id}` === section)
    : undefined;

  return (
    <SettingsProvider
      value={{
        settings,
        set,
        onSettingsChange,
        extensions,
        onReloadExtensions,
        extensionSettings,
        onExtensionSettingsChange,
      }}
    >
      <div className={`settings-host${active ? "" : " hidden"}`}>
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item${section === s.id ? " active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
          <button className="settings-nav-item" onClick={onOpenKeyboardShortcuts}>
            Keyboard Shortcuts
          </button>
          {configurableExtensions.length > 0 && (
            <>
              <div className="settings-nav-divider" />
              {configurableExtensions.map((ext) => (
                <button
                  key={ext.id}
                  className={`settings-nav-item${section === `ext:${ext.id}` ? " active" : ""}`}
                  onClick={() => setSection(`ext:${ext.id}`)}
                >
                  {ext.displayName}
                </button>
              ))}
            </>
          )}
        </nav>

        <div className="settings-content">
          {section === "terminal" && <TerminalSection />}
          {section === "behavior" && <BehaviorSection />}
          {section === "ui" && <UiSection />}
          {activeExtension && <ExtensionConfigSection ext={activeExtension} />}
          {activeExtension &&
            extensionSettingsComponents
              .filter((c) => c.extensionId === activeExtension.id)
              .map((c) => <c.component key={c.id} />)}

          <div className="settings-footer">
            {activeExtension ? (
              <button
                className="dialog-button secondary"
                disabled={Object.keys(extensionSettings[activeExtension.id] ?? {}).length === 0}
                onClick={() => {
                  const next = { ...extensionSettings };
                  delete next[activeExtension.id];
                  onExtensionSettingsChange(next);
                }}
              >
                Reset {activeExtension.displayName} Settings to Defaults
              </button>
            ) : (
              <button
                className="dialog-button secondary"
                onClick={() => onSettingsChange({ ...DEFAULT_SETTINGS })}
              >
                Reset Settings to Defaults
              </button>
            )}
            {/* Ground truth for "which build is this device actually
                running" — stale service workers have served old bundles
                that were indistinguishable from deploy failures. */}
            <div className="settings-build">Build {__BUILD_TIME__}</div>
          </div>
        </div>
      </div>
    </SettingsProvider>
  );
}
