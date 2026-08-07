import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, TmuxSession } from "../types";
import { bumpRecent, projectName, projectRows, sessionNameForProject } from "./projects";

function makeSession(overrides: Partial<TmuxSession>): TmuxSession {
  return { id: "$1", name: "session", created: 0, attached: 0, path: "~/works/app", windows: [], ...overrides };
}

function makeProject(overrides: Partial<Project>): Project {
  return { cwd: "~/works/app", pinned: false, lastOpened: 0, ...overrides };
}

describe("projectName", () => {
  it("derives the folder basename", () => {
    expect(projectName("~/works/app")).toBe("app");
    expect(projectName("/opt/data/thing")).toBe("thing");
  });

  it("handles trailing slashes, bare home, and root", () => {
    expect(projectName("~/works/app/")).toBe("app");
    expect(projectName("~")).toBe("~");
    expect(projectName("/")).toBe("/");
  });
});

describe("sessionNameForProject", () => {
  it("uses the basename when free", () => {
    expect(sessionNameForProject("~/works/app", [])).toBe("app");
  });

  it("sanitizes tmux-forbidden characters", () => {
    expect(sessionNameForProject("~/works/my.app:v2", [])).toBe("my-app-v2");
  });

  it("suffixes -2, -3… until unique", () => {
    expect(sessionNameForProject("~/other/app", ["app"])).toBe("app-2");
    expect(sessionNameForProject("~/third/app", ["app", "app-2"])).toBe("app-3");
  });
});

describe("bumpRecent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a new entry unpinned at MRU front", () => {
    const next = bumpRecent([makeProject({ cwd: "~/old", lastOpened: 10 })], "~/new");
    expect(next[0]).toEqual({ cwd: "~/new", pinned: false, lastOpened: 1_000_000 });
    expect(next).toHaveLength(2);
  });

  it("preserves the pinned flag when bumping an existing entry", () => {
    const next = bumpRecent([makeProject({ cwd: "~/a", pinned: true, lastOpened: 10 })], "~/a");
    expect(next).toEqual([{ cwd: "~/a", pinned: true, lastOpened: 1_000_000 }]);
  });

  it("evicts the oldest unpinned entries beyond the cap, never pinned ones", () => {
    const projects: Project[] = [
      makeProject({ cwd: "~/pinned-old", pinned: true, lastOpened: 1 }),
      ...Array.from({ length: 15 }, (_, i) => makeProject({ cwd: `~/p${i}`, lastOpened: 100 + i })),
    ];
    const next = bumpRecent(projects, "~/fresh");
    expect(next.some((p) => p.cwd === "~/pinned-old")).toBe(true);
    expect(next.some((p) => p.cwd === "~/p0")).toBe(false); // oldest unpinned evicted
    expect(next.filter((p) => !p.pinned)).toHaveLength(15);
  });
});

describe("projectRows", () => {
  it("returns empty for empty inputs", () => {
    expect(projectRows([], [])).toEqual([]);
  });

  it("flags a live session as pinned when a pinned project matches its path", () => {
    const session = makeSession({ path: "~/works/app" });
    const rows = projectRows([session], [makeProject({ cwd: "~/works/app", pinned: true })]);
    expect(rows).toEqual([{ dead: false, session, extraSessions: [], pinned: true }]);
  });

  it("matching ignores the session name entirely (rename-proof)", () => {
    const session = makeSession({ name: "renamed-out-of-band", path: "~/works/app" });
    const rows = projectRows([session], [makeProject({ cwd: "~/works/app", pinned: true })]);
    expect(rows).toEqual([{ dead: false, session, extraSessions: [], pinned: true }]);
  });

  it("shows unmatched live sessions unpinned, and dead rows only for pinned projects", () => {
    const session = makeSession({ path: "~/elsewhere" });
    const rows = projectRows(
      [session],
      [
        makeProject({ cwd: "~/works/pinned-gone", pinned: true }),
        makeProject({ cwd: "~/works/recent-only", pinned: false }),
      ],
    );
    expect(rows).toEqual([
      { dead: false, session, extraSessions: [], pinned: false },
      { dead: true, cwd: "~/works/pinned-gone" },
    ]);
  });

  it("orders dead rows MRU-first", () => {
    const rows = projectRows(
      [],
      [
        makeProject({ cwd: "~/older", pinned: true, lastOpened: 10 }),
        makeProject({ cwd: "~/newer", pinned: true, lastOpened: 20 }),
      ],
    );
    expect(rows).toEqual([
      { dead: true, cwd: "~/newer" },
      { dead: true, cwd: "~/older" },
    ]);
  });

  it("merges same-path sessions into one row, first session primary", () => {
    const a = makeSession({ id: "$1", name: "app", path: "~/works/app" });
    const b = makeSession({ id: "$2", name: "app-2", path: "~/works/app" });
    const rows = projectRows([a, b], [makeProject({ cwd: "~/works/app", pinned: true })]);
    expect(rows).toEqual([{ dead: false, session: a, extraSessions: [b], pinned: true }]);
  });

  it("never merges across different paths", () => {
    const a = makeSession({ id: "$1", name: "app", path: "~/a/app" });
    const b = makeSession({ id: "$2", name: "app-2", path: "~/b/app" });
    const rows = projectRows([a, b], []);
    expect(rows).toEqual([
      { dead: false, session: a, extraSessions: [], pinned: false },
      { dead: false, session: b, extraSessions: [], pinned: false },
    ]);
  });

  it("never merges pathless sessions with each other", () => {
    const a = makeSession({ id: "$1", name: "x", path: "" });
    const b = makeSession({ id: "$2", name: "y", path: "" });
    const rows = projectRows([a, b], []);
    expect(rows).toEqual([
      { dead: false, session: a, extraSessions: [], pinned: false },
      { dead: false, session: b, extraSessions: [], pinned: false },
    ]);
  });
});
