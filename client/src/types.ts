export interface TmuxWindow {
  // Stable tmux id ("@12") — survives renumbering.
  id: string;
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
  // The active pane's current foreground command (e.g. "bash", "claude") —
  // see the server-side TmuxWindow's matching field for why this exists.
  command: string;
}

export interface TmuxSession {
  // Stable tmux id ("$3") — survives rename.
  id: string;
  name: string;
  created: number;
  attached: number;
  windows: TmuxWindow[];
}

export type SidebarMode = "sessions" | "dirs";

// A pinned session survives its tmux session being killed: the sidebar keeps
// showing a dead row for it, and recreating a session by this name restores
// it in `cwd` (captured from the active window at pin time). Matched against
// live sessions by name — the only key that survives a kill/recreate cycle,
// since tmux's own session id doesn't.
export interface PinnedSession {
  name: string;
  cwd: string;
}

export interface Tab {
  id: string;
  // The editor group (split pane) this tab belongs to — see lib/splits.ts's
  // SplitNode. Every tab has exactly one; optional only because a tab
  // restored from localStorage before splits shipped won't have one yet —
  // loadStoredTabs stamps it with the tree's sole leaf id on migration.
  groupId?: string;
  sessionName: string;
  // What's actually passed to tmux attach-session / the WS ?session= param.
  // Equal to sessionName for a whole-session tab; a synthetic grouped
  // session name for a window-tab.
  attachName: string;
  // Present only for a window-tab — the specific window it's pinned to.
  windowIndex?: number;
  // Stable tmux ids for the tab's session/window, used to re-target
  // sessionName/windowIndex after an out-of-band rename or renumber
  // (see lib/tabs.ts's reconcileTabs). Absent for tabs restored from
  // localStorage before id-keying shipped, or a fresh open whose ids
  // haven't been resolved from the next poll yet — both self-heal on the
  // next successful id match.
  sessionId?: string;
  windowId?: string;
  // Legacy virtual-tab kinds from before built-in previews became extension-
  // registered viewers (image/media/pdf/markdown/json/yaml/csv all moved to
  // extViewerId/extViewerPath below). Only ever present on a tab restored
  // from localStorage before that migration shipped — App.tsx's one-time
  // migration effect converts these to extViewerId/extViewerPath as soon as
  // the registry populates; never set on a newly created tab.
  imagePath?: string;
  previewPath?: string;
  // Marks the (singleton) settings tab — sessionName/attachName are "" for
  // this and every virtual-tab kind below — every tmux-facing code path
  // (reconcile, the vanished-window sweep, dedupe, close) already gates on
  // windowIndex or a real session-name match, so a virtual tab passes
  // through untouched.
  settingsView?: true;
  // Marks the (singleton) Keyboard Shortcuts editor tab — same virtual-tab
  // conventions as settingsView above (sessionName/attachName "", deduped
  // globally, every tmux-facing code path passes through untouched).
  keyboardView?: true;
  // Marks an extension-registered file-viewer tab — the current virtual-tab
  // kind for every built-in and third-party preview. extViewerId identifies
  // which registered viewer (extensions.ts) renders extViewerPath; a
  // newly-created tab always has exactly one of settingsView/extViewerPath
  // set (imagePath/previewPath only appear pre-migration — see above).
  extViewerId?: string;
  extViewerPath?: string;
  // Optional override for the tab-bar label, set via ctx.app.openViewerTab's
  // `title` option — e.g. git-scm's diff viewer titles its tab
  // "App.tsx (Working Tree)" instead of the bare basename tabLabel derives
  // by default. Absent for every other viewer tab.
  extViewerTitle?: string;
  // Only on a viewer tab (extViewerPath set): the real session it was
  // opened "from" (App.tsx's openExtViewerTab), pinned at creation time so
  // it can join that session's Chrome-style tab group — see groupKeyForTab
  // in lib/tabs.ts. originSessionId mirrors sessionId's rename-survival role;
  // both are cleared once the origin session no longer exists (the viewer
  // tab itself is left open and just ungroups — previews aren't tied to a
  // live tmux process the way window-tabs are). Absent for a settings tab,
  // for a viewer tab opened with no real tab ever active, or one restored
  // from localStorage before this shipped.
  originSessionName?: string;
  originSessionId?: string;
  // Marks an extension detail-page tab — sessionName/attachName are "" like
  // every other virtual-tab kind above. Deduped globally by extensionPageId
  // (one page per extension, like the settings tab), never grouped to a
  // session. extensionPageSource is set only while the subject is a
  // registry-only entry not yet installed (the {source, id} the page/API
  // calls need); cleared once the extension becomes installed, since
  // installed extensions are looked up by id alone.
  extensionPageId?: string;
  extensionPageSource?: string;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
  // Right-aligned keyboard-shortcut hint — a files.* command id (e.g.
  // "files.copy") resolved to its first live binding by ContextMenu via
  // formatBinding, so a Settings rebind updates the hint on the very next
  // render (even in a menu already open when the rebind happens). Display
  // only: it doesn't dispatch the shortcut itself — these are local FileTree
  // handlers dispatched by FileTree's own key handler, not global commands.
  // No hint renders when the command is unbound.
  shortcutCommand?: string;
  // Renders a row of color swatches instead of the normal label/click row —
  // used by a tab-group chip's context menu to pick the group's color.
  // label/onClick are unused placeholders on a swatches item; ContextMenu
  // checks `swatches` first.
  swatches?: {
    colors: { key: string; hex: string }[];
    selected: string;
    onPick: (key: string) => void;
  };
}

