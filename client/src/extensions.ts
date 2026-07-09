// Client-side extension registry: fetches the installed-extension list from
// the server, dynamic-imports each enabled extension's client entry, and
// hands it a small ctx API (commands, file viewers, sidebar panels, active
// context, a fetch scoped to its own server routes). Themes/icon themes are
// NOT activated here — theme.ts and utils/iconThemes.ts read the same
// `extensions` list directly and apply themes without running any
// extension code, since they're just JSON.
import * as ReactNS from "react";
import { extensionApiBase, extensionFileUrl, fetchExtensions } from "./api";
import type { ExtensionSettingsValues } from "./settings";
import type { ExtensionInfo, MenuItem } from "./types";
import { getFileExtension } from "./utils/fileExtension";

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface RegisteredCommand {
  // Namespaced ext.<extensionId>.<id> — see registerCommand.
  id: string;
  label: string;
  defaultBinding?: string;
  run: () => void;
}

// Every prop beyond filePath/active is optional so a viewer that only cares
// about the file (e.g. hello-extension's DemoViewer) needs no changes —
// these are opt-in host affordances the built-in-turned-extension viewers
// (image/markdown/json/csv/media/pdf) rely on.
export interface FileViewerHostProps {
  filePath: string;
  active: boolean;
  // The tab bar's actions container — same portal mechanism ImageView's
  // zoom toolbar and MarkdownView/JsonView/CsvView's controls already use.
  toolbarTarget?: HTMLDivElement | null;
  // Escape hatch back to the default (nvim) view of this same file.
  openInEditor?: (path: string) => void;
  // Opens the app's shared context menu at the given screen position.
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // Reports dirty/clean transitions so closing the tab can confirm before
  // discarding unsaved edits (CsvView's editable grid).
  setDirty?: (dirty: boolean) => void;
  // Terminal/UI font size, in px — JsonView sizes its tree to match.
  fontSize?: number;
}

export type FileViewerMode = "default" | "preview";

export interface RegisteredFileViewer {
  id: string;
  extensionId: string;
  // Lowercase file extensions without the leading dot, e.g. ["demo"].
  extensions: string[];
  // "default" (image/media/pdf): a FILES-tree click opens this viewer
  // directly. "preview" (markdown/json/yaml/csv): a click still opens nvim;
  // this viewer is reached via the hover icon / "Preview" menu item /
  // Shift+Enter instead. See findFileViewerFor.
  mode: FileViewerMode;
  // Whether the FILES-tree context menu offers "Open in Editor" (nvim) as an
  // escape hatch from this "default"-mode viewer — true for image (editing
  // e.g. an SVG's source) and any third-party binary viewer, false for
  // media/pdf (nvim on audio/video/PDF bytes isn't useful). Ignored for
  // "preview"-mode viewers, which already open in nvim by default. Defaults
  // to true when omitted.
  editorFallback: boolean;
  component: ReactNS.ComponentType<FileViewerHostProps>;
}

export interface SidebarPanelHostProps {
  // The panel header's actions container — same portal mechanism
  // FileViewerHostProps.toolbarTarget uses for tab-bar controls. Lets a
  // panel put its own header-row buttons (refresh, sync, …) next to its
  // title instead of inside its scrollable body. null until the header
  // has mounted.
  actionsTarget?: HTMLDivElement | null;
}

export interface RegisteredSidebarPanel {
  // Namespaced ext.<extensionId>.<id> — used as the sidebar's PanelId.
  id: string;
  title: string;
  // Codicon name for the sidebar tab strip. Falls back to "extensions" when
  // omitted (see Sidebar.tsx's tab icon resolution).
  icon?: string;
  // Small count shown on this panel's sidebar tab (e.g. changed-file count
  // for Source Control) — null/0/undefined shows no badge. Set via
  // ctx.app.setSidebarBadge, not at registration time, since it typically
  // depends on data fetched after activate() runs.
  badge?: number | null;
  component: ReactNS.ComponentType<SidebarPanelHostProps>;
}

