import { describe, expect, it } from "vitest";
import { buildDirStatuses, statusForEntry, type GitFileStatus } from "./git.js";

// Worst-first order, copied from git.ts's own PRIORITY — kept independent
// here so a change to git.ts's ordering can't silently make this reference
// agree with a broken implementation.
const REFERENCE_PRIORITY: GitFileStatus[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
  "ignored",
];

// The pre-T1 O(entries) implementation, kept verbatim as the source of
// truth for the new aggregate-based statusForEntry to agree with.
function referenceStatusForEntry(
  statuses: Map<string, GitFileStatus>,
  trackedDirs: Set<string>,
  relPath: string,
  isDir: boolean,
): GitFileStatus | undefined {
  let result = statuses.get(relPath);
  if (!result) {
    const dirPrefix = `${relPath}/`;
    for (const [p, status] of statuses) {
      const matches = isDir ? p.startsWith(dirPrefix) : relPath.startsWith(`${p}/`);
      if (!matches) continue;
      if (!result || REFERENCE_PRIORITY.indexOf(status) < REFERENCE_PRIORITY.indexOf(result)) {
        result = status;
      }
    }
  }
  if (isDir && result === "ignored" && trackedDirs.has(relPath)) return undefined;
  return result;
}

// Synthetic statuses map exercising: worst-status aggregation across mixed
// kinds, a collapsed ignored directory, a synthetic collapsed untracked
// directory (statusForEntry's inheritance logic is generic even though only
// "ignored" is ever collapsed in practice — see git.ts's ls-files -i call),
// an exact-match directory entry that also has nested (worse-ranked-lower)
// children, deep multi-level nesting, and both trackedDirs outcomes.
function buildFixture() {
  const statuses = new Map<string, GitFileStatus>([
    ["src/a.ts", "modified"],
    ["src/deep/b.ts", "untracked"],
    ["vendor", "conflicted"],
    ["vendor/x.ts", "modified"],
    ["node_modules", "ignored"],
    ["cache", "untracked"],
    ["onlyignored", "ignored"],
    ["mixedignored", "ignored"],
    ["a/b/c/d.ts", "modified"],
  ]);
  const trackedDirs = new Set<string>(["mixedignored"]);
  const dirStatuses = buildDirStatuses(statuses);
  return { statuses, trackedDirs, dirStatuses };
}

const CASES: Array<{ name: string; relPath: string; isDir: boolean }> = [
  { name: "worst-status aggregation across mixed kinds", relPath: "src", isDir: true },
  { name: "deep nesting — immediate parent", relPath: "a/b/c", isDir: true },
  { name: "deep nesting — grandparent", relPath: "a/b", isDir: true },
  { name: "deep nesting — great-grandparent", relPath: "a", isDir: true },
  { name: "file inherits collapsed ignored directory", relPath: "node_modules/pkg/index.js", isDir: false },
  { name: "file inherits collapsed untracked directory", relPath: "cache/tmp/file.log", isDir: false },
  { name: "exact directory entry wins over nested aggregate", relPath: "vendor", isDir: true },
  { name: "exact file entry nested under exact directory entry", relPath: "vendor/x.ts", isDir: false },
  { name: "fully ignored directory (not in trackedDirs) stays ignored", relPath: "onlyignored", isDir: true },
  { name: "ignored directory with tracked content resolves to undefined", relPath: "mixedignored", isDir: true },
  { name: "untouched directory", relPath: "does/not/exist", isDir: true },
  { name: "untouched file", relPath: "README.md", isDir: false },
];

describe("statusForEntry", () => {
  const { statuses, trackedDirs, dirStatuses } = buildFixture();

  for (const { name, relPath, isDir } of CASES) {
    it(`matches the reference implementation: ${name}`, () => {
      const actual = statusForEntry(statuses, dirStatuses, trackedDirs, relPath, isDir);
      const expected = referenceStatusForEntry(statuses, trackedDirs, relPath, isDir);
      expect(actual).toBe(expected);
    });
  }

  it("resolves the worst-status directory aggregation to the documented value", () => {
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "src", true)).toBe("modified");
  });

  it("propagates a deeply nested status to every ancestor", () => {
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "a", true)).toBe("modified");
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "a/b", true)).toBe("modified");
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "a/b/c", true)).toBe("modified");
  });

  it("exact directory entry status wins over its nested children's aggregate", () => {
    // vendor/x.ts alone would aggregate to "modified", but vendor's own
    // exact entry ("conflicted") must take precedence.
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "vendor", true)).toBe("conflicted");
  });

  it("dims a fully ignored directory but not a mixed one", () => {
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "onlyignored", true)).toBe("ignored");
    expect(statusForEntry(statuses, dirStatuses, trackedDirs, "mixedignored", true)).toBeUndefined();
  });
});

describe("buildDirStatuses", () => {
  it("aggregates the worst status per ancestor directory", () => {
    const { dirStatuses } = buildFixture();
    expect(dirStatuses.get("src")).toBe("modified");
    expect(dirStatuses.get("src/deep")).toBe("untracked");
    expect(dirStatuses.get("a")).toBe("modified");
    expect(dirStatuses.get("a/b")).toBe("modified");
    expect(dirStatuses.get("a/b/c")).toBe("modified");
    // vendor's aggregate reflects only its nested child, not its own exact entry.
    expect(dirStatuses.get("vendor")).toBe("modified");
  });

  it("never sets an entry for a top-level (slash-free) path", () => {
    const dirStatuses = buildDirStatuses(new Map([["README.md", "modified"]]));
    expect(dirStatuses.size).toBe(0);
  });
});
