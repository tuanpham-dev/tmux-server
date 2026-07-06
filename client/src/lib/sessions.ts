import type { PinnedSession, TmuxSession } from "../types";

// One row for the sessions-mode sidebar tree: either a live tmux session
// (optionally pinned) or a "dead" pin — a pinned session with no matching
// live tmux session, kept around so the user can restore it. Matched by
// name only; tmux's own session id doesn't survive a kill/recreate cycle,
// so name is the only key a pin can be restored against.
export type SessionRow =
  | { dead: false; session: TmuxSession; pinned: boolean }
  | { dead: true; name: string; cwd: string };

// Live sessions first (in their given order, each flagged pinned if a pin
// matches its name), then a dead row for every pin with no live match, in
// the pins' own order. Dirs mode has no equivalent — a dead pin has no
// windows to group by cwd — so this is sessions-mode only.
export function sessionRowsWithPins(sessions: TmuxSession[], pins: PinnedSession[]): SessionRow[] {
  const liveNames = new Set(sessions.map((s) => s.name));
  const rows: SessionRow[] = sessions.map((session) => ({
    dead: false,
    session,
    pinned: pins.some((p) => p.name === session.name),
  }));
  for (const pin of pins) {
    if (!liveNames.has(pin.name)) rows.push({ dead: true, name: pin.name, cwd: pin.cwd });
  }
  return rows;
}
