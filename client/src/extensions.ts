// Client-side extension registry: fetches the installed-extension list from
// the server, dynamic-imports each enabled extension's client entry, and
// hands it a small ctx API (commands, file viewers, sidebar panels, active
// context, a fetch scoped to its own server routes). Themes/icon themes are
// NOT activated here — theme.ts and utils/iconThemes.ts read the same
// `extensions` list directly and apply themes without running any
// extension code, since they're just JSON. ctx.app.getFileIcon/getFolderIcon
// do let an extension *query* the already-active icon theme's resolved
// result (see makeContext) — that's read-only exposure of iconThemes.ts's
// own resolver, not extension involvement in loading/activating themes.
import * as ReactNS from "react";
import { extensionApiBase, extensionFileUrl, fetchExtensions } from "./api";
import type { CreateTerminalEngine } from "./engines/types";
import type { ExtensionSettingsValues } from "./settings";
import type { ExtensionInfo, MenuItem } from "./types";
import { getFileExtension } from "./utils/fileExtension";
import { getFileIconResult, getFolderIconResult, subscribeIconTheme } from "./utils/iconThemes";
import type { IconResult } from "./utils/iconThemes";

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
  // Opens the app's shared context menu at the given screen position — same
  // capability FileViewerHostProps.showMenu gives file viewers.
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // The app's shared confirm dialog (message → resolves true on confirm) —
  // for destructive panel actions like the ports panel's Kill process.
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

// "tab": the panel is its own sidebar tab (SCM, Search). "explorer": the
// panel is an accordion section inside the Explorer tab, alongside the
// built-in SESSIONS/FILES sections (the extracted PORTS panel) — it takes
// part in the accordion's ordering/collapse/resize persistence under its
// namespaced id.
export type SidebarPanelLocation = "tab" | "explorer";

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
  location: SidebarPanelLocation;
  // Whether an "explorer" accordion section starts collapsed for users with
  // no stored state for it (the tab location ignores this).
  defaultCollapsed?: boolean;
  component: ReactNS.ComponentType<SidebarPanelHostProps>;
}

// What a window action's isVisible/onClick are evaluated against — a plain
// snapshot of one SESSIONS-tree window row, not a live handle.
export interface WindowActionContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  // The window's active pane's current foreground command (see TmuxWindow.command)
  // — e.g. isVisible: (w) => w.command === "claude".
  command: string;
}

