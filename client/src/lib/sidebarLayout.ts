// Pure model for the sidebars' tabs and where each panel lives. No React,
// no DOM — useSidebarLayout turns this into state, and Sidebar renders one
// side of it.
//
// Two things generalize what Sidebar.tsx used to hold privately:
//   - a tab list PER SIDE, so a tab can be dragged to a second (right)
//     sidebar;
//   - panelHome, which overrides a panel's registered `location`, so any
//     section can be moved into any tab.
// Everything a tab shows is then one question — "which sections call this
// tab home?" — asked identically for the Explorer/Run/Commands accordions
// and for an extension's own tab (Source Control, Search).

export type SidebarSide = "left" | "right";

export const SIDES: readonly SidebarSide[] = ["left", "right"];

// Kept here rather than in Sidebar.tsx so extensions.ts can import them
// without the circular dependency that made it keep private copies.
export const EXPLORER_TAB_ID = "explorer";
export const RUN_TAB_ID = "run-view";
export const COMMANDS_TAB_ID = "commands-view";
export const EXTENSIONS_TAB_ID = "extensions-view";
export const CORE_TAB_IDS: readonly string[] = [
  EXPLORER_TAB_ID,
  RUN_TAB_ID,
  COMMANDS_TAB_ID,
  EXTENSIONS_TAB_ID,
];

// The built-in Explorer sections. They aren't extension panels, but every
// question below is asked of them the same way, so they enter the model as
// ordinary PanelLikes homed to Explorer by default.
export const BUILTIN_PANEL_IDS: readonly string[] = ["projects", "files"];

export type PanelLocation = "tab" | "explorer" | "run" | "commands";

export interface PanelLike {
  id: string;
  location: PanelLocation;
  // An extension asked for this section to be absent for now
  // (ctx.app.setSidebarPanelVisible) — absent, not forgotten: it keeps its
  // stored order/home.
  hidden?: boolean;
}

export interface SidebarLayout {
  left: string[];
  right: string[];
  // "" means "this side has no active tab" (an empty right sidebar).
  active: Record<SidebarSide, string>;
  // panelId → tabId, only for panels the user actually moved. A panel with
  // no entry lives wherever its registration says.
  panelHome: Record<string, string>;
  // Panels the USER hid, from the gear menu's Panes list. Distinct from
  // PanelLike.hidden, which an extension sets for context ("nothing to show
  // right now"): the two are ORed, so an extension can never un-hide
  // something the user hid, or the reverse.
  hiddenPanels: string[];
}

export const DEFAULT_LAYOUT: SidebarLayout = {
  left: [...CORE_TAB_IDS],
  right: [],
  active: { left: EXPLORER_TAB_ID, right: "" },
  panelHome: {},
  hiddenPanels: [],
};

export function otherSide(side: SidebarSide): SidebarSide {
  return side === "left" ? "right" : "left";
}

// Where a panel lives when the user has never moved it.
export function defaultTabForPanel(panel: PanelLike): string {
  switch (panel.location) {
    case "explorer":
      return EXPLORER_TAB_ID;
    case "run":
      return RUN_TAB_ID;
    case "commands":
      return COMMANDS_TAB_ID;
    default:
      // A "tab" panel is its own tab — the tab id and the panel id are the
      // same string, which is what lets "move Search into Explorer" and
      // "move it back" be the same operation.
      return panel.id;
  }
}

export function tabOfPanel(layout: SidebarLayout, panel: PanelLike): string {
  return layout.panelHome[panel.id] ?? defaultTabForPanel(panel);
}

export function sideOfTab(layout: SidebarLayout, tabId: string): SidebarSide | null {
  if (layout.left.includes(tabId)) return "left";
  if (layout.right.includes(tabId)) return "right";
  return null;
}

