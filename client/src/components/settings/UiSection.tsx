import type { AppSettings } from "../../settings";
import { listColorThemeOptions } from "../../theme";
import { listIconThemeOptions } from "../../utils/iconThemes";
import { useSettingsContext } from "./context";

export default function UiSection() {
  const { settings, set, extensions } = useSettingsContext();

  return (
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

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.showStatusBar}
          onChange={(e) => set("showStatusBar", e.target.checked)}
        />
        <span>Show status bar</span>
      </label>
      <div className="settings-hint">
        RAM in use, open terminals, and listening ports, along the bottom of the window. Always hidden on
        phones and tablets.
      </div>
    </>
  );
}