export interface ExtensionContext {
  React: typeof ReactNS;
  registerCommand(cmd: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    // Defaults to "default" when omitted, matching v1 extensions (like
    // hello-extension) that predate the preview/default distinction.
    mode?: FileViewerMode;
    // See RegisteredFileViewer.editorFallback. Defaults to true.
    editorFallback?: boolean;
    component: ReactNS.ComponentType<FileViewerHostProps>;
  }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    // Codicon name shown on this panel's sidebar tab. Defaults to
    // "extensions" when omitted.
    icon?: string;
    // Default keybinding (keybindings.ts combo syntax, e.g. "ctrl+shift+KeyG")
    // for an auto-registered "Sidebar: Focus <title>" command that reveals
    // the sidebar (if hidden) and switches to this tab — see
    // focusSidebarTab. Omit for no command at all; there's no unbound
    // default the way built-in commands get one, since most panels don't
    // need a dedicated shortcut cluttering the palette/keybinding list.
    focusBinding?: string;
    component: ReactNS.ComponentType<SidebarPanelHostProps>;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    // line jumps to that line when the path opens in nvim (ignored by a
    // "default"-mode viewer like image/media/pdf — same as a FILES-tree
    // ctrl+click "file:line" link, see openFileOrViewer).
    openFileTab(path: string, line?: number): void;
    // Opens (or activates, if already open) a tab for one of this
    // extension's own registered file viewers, bypassing the normal
    // extension-matching a FILES-tree click goes through — for a viewer
    // that's never auto-matched to a file extension (registerFileViewer's
    // `extensions: []`) and is only ever reached this way, e.g. a diff
    // viewer opened from a source-control panel. opts.title overrides the
    // tab-bar label (default: the path's basename); re-calling this for an
    // already-open (viewerId, path) tab also updates its title, e.g. to
    // reflect a working-tree/staged toggle.
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    // Bumps the FILES tree's refresh key so its git-status badges reflect a
    // change this extension just made (stage/commit/discard/pull) without
    // waiting for the tree's own poll.
    refreshFiles(): void;
    // Sets (or clears, via null/0) the count badge on one of this
    // extension's own registered sidebar panels (panelId is the same
    // unnamespaced id passed to registerSidebarPanel). No-ops if that
    // panel was never registered.
    setSidebarBadge(panelId: string, badge: number | null): void;
    // One-shot: returns (and clears) a pending "files to include" glob
    // pushed by the FILES-tree "Find in Folder…" menu item, or null if
    // none is pending. Only the search extension's activate() is expected
    // to call this — see requestFindInFolder/consumePendingFindInFolderGlob.
    consumeFindInFolderGlob(): string | null;
  };
  // fetch() scoped to this extension's own server hook, mounted at
  // /api/ext/<extensionId> — 404s if the extension has no server entry or
  // is disabled.
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  // Resolves an extension-relative path (a bundled stylesheet, an image) to
  // a fetchable URL — same route registerFileViewer's own client entry is
  // dynamic-imported from.
  assetUrl(relPath: string): string;
  // This extension's contributes.configuration values (declared default,
  // overridden by whatever the user set in Settings). get() takes the full
  // dotted key exactly as declared in the manifest. onDidChange fires with
  // no arguments — call get() again for whichever key you care about — same
  // as subscribeExtensionRegistry's plain re-render nudge.
  settings: {
    get(key: string): unknown;
    onDidChange(cb: () => void): () => void;
  };
}

export const extensionCommands: RegisteredCommand[] = [];
export const extensionFileViewers: RegisteredFileViewer[] = [];
export const extensionSidebarPanels: RegisteredSidebarPanel[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) l();
}

