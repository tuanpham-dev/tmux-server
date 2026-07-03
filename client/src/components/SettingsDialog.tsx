import { useEffect, useState } from "react";
import type { AppSettings } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";

interface Props {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}

export default function SettingsDialog({ settings, onChange, onClose }: Props) {
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  // Draft so intermediate keystrokes ("1" on the way to "18") don't get
  // rejected by validation and snap the controlled input back.
  const [fontSizeDraft, setFontSizeDraft] = useState(String(settings.fontSize));
  useEffect(() => {
    setFontSizeDraft(String(settings.fontSize));
  }, [settings.fontSize]);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog settings-dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="dialog-title">Settings</div>

        <label className="settings-row">
          <span className="settings-label">Terminal font family</span>
          <input
            className="dialog-input"
            value={settings.fontFamily}
            onChange={(e) => set("fontFamily", e.target.value)}
          />
        </label>

        <label className="settings-row">
          <span className="settings-label">Font size</span>
          <input
            className="dialog-input settings-number"
            type="number"
            min={8}
            max={32}
            value={fontSizeDraft}
            onChange={(e) => {
              setFontSizeDraft(e.target.value);
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 8 && v <= 32) set("fontSize", v);
            }}
            onBlur={() => setFontSizeDraft(String(settings.fontSize))}
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
          <span className="settings-label">On upload name conflict</span>
          <select
            className="dialog-input settings-select"
            value={settings.uploadConflict}
            onChange={(e) =>
              set("uploadConflict", e.target.value as AppSettings["uploadConflict"])
            }
          >
            <option value="rename">Keep both (rename new file)</option>
            <option value="overwrite">Overwrite existing file</option>
            <option value="ask">Ask every time</option>
          </select>
        </label>

        <div className="dialog-buttons">
          <button
            className="dialog-button secondary"
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          >
            Reset to Defaults
          </button>
          <button className="dialog-button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
