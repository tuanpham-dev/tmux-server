import { describe, expect, it } from "vitest";
import type { Tab, TmuxSession } from "../types";
import {
  groupKeyForTab,
  moveGroup,
  moveId,
  normalizeTabGroups,
  orderedGroupKeys,
  reconcileTabs,
} from "./tabs";

function makeTab(overrides: Partial<Tab>): Tab {
  return { id: "id", sessionName: "session", attachName: "session", ...overrides };
}

function makeSession(overrides: Partial<TmuxSession>): TmuxSession {
  return { id: "$1", name: "session", created: 0, attached: 0, windows: [], ...overrides };
}

describe("groupKeyForTab", () => {
  it("returns sessionName for a real (whole-session) tab", () => {
    expect(groupKeyForTab(makeTab({ sessionName: "blog" }))).toBe("blog");
  });

  it("returns sessionName for a real window-tab", () => {
    expect(groupKeyForTab(makeTab({ sessionName: "blog", windowIndex: 1 }))).toBe("blog");
  });

  it("returns originSessionName for a viewer tab with an origin", () => {
    const tab = makeTab({
      sessionName: "",
      attachName: "",
      extViewerId: "image",
      extViewerPath: "/a.png",
      originSessionName: "blog",
    });
    expect(groupKeyForTab(tab)).toBe("blog");
  });

  it("returns null for a viewer tab with no origin", () => {
    const tab = makeTab({
      sessionName: "",
      attachName: "",
      extViewerId: "image",
      extViewerPath: "/a.png",
    });
    expect(groupKeyForTab(tab)).toBeNull();
  });

  it("returns null for the settings tab", () => {
    const tab = makeTab({ sessionName: "", attachName: "", settingsView: true });
    expect(groupKeyForTab(tab)).toBeNull();
  });
});

describe("normalizeTabGroups", () => {
  it("keeps an already-normalized order unchanged (same reference)", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a" }),
      makeTab({ id: "2", sessionName: "a", windowIndex: 0 }),
      makeTab({ id: "3", sessionName: "b" }),
      makeTab({ id: "4", sessionName: "", attachName: "", settingsView: true }),
    ];
    expect(normalizeTabGroups(tabs)).toBe(tabs);
  });

  it("makes interleaved same-session tabs contiguous, anchored at the first occurrence", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a" }),
      makeTab({ id: "2", sessionName: "b" }),
      makeTab({ id: "3", sessionName: "a", windowIndex: 0 }),
    ];
    const next = normalizeTabGroups(tabs);
    expect(next.map((t) => t.id)).toEqual(["1", "3", "2"]);
  });

  it("pushes every ungrouped tab after all groups, preserving their relative order", () => {
    const tabs = [
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "orphan", sessionName: "", attachName: "", extViewerId: "image", extViewerPath: "/x.png" }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "a2", sessionName: "a", windowIndex: 0 }),
    ];
    const next = normalizeTabGroups(tabs);
    expect(next.map((t) => t.id)).toEqual(["a1", "a2", "b1", "settings", "orphan"]);
  });
});

describe("orderedGroupKeys", () => {
  it("returns distinct group keys in first-appearance order, excluding singletons", () => {
    const tabs = [
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "b2", sessionName: "b", windowIndex: 0 }),
    ];
    expect(orderedGroupKeys(tabs)).toEqual(["b", "a"]);
  });

  it("returns an empty array when every tab is ungrouped", () => {
    const tabs = [makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true })];
    expect(orderedGroupKeys(tabs)).toEqual([]);
  });
});

describe("moveGroup", () => {
  function groupedTabs() {
    return [
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "a2", sessionName: "a", windowIndex: 0 }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "c1", sessionName: "c" }),
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
    ];
  }

  it("moves a group earlier, keeping its own tabs' relative order and singletons trailing", () => {
    const next = moveGroup(groupedTabs(), "c", 0);
    expect(next.map((t) => t.id)).toEqual(["c1", "a1", "a2", "b1", "settings"]);
  });

  it("moves a group later", () => {
    const next = moveGroup(groupedTabs(), "a", 2);
    expect(next.map((t) => t.id)).toEqual(["b1", "c1", "a1", "a2", "settings"]);
  });

  it("clamps an out-of-range target index to the end", () => {
    const next = moveGroup(groupedTabs(), "a", 99);
    expect(next.map((t) => t.id)).toEqual(["b1", "c1", "a1", "a2", "settings"]);
  });

  it("returns the same reference for an unknown group key", () => {
    const tabs = groupedTabs();
    expect(moveGroup(tabs, "nonexistent", 0)).toBe(tabs);
  });

  it("returns the same reference when the target index doesn't change anything", () => {
    const tabs = groupedTabs();
    expect(moveGroup(tabs, "a", 0)).toBe(tabs);
  });

  it("reorders a collapsed group identically to an expanded one — moveGroup never reads collapse state", () => {
    // tabGroupState (color/collapsed) lives in useTabGroups, entirely
    // separate from the Tab[] moveGroup operates on — collapsing a group
    // has no representation here at all, so this just re-asserts the
    // "moves earlier" case with a differently-named group standing in for
    // "the one that happens to be collapsed" to document that intent.
    const next = moveGroup(groupedTabs(), "b", 0);
    expect(next.map((t) => t.id)).toEqual(["b1", "a1", "a2", "c1", "settings"]);
  });
});

describe("moveId", () => {
  it("moves an id earlier", () => {
    expect(moveId(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("moves an id later", () => {
    expect(moveId(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("clamps an out-of-range target index to the end", () => {
    expect(moveId(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
  });

  it("returns the same reference for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(moveId(order, "nonexistent", 0)).toBe(order);
  });

  it("returns the same reference when the target index doesn't change anything", () => {
    const order = ["a", "b", "c"];
    expect(moveId(order, "a", 0)).toBe(order);
  });
});

describe("reconcileTabs", () => {
  it("returns the same reference when nothing changed", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog" })];
    const sessions = [makeSession({ id: "$1", name: "blog" })];
    expect(reconcileTabs(tabs, sessions)).toBe(tabs);
  });

  it("adopts a rename detected via stable session id", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog", attachName: "blog" })];
    const sessions = [makeSession({ id: "$1", name: "blog-renamed" })];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].sessionName).toBe("blog-renamed");
    expect(next[0].attachName).toBe("blog-renamed");
  });

  it("does not follow a base-session rename for a window-tab's synthetic attachName", () => {
    const tabs = [
      makeTab({
        id: "1",
        sessionId: "$1",
        sessionName: "blog",
        attachName: "blog__win1",
        windowIndex: 1,
        windowId: "@1",
      }),
    ];
    const sessions = [
      makeSession({
        id: "$1",
        name: "blog-renamed",
        windows: [{ id: "@1", index: 1, name: "vim", active: true, cwd: "/tmp", activity: false }],
      }),
    ];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].sessionName).toBe("blog-renamed");
    expect(next[0].attachName).toBe("blog__win1");
  });

  it("adopts a window renumber via stable window id", () => {
    const tabs = [
      makeTab({ id: "1", sessionId: "$1", sessionName: "blog", windowIndex: 1, windowId: "@1" }),
    ];
    const sessions = [
      makeSession({
        id: "$1",
        name: "blog",
        windows: [{ id: "@1", index: 3, name: "vim", active: true, cwd: "/tmp", activity: false }],
      }),
    ];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].windowIndex).toBe(3);
  });

  it("leaves a tab untouched when its session no longer exists", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog" })];
    const next = reconcileTabs(tabs, []);
    expect(next).toBe(tabs);
  });
});
