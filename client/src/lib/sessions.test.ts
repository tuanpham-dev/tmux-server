import { describe, expect, it } from "vitest";
import type { PinnedSession, TmuxSession } from "../types";
import { sessionRowsWithPins } from "./sessions";

function makeSession(overrides: Partial<TmuxSession>): TmuxSession {
  return { id: "$1", name: "session", created: 0, attached: 0, windows: [], ...overrides };
}

function makePin(overrides: Partial<PinnedSession>): PinnedSession {
  return { name: "session", cwd: "/tmp", ...overrides };
}

describe("sessionRowsWithPins", () => {
  it("returns empty for empty inputs", () => {
    expect(sessionRowsWithPins([], [])).toEqual([]);
  });

  it("flags a live session as pinned when a pin matches its name", () => {
    const session = makeSession({ name: "blog" });
    const rows = sessionRowsWithPins([session], [makePin({ name: "blog" })]);
    expect(rows).toEqual([{ dead: false, session, pinned: true }]);
  });

  it("leaves a live session unpinned when no pin matches", () => {
    const session = makeSession({ name: "blog" });
    const rows = sessionRowsWithPins([session], [makePin({ name: "other" })]);
    expect(rows).toEqual([
      { dead: false, session, pinned: false },
      { dead: true, name: "other", cwd: "/tmp" },
    ]);
  });

  it("synthesizes a dead row for a pin with no live session, after all live rows", () => {
    const session = makeSession({ name: "blog" });
    const pin = makePin({ name: "gone", cwd: "/works/gone" });
    const rows = sessionRowsWithPins([session], [pin]);
    expect(rows).toEqual([
      { dead: false, session, pinned: false },
      { dead: true, name: "gone", cwd: "/works/gone" },
    ]);
  });

  it("preserves the pins' own order among multiple dead rows", () => {
    const pins = [makePin({ name: "b" }), makePin({ name: "a" })];
    const rows = sessionRowsWithPins([], pins);
    expect(rows).toEqual([
      { dead: true, name: "b", cwd: "/tmp" },
      { dead: true, name: "a", cwd: "/tmp" },
    ]);
  });

  it("does not synthesize a dead row once the pinned session becomes live again", () => {
    // Simulates the rename-follows-pin flow: after renameSession migrates the
    // pin's name, the session it matches is live under the new name — no
    // stale dead row for the old name should appear since the pin record
    // itself was updated, not duplicated.
    const session = makeSession({ name: "renamed" });
    const rows = sessionRowsWithPins([session], [makePin({ name: "renamed", cwd: "/tmp" })]);
    expect(rows).toEqual([{ dead: false, session, pinned: true }]);
  });
});
