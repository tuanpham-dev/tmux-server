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

// Reorders `tabs` so every group's members sit contiguously, anchored at the
// position of the group's first-encountered tab, with every ungrouped
// ("singleton") tab — settings, or a preview tab whose origin session went
// away — pushed after every group, in their own original relative order.
// Returns the same array reference when the order is already normalized, so
// callers can safely bail a setState on it.
export function normalizeTabGroups(tabs: Tab[]): Tab[] {
  const groups = new Map<string, Tab[]>();
  const ungrouped: Tab[] = [];
  for (const tab of tabs) {
    const key = groupKeyForTab(tab);
    if (key === null) {
      ungrouped.push(tab);
      continue;
    }
    const members = groups.get(key);
    if (members) members.push(tab);
    else groups.set(key, [tab]);
  }
  const consumed = new Set<string>();
  const next: Tab[] = [];
  for (const tab of tabs) {
    const key = groupKeyForTab(tab);
    if (key === null || consumed.has(key)) continue;
    consumed.add(key);
    next.push(...groups.get(key)!);
  }
  next.push(...ungrouped);
  const changed = next.some((t, i) => t.id !== tabs[i]?.id);
  return changed ? next : tabs;
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
