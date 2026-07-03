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
  // Marks an image-viewer tab instead of a tmux terminal tab. sessionName/
  // attachName are "" for these — every tmux-facing code path (reconcile,
  // the vanished-window sweep, dedupe, close) already gates on windowIndex
  // or a real session-name match, so an image tab passes through untouched.
  imagePath?: string;
  // Marks a markdown-preview tab — same "" sessionName/attachName convention
  // and the same tmux-path safety as imagePath above. A tab has at most one
  // of imagePath/previewPath set; see isRealTab/tabVirtualPath in App.tsx.
  previewPath?: string;
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

export interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
}

export interface TunnelAuth {
  cookie: string | null;
  authorization: string | null;
}
