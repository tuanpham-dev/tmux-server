import {
  isWindowTabSession,
  listClients,
  listGroupWindowIds,
  listSessionCurrentWindows,
  selectWindowById,
  switchClient,
  type SessionCurrentWindow,
  type TmuxClient,
} from "./tmux.js";

// One shared poller for every live attach, replacing the old per-window-tab
// pin watcher: each tick is two tmux calls total (list-clients +
// list-sessions) no matter how many tabs are open. It watches for tmux-native
// navigation the client UI can't see happening:
//
//  - a window tab's synthetic session getting select-window'd away from its
//    pin (status-bar click, choose-window, prefix+n/p) — reverted, and the
//    client is told which window the user picked so it can surface that
//    window's own tab;
//  - the pinned window disappearing entirely (tmux falls back to an adjacent
//    window) — the tab must close, same as the old watcher;
//  - the attached client being switch-client'ed to another session
//    (choose-tree, prefix+s) — reverted, and the client is told which
//    session (and window) the user picked.
//
// Everything is keyed on stable tmux ids ($n sessions, @n windows), so
// renames and window renumbering can't confuse the comparisons or the revert
// targets.
const TICK_MS = 200;

// Once a tick notices a deviation, the entry is re-read at this faster
// cadence until two consecutive reads agree, then acted on — a single
// status-bar click resolves in ~SETTLE_MS, while a rapid burst (holding
// prefix+n) still collapses into one action for wherever the user landed.
const SETTLE_MS = 100;

// A burst that never pauses still gets acted on after this many rounds
// rather than deferring forever.
const MAX_SETTLE_ROUNDS = 20;

export interface AttachCallbacks {
  // The pinned window is gone (shell exit, kill-window from elsewhere); tmux
  // already fell back to an adjacent window, so the tab must close.
  onPinnedGone: () => void;
  // A deliberate window switch inside a window tab; the synthetic session
  // has already been reverted to its pin.
  onWindowSwitched: (windowIndex: number) => void;
  // A deliberate cross-session switch; the client has already been switched
  // back. `session` is the target's name (tabs are keyed by name),
  // `windowIndex` its current window — for a choose-tree window pick, the
  // exact window picked, since switch-client selects it before switching.
  onSessionSwitched: (session: string, windowIndex: number) => void;
  // The pinned (or, for a whole-session tab, current) window's foreground
  // command changed — e.g. a shell exec'd into nvim, or nvim quit back to
  // the shell. Rides the same 200ms tick as the deviation checks below, so
  // the client's touch-key "when" filter (see touchKeys.ts) reacts without
  // a dedicated poll.
  onCommandChanged: (command: string) => void;
}

interface Entry {
  clientPid: number;
  sessionId: string;
  // null for a whole-session tab (no pin to enforce).
  pinnedWindowId: string | null;
  callbacks: AttachCallbacks;
  // A settle/revert cycle for this entry is still in flight; skip it in the
  // regular tick until done.
  busy: boolean;
  // Last foreground command reported to this entry's callback — null until
  // the first tick, so that tick always fires onCommandChanged once even if
  // the initial value happens to be "".
  lastCommand: string | null;
}

const entries = new Set<Entry>();
let timer: NodeJS.Timeout | null = null;

