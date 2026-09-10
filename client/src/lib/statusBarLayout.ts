// Pure model for the status bar's arrangement: which items sit in the left
// group, which in the right, and in what order. No React, no DOM — StatusBar
// turns this into buttons and a drag.
//
// The bar mixes two kinds of item, core readouts (memory, terminals) and
// whatever extensions contribute, and the user can reorder either kind and
// move one between the groups. So the stored value is just ids per group;
// what an item IS stays the renderer's business.

export type StatusBarSide = "left" | "right";

export const STATUS_BAR_SIDES: readonly StatusBarSide[] = ["left", "right"];

export interface StatusBarLayout {
  left: string[];
  right: string[];
}

export const EMPTY_STATUS_BAR_LAYOUT: StatusBarLayout = { left: [], right: [] };

// An item the bar can render right now: its id and the group it belongs to
// until the user says otherwise.
export interface StatusBarSlot {
  id: string;
  defaultSide: StatusBarSide;
}

export function sideOfItem(layout: StatusBarLayout, id: string): StatusBarSide | null {
  if (layout.left.includes(id)) return "left";
  if (layout.right.includes(id)) return "right";
  return null;
}

// The order each group actually renders. Stored ids come first, in their
// stored order; anything the user has never arranged is appended to its
// default group in registration order. Ids with no live slot (an extension
// that is disabled right now) drop out here rather than being pruned from
// storage, so disabling and re-enabling an extension keeps its position —
// the same never-prune rule the sidebar layout follows.
export function resolveStatusBarLayout(
  slots: readonly StatusBarSlot[],
  layout: StatusBarLayout,
): StatusBarLayout {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const take = (ids: readonly string[]) =>
    ids.filter((id) => {
      if (placed.has(id) || !byId.has(id)) return false;
      placed.add(id);
      return true;
    });

  const left = take(layout.left);
  const right = take(layout.right);
  for (const slot of slots) {
    if (placed.has(slot.id)) continue;
    placed.add(slot.id);
    (slot.defaultSide === "left" ? left : right).push(slot.id);
  }
  return { left, right };
}

// Moves an item to `side` at `index`, counted among that side's items with
// the moved one removed. Ids the caller didn't pass in `resolved` (a
// disabled extension's, say) keep their stored slot: the returned layout is
// built from the stored one so nothing is lost by a drag.
export function moveStatusBarItem(
  stored: StatusBarLayout,
  resolved: StatusBarLayout,
  id: string,
  side: StatusBarSide,
  index: number,
): StatusBarLayout {
  const target = [...resolved[side].filter((other) => other !== id)];
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, id);
  const other = side === "left" ? "right" : "left";
  const otherIds = resolved[other].filter((o) => o !== id);

  // Fold back any stored id that isn't currently rendered, at the position
  // it had, so an arrangement made while an extension was enabled survives
  // that extension being turned off and on again.
  const merge = (rendered: string[], storedIds: readonly string[]): string[] => {
    const out = [...rendered];
    for (const storedId of storedIds) {
      if (storedId === id || out.includes(storedId)) continue;
      if (resolved.left.includes(storedId) || resolved.right.includes(storedId)) continue;
      const at2 = Math.min(storedIds.indexOf(storedId), out.length);
      out.splice(at2, 0, storedId);
    }
    return out;
  };

  return side === "left"
    ? { left: merge(target, stored.left), right: merge(otherIds, stored.right) }
    : { left: merge(otherIds, stored.left), right: merge(target, stored.right) };
}
