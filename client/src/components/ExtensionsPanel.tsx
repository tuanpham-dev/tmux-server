import { useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import { parsePublisher } from "../lib/extensionId";
import { compareVersions } from "../lib/version";
import type { ExtensionInfo, RegistryCatalogEntry, RegistrySourceResult } from "../types";
import Icon from "./Icon";

interface Props {
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  registries: string[];
  onRegistriesChange: (registries: string[]) => void;
  registryCatalog: RegistrySourceResult[];
  registryLoading: boolean;
  onEnsureRegistryLoaded: () => void;
  onRefreshRegistry: (refresh: boolean, sourcesOverride?: string[]) => void;
  onOpenExtensionPage: (id: string, source?: string) => void;
}

function ExtIcon({ src }: { src: string | null }) {
  return src ? <img src={src} alt="" className="extension-icon" /> : <Icon name="extensions" className="extension-icon" />;
}

// One list row — VS Code's extension-list-item layout: icon, then a stacked
// title/description/publisher column, then a right-hand actions strip.
// `children` are that row's action controls (checkbox+uninstall for an
// installed row, an Install button for an available one) — kept in the
// caller since the two rows' actions differ enough that folding them in here
// would just replace one branch with another.
function ExtensionRow({
  iconSrc,
  displayName,
  description,
  publisher,
  verified,
  disabled,
  onOpen,
  children,
}: {
  iconSrc: string | null;
  displayName: string;
  description: string;
  publisher?: string;
  verified?: boolean;
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={`extension-row extension-row-clickable${disabled ? " extension-row-disabled" : ""}`}
      onClick={onOpen}
    >
      <ExtIcon src={iconSrc} />
      <div className="extension-row-body">
        <div className="extension-row-title">{displayName}</div>
        <div className="extension-row-description">{description}</div>
        <div className="extension-row-footer">
          {verified && <Icon name="verified-filled" className="extension-verified-icon" />}
          {publisher && <span className="extension-row-publisher">{publisher}</span>}
          {children && (
            <div className="extension-row-actions" onClick={(e) => e.stopPropagation()}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExtensionsPanel({
  extensions,
  onReloadExtensions,
  registries,
  onRegistriesChange,
  registryCatalog,
  registryLoading,
  onEnsureRegistryLoaded,
  onRefreshRegistry,
  onOpenExtensionPage,
}: Props) {
  const [search, setSearch] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installingTsix, setInstallingTsix] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRegistries, setShowRegistries] = useState(false);
  const [newRegistry, setNewRegistry] = useState("");
  const [installedCollapsed, setInstalledCollapsed] = useState(false);
  const [availableCollapsed, setAvailableCollapsed] = useState(false);

  useEffect(() => {
    onEnsureRegistryLoaded();
  }, [onEnsureRegistryLoaded]);

  const installedIds = new Set(extensions.map((e) => e.id));
  // A just-removed source's fetched entries linger in registryCatalog until
  // the next refresh — filtered out here so removal reads as immediate
  // rather than waiting on a refetch (see addRegistry's sourcesOverride for
  // the mirror-image add case).
  const liveRegistryCatalog = registryCatalog.filter((src) => registries.includes(src.source));

  // {id -> {source, version}} for the highest-version registry entry that
  // beats the installed version — drives the per-row "Update" action.
  const updateBySource = new Map<string, { source: string; version: string }>();
  for (const src of liveRegistryCatalog) {
    for (const entry of src.entries) {
      const installed = extensions.find((e) => e.id === entry.id);
      if (!installed || compareVersions(entry.version, installed.version) <= 0) continue;
      const current = updateBySource.get(entry.id);
      if (!current || compareVersions(entry.version, current.version) > 0) {
        updateBySource.set(entry.id, { source: src.source, version: entry.version });
      }
    }
  }

  const availableEntries: (RegistryCatalogEntry & { source: string })[] = [];
  for (const src of liveRegistryCatalog) {
    for (const entry of src.entries) {
      if (installedIds.has(entry.id)) continue;
      availableEntries.push({ source: src.source, ...entry });
    }
  }

  const searchLower = search.trim().toLowerCase();
  const matches = (displayName: string, description: string, id: string) =>
    !searchLower ||
    displayName.toLowerCase().includes(searchLower) ||
    description.toLowerCase().includes(searchLower) ||
    id.toLowerCase().includes(searchLower);

  const visibleInstalled = extensions.filter((e) => matches(e.displayName, e.description, e.id));
  const visibleAvailable = availableEntries.filter((e) => matches(e.displayName, e.description, e.id));

  const runInstall = (source: string, id: string) => {
    setInstallingId(id);
    setError(null);
    api
      .installFromRegistry(source, id)
      .then(onReloadExtensions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstallingId(null));
  };

  const addRegistry = () => {
    const value = newRegistry.trim();
    if (!value || registries.includes(value)) return;
    // Passed explicitly (not left to the next render's registries prop) so
    // the refresh doesn't race the settings doc's debounced write-back —
    // see api.fetchRegistry's doc comment.
    const next = [...registries, value];
    onRegistriesChange(next);
    setNewRegistry("");
    onRefreshRegistry(true, next);
  };

  const removeRegistry = (source: string) => {
    onRegistriesChange(registries.filter((r) => r !== source));
  };

  return (
    <div className="extensions-panel">
      <div className="extensions-panel-toolbar">
        <input
          className="dialog-input extension-filter-search"
          placeholder="Search extensions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="dialog-button secondary extension-install-button">
          {installingTsix ? "Installing…" : "Install from .tsix"}
          <input
            type="file"
            accept=".tsix"
            disabled={installingTsix}
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setInstallingTsix(true);
              setError(null);
              try {
                await api.installExtensionTsix(file);
                onReloadExtensions();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setInstallingTsix(false);
              }
            }}
          />
        </label>
        <button
          className="icon-button"
          title="Refresh registries"
          onClick={() => onRefreshRegistry(true)}
        >
          <Icon name="refresh" />
        </button>
        <button
          className={`icon-button${showRegistries ? " active" : ""}`}
          title="Manage registries"
          onClick={() => setShowRegistries((v) => !v)}
        >
          <Icon name="gear" />
        </button>
      </div>

      {showRegistries && (
        <div className="extensions-registries">
          {registries.length === 0 && (
            <div className="settings-hint">
              No registries configured. Add a URL serving an index.json, or a local directory path.
            </div>
          )}
          {registries.map((source) => {
            const result = registryCatalog.find((r) => r.source === source);
            return (
              <div key={source} className="extensions-registry-row">
                <span className="extensions-registry-source" title={source}>
                  {source}
                </span>
                {result?.error && <span className="extension-error extensions-registry-error">{result.error}</span>}
                <button className="icon-button" title="Remove" onClick={() => removeRegistry(source)}>
                  <Icon name="trash" />
                </button>
              </div>
            );
          })}
          <div className="extensions-registry-add">
            <input
              className="dialog-input"
              placeholder="https://example.com/ or /path/to/dist"
              value={newRegistry}
              onChange={(e) => setNewRegistry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addRegistry();
              }}
            />
            <button className="dialog-button secondary" onClick={addRegistry}>
              Add
            </button>
          </div>
        </div>
      )}

      {error && <div className="extension-error">{error}</div>}

      <div className="extensions-panel-body">
        <div
          className="extensions-panel-section-header"
          onClick={() => setInstalledCollapsed((v) => !v)}
        >
          <Icon
            name={installedCollapsed ? "chevron-right" : "chevron-down"}
            className="extensions-panel-section-chevron"
          />
          <span className="extensions-panel-section-title">Installed</span>
          <span className="extensions-panel-section-badge">{extensions.length}</span>
        </div>
        {!installedCollapsed && (
          <div className="extension-list">
            {extensions.length === 0 && <div className="keybinding-empty">No extensions installed</div>}
            {extensions.length > 0 && visibleInstalled.length === 0 && (
              <div className="keybinding-empty">No extensions match your search</div>
            )}
            {visibleInstalled.map((ext) => {
              const update = updateBySource.get(ext.id);
              return (
                <ExtensionRow
                  key={ext.id}
                  iconSrc={ext.icon ? api.extensionFileUrl(ext.id, ext.icon) : null}
                  displayName={ext.displayName}
                  description={ext.description}
                  publisher={parsePublisher(ext.id)}
                  verified={ext.builtin}
                  disabled={!ext.enabled}
                  onOpen={() => onOpenExtensionPage(ext.id)}
                >
                  {update && (
                    <button
                      className="dialog-button secondary"
                      disabled={installingId === ext.id}
                      title={`Update to v${update.version}`}
                      onClick={() => runInstall(update.source, ext.id)}
                    >
                      {installingId === ext.id ? "Updating…" : `Update to v${update.version}`}
                    </button>
                  )}
                </ExtensionRow>
              );
            })}
          </div>
        )}

        <div
          className="extensions-panel-section-header"
          onClick={() => setAvailableCollapsed((v) => !v)}
        >
          <Icon
            name={availableCollapsed ? "chevron-right" : "chevron-down"}
            className="extensions-panel-section-chevron"
          />
          <span className="extensions-panel-section-title">Available</span>
          {registryLoading ? (
            <span className="extensions-panel-section-loading">Loading…</span>
          ) : (
            <span className="extensions-panel-section-badge">{availableEntries.length}</span>
          )}
        </div>
        {!availableCollapsed && (
          <div className="extension-list">
            {registries.length === 0 && (
              <div className="keybinding-empty">
                No registries configured — click the gear above to add one.
              </div>
            )}
            {registries.length > 0 && availableEntries.length === 0 && !registryLoading && (
              <div className="keybinding-empty">No available extensions</div>
            )}
            {registries.length > 0 && availableEntries.length > 0 && visibleAvailable.length === 0 && (
              <div className="keybinding-empty">No extensions match your search</div>
            )}
            {visibleAvailable.map((entry) => (
              <ExtensionRow
                key={`${entry.source}:${entry.id}`}
                iconSrc={entry.hasIcon ? api.registryIconUrl(entry.source, entry.id) : null}
                displayName={entry.displayName}
                description={entry.description}
                publisher={entry.publisher ?? parsePublisher(entry.id)}
                onOpen={() => onOpenExtensionPage(entry.id, entry.source)}
              >
                <button
                  className="dialog-button primary"
                  disabled={installingId === entry.id}
                  onClick={() => runInstall(entry.source, entry.id)}
                >
                  {installingId === entry.id ? "Installing…" : "Install"}
                </button>
              </ExtensionRow>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