export interface RegisteredWindowAction {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Codicon name for the row button (same Icon component the built-in
  // window-kill-button uses).
  icon: string;
  title: string;
  // Re-evaluated by Sidebar.tsx on every window row render (the session
  // list already polls every ~3s — see useSessions.ts — so this is
  // reactive for free, no extra plumbing needed).
  isVisible(ctx: WindowActionContext): boolean;
  onClick(ctx: WindowActionContext): void;
  // Also render this action in the tab bar's actions area (next to the
  // built-in per-tab controls) whenever a group's active tab is the
  // matching terminal window — see App.tsx's tabExtrasFor. Defaults to
  // false: most window actions are row-only.
  showInTabBar?: boolean;
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
    // Where the panel renders — its own sidebar tab (default) or an
    // accordion section inside the Explorer tab. See SidebarPanelLocation.
    location?: SidebarPanelLocation;
    // Explorer-location only: collapsed by default for users with no stored
    // accordion state for this panel.
    defaultCollapsed?: boolean;
    // Default keybinding (keybindings.ts combo syntax, e.g. "ctrl+shift+KeyG")
    // for the auto-registered "Sidebar: Focus <title>" command that reveals
    // the sidebar (if hidden) and switches to this tab / expands this
    // section — see focusSidebarTab/focusExplorerPanel. For "tab" panels,
    // omitting it omits the command entirely (most panels don't need a
    // dedicated shortcut cluttering the palette); "explorer" panels always
    // get the command (unbound when omitted), matching the built-in
    // sections' own always-present focus commands.
    focusBinding?: string;
    component: ReactNS.ComponentType<SidebarPanelHostProps>;
  }): void;
  // Contributes a button to the SESSIONS tree's window rows (next to the
  // built-in kill-window button), shown only on rows where isVisible
  // returns true — e.g. a preview action for windows running a specific
  // command. Generic: not tied to any particular command or extension.
  registerWindowAction(action: {
    id: string;
    icon: string;
    title: string;
    isVisible: (ctx: WindowActionContext) => boolean;
    onClick: (ctx: WindowActionContext) => void;
    showInTabBar?: boolean;
  }): void;
  // Contributes per-row decorations (badge + row class + tooltip) to the
  // FILES tree, and optionally a root decoration (the branch pill slot).
  // provideDecoration is synchronous — serve from a cache the extension
  // maintains itself, then call the returned refresh() after that cache
  // changes so the tree re-renders with the new answers.
  registerFileDecorationProvider(provider: {
    id: string;
    provideDecoration: (path: string, isDir: boolean) => FileDecoration | undefined;
    provideRootDecoration?: (rootPath: string) => RootDecoration | undefined;
  }): { refresh(): void };
  // Contributes badges to SESSIONS-tree window rows (where the built-in
  // subagent count rendered before extraction). Same sync-from-cache +
  // refresh() contract as registerFileDecorationProvider.
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (ctx: SessionDecorationContext) => SessionDecoration | undefined;
    onClick?: (anchorRect: DOMRect, ctx: SessionDecorationContext) => void;
  }): { refresh(): void };
  // Supplies a terminal engine (the CreateTerminalEngine seam from
  // engines/types) — TerminalView resolves the engine setting against this
  // registry after extensions settle. See engines/index.ts.
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
  // Contributes result rows to the quick switcher (non-command mode),
  // alongside the core tab/window/session/file sources. Same sync-from-
  // cache + refresh() contract as the decoration providers.
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults: (query: string) => QuickSwitcherItem[];
  }): { refresh(): void };
  // Renders per-terminal UI in the touch-key bar's old slots — see
  // TerminalAccessoryContext/TerminalAccessoryPlacement.
  registerTerminalAccessory(accessory: {
    id: string;
    placement: TerminalAccessoryPlacement;
    component: ReactNS.ComponentType<TerminalAccessoryHostProps>;
  }): void;
  // Renders a component once over the editor area (the .main region), on top
  // of whatever tab is active — a terminal, Settings, a viewer. Unlike a
  // terminal accessory (which only mounts inside a focused TerminalView),
  // this is app-global. The host draws it into a pointer-events:none overlay
  // layer, so the component must opt its own interactive surfaces back into
  // pointer-events. See AppOverlayContext/AppOverlayHostProps.
  registerAppOverlay(overlay: {
    id: string;
    component: ReactNS.ComponentType<AppOverlayHostProps>;
  }): void;
  // Renders a custom component inside this extension's Settings section,
  // below its scalar configuration controls.
  registerSettingsComponent(component: { id: string; component: ReactNS.ComponentType }): void;
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
    // Resolves a file/folder name against the currently active icon theme
    // (same resolver the FILES tree and tab bar use) — read-only query, the
    // extension never loads or activates a theme itself. `kind: "none"`
    // means no icon theme is active, or it has no icon for that name; the
    // extension's own FileIcon copy already renders that as nothing.
    getFileIcon(fileName: string): IconResult;
    getFolderIcon(folderName: string, expanded: boolean): IconResult;
    // Fires with no arguments whenever the active icon theme finishes
    // loading or changes in Settings — call getFileIcon/getFolderIcon again
    // to get the fresh result, same shape as settings.onDidChange below.
    onDidChangeIconTheme(cb: () => void): () => void;
    // Runs a command by id — a built-in command (e.g. "tab.next",
    // "quickSwitcher.toggle") or an extension command by its namespaced id
    // (ext.<extensionId>.<id>). No-ops on an unknown id, or one whose scope
    // can't be dispatched globally (terminal/files/sessions-scoped commands
    // aren't runnable this way — see getCommands, which omits them).
    executeCommand(commandId: string): void;
    // Lists the commands executeCommand can actually run right now — every
    // global built-in command plus every registered extension command, as
    // {id,label}. Snapshot, not live; call again after the registry changes.
    getCommands(): { id: string; label: string }[];
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
    // Writes one of this extension's own configuration values — same
    // store the Settings UI edits (server-synced), so onDidChange fires
    // and the value persists.
    set(key: string, value: unknown): void;
    onDidChange(cb: () => void): () => void;
  };
}