// React components subscribe here (see useExtensionRegistry) to re-render
// once extension activation populates the registries above — activation is
// async and happens after first mount.
export function subscribeExtensionRegistry(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Matches by extension + mode ("default": FILES-tree click target;
// "preview": hover icon / "Preview" menu / Shift+Enter target — see
// FileViewerMode). Among ties, a non-builtin (user-installed) viewer wins
// over a bundled one, so a third-party extension can override e.g. the
// built-in CSV preview; otherwise first-registered wins.
export function findFileViewerFor(
  filePath: string,
  viewers: RegisteredFileViewer[],
  mode: FileViewerMode,
): RegisteredFileViewer | null {
  const ext = getFileExtension(filePath);
  if (!ext) return null;
  const matches = viewers.filter((v) => v.mode === mode && v.extensions.includes(ext));
  if (matches.length <= 1) return matches[0] ?? null;
  const isBuiltin = (extensionId: string) =>
    installedExtensions.find((e) => e.id === extensionId)?.builtin ?? false;
  return matches.find((v) => !isBuiltin(v.extensionId)) ?? matches[0];
}

export function useExtensionRegistry(): {
  commands: RegisteredCommand[];
  fileViewers: RegisteredFileViewer[];
  sidebarPanels: RegisteredSidebarPanel[];
} {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionRegistry(() => setTick((t) => t + 1)), []);
  // New array references only when the registry actually changes (tick),
  // not on every unrelated App re-render — consumers (e.g. Sidebar's
  // reconcile effect) depend on these by reference, and the underlying
  // arrays are mutated in place by registerCommand/etc., so returning them
  // directly would never look "changed" to a dependency array.
  return ReactNS.useMemo(
    () => ({
      commands: [...extensionCommands],
      fileViewers: [...extensionFileViewers],
      sidebarPanels: [...extensionSidebarPanels],
    }),
    [tick],
  );
}

let activeContextValue: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
const contextListeners = new Set<(ctx: ActiveContext) => void>();

// Called from App.tsx whenever the derived "active real tab" context
// changes (session/window/cwd) — see the activeRealTab/filesRootDir
// derivation it already computes for the FILES panel and lazygit pill.
export function setActiveContext(ctx: ActiveContext): void {
  activeContextValue = ctx;
  for (const l of contextListeners) l(ctx);
}

let openFileTabHandler: ((path: string, line?: number) => void) | null = null;

// Wired once from App.tsx to whatever dispatch logic decides which viewer
// (nvim, an extension viewer, a built-in preview) opens a given path.
export function setOpenFileTabHandler(handler: (path: string, line?: number) => void): void {
  openFileTabHandler = handler;
}

let openViewerTabHandler:
  | ((namespacedViewerId: string, path: string, title?: string) => void)
  | null = null;

// Wired once from App.tsx to openExtViewerTab — see ExtensionContext.app.openViewerTab.
export function setOpenViewerTabHandler(
  handler: (namespacedViewerId: string, path: string, title?: string) => void,
): void {
  openViewerTabHandler = handler;
}

let refreshFilesHandler: (() => void) | null = null;

// Wired once from App.tsx to bump filesRefreshKey — see ExtensionContext.app.refreshFiles.
export function setRefreshFilesHandler(handler: () => void): void {
  refreshFilesHandler = handler;
}

interface SidebarTabsBridge {
  select(id: string): void;
  getActive(): string;
}

let sidebarTabsBridge: SidebarTabsBridge | null = null;
// Buffers a tab id requested while the Sidebar hasn't (re)mounted yet —
// notably focusSidebarTab's "reveal a hidden sidebar, then select" path:
// the visibility setState is queued but the Sidebar (and its bridge) isn't
// back until its own next render/effect pass.
let pendingTabId: string | null = null;

// Wired once from Sidebar.tsx (re-registered whenever its selectTab/
// activeTabId identity changes) — lets core code (the FILES-tree "Find in
// Folder…" menu item, and focusSidebarTab below) force-activate a sidebar
// tab by its (possibly extension-namespaced) id, or read which one is
// currently active.
export function setSidebarTabsBridge(bridge: SidebarTabsBridge | null): void {
  sidebarTabsBridge = bridge;
  if (bridge && pendingTabId !== null) {
    const id = pendingTabId;
    pendingTabId = null;
    bridge.select(id);
  }
}

export function selectSidebarTab(id: string): void {
  if (sidebarTabsBridge) sidebarTabsBridge.select(id);
  else pendingTabId = id;
}

interface SidebarVisibility {
  isVisible(): boolean;
  setVisible(visible: boolean): void;
}

let sidebarVisibility: SidebarVisibility | null = null;

// Wired once from App.tsx — lets focusSidebarTab below reveal a hidden
// sidebar (and hide it again for the VS Code "re-press the active tab's
// shortcut" toggle).
export function setSidebarVisibleHandler(handler: SidebarVisibility | null): void {
  sidebarVisibility = handler;
}

// Drives every "Sidebar: Focus <tab>" command (sidebar.focusExplorer and
// any extension panel's focusBinding command, see registerSidebarPanel
// below): hidden → reveal and switch to it; visible on a different tab →
// switch to it; visible and already the active tab → hide the sidebar
// (VS Code's toggle behavior).
export function focusSidebarTab(id: string): void {
  if (!sidebarVisibility) return;
  if (!sidebarVisibility.isVisible()) {
    sidebarVisibility.setVisible(true);
    selectSidebarTab(id);
    return;
  }
  if (sidebarTabsBridge?.getActive() === id) {
    sidebarVisibility.setVisible(false);
    return;
  }
  selectSidebarTab(id);
}

// "Find in Folder…" (FILES-tree folder context menu, useFileActions.ts) —
// switches to the bundled search extension's tab and hands it a glob scope.
// Hardcodes the search extension's namespaced panel id rather than adding a
// generic extension-contribution API, since this wires one specific
// built-in menu item to one specific built-in extension (same category of
// coupling as core already knowing about git-scm's diff viewer). The
// extension id itself is `${publisher}.${name}` from its manifest (see
// server/src/extensions.ts's resolveId), not just the bare folder name —
// extensions/search/package.json is publisher "tmux-server", name "search".
const SEARCH_PANEL_ID = "ext.tmux-server.search.search";

// The search panel isn't mounted yet at the moment this fires (activating
// its tab and mounting SearchPanel both happen on the next render) — the
// pending glob is consumed once by the panel's own mount/session-load
// effect rather than pushed through a live-subscriber callback.
let pendingFindInFolderGlob: string | null = null;

export function requestFindInFolder(glob: string): void {
  if (extensionSidebarPanels.some((p) => p.id === SEARCH_PANEL_ID)) {
    pendingFindInFolderGlob = glob;
    selectSidebarTab(SEARCH_PANEL_ID);
  }
}

// Reads without immediately clearing: React's development-mode double-
// invoke runs the search panel's mount effect twice, synchronously, for
// the same logical mount — the second pass's own "restore last session's
// cached state" step would otherwise run with nothing left to override it
// with, since an eager clear on the first read already nulled it out,
// stomping the correctly-applied result with stale cached values. The
// setTimeout defers the actual clear past both synchronous passes (which
// always complete within the same tick) while still clearing it before any
// later, unrelated mount (which requires an intervening user action, so it
// always takes far longer than one tick).
export function consumePendingFindInFolderGlob(): string | null {
  const glob = pendingFindInFolderGlob;
  if (glob !== null) {
    setTimeout(() => {
      pendingFindInFolderGlob = null;
    }, 0);
  }
  return glob;
}

let installedExtensions: ExtensionInfo[] = [];

export function getInstalledExtensions(): ExtensionInfo[] {
  return installedExtensions;
}

// Sparse overrides as last pushed from App.tsx (see setExtensionSettingsOverrides),
// and the resolved (override ?? manifest default) values per extension id —
// recomputed on every push so ctx.settings.get() is a plain lookup. Kept as
// a NEW object per extension on every push (never mutated in place) so the
// shallow-equal comparison below can actually detect "nothing changed".
let extensionSettingsOverrides: ExtensionSettingsValues = {};
let resolvedExtensionSettings: Record<string, Record<string, unknown>> = {};
const extensionSettingsListeners = new Map<string, Set<() => void>>();

function resolveExtensionSettings(ext: ExtensionInfo, overrides: ExtensionSettingsValues): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const section of ext.configuration) {
    for (const prop of section.properties) values[prop.key] = prop.default;
  }
  Object.assign(values, overrides[ext.id]);
  return values;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