// Guarantees the invariants every consumer assumes: no id on both sides (or
// twice on one), and all four core tabs present. A missing core id lands on
// the LEFT in the documented order — each insertion goes right after
// Explorer, so applying them in reverse yields Explorer → Run → Commands →
// Extensions (the same trick Sidebar.tsx's sanitizeTabsOrder used).
export function sanitizeLayout(layout: SidebarLayout): SidebarLayout {
  const seen = new Set<string>();
  const dedupe = (ids: string[]) =>
    ids.filter((id) => {
      if (typeof id !== "string" || id === "" || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const left = dedupe(layout.left ?? []);
  const right = dedupe(layout.right ?? []);

  if (!seen.has(EXPLORER_TAB_ID)) left.unshift(EXPLORER_TAB_ID);
  const afterExplorer = (id: string) => {
    if (seen.has(id)) return;
    const at = left.indexOf(EXPLORER_TAB_ID);
    left.splice(at === -1 ? left.length : at + 1, 0, id);
    seen.add(id);
  };
  seen.add(EXPLORER_TAB_ID);
  afterExplorer(EXTENSIONS_TAB_ID);
  afterExplorer(COMMANDS_TAB_ID);
  afterExplorer(RUN_TAB_ID);

  const active: Record<SidebarSide, string> = {
    left: left.includes(layout.active?.left) ? layout.active.left : (left[0] ?? ""),
    right: right.includes(layout.active?.right) ? layout.active.right : (right[0] ?? ""),
  };
  const panelHome: Record<string, string> = {};
  for (const [panelId, tabId] of Object.entries(layout.panelHome ?? {})) {
    if (typeof tabId === "string" && tabId !== "") panelHome[panelId] = tabId;
  }
  const hiddenPanels = (layout.hiddenPanels ?? []).filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  return { left, right, active, panelHome, hiddenPanels: [...new Set(hiddenPanels)] };
}

// The sections a tab shows, in the shared accordion order. `panels` carries
// every candidate section (built-ins included); an id with no entry is
// stale storage and drops out here rather than being pruned.
export function isPanelHidden(layout: SidebarLayout, panel: PanelLike): boolean {
  return !!panel.hidden || layout.hiddenPanels.includes(panel.id);
}

export function sectionsForTab(
  panelOrder: readonly string[],
  panels: ReadonlyMap<string, PanelLike>,
  layout: SidebarLayout,
  tabId: string,
): string[] {
  return panelOrder.filter((id) => {
    const panel = panels.get(id);
    return !!panel && !isPanelHidden(layout, panel) && tabOfPanel(layout, panel) === tabId;
  });
}

// Flips a panel's user-hidden state. A hidden panel leaves its tab (and the
// tab retires with it when it was the last one) but keeps its stored home
// and order, so showing it again puts it back where it was.
export function togglePanelHidden(layout: SidebarLayout, panelId: string): SidebarLayout {
  const hidden = layout.hiddenPanels.includes(panelId)
    ? layout.hiddenPanels.filter((id) => id !== panelId)
    : [...layout.hiddenPanels, panelId];
  return { ...layout, hiddenPanels: hidden };
}

// Explorer and Extensions always show (Explorer is the fallback tab and can
// legitimately be empty; Extensions renders the extension manager, not
// sections). Every other tab — the Run/Commands accordions and each
// extension's own tab — shows only while something calls it home, so
// moving a tab's last section away retires the tab with it.
export function isTabVisible(
  tabId: string,
  panelOrder: readonly string[],
  panels: ReadonlyMap<string, PanelLike>,
  layout: SidebarLayout,
): boolean {
  if (tabId === EXPLORER_TAB_ID || tabId === EXTENSIONS_TAB_ID) return true;
  return sectionsForTab(panelOrder, panels, layout, tabId).length > 0;
}

export function visibleTabsForSide(
  layout: SidebarLayout,
  side: SidebarSide,
  panelOrder: readonly string[],
  panels: ReadonlyMap<string, PanelLike>,
): string[] {
  return layout[side].filter((id) => isTabVisible(id, panelOrder, panels, layout));
}

// The tab a side actually renders: its stored choice while that's still
// visible, else the first visible tab, else null (an empty side).
export function resolveActive(
  layout: SidebarLayout,
  side: SidebarSide,
  visibleTabs: readonly string[],
): string | null {
  const stored = layout.active[side];
  if (stored && visibleTabs.includes(stored)) return stored;
  return visibleTabs[0] ?? null;
}

export function selectTab(layout: SidebarLayout, tabId: string): SidebarLayout {
  const side = sideOfTab(layout, tabId);
  if (!side || layout.active[side] === tabId) return layout;
  return { ...layout, active: { ...layout.active, [side]: tabId } };
}

// Moves a tab within a side (reorder) or across sides. The destination side
// activates what just landed there — a tab you dragged is a tab you want to
// see — and a side left empty forgets its active tab.
export function moveTabToSide(
  layout: SidebarLayout,
  tabId: string,
  side: SidebarSide,
  index: number,
): SidebarLayout {
  const from = sideOfTab(layout, tabId);
  if (!from) return layout;
  const left = layout.left.filter((id) => id !== tabId);
  const right = layout.right.filter((id) => id !== tabId);
  const target = side === "left" ? left : right;
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, tabId);
  const active = { ...layout.active, [side]: tabId };
  if (from !== side) {
    const source = from === "left" ? left : right;
    if (layout.active[from] === tabId) active[from] = source[0] ?? "";
  }
  return { ...layout, left, right, active };
}

// Rehomes a section. Moving it back to where its registration puts it drops
// the override entirely, so the stored layout only ever records real
// deviations (and a panel whose extension later changes its own location
// follows that change).
export function movePanelToTab(
  layout: SidebarLayout,
  panel: PanelLike,
  tabId: string,
): SidebarLayout {
  const panelHome = { ...layout.panelHome };
  // "" means "reset", the same outcome as naming the panel's own default —
  // never a home in its own right, which would strand the section in a tab
  // that doesn't exist.
  if (tabId === "" || tabId === defaultTabForPanel(panel)) delete panelHome[panel.id];
  else panelHome[panel.id] = tabId;
  return { ...layout, panelHome };
}

// Every tab a section could be moved to, across both sides: the tabs
// actually on screen right now, plus the panel's own tab when it's an
// extension tab panel currently living elsewhere (nothing else would bring
// it back). Never the Extensions tab, whose body is the extension manager,
// and never the tab the panel is already in. Stale ids (an extension that
// isn't registered on this load) are excluded by the visibility test, so a
// move target always has a real name and a real destination.
export function moveTargetsForPanel(
  layout: SidebarLayout,
  panel: PanelLike,
  panelOrder: readonly string[],
  panels: ReadonlyMap<string, PanelLike>,
): { tabId: string; side: SidebarSide }[] {
  const targets: { tabId: string; side: SidebarSide }[] = [];
  for (const side of SIDES) {
    for (const tabId of visibleTabsForSide(layout, side, panelOrder, panels)) {
      if (tabId === EXTENSIONS_TAB_ID) continue;
      targets.push({ tabId, side });
    }
  }
  const own = defaultTabForPanel(panel);
  if (panel.location === "tab" && !targets.some((t) => t.tabId === own)) {
    targets.push({ tabId: own, side: sideOfTab(layout, own) ?? "left" });
  }
  return targets.filter((t) => t.tabId !== tabOfPanel(layout, panel));
}
