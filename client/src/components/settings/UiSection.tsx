import type { AppSettings } from "../../settings";
import { listColorThemeOptions } from "../../theme";
import { listIconThemeOptions } from "../../utils/iconThemes";
import { useSettingsContext } from "./context";
import TouchKeysEditor from "./TouchKeysEditor";

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

      <label className="settings-row">
        <span className="settings-label">On-screen key bar (touch)</span>
        <select
          className="dialog-input settings-select"
          value={settings.touchKeyBar}
          onChange={(e) => set("touchKeyBar", e.target.value as AppSettings["touchKeyBar"])}
        >
          <option value="auto">Auto (mobile devices only)</option>
          <option value="always">Always show</option>
          <option value="never">Never show</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Key bar style</span>
        <select
          className="dialog-input settings-select"
          value={settings.touchKeyBarStyle}
          onChange={(e) => set("touchKeyBarStyle", e.target.value as AppSettings["touchKeyBarStyle"])}
        >
          <option value="bar">Fixed bar</option>
          <option value="floating">Floating toggle</option>
        </select>
      </label>

      <TouchKeysEditor />

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.fileTreeGitStatus}
          onChange={(e) => set("fileTreeGitStatus", e.target.checked)}
        />
        <span>Show git status in files tree</span>
      </label>
    </>
  );
}
