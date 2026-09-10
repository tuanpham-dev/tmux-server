import { describe, expect, it } from "vitest";
import {
  COMMANDS_TAB_ID,
  DEFAULT_LAYOUT,
  EXPLORER_TAB_ID,
  EXTENSIONS_TAB_ID,
  RUN_TAB_ID,
  defaultTabForPanel,
  isPanelHidden,
  isTabVisible,
  moveTabToSide,
  moveTargetsForPanel,
  ownTabForPanel,
  movePanelToTab,
  resolveActive,
  sanitizeLayout,
  sectionsForTab,
  sideOfTab,
  selectTab,
  tabOfPanel,
  togglePanelHidden,
  visibleTabsForSide,
  type PanelLike,
  type SidebarLayout,
} from "./sidebarLayout";

const SEARCH = "ext.tmux-server.search.search";
const GIT = "ext.tmux-server.git-scm.git";
const PORTS = "ext.tmux-server.ports.ports";

const panels: PanelLike[] = [
  { id: "projects", location: "explorer" },
  { id: "files", location: "explorer" },
  { id: PORTS, location: "run" },
  { id: SEARCH, location: "tab" },
  { id: GIT, location: "tab" },
];
const byId = new Map(panels.map((p) => [p.id, p]));
const order = ["projects", "files", PORTS, SEARCH, GIT];

const layout = (over: Partial<SidebarLayout> = {}): SidebarLayout => ({
  ...DEFAULT_LAYOUT,
  left: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID, SEARCH, GIT],
  ...over,
});

describe("tabOfPanel", () => {
  it("sends each location to its accordion tab, and a tab panel to itself", () => {
    expect(defaultTabForPanel({ id: "files", location: "explorer" })).toBe(EXPLORER_TAB_ID);
    expect(defaultTabForPanel({ id: PORTS, location: "run" })).toBe(RUN_TAB_ID);
    expect(defaultTabForPanel({ id: "x", location: "commands" })).toBe(COMMANDS_TAB_ID);
    expect(defaultTabForPanel({ id: SEARCH, location: "tab" })).toBe(SEARCH);
  });

  it("lets panelHome override the registered location", () => {
    const l = layout({ panelHome: { [PORTS]: EXPLORER_TAB_ID } });
    expect(tabOfPanel(l, byId.get(PORTS)!)).toBe(EXPLORER_TAB_ID);
    expect(tabOfPanel(l, byId.get("files")!)).toBe(EXPLORER_TAB_ID);
  });
});

describe("sanitizeLayout", () => {
  it("adds every missing core tab in the documented order", () => {
    const l = sanitizeLayout({ left: [], right: [], active: { left: "", right: "" }, panelHome: {}, hiddenPanels: [] });
    expect(l.left).toEqual([EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID]);
  });

  it("keeps a core tab the user moved to the right side where it is", () => {
    const l = sanitizeLayout({
      left: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID],
      right: [EXTENSIONS_TAB_ID],
      active: { left: EXPLORER_TAB_ID, right: EXTENSIONS_TAB_ID },
      panelHome: {},
      hiddenPanels: [],
    });
    expect(l.left).not.toContain(EXTENSIONS_TAB_ID);
    expect(l.right).toEqual([EXTENSIONS_TAB_ID]);
  });

  it("drops a duplicate id, keeping the left copy", () => {
    const l = sanitizeLayout({
      left: [EXPLORER_TAB_ID, GIT, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID],
      right: [GIT],
      active: { left: GIT, right: GIT },
      panelHome: {},
      hiddenPanels: [],
    });
    expect(l.left.filter((id) => id === GIT)).toHaveLength(1);
    expect(l.right).toEqual([]);
    expect(l.active.right).toBe("");
  });

  it("falls back to a side's first tab when its stored active tab is gone", () => {
    const l = sanitizeLayout({ ...layout(), active: { left: "vanished", right: "" } });
    expect(l.active.left).toBe(EXPLORER_TAB_ID);
  });
});

