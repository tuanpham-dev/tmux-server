export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
}

export interface TmuxSession {
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
