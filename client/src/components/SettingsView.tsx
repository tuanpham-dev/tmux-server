import { useEffect, useState } from "react";
import * as api from "../api";
import { useExtensionRegistry } from "../extensions";
import {
  COMMANDS,
  formatBinding,
  recorderState,
  resolveBindings,
  serializeEvent,
  type Command,
  type KeybindingOverrides,
} from "../keybindings";
import type { AppSettings } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";
import { listColorThemeOptions } from "../theme";
import type { ExtensionInfo } from "../types";
import { listIconThemeOptions } from "../utils/iconThemes";
import Icon from "./Icon";

interface Props {
  active: boolean;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  keybindingOverrides: KeybindingOverrides;
  onKeybindingOverridesChange: (overrides: KeybindingOverrides) => void;
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
}

type Section = "terminal" | "behavior" | "ui" | "keyboard" | "extensions";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "behavior", label: "Behavior" },
  { id: "ui", label: "UI" },
  { id: "keyboard", label: "Keyboard" },
  { id: "extensions", label: "Extensions" },
];

// Draft so intermediate keystrokes ("1" on the way to "18") don't get
// rejected by validation and snap the controlled input back — same pattern
// the old settings dialog used for font size.
function NumberField({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <input
      className="dialog-input settings-number"
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) onCommit(v);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

export default function SettingsView({
  active,
  settings,
  onSettingsChange,
  keybindingOverrides,
  onKeybindingOverridesChange,
  extensions,
  onReloadExtensions,
}: Props) {
  const [section, setSection] = useState<Section>("terminal");
  const [filter, setFilter] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onSettingsChange({ ...settings, [key]: value });

  // Extension-registered commands join the built-in list everywhere this
  // section lists/resolves/records commands — see App.tsx's matching merge
  // for the dispatcher side.
  const { commands: extCommands } = useExtensionRegistry();
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBinding: c.defaultBinding ?? "",
    scope: "global",
  }));
  const allCommands: Command[] = [...COMMANDS, ...extCommandDefs];

  const resolved = resolveBindings(keybindingOverrides, extCommandDefs);
  // combo → command ids sharing it, for the conflict warning. An empty
  // binding (an extension command with no defaultBinding, never assigned
  // one) is intentionally excluded — several of those otherwise look like
  // mutual conflicts under the shared "" key.
  const byBinding: Record<string, string[]> = {};
  for (const cmd of allCommands) {
    if (resolved[cmd.id]) (byBinding[resolved[cmd.id]] ??= []).push(cmd.id);
  }

  // Chord recorder. The window-level capture listener plus the module-level
  // recorderState flag (checked by App's dispatcher and read here) means the
  // captured combo never also triggers the command it's currently bound to.
  useEffect(() => {
    recorderState.recording = recordingId !== null;
    if (recordingId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = serializeEvent(e);
      if (!combo) return; // modifier alone — keep waiting for the chord
      const cmd = allCommands.find((c) => c.id === recordingId);
      const next = { ...keybindingOverrides };
      // Recording the default back is "no override", so a future default
      // change still reaches this command.
      if (cmd && combo === cmd.defaultBinding) delete next[recordingId];
      else next[recordingId] = combo;
      onKeybindingOverridesChange(next);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      recorderState.recording = false;
    };
  }, [recordingId, keybindingOverrides, onKeybindingOverridesChange]);

  // Leaving the tab (or the Keyboard section) mid-recording cancels it.
  useEffect(() => {
    if (!active || section !== "keyboard") setRecordingId(null);
  }, [active, section]);

  const resetBinding = (id: string) => {
    const next = { ...keybindingOverrides };
    delete next[id];
    onKeybindingOverridesChange(next);
  };

  const filterLower = filter.trim().toLowerCase();
  const visibleCommands = allCommands.filter(
    (cmd) =>
      !filterLower ||
      cmd.label.toLowerCase().includes(filterLower) ||
      formatBinding(resolved[cmd.id]).toLowerCase().includes(filterLower),
  );

  return (
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
      </nav>

      <div className="settings-content">
        {section === "terminal" && (
          <>
            <h2 className="settings-section-title">Terminal</h2>

            <label className="settings-row">
              <span className="settings-label">Font family</span>
              <input
                className="dialog-input"
                value={settings.fontFamily}
                onChange={(e) => set("fontFamily", e.target.value)}
              />
            </label>

            <label className="settings-row">
              <span className="settings-label">Font size</span>
              <NumberField
                value={settings.fontSize}
                min={8}
                max={32}
                step={1}
                onCommit={(v) => set("fontSize", Math.round(v))}
              />
            </label>

            <label className="settings-row">
              <span className="settings-label">Line height</span>
              <NumberField
                value={settings.lineHeight}
                min={1}
                max={2}
                step={0.1}
                onCommit={(v) => set("lineHeight", v)}
              />
            </label>

            <label className="settings-row">
              <span className="settings-label">Letter spacing (px)</span>
              <NumberField
                value={settings.letterSpacing}
                min={-2}
                max={8}
                step={0.5}
                onCommit={(v) => set("letterSpacing", v)}
              />
            </label>

            <label className="settings-row">
              <span className="settings-label">Bold text weight</span>
              <select
                className="dialog-input settings-select"
                value={settings.fontWeightBold}
                onChange={(e) => set("fontWeightBold", e.target.value as AppSettings["fontWeightBold"])}
              >
                <option value="normal">normal</option>
                <option value="bold">bold</option>
              </select>
            </label>

            <label className="settings-row">
              <span className="settings-label">Cursor style</span>
              <select
                className="dialog-input settings-select"
                value={settings.cursorStyle}
                onChange={(e) => set("cursorStyle", e.target.value as AppSettings["cursorStyle"])}
              >
                <option value="block">block</option>
                <option value="bar">bar</option>
                <option value="underline">underline</option>
              </select>
            </label>

            <label className="settings-row checkbox-row">
              <input
                type="checkbox"
                checked={settings.cursorBlink}
                onChange={(e) => set("cursorBlink", e.target.checked)}
              />
              <span>Cursor blink</span>
            </label>

            <label className="settings-row">
              <span className="settings-label">Minimum contrast ratio</span>
              <select
                className="dialog-input settings-select"
                value={String(settings.minimumContrastRatio)}
                onChange={(e) => set("minimumContrastRatio", Number(e.target.value))}
              >
                <option value="1">Off</option>
                <option value="4.5">4.5 (WCAG AA)</option>
                <option value="7">7 (WCAG AAA)</option>
                <option value="21">21 (maximum)</option>
              </select>
            </label>
          </>
        )}

        {section === "behavior" && (
          <>
            <h2 className="settings-section-title">Behavior</h2>

            <label className="settings-row">
              <span className="settings-label">On upload name conflict</span>
              <select
                className="dialog-input settings-select"
                value={settings.uploadConflict}
                onChange={(e) => set("uploadConflict", e.target.value as AppSettings["uploadConflict"])}
              >
                <option value="rename">Keep both (rename new file)</option>
                <option value="overwrite">Overwrite existing file</option>
                <option value="ask">Ask every time</option>
              </select>
            </label>

            <label className="settings-row checkbox-row">
              <input
                type="checkbox"
                checked={settings.confirmBeforeKill}
                onChange={(e) => set("confirmBeforeKill", e.target.checked)}
              />
              <span>Confirm before killing sessions and windows</span>
            </label>

            <label className="settings-row">
              <span className="settings-label">After closing the active tab</span>
              <select
                className="dialog-input settings-select"
                value={settings.tabCloseActivation}
                onChange={(e) =>
                  set("tabCloseActivation", e.target.value as AppSettings["tabCloseActivation"])
                }
              >
                <option value="recent">Activate previously used tab</option>
                <option value="adjacent">Activate adjacent tab</option>
              </select>
            </label>

            <label className="settings-row">
              <span className="settings-label">Default new-session directory</span>
              <input
                className="dialog-input"
                placeholder="Server default"
                value={settings.newSessionCwd}
                onChange={(e) => set("newSessionCwd", e.target.value)}
              />
            </label>
          </>
        )}

        {section === "ui" && (
          <>
            <h2 className="settings-section-title">UI</h2>

            <label className="settings-row">
              <span className="settings-label">Color theme</span>
              <select
                className="dialog-input settings-select"
                value={settings.colorTheme}
                onChange={(e) => set("colorTheme", e.target.value)}
              >
                {listColorThemeOptions(extensions).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span className="settings-label">Icon theme</span>
              <select
                className="dialog-input settings-select"
                value={settings.iconTheme}
                onChange={(e) => set("iconTheme", e.target.value)}
              >
                {listIconThemeOptions(extensions).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span className="settings-label">On-screen key bar (touch)</span>
              <select
                className="dialog-input settings-select"
                value={settings.touchKeyBar}
                onChange={(e) => set("touchKeyBar", e.target.value as AppSettings["touchKeyBar"])}
              >
                <option value="auto">Auto (touch devices only)</option>
                <option value="always">Always show</option>
                <option value="never">Never show</option>
              </select>
            </label>

            <label className="settings-row checkbox-row">
              <input
                type="checkbox"
                checked={settings.fileTreeGitStatus}
                onChange={(e) => set("fileTreeGitStatus", e.target.checked)}
              />
              <span>Show git status in files tree</span>
            </label>
          </>
        )}

        {section === "keyboard" && (
          <>
            <h2 className="settings-section-title">Keyboard Shortcuts</h2>

            <input
              className="dialog-input keybinding-filter"
              placeholder="Type to search keybindings"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />

            <div className="keybinding-table">
              {visibleCommands.map((cmd) => {
                const binding = resolved[cmd.id];
                const overridden = keybindingOverrides[cmd.id] !== undefined;
                const isRecording = recordingId === cmd.id;
                const conflicts = (byBinding[binding] ?? []).filter((id) => id !== cmd.id);
                const conflictLabels = conflicts
                  .map((id) => allCommands.find((c) => c.id === id)?.label ?? id)
                  .join(", ");
                return (
                  <div
                    key={cmd.id}
                    className="keybinding-row"
                    onDoubleClick={() => setRecordingId(cmd.id)}
                  >
                    <span className="keybinding-label">{cmd.label}</span>
                    {conflicts.length > 0 && !isRecording && (
                      <span
                        className="keybinding-conflict"
                        title={`Also bound to: ${conflictLabels}`}
                      >
                        <Icon name="warning" />
                      </span>
                    )}
                    <span className={`keybinding-chip${isRecording ? " recording" : ""}`}>
                      {isRecording ? "Press key combination…" : formatBinding(binding)}
                    </span>
                    <button
                      className="icon-button keybinding-action"
                      title={isRecording ? "Cancel recording (Esc)" : "Change keybinding"}
                      onClick={() => setRecordingId(isRecording ? null : cmd.id)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon-button keybinding-action"
                      title="Reset to default"
                      style={{ visibility: overridden ? "visible" : "hidden" }}
                      onClick={() => resetBinding(cmd.id)}
                    >
                      <Icon name="discard" />
                    </button>
                  </div>
                );
              })}
              {visibleCommands.length === 0 && (
                <div className="keybinding-empty">No matching keybindings</div>
              )}
            </div>
          </>
        )}

        {section === "extensions" && (
          <>
            <h2 className="settings-section-title">Extensions</h2>

            <label className="dialog-button secondary extension-install-button">
              {installing ? "Installing…" : "Install from .vsix"}
              <input
                type="file"
                accept=".vsix"
                disabled={installing}
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setInstalling(true);
                  setExtensionsError(null);
                  try {
                    await api.installExtensionVsix(file);
                    onReloadExtensions();
                  } catch (err) {
                    setExtensionsError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setInstalling(false);
                  }
                }}
              />
            </label>
            <span className="settings-hint">
              Or drop an extension folder into ~/.config/tmux-server/extensions/ and reopen this tab.
            </span>

            {extensionsError && <div className="extension-error">{extensionsError}</div>}

            <div className="extension-list">
              {extensions.length === 0 && (
                <div className="keybinding-empty">No extensions installed</div>
              )}
              {extensions.map((ext) => (
                <div key={ext.id} className="extension-row">
                  <label className="checkbox-row extension-row-toggle">
                    <input
                      type="checkbox"
                      checked={ext.enabled}
                      onChange={(e) => {
                        api
                          .setExtensionEnabled(ext.id, e.target.checked)
                          .then(onReloadExtensions)
                          .catch((err) => setExtensionsError(err instanceof Error ? err.message : String(err)));
                      }}
                    />
                  </label>
                  <div className="extension-row-info">
                    <div className="extension-row-title">
                      {ext.displayName} <span className="extension-row-version">v{ext.version}</span>
                    </div>
                    {ext.description && <div className="extension-row-description">{ext.description}</div>}
                    <div className="extension-row-contributes">
                      {ext.themes.length > 0 && <span>{ext.themes.length} color theme(s)</span>}
                      {ext.iconThemes.length > 0 && <span>{ext.iconThemes.length} icon theme(s)</span>}
                      {ext.hasClient && <span>UI functionality</span>}
                      {ext.hasServer && <span>Server functionality</span>}
                    </div>
                    {ext.hasClient && (
                      <div className="settings-hint">Reload the page for a change here to take effect.</div>
                    )}
                    {ext.hasServer && !ext.enabled && (
                      <div className="settings-hint">
                        Restart the tmux-server server to fully unload a disabled extension's server code.
                      </div>
                    )}
                  </div>
                  {pendingUninstallId === ext.id ? (
                    <div className="extension-row-confirm">
                      <span>Uninstall?</span>
                      <button
                        className="dialog-button primary"
                        onClick={() => {
                          api
                            .uninstallExtension(ext.id)
                            .then(onReloadExtensions)
                            .catch((err) => setExtensionsError(err instanceof Error ? err.message : String(err)))
                            .finally(() => setPendingUninstallId(null));
                        }}
                      >
                        Yes
                      </button>
                      <button className="dialog-button secondary" onClick={() => setPendingUninstallId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="icon-button keybinding-action"
                      title="Uninstall"
                      onClick={() => setPendingUninstallId(ext.id)}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="settings-footer" style={section === "extensions" ? { display: "none" } : undefined}>
          {section === "keyboard" ? (
            <button
              className="dialog-button secondary"
              disabled={Object.keys(keybindingOverrides).length === 0}
              onClick={() => onKeybindingOverridesChange({})}
            >
              Reset All Keybindings
            </button>
          ) : (
            <button
              className="dialog-button secondary"
              onClick={() => onSettingsChange({ ...DEFAULT_SETTINGS })}
            >
              Reset Settings to Defaults
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
