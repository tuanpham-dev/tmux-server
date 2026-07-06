import { useState } from "react";
import * as api from "../../api";
import Icon from "../Icon";
import { useSettingsContext } from "./context";

export default function ExtensionsSection() {
  const { extensions, onReloadExtensions } = useSettingsContext();
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [extensionSearch, setExtensionSearch] = useState("");
  const [extensionStatusFilter, setExtensionStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [extensionSourceFilter, setExtensionSourceFilter] = useState<"all" | "builtin" | "installed">("all");
  const [extensionContributesFilter, setExtensionContributesFilter] = useState<
    "all" | "themes" | "iconThemes" | "fonts" | "client" | "server"
  >("all");

  const extensionSearchLower = extensionSearch.trim().toLowerCase();
  const visibleExtensions = extensions.filter((ext) => {
    if (
      extensionSearchLower &&
      !ext.displayName.toLowerCase().includes(extensionSearchLower) &&
      !ext.description.toLowerCase().includes(extensionSearchLower) &&
      !ext.id.toLowerCase().includes(extensionSearchLower)
    ) {
      return false;
    }
    if (extensionStatusFilter === "enabled" && !ext.enabled) return false;
    if (extensionStatusFilter === "disabled" && ext.enabled) return false;
    if (extensionSourceFilter === "builtin" && !ext.builtin) return false;
    if (extensionSourceFilter === "installed" && ext.builtin) return false;
    switch (extensionContributesFilter) {
      case "themes":
        return ext.themes.length > 0;
      case "iconThemes":
        return ext.iconThemes.length > 0;
      case "fonts":
        return ext.fonts.length > 0;
      case "client":
        return ext.hasClient;
      case "server":
        return ext.hasServer;
      default:
        return true;
    }
  });

  return (
    <>
      <h2 className="settings-section-title">Extensions</h2>

      <label className="dialog-button secondary extension-install-button">
        {installing ? "Installing…" : "Install from .tsix"}
        <input
          type="file"
          accept=".tsix"
          disabled={installing}
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setInstalling(true);
            setExtensionsError(null);
            try {
              await api.installExtensionTsix(file);
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

      <div className="extension-filter-row">
        <input
          className="dialog-input extension-filter-search"
          placeholder="Search extensions"
          value={extensionSearch}
          onChange={(e) => setExtensionSearch(e.target.value)}
        />
        <select
          className="dialog-input settings-select extension-filter-select"
          value={extensionStatusFilter}
          onChange={(e) => setExtensionStatusFilter(e.target.value as typeof extensionStatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <select
          className="dialog-input settings-select extension-filter-select"
          value={extensionSourceFilter}
          onChange={(e) => setExtensionSourceFilter(e.target.value as typeof extensionSourceFilter)}
        >
          <option value="all">All sources</option>
          <option value="builtin">Built-in</option>
          <option value="installed">Installed</option>
        </select>
        <select
          className="dialog-input settings-select extension-filter-select"
          value={extensionContributesFilter}
          onChange={(e) =>
            setExtensionContributesFilter(e.target.value as typeof extensionContributesFilter)
          }
        >
          <option value="all">All contributions</option>
          <option value="themes">Color themes</option>
          <option value="iconThemes">Icon themes</option>
          <option value="fonts">Fonts</option>
          <option value="client">UI functionality</option>
          <option value="server">Server functionality</option>
        </select>
      </div>

      <div className="extension-list">
        {extensions.length === 0 && (
          <div className="keybinding-empty">No extensions installed</div>
        )}
        {extensions.length > 0 && visibleExtensions.length === 0 && (
          <div className="keybinding-empty">No extensions match your search</div>
        )}
        {visibleExtensions.map((ext) => (
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
                {ext.builtin && <span className="extension-row-builtin">Built-in</span>}
              </div>
              {ext.description && <div className="extension-row-description">{ext.description}</div>}
              <div className="extension-row-contributes">
                {ext.themes.length > 0 && <span>{ext.themes.length} color theme(s)</span>}
                {ext.iconThemes.length > 0 && <span>{ext.iconThemes.length} icon theme(s)</span>}
                {ext.fonts.length > 0 && <span>{ext.fonts.length} font(s)</span>}
                {ext.hasClient && <span>UI functionality</span>}
                {ext.hasServer && <span>Server functionality</span>}
              </div>
              {ext.hasServer && !ext.enabled && (
                <div className="settings-hint">
                  Restart the tmux-server server to fully unload a disabled extension's server code.
                </div>
              )}
            </div>
            {pendingUninstallId === ext.id ? (
              <div className="extension-row-confirm">
                <span>
                  {ext.builtin
                    ? "Uninstall this built-in? You can restore it later by installing its .tsix again."
                    : "Uninstall?"}
                </span>
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
  );
}