describe("sectionsForTab", () => {
  it("groups the built-ins under Explorer and run panels under Run", () => {
    const l = layout();
    expect(sectionsForTab(order, byId, l, EXPLORER_TAB_ID)).toEqual(["projects", "files"]);
    expect(sectionsForTab(order, byId, l, RUN_TAB_ID)).toEqual([PORTS]);
    expect(sectionsForTab(order, byId, l, SEARCH)).toEqual([SEARCH]);
  });

  it("moves a section into another tab when panelHome says so", () => {
    const l = layout({ panelHome: { [PORTS]: EXPLORER_TAB_ID } });
    expect(sectionsForTab(order, byId, l, EXPLORER_TAB_ID)).toEqual(["projects", "files", PORTS]);
    expect(sectionsForTab(order, byId, l, RUN_TAB_ID)).toEqual([]);
  });

  it("skips a hidden section and an id with no registered panel", () => {
    const hidden = new Map(byId);
    hidden.set(PORTS, { id: PORTS, location: "run", hidden: true });
    expect(sectionsForTab([...order, "stale"], hidden, layout(), RUN_TAB_ID)).toEqual([]);
  });

  it("follows the shared accordion order", () => {
    const l = layout({ panelHome: { [PORTS]: EXPLORER_TAB_ID } });
    expect(sectionsForTab([PORTS, "files", "projects"], byId, l, EXPLORER_TAB_ID)).toEqual([
      PORTS,
      "files",
      "projects",
    ]);
  });
});

describe("tab visibility", () => {
  it("always shows Explorer and Extensions, even with no sections", () => {
    const empty = new Map<string, PanelLike>();
    expect(isTabVisible(EXPLORER_TAB_ID, [], empty, layout())).toBe(true);
    expect(isTabVisible(EXTENSIONS_TAB_ID, [], empty, layout())).toBe(true);
  });

  it("hides Run once its last section is moved away", () => {
    expect(isTabVisible(RUN_TAB_ID, order, byId, layout())).toBe(true);
    const moved = layout({ panelHome: { [PORTS]: EXPLORER_TAB_ID } });
    expect(isTabVisible(RUN_TAB_ID, order, byId, moved)).toBe(false);
  });

  it("hides an extension's own tab when its panel is moved into Explorer", () => {
    const moved = layout({ panelHome: { [SEARCH]: EXPLORER_TAB_ID } });
    expect(isTabVisible(SEARCH, order, byId, moved)).toBe(false);
    expect(visibleTabsForSide(moved, "left", order, byId)).not.toContain(SEARCH);
    expect(sectionsForTab(order, byId, moved, EXPLORER_TAB_ID)).toContain(SEARCH);
  });

  it("lists only the tabs that belong to the asked-for side", () => {
    const l = layout({ left: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID], right: [GIT] });
    expect(visibleTabsForSide(l, "right", order, byId)).toEqual([GIT]);
    expect(visibleTabsForSide(l, "left", order, byId)).toEqual([
      EXPLORER_TAB_ID,
      RUN_TAB_ID,
      EXTENSIONS_TAB_ID,
    ]);
  });
});

describe("resolveActive", () => {
  it("keeps the stored tab while it is visible", () => {
    expect(resolveActive(layout({ active: { left: GIT, right: "" } }), "left", [EXPLORER_TAB_ID, GIT])).toBe(GIT);
  });

  it("falls back to the first visible tab, then to null", () => {
    expect(resolveActive(layout({ active: { left: GIT, right: "" } }), "left", [EXPLORER_TAB_ID])).toBe(
      EXPLORER_TAB_ID,
    );
    expect(resolveActive(layout(), "right", [])).toBe(null);
  });
});

describe("moveTabToSide", () => {
  it("moves a tab to the other side and activates it there", () => {
    const l = moveTabToSide(layout(), GIT, "right", 0);
    expect(sideOfTab(l, GIT)).toBe("right");
    expect(l.right).toEqual([GIT]);
    expect(l.active.right).toBe(GIT);
    expect(l.left).not.toContain(GIT);
  });

  it("reorders within a side without duplicating", () => {
    const l = moveTabToSide(layout(), GIT, "left", 0);
    expect(l.left[0]).toBe(GIT);
    expect(l.left.filter((id) => id === GIT)).toHaveLength(1);
  });

  it("hands the source side a new active tab when the moved one was active", () => {
    const start = layout({ active: { left: GIT, right: "" } });
    const l = moveTabToSide(start, GIT, "right", 0);
    expect(l.active.left).toBe(EXPLORER_TAB_ID);
  });

  it("empties the source side's active tab when nothing is left", () => {
    const start = layout({ left: [EXPLORER_TAB_ID], right: [GIT], active: { left: EXPLORER_TAB_ID, right: GIT } });
    const l = moveTabToSide(start, GIT, "left", 1);
    expect(l.right).toEqual([]);
    expect(l.active.right).toBe("");
  });

  it("clamps an out-of-range index and ignores an unknown tab", () => {
    const l = moveTabToSide(layout(), GIT, "right", 99);
    expect(l.right).toEqual([GIT]);
    expect(moveTabToSide(layout(), "nope", "right", 0)).toEqual(layout());
  });
});