// A single row's decoration in the FILES tree — the visual vocabulary
// GitStatusBadge/git-status-* row classes used before extraction, made
// generic. Colors live in the providing extension's own stylesheet (it
// supplies a className), not in a color value here, so theming stays CSS.
export interface FileDecoration {
  // Short badge text rendered at the row's right edge (e.g. "M").
  badge?: string;
  // Tooltip for the badge (falls back to the badge text).
  tooltip?: string;
  // Extra class(es) applied to the whole row (e.g. "git-status-modified" —
  // row coloring/dimming is the provider's stylesheet's job).
  className?: string;
}

// Decoration for the tree's root header (the branch pill, generically):
// label is the pill text.
export interface RootDecoration {
  label: string;
  tooltip?: string;
}

export interface RegisteredFileDecorationProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, from provider-owned cache — called per visible row on
  // every tree render, so it must be a plain lookup, never a fetch.
  provideDecoration(path: string, isDir: boolean): FileDecoration | undefined;
  provideRootDecoration?(rootPath: string): RootDecoration | undefined;
}

// What a session-window decoration's provide/onClick are evaluated against —
// same plain-snapshot shape as WindowActionContext.
export interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

// A badge on a SESSIONS-tree window row (the subagent count, generically).
export interface SessionDecoration {
  badge: string;
  tooltip?: string;
  className?: string;
}

export interface RegisteredSessionDecorationProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, from provider-owned cache — see provideDecoration above.
  provideWindowDecoration(ctx: SessionDecorationContext): SessionDecoration | undefined;
  // Clicking the badge. anchorRect is the badge's bounding rect so the
  // extension can position its own popover (rendered via its own portal
  // root, torn down in deactivate).
  onClick?(anchorRect: DOMRect, ctx: SessionDecorationContext): void;
}

// A quick-switcher result contributed by an extension provider — rendered
// alongside the core tab/window/session/file rows.
export interface QuickSwitcherItem {
  label: string;
  // Short chip text shown where core rows show their group ("tab", "file",
  // …). Defaults to "ext".
  tag?: string;
  // secondary mirrors core rows' Shift+Enter/Shift+click argument; items
  // without a secondary action can ignore it.
  run: (secondary: boolean) => void;
}

export interface RegisteredQuickSwitcherProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, called per keystroke with the current (non-command-mode)
  // query — answer from provider-owned cached state and self-limit result
  // counts; call the registration handle's refresh() when that cache
  // changes so an open switcher re-queries.
  provideResults(query: string): QuickSwitcherItem[];
}

// The per-terminal context handed to a terminal accessory's component —
// shaped from exactly what the extracted touch-key bar consumed (see
// extensions/touch-keys), no speculative surface.
export interface TerminalAccessoryContext {
  // Whether this terminal is the focused one (accessories usually render
  // only for it).
  focused: boolean;
  // matchMedia("(pointer: coarse) and (hover: none)") — a real phone or
  // tablet, not a touch-screen laptop.
  mobilePointer: boolean;
  // The pane's current foreground command (for when-clause gating).
  command: string;
  // The app's sticky-Ctrl state for this terminal (applied to typed input
  // by TerminalView's own input pipeline) — accessories may display and
  // toggle it.
  stickyCtrl: boolean;
  toggleStickyCtrl(): void;
  // Raw bytes to the pty (mouse-report/keystroke channel).
  sendInput(data: string): void;
  // Local-echo-aware text send (e.g. voice transcripts) — buffers through
  // the echo overlay when local echo is active instead of going straight
  // to the pty.
  sendText(text: string): void;
  // Routes a picked image through the terminal's upload pipeline.
  uploadImage(file: File): void;
  // Multi-image counterpart — uploads all and inserts their paths as one
  // no-submit block (bracketed paste when the pane's program supports it,
  // else space-separated). Use for a multi-select picker or a multi-drop.
  uploadImages(files: File[]): void;
  // Suppresses (or restores) the mobile soft keyboard for this terminal:
  // the engine's hidden input element gets inputmode="none", so it stays
  // focusable — hardware keys and accessory-drawn keyboards keep working —
  // but tapping the terminal no longer summons the OS keyboard. The
  // request is remembered across engine remounts and no-ops on an engine
  // that doesn't implement the seam's setSoftKeyboardSuppressed. Make this
  // opt-in via your own setting: while suppressed, YOUR accessory is the
  // only on-screen text input (no OS autocomplete/dictation/IME).
  setSoftKeyboardSuppressed(suppressed: boolean): void;
  // Positioning container for "overlay" accessories (the terminal body).
  containerRef: ReactNS.RefObject<HTMLDivElement | null>;
}

