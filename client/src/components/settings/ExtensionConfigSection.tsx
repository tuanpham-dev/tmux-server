import type { ExtensionInfo } from "../../types";
import { NumberField } from "./controls";
import { useSettingsContext } from "./context";

// Renders one control per declared contributes.configuration property,
// grouped by the manifest's own configuration sections (title optional).
// Write-back is sparse: setting a value back to its declared default removes
// the override entirely (see setValue) — same rationale as keybinding
// overrides, so a future manifest default change still reaches a user who
// never customized that property. Bounds default to a wide ±1e9 when the
// schema omits minimum/maximum, since NumberField requires both.
function ExtensionProperties({
  ext,
  overrides,
  onChange,
}: {
  ext: ExtensionInfo;
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const setValue = (key: string, value: unknown, def: unknown) => {
    const next = { ...overrides };
    if (value === def) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <>
      {ext.configuration.map((section, sectionIndex) => (
        <div key={sectionIndex}>
          {section.title && <h3 className="settings-subsection-title">{section.title}</h3>}
          {section.properties.map((prop) => {
            const value = prop.key in overrides ? overrides[prop.key] : prop.default;
            const label = prop.description || prop.key;

            if (prop.type === "boolean") {
              return (
                <label key={prop.key} className="settings-row checkbox-row" title={prop.key}>
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => setValue(prop.key, e.target.checked, prop.default)}
                  />
                  <span>{label}</span>
                </label>
              );
            }

            if (prop.type === "number" || prop.type === "integer") {
              const numericValue = typeof value === "number" ? value : Number(prop.default) || 0;
              return (
                <label key={prop.key} className="settings-row" title={prop.key}>
                  <span className="settings-label">{label}</span>
                  <NumberField
                    value={numericValue}
                    min={prop.minimum ?? -1e9}
                    max={prop.maximum ?? 1e9}
                    step={prop.type === "integer" ? 1 : 0.1}
                    onCommit={(v) => setValue(prop.key, prop.type === "integer" ? Math.round(v) : v, prop.default)}
                  />
                </label>
              );
            }

            if (prop.enum && prop.enum.length > 0) {
              return (
                <label key={prop.key} className="settings-row" title={prop.key}>
                  <span className="settings-label">{label}</span>
                  <select
                    className="dialog-input settings-select"
                    value={String(value)}
                    onChange={(e) => setValue(prop.key, e.target.value, prop.default)}
                  >
                    {prop.enum.map((opt, optIndex) => (
                      <option key={opt} value={opt} title={prop.enumDescriptions?.[optIndex]}>
                        {prop.enumItemLabels?.[optIndex] ?? opt}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }

            return (
              <label key={prop.key} className="settings-row" title={prop.key}>
                <span className="settings-label">{label}</span>
                <input
                  className="dialog-input"
                  value={typeof value === "string" ? value : String(value ?? "")}
                  onChange={(e) => setValue(prop.key, e.target.value, prop.default)}
                />
              </label>
            );
          })}
        </div>
      ))}
    </>
  );
}

export default function ExtensionConfigSection({ ext }: { ext: ExtensionInfo }) {
  const { extensionSettings, onExtensionSettingsChange } = useSettingsContext();

  return (
    <>
      <h2 className="settings-section-title">{ext.displayName}</h2>
      <ExtensionProperties
        ext={ext}
        overrides={extensionSettings[ext.id] ?? {}}
        onChange={(next) => {
          const nextAll = { ...extensionSettings };
          if (Object.keys(next).length === 0) delete nextAll[ext.id];
          else nextAll[ext.id] = next;
          onExtensionSettingsChange(nextAll);
        }}
      />
    </>
  );
}
