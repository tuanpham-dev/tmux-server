import type { AppSettings } from "../../settings";
import { useSettingsContext } from "./context";

export default function BehaviorSection() {
  const { settings, set } = useSettingsContext();

  return (
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
        <span className="settings-label">Open new tabs</span>
        <select
          className="dialog-input settings-select"
          value={settings.newTabPlacement}
          onChange={(e) =>
            set("newTabPlacement", e.target.value as AppSettings["newTabPlacement"])
          }
        >
          <option value="end">At the end of the tab bar</option>
          <option value="afterActive">To the right of the active tab</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.tabGroupsBySession}
          onChange={(e) => set("tabGroupsBySession", e.target.checked)}
        />
        <span>Group tabs by session in the tab bar</span>
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

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.paletteSortByUsage}
          onChange={(e) => set("paletteSortByUsage", e.target.checked)}
        />
        <span>Sort command palette by most-used</span>
      </label>
    </>
  );
}
