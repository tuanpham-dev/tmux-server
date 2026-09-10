import { describe, expect, it } from "vitest";
import {
  EMPTY_STATUS_BAR_LAYOUT,
  moveStatusBarItem,
  resolveStatusBarLayout,
  sideOfItem,
  type StatusBarSlot,
} from "./statusBarLayout";

const slots: StatusBarSlot[] = [
  { id: "ext.ports", defaultSide: "right" },
  { id: "core.memory", defaultSide: "right" },
  { id: "core.terminals", defaultSide: "right" },
];

describe("resolveStatusBarLayout", () => {
  it("falls back to registration order in each item's default group", () => {
    expect(resolveStatusBarLayout(slots, EMPTY_STATUS_BAR_LAYOUT)).toEqual({
      left: [],
      right: ["ext.ports", "core.memory", "core.terminals"],
    });
  });

  it("honors a stored order and a stored group", () => {
    const resolved = resolveStatusBarLayout(slots, {
      left: ["core.terminals"],
      right: ["core.memory", "ext.ports"],
    });
    expect(resolved).toEqual({ left: ["core.terminals"], right: ["core.memory", "ext.ports"] });
  });

  it("appends an item the user has never arranged", () => {
    const resolved = resolveStatusBarLayout(slots, { left: [], right: ["core.terminals"] });
    expect(resolved.right).toEqual(["core.terminals", "ext.ports", "core.memory"]);
  });

  it("drops an id with no live item without touching storage", () => {
    const resolved = resolveStatusBarLayout(slots, { left: ["ext.gone"], right: ["core.memory"] });
    expect(resolved.left).toEqual([]);
    expect(resolved.right[0]).toBe("core.memory");
  });

  it("keeps an id that appears twice only once", () => {
    const resolved = resolveStatusBarLayout(slots, {
      left: ["core.memory"],
      right: ["core.memory", "core.terminals"],
    });
    expect(resolved.left).toEqual(["core.memory"]);
    expect(resolved.right).not.toContain("core.memory");
  });
});

describe("sideOfItem", () => {
  it("reports the group holding an id, or null", () => {
    const layout = { left: ["a"], right: ["b"] };
    expect(sideOfItem(layout, "a")).toBe("left");
    expect(sideOfItem(layout, "b")).toBe("right");
    expect(sideOfItem(layout, "c")).toBe(null);
  });
});

describe("moveStatusBarItem", () => {
  const resolved = { left: [], right: ["ext.ports", "core.memory", "core.terminals"] };

  it("reorders within a group", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "core.terminals", "right", 0);
    expect(next.right).toEqual(["core.terminals", "ext.ports", "core.memory"]);
  });

  it("moves an item to the other group", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "ext.ports", "left", 0);
    expect(next.left).toEqual(["ext.ports"]);
    expect(next.right).toEqual(["core.memory", "core.terminals"]);
  });

  it("clamps an out-of-range index", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "ext.ports", "right", 99);
    expect(next.right).toEqual(["core.memory", "core.terminals", "ext.ports"]);
  });

  it("never duplicates the moved id", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "core.memory", "right", 2);
    expect(next.right.filter((id) => id === "core.memory")).toHaveLength(1);
  });

  it("preserves a stored id that isn't rendered right now", () => {
    const stored = { left: [], right: ["ext.disabled", "ext.ports", "core.memory", "core.terminals"] };
    const next = moveStatusBarItem(stored, resolved, "core.terminals", "right", 0);
    expect(next.right).toContain("ext.disabled");
    expect(next.right[next.right.length - 1]).not.toBe("ext.disabled");
  });
});
