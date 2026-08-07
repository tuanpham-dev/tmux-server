import type { Project, TmuxSession } from "../types";

// A project's display name is always derived from its folder — never stored,
// so renaming the folder is renaming the project. Works on the `~`-shortened
// paths the server hands out ("~/works/app" → "app"; "~" → "~").
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || trimmed || "/";
}

// tmux session names may not contain "." or ":" (tmux rejects/mangles them);
// the folder basename is otherwise used as-is, suffixed -2, -3… when a live
// session already holds the name (two projects sharing a basename). The name
// is purely cosmetic — project↔session matching is by path, never name.
export function sessionNameForProject(cwd: string, existingSessionNames: Iterable<string>): string {
  const base = projectName(cwd).replace(/[.:]/g, "-");
  const taken = new Set(existingSessionNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// How many unpinned entries the recents list keeps — pinned entries never
// count against (or get evicted by) the cap.
const RECENTS_CAP = 15;

// Records a project open: upserts the entry (preserving its pinned flag),
// stamps lastOpened, and evicts the oldest unpinned entries beyond the cap.
export function bumpRecent(projects: Project[], cwd: string): Project[] {
  const existing = projects.find((p) => p.cwd === cwd);
  const next: Project[] = [
    { cwd, pinned: existing?.pinned ?? false, lastOpened: Date.now() },
    ...projects.filter((p) => p.cwd !== cwd),
  ];
  let unpinned = 0;
  return next
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .filter((p) => p.pinned || ++unpinned <= RECENTS_CAP);
}

// One row of the PROJECTS panel: a live project — its primary tmux session
// plus any further sessions rooted in the same folder, merged so one folder
// never shows two look-alike rows (flagged pinned when a pinned project's
// folder matches) — or a dead pinned project, kept visible so one click
// restores its session in exactly that folder. Unpinned projects never
// produce rows — they live only in the recents dropdown.
export type ProjectRow =
  | { dead: false; session: TmuxSession; extraSessions: TmuxSession[]; pinned: boolean }
  | { dead: true; cwd: string };

// Live projects first (tmux order of their primary session — every live
// session shows, registered or not; same-path sessions merge, first one
// primary; pathless sessions never merge), then a dead row for each pinned
// project whose folder no live session is rooted in, MRU-first. Matching is
// by session_path, so an out-of-band `tmux rename-session` can't orphan a
// pin.
export function projectRows(sessions: TmuxSession[], projects: Project[]): ProjectRow[] {
  const pinnedCwds = new Set(projects.filter((p) => p.pinned).map((p) => p.cwd));
  const rows: ProjectRow[] = [];
  const byPath = new Map<string, Extract<ProjectRow, { dead: false }>>();
  for (const session of sessions) {
    const primary = session.path ? byPath.get(session.path) : undefined;
    if (primary) {
      primary.extraSessions.push(session);
      continue;
    }
    const row: Extract<ProjectRow, { dead: false }> = {
      dead: false,
      session,
      extraSessions: [],
      pinned: pinnedCwds.has(session.path),
    };
    if (session.path) byPath.set(session.path, row);
    rows.push(row);
  }
  const livePaths = new Set(sessions.map((s) => s.path));
  for (const p of [...projects].sort((a, b) => b.lastOpened - a.lastOpened)) {
    if (p.pinned && !livePaths.has(p.cwd)) rows.push({ dead: true, cwd: p.cwd });
  }
  return rows;
}