export interface TerminalAccessoryHostProps {
  context: TerminalAccessoryContext;
}

// "bar": rendered after the terminal body, in document flow (the docked
// touch-key bar's slot). "overlay": rendered inside the terminal body's
// positioning context (the floating touch keys' slot).
export type TerminalAccessoryPlacement = "bar" | "overlay";

export interface RegisteredTerminalAccessory {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  placement: TerminalAccessoryPlacement;
  component: ReactNS.ComponentType<TerminalAccessoryHostProps>;
}

// The context handed to an app-global overlay (registerAppOverlay) — kept
// minimal, sized to what a bottom swipe/gesture strip needs. No per-terminal
// "focused" here: the overlay is drawn once over the editor area regardless
// of which tab is active.
export interface AppOverlayContext {
  // matchMedia("(pointer: coarse) and (hover: none)") — a real phone or
  // tablet, not a touch-screen laptop.
  mobilePointer: boolean;
  // The overlay layer element (a bottom-anchored positioning context inside
  // .main) — for an overlay that clamps/positions against the editor bounds.
  containerRef: ReactNS.RefObject<HTMLDivElement | null>;
}

export interface AppOverlayHostProps {
  context: AppOverlayContext;
}

export interface RegisteredAppOverlay {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  component: ReactNS.ComponentType<AppOverlayHostProps>;
}

// A custom component rendered inside the extension's own Settings section,
// below its scalar configuration controls — for config that outgrows the
// scalar property renderer (the touch-keys drag-and-drop layout editor).
// Reads/writes its values through ctx.settings (get/set/onDidChange).
export interface RegisteredSettingsComponent {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  component: ReactNS.ComponentType;
}

// A terminal engine implementation supplied by an extension — the app's
// rendering surface itself. Activated lazily, on demand, by
// engines/index.ts's loadEngine() — not part of loadExtensions()'s blanket
// activation sweep (see its comment). The xterm-engine extension is a
// *required builtin* (see the server's tmuxServer.required handling), so
// loadEngine's fallback path always has one to activate even if the
// resolved/selected engine is unavailable.
export interface RegisteredTerminalEngine {
  // Namespaced ext.<extensionId>.<id> — what the terminalEngine setting
  // stores.
  id: string;
  extensionId: string;
  // Human label for the Settings engine select.
  label: string;
  create: CreateTerminalEngine;
}

export const extensionCommands: RegisteredCommand[] = [];
export const extensionFileViewers: RegisteredFileViewer[] = [];
export const extensionSidebarPanels: RegisteredSidebarPanel[] = [];
export const extensionWindowActions: RegisteredWindowAction[] = [];
export const extensionFileDecorationProviders: RegisteredFileDecorationProvider[] = [];
export const extensionSessionDecorationProviders: RegisteredSessionDecorationProvider[] = [];
export const extensionTerminalEngines: RegisteredTerminalEngine[] = [];
export const extensionQuickSwitcherProviders: RegisteredQuickSwitcherProvider[] = [];
export const extensionTerminalAccessories: RegisteredTerminalAccessory[] = [];
export const extensionAppOverlays: RegisteredAppOverlay[] = [];
export const extensionSettingsComponents: RegisteredSettingsComponent[] = [];

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

// Re-render nudge for components that query the registries imperatively per
// render (FileTree/SessionList reading decoration providers) rather than
// consuming useExtensionRegistry's snapshot arrays — the returned tick is
// only ever used as a dependency/render trigger. Also bumped by providers'
// refresh() handles when their cached data (not the registry itself) changes.
export function useExtensionRegistryVersion(): number {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionRegistry(() => setTick((t) => t + 1)), []);
  return tick;
}

