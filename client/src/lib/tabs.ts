import type { Tab, TabGroupState, TmuxSession } from "../types";

// A "virtual" tab (image viewer, markdown preview, settings, …) has no tmux
// session behind it — sessionName/attachName are "". Centralized here so a
// future virtual-tab kind only needs to extend this one place, not every
// imagePath-only check that predates it.
export function isRealTab(tab: Tab): boolean {
  return (
    tab.imagePath === undefined &&
    tab.previewPath === undefined &&
    tab.settingsView === undefined &&
    tab.extViewerPath === undefined
  );
}

export function tabVirtualPath(tab: Tab): string | undefined {
  return tab.imagePath ?? tab.previewPath ?? tab.extViewerPath;
}

// Chrome-style tab groups (plans/tab-groups-by-session.md): a real tab's
// group is simply its session. A viewer tab (image/markdown/etc.) joins the
// group of the real session it was opened from (originSessionName, cleared
// once that session no longer exists — see the effect in App() that strips
// it). The settings tab is never grouped — it's a global singleton, not
// tied to any one session.
export function groupKeyForTab(tab: Tab): string | null {
  if (isRealTab(tab)) return tab.sessionName;
  return tab.originSessionName ?? null;
}

// Every group's tabs as a contiguous block, keyed by group, in first-
// appearance order, plus the trailing ungrouped ("singleton") tabs —
// settings, or a preview tab whose origin session went away. The one
// decomposition normalizeTabGroups, orderedGroupKeys, and moveGroup all
// share, so "what order are the groups in" can't drift across call sites.
function groupBlocks(tabs: Tab[]): { order: string[]; blocks: Map<string, Tab[]>; singletons: Tab[] } {
  const order: string[] = [];
  const blocks = new Map<string, Tab[]>();
  const singletons: Tab[] = [];
  for (const tab of tabs) {
    const key = groupKeyForTab(tab);
    if (key === null) {
      singletons.push(tab);
      continue;
    }
    const members = blocks.get(key);
    if (members) members.push(tab);
    else {
      order.push(key);
      blocks.set(key, [tab]);
    }
  }
  return { order, blocks, singletons };
}

// The distinct group keys among `tabs`, in first-appearance order — the
// same order normalizeTabGroups anchors on and moveGroup reorders.
export function orderedGroupKeys(tabs: Tab[]): string[] {
  return groupBlocks(tabs).order;
}

// Reorders `tabs` so every group's members sit contiguously, anchored at the
// position of the group's first-encountered tab, with every ungrouped
// ("singleton") tab — settings, or a preview tab whose origin session went
// away — pushed after every group, in their own original relative order.
// Returns the same array reference when the order is already normalized, so
// callers can safely bail a setState on it.
export function normalizeTabGroups(tabs: Tab[]): Tab[] {
  const { order, blocks, singletons } = groupBlocks(tabs);
  const next: Tab[] = [];
  for (const key of order) next.push(...blocks.get(key)!);
  next.push(...singletons);
  const changed = next.some((t, i) => t.id !== tabs[i]?.id);
  return changed ? next : tabs;
}

// Moves a whole group's contiguous tab block to a new position relative to
// the other groups — the drag-a-chip / "Move Group Left/Right" operation.
// Mirrors moveTab's remove-then-splice pattern but at group-block
// granularity; singletons always stay trailing every group, untouched.
// Assumes `tabs` is already normalized (groups contiguous) — true whenever
// grouping is enabled, the only time this is callable. Returns the same
// array reference when the move is a no-op (unknown group key, or the
// target position doesn't actually change anything).
export function moveGroup(tabs: Tab[], groupKey: string, toIndex: number): Tab[] {
  const { order, blocks, singletons } = groupBlocks(tabs);
  if (!blocks.has(groupKey)) return tabs;
  const withoutDragged = order.filter((k) => k !== groupKey);
  const clamped = Math.max(0, Math.min(toIndex, withoutDragged.length));
  const nextOrder = [...withoutDragged];
  nextOrder.splice(clamped, 0, groupKey);
  const next: Tab[] = [];
  for (const key of nextOrder) next.push(...blocks.get(key)!);
  next.push(...singletons);
  const changed = next.some((t, i) => t.id !== tabs[i]?.id);
  return changed ? next : tabs;
}

// Moves an id to a new position within a flat string-id array — the sidebar
// tab strip's drag-a-tab reorder. Same remove-then-splice shape as moveGroup,
// but at plain-array granularity (no grouping concept). Returns the same
// array reference when the id is unknown or the move is a no-op.
export function moveId(order: string[], id: string, toIndex: number): string[] {
  if (!order.includes(id)) return order;
  const without = order.filter((x) => x !== id);
  const clamped = Math.max(0, Math.min(toIndex, without.length));
  const next = [...without];
  next.splice(clamped, 0, id);
  return next.some((x, i) => x !== order[i]) ? next : order;
}

// Keeps tabs pointed at the right session/window across an out-of-band
// rename or renumber (another terminal, not this app). Matches by stable
// tmux id first — falls back to name/index only for a tab whose ids haven't
// resolved yet (freshly opened, or restored from localStorage before
// id-keying shipped), which then adopts the id it finds for next time. A
// session/window that's gone entirely is left alone here; the attach's own
// "exit" message (or the window-tab cleanup effect below) closes that tab.
export function reconcileTabs(tabs: Tab[], sessions: TmuxSession[]): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const session = tab.sessionId
      ? sessions.find((s) => s.id === tab.sessionId)
      : sessions.find((s) => s.name === tab.sessionName);
    if (!session) return tab;

    let updated = tab;
    if (updated.sessionId !== session.id || updated.sessionName !== session.name) {
      changed = true;
      updated = {
        ...updated,
        sessionId: session.id,
        sessionName: session.name,
        // attachName tracks the base session's name only for a whole-session
        // tab; a window-tab's attachName is its own synthetic session name
        // and must never follow a rename of the base session.
        attachName: updated.windowIndex === undefined ? session.name : updated.attachName,
      };
    }

    if (updated.windowIndex !== undefined) {
      const win = updated.windowId
        ? session.windows.find((w) => w.id === updated.windowId)
        : session.windows.find((w) => w.index === updated.windowIndex);
      if (win && (updated.windowId !== win.id || updated.windowIndex !== win.index)) {
        changed = true;
        updated = { ...updated, windowId: win.id, windowIndex: win.index };
      }
    }

    return updated;
  });
  return changed ? next : tabs;
}

export function loadStoredTabs(): Tab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabs") ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Tabs stored before per-window tabs shipped won't have attachName —
    // every tab back then was a whole-session tab, where it always equals
    // sessionName.
    return parsed.map((t) => ({ ...t, attachName: t.attachName ?? t.sessionName }));
  } catch {
    return [];
  }
}

// Per-device, not server-synced (like `tabs` itself) — group color/collapse
// state is meaningless without the device's own tab list.
export function loadStoredTabGroupState(): Record<string, TabGroupState> {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabGroupState") ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
