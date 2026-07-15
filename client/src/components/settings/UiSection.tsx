import type { AppSettings } from "../../settings";
import { listColorThemeOptions } from "../../theme";
import { DEFAULT_TOUCH_KEYS, parseSend, type TouchKey } from "../../touchKeys";
import { listIconThemeOptions } from "../../utils/iconThemes";
import { useSettingsContext } from "./context";

export default function UiSection() {
  const { settings, set, extensions } = useSettingsContext();

  const updateKey = (i: number, next: TouchKey) => {
    const keys = settings.touchKeys.slice();
    keys[i] = next;
    set("touchKeys", keys);
  };
  const moveKey = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= settings.touchKeys.length) return;
    const keys = settings.touchKeys.slice();
    [keys[i], keys[j]] = [keys[j], keys[i]];
    set("touchKeys", keys);
  };
  const removeKey = (i: number) => {
    set(
      "touchKeys",
      settings.touchKeys.filter((_, idx) => idx !== i),
    );
  };
  const addKey = () => {
    set("touchKeys", [...settings.touchKeys, { label: "", send: "", when: "" }]);
  };
  const restoreDefaultKeys = () => {
    set(
      "touchKeys",
      DEFAULT_TOUCH_KEYS.map((k) => ({ ...k })),
    );
  };

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

      <div className="settings-row">
        <span className="settings-label">Touch keys</span>
        <div className="touch-key-editor-legend">
          send: literal text, or tokens {"{esc} {tab} {enter} {up} {down} {left} {right} {home} {end} {pgup} {pgdn} {space} {^x}"}{" "}
          (Ctrl+x, e.g. {"{^c}"}), {"{{"} for a literal {"{"}. when: comma-separated program names (e.g. "nvim"); empty = always.
        </div>
        <div className="touch-key-editor">
          {settings.touchKeys.map((key, i) => {
            const parsed = key.send === "{ctrl}" || key.send === "" ? null : parseSend(key.send);
            const error = parsed && "error" in parsed ? parsed.error : null;
            return (
              <div className="touch-key-editor-row" key={i}>
                <input
                  className="dialog-input touch-key-editor-label"
                  placeholder="Label"
                  value={key.label}
                  onChange={(e) => updateKey(i, { ...key, label: e.target.value })}
                />
                <input
                  className={`dialog-input touch-key-editor-send${error ? " invalid" : ""}`}
                  placeholder="Send (e.g. {esc})"
                  value={key.send}
                  onChange={(e) => updateKey(i, { ...key, send: e.target.value })}
                />
                <input
                  className="dialog-input touch-key-editor-when"
                  placeholder="When (e.g. nvim)"
                  value={key.when}
                  onChange={(e) => updateKey(i, { ...key, when: e.target.value })}
                />
                <div className="touch-key-editor-actions">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === 0}
                    onClick={() => moveKey(i, -1)}
                    aria-label="Move key up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === settings.touchKeys.length - 1}
                    onClick={() => moveKey(i, 1)}
                    aria-label="Move key down"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => removeKey(i)}
                    aria-label="Remove key"
                  >
                    ✕
                  </button>
                </div>
                {error && <div className="touch-key-editor-error">{error}</div>}
              </div>
            );
          })}
        </div>
        <div className="touch-key-editor-buttons">
          <button type="button" className="dialog-button secondary" onClick={addKey}>
            Add key
          </button>
          <button type="button" className="dialog-button secondary" onClick={restoreDefaultKeys}>
            Restore default keys
          </button>
        </div>
      </div>

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
