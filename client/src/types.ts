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

export interface FsEntry {
  name: string;
  dir: boolean;
}

export interface FsListing {
  path: string;
  entries: FsEntry[];
}
