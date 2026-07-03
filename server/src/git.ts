import { execFile } from "node:child_process";

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflicted"
  | "ignored";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function classify(code: string): GitFileStatus {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  const [index, work] = code;
  if (
    index === "U" ||
    work === "U" ||
    (index === "A" && work === "A") ||
    (index === "D" && work === "D")
  ) {
    return "conflicted";
  }
  if (index === "R" || work === "R") return "renamed";
  if (index === "D" || work === "D") return "deleted";
  if (index === "A" || work === "A" || index === "C" || work === "C") return "added";
  return "modified";
}

// "branch --show-current" prints nothing (without erroring) for a detached
// HEAD, so fall back to a short commit hash in that case.
async function getBranch(root: string): Promise<string | null> {
  let branch: string;
  try {
    branch = (await git(["branch", "--show-current"], root)).trim();
  } catch {
    return null;
  }
  if (branch) return branch;
  try {
    return (await git(["rev-parse", "--short", "HEAD"], root)).trim();
  } catch {
    return null;
  }
}

export interface RepoStatus {
  root: string;
  branch: string | null;
  statuses: Map<string, GitFileStatus>;
  trackedDirs: Set<string>;
}

// Every ancestor directory (relative to root, no trailing slash) that
// contains at least one tracked file. Used to tell a directory that's
// genuinely fully ignored (e.g. "client/dist", never tracked) apart from one
// that merely has some ignored content mixed in with tracked files.
async function getTrackedDirs(root: string): Promise<Set<string>> {
  let out: string;
  try {
    out = await git(["ls-files", "-z"], root);
  } catch {
    return new Set();
  }
  const dirs = new Set<string>();
  for (const token of out.split("\0")) {
    if (!token) continue;
    let idx = token.lastIndexOf("/");
    while (idx !== -1) {
      const dir = token.slice(0, idx);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      idx = dir.lastIndexOf("/");
    }
  }
  return dirs;
}

// Runs once per "/api/fs" request for whatever directory is being listed.
// Uses -z so paths with spaces/special chars come back unquoted and
// NUL-delimited instead of needing C-style unescaping. -uall expands both
// untracked and ignored directories into their individual files (so no
// directory is ever collapsed into a single "!!"/"??" entry here), which is
// what per-file badges need; statusForEntry's trackedDirs check is what
// keeps a merely-mixed directory from reading as fully ignored.
export async function getRepoStatuses(anyDirInRepo: string): Promise<RepoStatus | null> {
  let root: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], anyDirInRepo)).trim();
  } catch {
    return null;
  }
  if (!root) return null;

  let out: string;
  try {
    out = await git(
      ["status", "--porcelain=v1", "-z", "-uall", "--ignored=traditional"],
      root,
    );
  } catch {
    return null;
  }

  const statuses = new Map<string, GitFileStatus>();
  const tokens = out.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const code = token.slice(0, 2);
    // Collapsed untracked/ignored directories are reported with a trailing
    // slash (e.g. "!! node_modules/"); strip it so directory entries key the
    // same way as files.
    const filePath = token.slice(3).replace(/\/$/, "");
    statuses.set(filePath, classify(code));
    // Renames/copies emit the original path as a separate NUL-terminated
    // token right after; skip it so it isn't misread as its own entry.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      i++;
    }
  }
  const [branch, trackedDirs] = await Promise.all([getBranch(root), getTrackedDirs(root)]);
  return { root, branch, statuses, trackedDirs };
}

// Lists every file under dirPath that isn't gitignored (tracked +
// untracked), for the quick switcher's file search. Returns null when
// dirPath isn't inside a git repo, so callers can fall back to a plain
// directory walk. Run with cwd = dirPath (not the repo root) so git scopes
// and returns paths relative to dirPath itself, matching what the fallback
// walker would produce for the same directory.
export async function listRepoFiles(
  dirPath: string,
  cap: number,
): Promise<{ files: string[]; truncated: boolean } | null> {
  try {
    await git(["rev-parse", "--show-toplevel"], dirPath);
  } catch {
    return null;
  }

  let out: string;
  try {
    out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], dirPath);
  } catch {
    return null;
  }

  const files: string[] = [];
  let truncated = false;
  for (const token of out.split("\0")) {
    if (!token) continue;
    if (files.length >= cap) {
      truncated = true;
      break;
    }
    files.push(token);
  }
  return { files, truncated };
}

// Worst-first tie-break when a directory contains changes of several kinds.
const PRIORITY: GitFileStatus[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
  "ignored",
];

// relPath is the entry's path relative to the repo root. Checks for an exact
// match first, then falls back to nested matches in either direction: a
// directory aggregates the "worst" status among any changed path inside it,
// while a file nested inside a collapsed ignored/untracked directory
// inherits that directory's status.
export function statusForEntry(
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
      if (!result || PRIORITY.indexOf(status) < PRIORITY.indexOf(result)) result = status;
    }
  }
  // A directory is only dimmed as "ignored" when it's fully covered by
  // .gitignore. `git status -uall` always expands ignored directories into
  // their individual files rather than collapsing them, so a directory that
  // merely contains some ignored files/subfolders alongside ordinary tracked
  // content would otherwise resolve to "ignored" too (nothing else in the
  // sparse status map outranks it, since clean tracked files never appear
  // there at all). Checking for tracked descendants tells the two apart.
  if (isDir && result === "ignored" && trackedDirs.has(relPath)) return undefined;
  return result;
}