describe("movePanelToTab", () => {
  it("records a move and drops the record on the way back", () => {
    const moved = movePanelToTab(layout(), byId.get(PORTS)!, EXPLORER_TAB_ID);
    expect(moved.panelHome[PORTS]).toBe(EXPLORER_TAB_ID);
    const back = movePanelToTab(moved, byId.get(PORTS)!, RUN_TAB_ID);
    expect(back.panelHome).not.toHaveProperty(PORTS);
  });

  it("treats an empty target as a reset rather than a home", () => {
    const moved = movePanelToTab(layout(), byId.get(PORTS)!, EXPLORER_TAB_ID);
    const reset = movePanelToTab(moved, byId.get(PORTS)!, "");
    expect(reset.panelHome).not.toHaveProperty(PORTS);
    expect(tabOfPanel(reset, byId.get(PORTS)!)).toBe(RUN_TAB_ID);
  });

  it("returns an extension tab panel home by moving it to its own id", () => {
    const inExplorer = movePanelToTab(layout(), byId.get(SEARCH)!, EXPLORER_TAB_ID);
    expect(tabOfPanel(inExplorer, byId.get(SEARCH)!)).toBe(EXPLORER_TAB_ID);
    const back = movePanelToTab(inExplorer, byId.get(SEARCH)!, SEARCH);
    expect(back.panelHome).not.toHaveProperty(SEARCH);
    expect(tabOfPanel(back, byId.get(SEARCH)!)).toBe(SEARCH);
  });
});

describe("moveTargetsForPanel", () => {
  it("offers every tab but the Extensions tab and the panel's current one", () => {
    const targets = moveTargetsForPanel(layout(), byId.get(PORTS)!, order, byId).map((t) => t.tabId);
    expect(targets).toContain(EXPLORER_TAB_ID);
    expect(targets).toContain(SEARCH);
    expect(targets).not.toContain(EXTENSIONS_TAB_ID);
    expect(targets).not.toContain(RUN_TAB_ID); // where PORTS already is
  });

  it("offers a relocated tab panel its own tab back, even though no tab shows it", () => {
    const moved = movePanelToTab(layout(), byId.get(SEARCH)!, EXPLORER_TAB_ID);
    const targets = moveTargetsForPanel(moved, byId.get(SEARCH)!, order, byId).map((t) => t.tabId);
    expect(targets).toContain(SEARCH);
    expect(targets).not.toContain(EXPLORER_TAB_ID); // where it is now
  });

  it("skips a stale tab id whose extension is not registered", () => {
    const l = layout({ left: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID, "ext.gone.panel"] });
    const targets = moveTargetsForPanel(l, byId.get(PORTS)!, order, byId).map((t) => t.tabId);
    expect(targets).not.toContain("ext.gone.panel");
  });

  it("reports which side each target lives on", () => {
    const l = layout({ left: [EXPLORER_TAB_ID, RUN_TAB_ID, COMMANDS_TAB_ID, EXTENSIONS_TAB_ID], right: [GIT] });
    expect(moveTargetsForPanel(l, byId.get(PORTS)!, order, byId)).toContainEqual({ tabId: GIT, side: "right" });
  });
});

describe("selectTab", () => {
  it("activates a tab on whichever side holds it", () => {
    const l = selectTab(layout({ right: [GIT], left: [EXPLORER_TAB_ID] }), GIT);
    expect(l.active.right).toBe(GIT);
    expect(l.active.left).toBe(EXPLORER_TAB_ID);
  });

  it("is a no-op for an unknown tab", () => {
    const start = layout();
    expect(selectTab(start, "nope")).toBe(start);
  });
});

