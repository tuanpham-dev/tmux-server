import { describe, expect, it } from "vitest";
import type { Tab, TmuxSession } from "../types";
import { groupKeyForTab, normalizeTabGroups, reconcileTabs } from "./tabs";

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