// Per-session tab-group UI state (client/src/App.tsx's tabGroupState),
// keyed by sessionName — see App.tsx's rename-migration comment for why
// name, not the stable session id, is the key.
export interface TabGroupState {
  color: string; // a utils/groupColor.ts GROUP_COLORS key
  collapsed: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflicted"
  | "ignored";

export interface FsEntry {
  name: string;
  dir: boolean;
  gitStatus?: GitFileStatus;
}

export interface FsListing {
  path: string;
  entries: FsEntry[];
  branch: string | null;
}

export interface FsFilesListing {
  path: string;
  files: string[];
  truncated: boolean;
}

export interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  session: string;
}

export interface TunnelAuth {
  cookie: string | null;
  authorization: string | null;
}

// First configured PROXY_DOMAIN (see server/src/security.ts), or null when
// unset — the PORTS panel uses this to decide whether a port's URL is
// "<port>.<domain>" or the app-origin "/proxy/<port>/" fallback.
export interface ProxyConfig {
  domain: string | null;
}

export interface ExtensionThemeContribution {
  label: string;
  path: string;
}

export interface ExtensionIconThemeContribution {
  id: string;
  label: string;
  path: string;
}

export interface ExtensionFontSrc {
  path: string;
  format: string;
}

// See server/src/extensions.ts's FontGroupContribution comment — a
// tmux-server-specific manifest field, not a VS Code concept. Entries
// sharing a `family` are different weights/styles of the same font; entries
// with distinct `family` values are separate fonts bundled into one group. A
// group is the Settings font picker's unit of selection — picking it writes
// every family in `fonts` into the stack at once. One extension can
// contribute several groups.
export interface ExtensionFontEntry {
  family: string;
  src: ExtensionFontSrc[];
  weight?: string;
  style?: string;
  // CSS unicode-range descriptor — splits one family/weight/style combo
  // across several entries by script (e.g. IBM Plex Mono's latin/cyrillic/
  // vietnamese subsets), each loaded as its own FontFace.
  unicodeRange?: string;
}

export interface ExtensionFontGroupContribution {
  group: string;
  fonts: ExtensionFontEntry[];
}

// Mirrors server/src/extensions.ts's ExtensionConfigurationProperty — the
// server has already normalized/validated the manifest, so the client just
// renders a control per property. `key` is the full dotted name exactly as
// declared (no shared prefix assumed).
export interface ExtensionConfigurationProperty {
  key: string;
  type: "boolean" | "number" | "integer" | "string";
  default: unknown;
  description: string;
  enum?: string[];
  enumItemLabels?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ExtensionConfigurationSection {
  title?: string;
  properties: ExtensionConfigurationProperty[];
}

// One installable entry from a registry source's index.json — see
// server/src/registry.ts. file/readme/icon relative paths never reach the
// client; it names entries by {source, id} and the server re-resolves them.
export interface RegistryCatalogEntry {
  id: string;
  displayName: string;
  publisher?: string;
  version: string;
  description: string;
  hasReadme: boolean;
  hasIcon: boolean;
}

export interface RegistrySourceResult {
  source: string;
  error?: string;
  entries: RegistryCatalogEntry[];
}

export interface ExtensionInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  // Extension-relative path (VS Code manifest `icon` field), or null —
  // resolved via extensionFileUrl(id, icon), same as clientEntry.
  icon: string | null;
  enabled: boolean;
  themes: ExtensionThemeContribution[];
  iconThemes: ExtensionIconThemeContribution[];
  fonts: ExtensionFontGroupContribution[];
  configuration: ExtensionConfigurationSection[];
  clientEntry: string | null;
  hasClient: boolean;
  hasServer: boolean;
  // Shipped from the repo's extensions/ dir rather than user-installed.
  builtin: boolean;
}
