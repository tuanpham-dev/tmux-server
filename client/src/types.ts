export interface TmuxWindow {
  // Stable tmux id ("@12") — survives renumbering.
  id: string;
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
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

export interface Tab {
  id: string;
  sessionName: string;
  // What's actually passed to tmux attach-session / the WS ?session= param.
  // Equal to sessionName for a whole-session tab; a synthetic grouped
  // session name for a window-tab.
  attachName: string;
  // Present only for a window-tab — the specific window it's pinned to.
  windowIndex?: number;
  // Stable tmux ids for the tab's session/window, used to re-target
  // sessionName/windowIndex after an out-of-band rename or renumber
  // (see App.tsx's reconcileTabIds). Absent for tabs restored from
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
  // Marks an extension-registered file-viewer tab — the current virtual-tab
  // kind for every built-in and third-party preview. extViewerId identifies
  // which registered viewer (extensions.ts) renders extViewerPath; a
  // newly-created tab always has exactly one of settingsView/extViewerPath
  // set (imagePath/previewPath only appear pre-migration — see above).
  extViewerId?: string;
  extViewerPath?: string;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
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

export interface ExtensionInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  enabled: boolean;
  themes: ExtensionThemeContribution[];
  iconThemes: ExtensionIconThemeContribution[];
  fonts: ExtensionFontGroupContribution[];
  clientEntry: string | null;
  hasClient: boolean;
  hasServer: boolean;
  // Shipped from the repo's extensions/ dir rather than user-installed.
  builtin: boolean;
}