// First provider with an answer wins — decorations don't merge. With one
// bundled provider (git-scm) that's exact; if two ever collide, registration
// order (builtin-last override semantics don't apply here) decides.
export function getFileDecoration(path: string, isDir: boolean): FileDecoration | undefined {
  for (const p of extensionFileDecorationProviders) {
    const d = p.provideDecoration(path, isDir);
    if (d) return d;
  }
  return undefined;
}

export function getRootDecorations(rootPath: string): RootDecoration[] {
  const out: RootDecoration[] = [];
  for (const p of extensionFileDecorationProviders) {
    const d = p.provideRootDecoration?.(rootPath);
    if (d) out.push(d);
  }
  return out;
}

// Extension quick-switcher results for a query, in registration order — a
// provider that throws contributes nothing rather than breaking the list.
export function getQuickSwitcherResults(
  query: string,
): { provider: RegisteredQuickSwitcherProvider; item: QuickSwitcherItem }[] {
  const out: { provider: RegisteredQuickSwitcherProvider; item: QuickSwitcherItem }[] = [];
  for (const p of extensionQuickSwitcherProviders) {
    try {
      for (const item of p.provideResults(query)) out.push({ provider: p, item });
    } catch (err) {
      console.error(`quick-switcher provider ${p.id} threw:`, err);
    }
  }
  return out;
}