// Called from App.tsx whenever extension settings change (initial load,
// server doc arriving, or a user edit in Settings) — recomputes every
// installed extension's resolved values and notifies only the extensions
// whose resolved values actually changed.
export function setExtensionSettingsOverrides(
  overrides: ExtensionSettingsValues,
  extensions: ExtensionInfo[],
): void {
  extensionSettingsOverrides = overrides;
  const prev = resolvedExtensionSettings;
  const next: Record<string, Record<string, unknown>> = {};
  for (const ext of extensions) next[ext.id] = resolveExtensionSettings(ext, overrides);
  resolvedExtensionSettings = next;
  for (const [id, values] of Object.entries(next)) {
    if (prev[id] && shallowEqual(prev[id], values)) continue;
    const listeners = extensionSettingsListeners.get(id);
    if (listeners) for (const l of listeners) l();
  }
}

function makeContext(ext: ExtensionInfo, runtime: ExtensionRuntime): ExtensionContext {
  return {
    React: ReactNS,
    registerCommand(cmd) {
      extensionCommands.push({ ...cmd, id: `ext.${ext.id}.${cmd.id}` });
      notify();
    },
    registerFileViewer(viewer) {
      extensionFileViewers.push({
        id: `ext.${ext.id}.${viewer.id}`,
        extensionId: ext.id,
        extensions: viewer.extensions.map((e) => e.toLowerCase()),
        mode: viewer.mode ?? "default",
        editorFallback: viewer.editorFallback ?? true,
        component: viewer.component,
      });
      notify();
    },
    registerSidebarPanel(panel) {
      const namespacedId = `ext.${ext.id}.${panel.id}`;
      extensionSidebarPanels.push({
        id: namespacedId,
        title: panel.title,
        icon: panel.icon,
        component: panel.component,
      });
      // Opt-in only — most panels don't warrant their own dedicated
      // shortcut cluttering the palette/keybinding list (see the
      // focusBinding doc comment above).
      if (panel.focusBinding) {
        extensionCommands.push({
          id: `${namespacedId}.focus`,
          label: `Sidebar: Focus ${panel.title}`,
          defaultBinding: panel.focusBinding,
          run: () => focusSidebarTab(namespacedId),
        });
      }
      notify();
    },
    app: {
      getActiveContext: () => activeContextValue,
      onDidChangeContext(cb) {
        contextListeners.add(cb);
        // Tracked per-extension (not just the shared Set above) so
        // deactivateClientExtension can unsubscribe exactly this extension's
        // callbacks without touching any other extension's.
        runtime.contextListeners.add(cb);
        return () => {
          contextListeners.delete(cb);
          runtime.contextListeners.delete(cb);
        };
      },
      openFileTab(path, line) {
        openFileTabHandler?.(path, line);
      },
      openViewerTab(viewerId, path, opts) {
        openViewerTabHandler?.(`ext.${ext.id}.${viewerId}`, path, opts?.title);
      },
      refreshFiles() {
        refreshFilesHandler?.();
      },
      setSidebarBadge(panelId, badge) {
        const namespaced = `ext.${ext.id}.${panelId}`;
        const panel = extensionSidebarPanels.find((p) => p.id === namespaced);
        if (!panel) return;
        panel.badge = badge;
        notify();
      },
      consumeFindInFolderGlob: () => consumePendingFindInFolderGlob(),
    },
    serverFetch(path, init) {
      return fetch(`${extensionApiBase(ext.id)}${path}`, init);
    },
    settings: {
      get(key) {
        return resolvedExtensionSettings[ext.id]?.[key];
      },
      onDidChange(cb) {
        let listeners = extensionSettingsListeners.get(ext.id);
        if (!listeners) {
          listeners = new Set();
          extensionSettingsListeners.set(ext.id, listeners);
        }
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    assetUrl(relPath) {
      return extensionFileUrl(ext.id, relPath);
    },
  };
}

interface ExtensionRuntime {
  // The dynamically-imported client-entry module, so deactivate (below) can
  // call its optional `deactivate` export.
  module: unknown;
  // This extension's own onDidChangeContext callbacks — a subset of the
  // shared contextListeners Set, tracked separately so deactivation can
  // remove exactly these without touching other extensions' callbacks.
  contextListeners: Set<(ctx: ActiveContext) => void>;
}

const activatedIds = new Set<string>();
const extensionRuntimes = new Map<string, ExtensionRuntime>();

async function activateClientExtension(ext: ExtensionInfo): Promise<void> {
  if (activatedIds.has(ext.id) || !ext.clientEntry) return;
  activatedIds.add(ext.id);
  const runtime: ExtensionRuntime = { module: null, contextListeners: new Set() };
  extensionRuntimes.set(ext.id, runtime);
  try {
    const url = extensionFileUrl(ext.id, ext.clientEntry);
    // Vite must not try to statically analyze/pre-bundle this — the path is
    // only known at runtime, from the server's extension list.
    const mod: unknown = await import(/* @vite-ignore */ url);
    runtime.module = mod;
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${ext.id}: client entry has no activate() export`);
      return;
    }
    (activate as (ctx: ExtensionContext) => void)(makeContext(ext, runtime));
  } catch (err) {
    console.error(`extension ${ext.id}: failed to load client entry:`, err);
  }
}

// Reverses activateClientExtension: calls the module's optional deactivate()
// export (e.g. to remove an injected stylesheet), removes this extension's
// entries from the command/file-viewer/sidebar-panel registries, unsubscribes
// its onDidChangeContext and settings.onDidChange callbacks, and clears
// activatedIds so a later re-enable calls activate() again instead of
// silently no-oping against the stale guard.
function deactivateClientExtension(extId: string): void {
  if (!activatedIds.has(extId)) return;
  const runtime = extensionRuntimes.get(extId);
  const deactivate = (runtime?.module as { deactivate?: unknown } | null)?.deactivate;
  if (typeof deactivate === "function") {
    try {
      (deactivate as () => void)();
    } catch (err) {
      console.error(`extension ${extId}: deactivate() threw:`, err);
    }
  }
  const prefix = `ext.${extId}.`;
  for (let i = extensionCommands.length - 1; i >= 0; i--) {
    if (extensionCommands[i].id.startsWith(prefix)) extensionCommands.splice(i, 1);
  }
  for (let i = extensionFileViewers.length - 1; i >= 0; i--) {
    if (extensionFileViewers[i].extensionId === extId) extensionFileViewers.splice(i, 1);
  }
  for (let i = extensionSidebarPanels.length - 1; i >= 0; i--) {
    if (extensionSidebarPanels[i].id.startsWith(prefix)) extensionSidebarPanels.splice(i, 1);
  }
  if (runtime) for (const cb of runtime.contextListeners) contextListeners.delete(cb);
  extensionSettingsListeners.delete(extId);
  extensionRuntimes.delete(extId);
  activatedIds.delete(extId);
  notify();
}

// Fetches the list once and activates every enabled extension's client
// entry. Themes/icon themes need no activation step — see the module
// comment — so this only concerns commands/viewers/panels. onListLoaded, if
// given, fires right after the list is known but before any client entry
// activates — App.tsx uses this to push extension-settings overrides into
// this module's store first, so ctx.settings.get() already resolves
// correctly the very first time an activating extension reads it.
export async function loadExtensions(onListLoaded?: (list: ExtensionInfo[]) => void): Promise<ExtensionInfo[]> {
  const list = await fetchExtensions();
  const enabledIds = new Set(list.filter((ext) => ext.enabled).map((ext) => ext.id));
  // Disabled or uninstalled since the last load: tear this extension down
  // before installedExtensions/notify reflect the new list, so nothing
  // observes a moment where a now-gone extension's panel/viewer is still
  // registered but its backing extension info has already disappeared.
  for (const id of [...activatedIds]) {
    if (!enabledIds.has(id)) deactivateClientExtension(id);
  }
  installedExtensions = list;
  notify();
  onListLoaded?.(list);
  await Promise.all(
    list.filter((ext) => ext.enabled && ext.hasClient).map((ext) => activateClientExtension(ext)),
  );
  return list;
}