export function registerAttach(
  clientPid: number,
  sessionId: string,
  pinnedWindowId: string | null,
  callbacks: AttachCallbacks,
): () => void {
  const entry: Entry = {
    clientPid,
    sessionId,
    pinnedWindowId,
    callbacks,
    busy: false,
    lastCommand: null,
  };
  entries.add(entry);
  if (!timer) timer = setInterval(tick, TICK_MS);
  return () => {
    entries.delete(entry);
    if (entries.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// Guards against ticks overlapping when tmux responds slower than TICK_MS.
let tickBusy = false;

async function tick(): Promise<void> {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const [clients, currentWindows] = await Promise.all([
      listClients(),
      listSessionCurrentWindows(),
    ]);
    const clientByPid = new Map(clients.map((c) => [c.pid, c]));
    // Copy: revert completions and unregisters mutate the set mid-iteration.
    for (const entry of [...entries]) {
      if (!entry.busy) checkEntry(entry, clientByPid, currentWindows);
    }
  } catch {
    // tmux hiccup (server briefly gone, etc.) — try again next tick.
  } finally {
    tickBusy = false;
  }
}

function checkEntry(
  entry: Entry,
  clientByPid: Map<number, TmuxClient>,
  currentWindows: Map<string, SessionCurrentWindow>,
): void {
  const client = clientByPid.get(entry.clientPid);
  const curw = currentWindows.get(entry.sessionId);
  const crossSession = client !== undefined && client.sessionId !== entry.sessionId;
  const windowMoved =
    entry.pinnedWindowId !== null &&
    curw !== undefined &&
    curw.windowId !== entry.pinnedWindowId;
  // Command tracking: only trust curw's command when it's actually the
  // window this attach is showing right now (no pending cross-session or pin
  // deviation) — mid-deviation, curw briefly reflects wherever tmux
  // navigated to, not what's still on screen until the revert lands.
  if (!crossSession && !windowMoved && curw !== undefined && curw.command !== entry.lastCommand) {
    entry.lastCommand = curw.command;
    entry.callbacks.onCommandChanged(curw.command);
  }
  // Nothing deviated (or the session itself is gone, which term.onExit
  // handles) — nothing to do.
  if (!crossSession && !windowMoved) return;
  entry.busy = true;
  void settleAndAct(entry, client?.sessionId ?? null, curw?.windowId ?? null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-reads the entry's state every SETTLE_MS until two consecutive reads
// agree, then reverts the deviation and notifies. Seeded with the values the
// detecting tick saw, so a single quick switch settles after one round.
async function settleAndAct(
  entry: Entry,
  seenClientSession: string | null,
  seenWindowId: string | null,
): Promise<void> {
  try {
    let prevClientSession = seenClientSession;
    let prevWindowId = seenWindowId;
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      await sleep(SETTLE_MS);
      const [clients, currentWindows] = await Promise.all([
        listClients(),
        listSessionCurrentWindows(),
      ]);
      // Tab closed while settling — don't revert a dead attach.
      if (!entries.has(entry)) return;
      const client = clients.find((c) => c.pid === entry.clientPid);
      const curw = currentWindows.get(entry.sessionId);
      const clientSession = client?.sessionId ?? null;
      const windowId = curw?.windowId ?? null;
      const settled =
        (clientSession === prevClientSession && windowId === prevWindowId) ||
        round === MAX_SETTLE_ROUNDS - 1;
      prevClientSession = clientSession;
      prevWindowId = windowId;
      if (!settled) continue;

      // Cross-session first: it applies to every tab, and while the client
      // is off in another session the window-pin state is meaningless.
      if (client && client.sessionId !== entry.sessionId) {
        const target = currentWindows.get(client.sessionId);
        await switchClient(client.tty, entry.sessionId);
        // Synthetic window-tab sessions show up in tmux's own choosers too;
        // a pick of one is reverted but not surfaced — mapping it back to a
        // meaningful tab isn't worth the plumbing.
        if (target && !isWindowTabSession(target.name)) {
          entry.callbacks.onSessionSwitched(target.name, target.windowIndex);
        }
        return;
      }
      if (
        entry.pinnedWindowId !== null &&
        curw !== undefined &&
        curw.windowId !== entry.pinnedWindowId
      ) {
        const ids = await listGroupWindowIds(entry.sessionId);
        if (!ids.includes(entry.pinnedWindowId)) {
          entry.callbacks.onPinnedGone();
          return;
        }
        await selectWindowById(entry.sessionId, entry.pinnedWindowId);
        entry.callbacks.onWindowSwitched(curw.windowIndex);
      }
      // Deviation resolved itself (or was only transient) — done either way.
      return;
    }
  } catch {
    // tmux hiccup — the regular tick notices again if still deviated.
  } finally {
    entry.busy = false;
  }
}