describe("user-hidden panes", () => {
  it("hides a pane from its tab and retires the tab with its last one", () => {
    const hidden = togglePanelHidden(layout(), PORTS);
    expect(hidden.hiddenPanels).toEqual([PORTS]);
    expect(sectionsForTab(order, byId, hidden, RUN_TAB_ID)).toEqual([]);
    expect(isTabVisible(RUN_TAB_ID, order, byId, hidden)).toBe(false);
  });

  it("restores the pane, and its place, when toggled back", () => {
    const hidden = togglePanelHidden(layout(), "files");
    const shown = togglePanelHidden(hidden, "files");
    expect(shown.hiddenPanels).toEqual([]);
    expect(sectionsForTab(order, byId, shown, EXPLORER_TAB_ID)).toEqual(["projects", "files"]);
  });

  it("ORs with the extension-set hidden flag, so neither overrides the other", () => {
    const extHidden = new Map(byId);
    extHidden.set(PORTS, { id: PORTS, location: "run", hidden: true });
    // The extension says hidden; the user has said nothing.
    expect(isPanelHidden(layout(), extHidden.get(PORTS)!)).toBe(true);
    // The user says hidden; the extension has said nothing.
    expect(isPanelHidden(togglePanelHidden(layout(), "files"), byId.get("files")!)).toBe(true);
  });

  it("leaves a tab with no sections at all when every pane is hidden", () => {
    let l = layout();
    for (const id of ["projects", "files"]) l = togglePanelHidden(l, id);
    expect(sectionsForTab(order, byId, l, EXPLORER_TAB_ID)).toEqual([]);
    // Explorer still shows — it is the fallback tab, and its emptiness is
    // what the sidebar's hint explains.
    expect(isTabVisible(EXPLORER_TAB_ID, order, byId, l)).toBe(true);
  });
});


// git-scm ships COMMITS as a PANE OF the SOURCE CONTROL panel — stacked
// under it in the same tab, movable anywhere else, but never a tab of its
// own. That is the case defaultTab exists for.
describe("a pane of another panel", () => {
  const COMMITS = "ext.tmux-server.git-scm.commits";
  const commits: PanelLike = { id: COMMITS, location: "tab", defaultTab: GIT };
  const withCommits = new Map(byId).set(COMMITS, commits);
  const orderWithCommits = [...order, COMMITS];
  // Deliberately NOT added to either side's tab list: owning no tab, it
  // never takes a slot in the strip (see useSidebarLayout's reconciliation).
  const base = layout;

  it("stacks under its host panel in the host's tab", () => {
    expect(defaultTabForPanel(commits)).toBe(GIT);
    expect(tabOfPanel(base(), commits)).toBe(GIT);
    expect(sectionsForTab(orderWithCommits, withCommits, base(), GIT)).toEqual([GIT, COMMITS]);
  });

  it("owns no tab, so it can never become one", () => {
    expect(ownTabForPanel(commits)).toBe("");
    const targets = moveTargetsForPanel(base(), commits, orderWithCommits, withCommits);
    expect(targets.map((t) => t.tabId)).not.toContain(COMMITS);
    expect(isTabVisible(COMMITS, orderWithCommits, withCommits, base())).toBe(false);
    expect(visibleTabsForSide(base(), "left", orderWithCommits, withCommits)).not.toContain(COMMITS);
  });

  it("never offers the tab it is already in", () => {
    const targets = moveTargetsForPanel(base(), commits, orderWithCommits, withCommits);
    expect(targets.map((t) => t.tabId)).not.toContain(GIT);
  });

  it("still moves into any other tab, and resets back to its host", () => {
    const moved = movePanelToTab(base(), commits, EXPLORER_TAB_ID);
    expect(tabOfPanel(moved, commits)).toBe(EXPLORER_TAB_ID);
    expect(sectionsForTab(orderWithCommits, withCommits, moved, EXPLORER_TAB_ID)).toEqual([
      "projects",
      "files",
      COMMITS,
    ]);
    // "Reset Location" names defaultTabForPanel, so it drops the override.
    const reset = movePanelToTab(moved, commits, defaultTabForPanel(commits));
    expect(reset.panelHome[COMMITS]).toBeUndefined();
    expect(tabOfPanel(reset, commits)).toBe(GIT);
  });

  it("follows its host tab to the right sidebar", () => {
    const moved = moveTabToSide(base(), GIT, "right", 0);
    expect(sideOfTab(moved, GIT)).toBe("right");
    expect(sectionsForTab(orderWithCommits, withCommits, moved, GIT)).toEqual([GIT, COMMITS]);
  });

  it("keeps the host tab alive on its own once the pane is moved away", () => {
    const moved = movePanelToTab(base(), commits, EXPLORER_TAB_ID);
    expect(sectionsForTab(orderWithCommits, withCommits, moved, GIT)).toEqual([GIT]);
    expect(isTabVisible(GIT, orderWithCommits, withCommits, moved)).toBe(true);
  });

  it("leaves an ordinary tab panel owning its own tab", () => {
    expect(defaultTabForPanel(byId.get(SEARCH)!)).toBe(SEARCH);
    expect(ownTabForPanel(byId.get(SEARCH)!)).toBe(SEARCH);
    expect(ownTabForPanel(byId.get(PORTS)!)).toBe("");
  });
});
