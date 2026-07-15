import type { AppSettings } from "../../settings";
import { useSettingsContext } from "./context";
import { FontFamilyPicker, NumberField } from "./controls";

// ghostty-web has no native options for line height, letter spacing, bold
// weight, or minimum contrast ratio — the ghostty engine implements them
// app-side (ghosttyShims.ts, utils/fonts.ts). The xterm engine
// (plans/terminal-engine-setting.md) has native options for all of these;
// textThickness stays app-side either way (canvas shim vs
// -webkit-text-stroke — see settings.ts).
export default function TerminalSection() {
  const { settings, set, extensions } = useSettingsContext();

  return (
    <>
      <h2 className="settings-section-title">Terminal</h2>

      <label className="settings-row">
        <span className="settings-label">Engine</span>
        <select
          className="dialog-input settings-select"
          value={settings.terminalEngine}
          onChange={(e) => set("terminalEngine", e.target.value as AppSettings["terminalEngine"])}
        >
          <option value="ghostty">Ghostty</option>
          <option value="xterm">xterm.js</option>
          <option value="auto">Auto (xterm.js on mobile)</option>
        </select>
      </label>

      <FontFamilyPicker
        value={settings.fontFamily}
        onChange={(v) => set("fontFamily", v)}
        extensions={extensions}
      />

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
        <span className="settings-label">Text weight</span>
        <select
          className="dialog-input settings-select"
          value={settings.fontWeight}
          onChange={(e) => set("fontWeight", e.target.value as AppSettings["fontWeight"])}
        >
          <option value="normal">normal (400)</option>
          <option value="medium">medium (500)</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Text thickness (px)</span>
        <NumberField
          value={settings.textThickness}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) => set("textThickness", v)}
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
        <span className="settings-label">Local echo when</span>
        <input
          className="dialog-input"
          placeholder="e.g. claude (empty disables)"
          value={settings.localEchoWhen}
          onChange={(e) => set("localEchoWhen", e.target.value)}
        />
      </label>
      <div className="settings-hint">
        On mobile, typed input renders instantly and buffers until Enter
        while the pane's foreground command matches this comma-separated
        list (case-insensitive, exact match). Empty disables local echo.
      </div>
    </>
  );
}