// All providers' badges, in registration order — a window row can carry
// several (unlike file decorations, where one row = one status).
export function getWindowDecorations(
  ctx: SessionDecorationContext,
): { provider: RegisteredSessionDecorationProvider; decoration: SessionDecoration }[] {
  const out: { provider: RegisteredSessionDecorationProvider; decoration: SessionDecoration }[] = [];
  for (const p of extensionSessionDecorationProviders) {
    const d = p.provideWindowDecoration(ctx);
    if (d) out.push({ provider: p, decoration: d });
  }
  return out;
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
  windowActions: RegisteredWindowAction[];
  appOverlays: RegisteredAppOverlay[];
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
      windowActions: [...extensionWindowActions],
      appOverlays: [...extensionAppOverlays],
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

// Wired from App.tsx to the same globalHandlers + extension-command map the
// keyboard dispatcher (useGlobalKeybindings) runs — backs
// ExtensionContext.app.executeCommand/getCommands. Nulled on unmount.
let executeCommandHandler: ((commandId: string) => void) | null = null;
let getCommandsHandler: (() => { id: string; label: string }[]) | null = null;

export function setExecuteCommandHandler(handler: ((commandId: string) => void) | null): void {
  executeCommandHandler = handler;
}

export function setGetCommandsHandler(handler: (() => { id: string; label: string }[]) | null): void {
  getCommandsHandler = handler;
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

interface SessionsFocusBridge {
  // Expands the SESSIONS accordion panel if collapsed, then moves keyboard
  // focus to its focused-or-first row.
  focus(): void;
}

let sessionsFocusBridge: SessionsFocusBridge | null = null;

// Wired once from Sidebar.tsx — lets sidebar.focusSessions below (App.tsx's
// globalHandlers) reach into the accordion panel it doesn't otherwise know
// about, same bridge pattern as setSidebarTabsBridge above.
export function setSessionsFocusBridge(bridge: SessionsFocusBridge | null): void {
  sessionsFocusBridge = bridge;
}

// Same literal-id-not-import approach as SEARCH_PANEL_ID above — Sidebar.tsx
// already imports from this module, so importing its EXPLORER_TAB_ID export
// back would be circular.
const EXPLORER_TAB_ID = "explorer";

// Drives the "Sidebar: Focus Sessions" command: reveal the sidebar and
// switch to the Explorer tab if needed (reusing focusSidebarTab's own
// reveal/switch logic, but never its toggle-hide branch — this command
// always ends by focusing a row, not hiding the sidebar), then hand off to
// the SESSIONS panel itself.
export function focusSessionsPanel(): void {
  if (!sidebarVisibility) return;
  if (!sidebarVisibility.isVisible()) {
    sidebarVisibility.setVisible(true);
    selectSidebarTab(EXPLORER_TAB_ID);
  } else if (sidebarTabsBridge?.getActive() !== EXPLORER_TAB_ID) {
    selectSidebarTab(EXPLORER_TAB_ID);
  }
  sessionsFocusBridge?.focus();
}

interface ExplorerPanelFocusBridge {
  // Expands the given accordion section if collapsed, then moves keyboard
  // focus into its content — the generic counterpart of the SESSIONS
  // bridge above, for extension panels registered with location "explorer".
  focus(panelId: string): void;
}

let explorerPanelFocusBridge: ExplorerPanelFocusBridge | null = null;

// Wired once from Sidebar.tsx — same bridge pattern as
// setSessionsFocusBridge above.
export function setExplorerPanelFocusBridge(bridge: ExplorerPanelFocusBridge | null): void {
  explorerPanelFocusBridge = bridge;
}

// Drives every explorer-located extension panel's "Sidebar: Focus <title>"
// command — see focusSessionsPanel's doc comment for the reveal/switch
// logic this mirrors.
export function focusExplorerPanel(panelId: string): void {
  if (!sidebarVisibility) return;
  if (!sidebarVisibility.isVisible()) {
    sidebarVisibility.setVisible(true);
    selectSidebarTab(EXPLORER_TAB_ID);
  } else if (sidebarTabsBridge?.getActive() !== EXPLORER_TAB_ID) {
    selectSidebarTab(EXPLORER_TAB_ID);
  }
  explorerPanelFocusBridge?.focus(panelId);
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

// Wired once from App.tsx to the server-synced extension-settings store's
// updater — backs ctx.settings.set.
let extensionSettingUpdater: ((extId: string, key: string, value: unknown) => void) | null = null;

export function setExtensionSettingUpdater(
  handler: ((extId: string, key: string, value: unknown) => void) | null,
): void {
  extensionSettingUpdater = handler;
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
      const location = panel.location ?? "tab";
      extensionSidebarPanels.push({
        id: namespacedId,
        title: panel.title,
        icon: panel.icon,
        location,
        defaultCollapsed: panel.defaultCollapsed,
        component: panel.component,
      });
      // Tab panels: opt-in only — most don't warrant a dedicated shortcut
      // cluttering the palette/keybinding list. Explorer sections: always
      // registered (unbound when no focusBinding), matching the built-in
      // SESSIONS/FILES sections' always-present focus commands.
      if (panel.focusBinding || location === "explorer") {
        extensionCommands.push({
          id: `${namespacedId}.focus`,
          label: `Sidebar: Focus ${panel.title}`,
          defaultBinding: panel.focusBinding,
          run: () =>
            location === "explorer" ? focusExplorerPanel(namespacedId) : focusSidebarTab(namespacedId),
        });
      }
      notify();
    },
    registerWindowAction(action) {
      extensionWindowActions.push({
        id: `ext.${ext.id}.${action.id}`,
        extensionId: ext.id,
        icon: action.icon,
        title: action.title,
        isVisible: action.isVisible,
        onClick: action.onClick,
        showInTabBar: action.showInTabBar ?? false,
      });
      notify();
    },
    registerFileDecorationProvider(provider) {
      extensionFileDecorationProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideDecoration: provider.provideDecoration,
        provideRootDecoration: provider.provideRootDecoration,
      });
      notify();
      // refresh() is the provider's "my cached answers changed" nudge —
      // same notify the registries use, so every subscribed consumer
      // re-queries. Cheap enough at this scale to not need per-provider
      // listener granularity.
      return { refresh: notify };
    },
    registerSessionDecorationProvider(provider) {
      extensionSessionDecorationProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideWindowDecoration: provider.provideWindowDecoration,
        onClick: provider.onClick,
      });
      notify();
      return { refresh: notify };
    },
    registerTerminalEngine(engine) {
      extensionTerminalEngines.push({
        id: `ext.${ext.id}.${engine.id}`,
        extensionId: ext.id,
        label: engine.label,
        create: engine.create,
      });
      notify();
    },
    registerQuickSwitcherProvider(provider) {
      extensionQuickSwitcherProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideResults: provider.provideResults,
      });
      notify();
      return { refresh: notify };
    },
    registerTerminalAccessory(accessory) {
      extensionTerminalAccessories.push({
        id: `ext.${ext.id}.${accessory.id}`,
        extensionId: ext.id,
        placement: accessory.placement,
        component: accessory.component,
      });
      notify();
    },
    registerAppOverlay(overlay) {
      extensionAppOverlays.push({
        id: `ext.${ext.id}.${overlay.id}`,
        extensionId: ext.id,
        component: overlay.component,
      });
      notify();
    },
    registerSettingsComponent(component) {
      extensionSettingsComponents.push({
        id: `ext.${ext.id}.${component.id}`,
        extensionId: ext.id,
        component: component.component,
      });
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
      getFileIcon: (fileName) => getFileIconResult(fileName),
      getFolderIcon: (folderName, expanded) => getFolderIconResult(folderName, expanded),
      onDidChangeIconTheme(cb) {
        // subscribeIconTheme's own listeners Set is private to iconThemes.ts
        // (unlike contextListeners below, which this module owns directly),
        // so runtime tracks the *unsubscribe* closure it returns rather than
        // the raw callback — that's the only handle deactivate has to stop
        // it from firing into a torn-down extension.
        const unsubscribe = subscribeIconTheme(cb);
        runtime.iconThemeListeners.add(unsubscribe);
        return () => {
          runtime.iconThemeListeners.delete(unsubscribe);
          unsubscribe();
        };
      },
      executeCommand: (commandId) => executeCommandHandler?.(commandId),
      getCommands: () => getCommandsHandler?.() ?? [],
    },
    serverFetch(path, init) {
      return fetch(`${extensionApiBase(ext.id)}${path}`, init);
    },
    settings: {
      get(key) {
        return resolvedExtensionSettings[ext.id]?.[key];
      },
      set(key, value) {
        extensionSettingUpdater?.(ext.id, key, value);
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
  // Unsubscribe closures returned by subscribeIconTheme for this extension's
  // onDidChangeIconTheme callbacks — see makeContext's app.onDidChangeIconTheme.
  iconThemeListeners: Set<() => void>;
}

const activatedIds = new Set<string>();
const extensionRuntimes = new Map<string, ExtensionRuntime>();
// One shared promise per in-flight activation, so concurrent callers (every
// TerminalView mounting in the same tick calls loadEngine → here) all await
// the same import instead of the late ones returning before the engine has
// registered — which used to leave loadEngine's registry lookup empty and
// surface as "Terminal engine unavailable" on first load.
const pendingActivations = new Map<string, Promise<void>>();

async function activateClientExtension(ext: ExtensionInfo): Promise<void> {
  if (activatedIds.has(ext.id) || !ext.clientEntry) return;
  const inFlight = pendingActivations.get(ext.id);
  if (inFlight) return inFlight;
  const url = extensionFileUrl(ext.id, ext.clientEntry);
  const promise = (async () => {
    let mod: unknown;
    try {
      // Vite must not try to statically analyze/pre-bundle this — the path is
      // only known at runtime, from the server's extension list.
      mod = await import(/* @vite-ignore */ url);
    } catch (err) {
      // Deliberately NOT latched into activatedIds: an import failure here is
      // typically transient (server restarting mid-request, network hiccup),
      // and latching it used to disable the extension — including the
      // required xterm engine — for the whole page session. Leaving it
      // unlatched lets the next activateExtensionById retry the import.
      console.error(`extension ${ext.id}: failed to load client entry:`, err);
      return;
    }
    // Latched only once the module is actually in hand — from here on,
    // failures are deterministic (bad export, activate() bug), so a retry
    // could only duplicate registrations.
    activatedIds.add(ext.id);
    const runtime: ExtensionRuntime = { module: mod, contextListeners: new Set(), iconThemeListeners: new Set() };
    extensionRuntimes.set(ext.id, runtime);
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${ext.id}: client entry has no activate() export`);
      return;
    }
    try {
      (activate as (ctx: ExtensionContext) => void)(makeContext(ext, runtime));
    } catch (err) {
      console.error(`extension ${ext.id}: activate() threw:`, err);
    }
  })().finally(() => pendingActivations.delete(ext.id));
  pendingActivations.set(ext.id, promise);
  return promise;
}

// Reverses activateClientExtension: calls the module's optional deactivate()
// export (e.g. to remove an injected stylesheet), removes this extension's
// entries from the command/file-viewer/sidebar-panel registries, unsubscribes
// its onDidChangeContext, onDidChangeIconTheme, and settings.onDidChange
// callbacks, and clears activatedIds so a later re-enable calls activate()
// again instead of silently no-oping against the stale guard.
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
  for (let i = extensionWindowActions.length - 1; i >= 0; i--) {
    if (extensionWindowActions[i].extensionId === extId) extensionWindowActions.splice(i, 1);
  }
  for (let i = extensionFileDecorationProviders.length - 1; i >= 0; i--) {
    if (extensionFileDecorationProviders[i].extensionId === extId) extensionFileDecorationProviders.splice(i, 1);
  }
  for (let i = extensionSessionDecorationProviders.length - 1; i >= 0; i--) {
    if (extensionSessionDecorationProviders[i].extensionId === extId) extensionSessionDecorationProviders.splice(i, 1);
  }
  for (let i = extensionTerminalEngines.length - 1; i >= 0; i--) {
    if (extensionTerminalEngines[i].extensionId === extId) extensionTerminalEngines.splice(i, 1);
  }
  for (let i = extensionQuickSwitcherProviders.length - 1; i >= 0; i--) {
    if (extensionQuickSwitcherProviders[i].extensionId === extId) extensionQuickSwitcherProviders.splice(i, 1);
  }
  for (let i = extensionTerminalAccessories.length - 1; i >= 0; i--) {
    if (extensionTerminalAccessories[i].extensionId === extId) extensionTerminalAccessories.splice(i, 1);
  }
  for (let i = extensionAppOverlays.length - 1; i >= 0; i--) {
    if (extensionAppOverlays[i].extensionId === extId) extensionAppOverlays.splice(i, 1);
  }
  for (let i = extensionSettingsComponents.length - 1; i >= 0; i--) {
    if (extensionSettingsComponents[i].extensionId === extId) extensionSettingsComponents.splice(i, 1);
  }
  if (runtime) for (const cb of runtime.contextListeners) contextListeners.delete(cb);
  if (runtime) for (const unsubscribe of runtime.iconThemeListeners) unsubscribe();
  extensionSettingsListeners.delete(extId);
  extensionRuntimes.delete(extId);
  activatedIds.delete(extId);
  notify();
}

// Fetches the list once and activates every enabled extension's client
// entry EXCEPT terminal engines (filtered out below) — a terminal engine's
// code is only ever activated on demand, by engines/index.ts's loadEngine(),
// for whichever ONE engine a session actually resolves to. Eagerly
// activating every bundled engine here regardless of selection used to mean
// every boot downloaded and ran all of them, and terminal rendering waited
// on this entire Promise.all (every other extension too, not just its own
// engine) rather than just its own engine's fetch. Themes/icon themes need
// no activation step at all — see the module comment — so this only
// concerns commands/viewers/panels/engines. onListLoaded, if given, fires
// right after the list is known but before any client entry activates —
// App.tsx uses this to push extension-settings overrides into this module's
// store first, so ctx.settings.get() already resolves correctly the very
// first time an activating extension reads it.
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
  settleExtensionsListed();
  onListLoaded?.(list);
  await Promise.all(
    list
      .filter((ext) => ext.enabled && ext.hasClient && ext.terminalEngines.length === 0)
      .map((ext) => activateClientExtension(ext)),
  );
  return list;
}

// Activates exactly one extension's client entry on demand — used by
// engines/index.ts's loadEngine() to fetch/run only the terminal engine a
// session actually needs, instead of loadExtensions()'s blanket sweep above
// (which now deliberately skips every terminal-engine extension). A no-op
// for an id that isn't installed, already active, or has no client — same
// guards activateClientExtension already applies internally.
export async function activateExtensionById(id: string): Promise<void> {
  const ext = installedExtensions.find((e) => e.id === id);
  if (ext) await activateClientExtension(ext);
}

// Resolved as soon as the extension LIST is known (before any activation) —
// engines/index.ts's loadEngine() waits on this alone, so opening a terminal
// never blocks on unrelated extensions (previews, git-scm, search, …)
// finishing activation.
let settleExtensionsListed: () => void = () => {};
const extensionsListed = new Promise<void>((resolve) => {
  settleExtensionsListed = resolve;
});

export function whenExtensionsListed(): Promise<void> {
  return extensionsListed;
}
