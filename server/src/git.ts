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
}

// Runs once per "/api/fs" request for whatever directory is being listed.
// Uses -z so paths with spaces/special chars come back unquoted and
// NUL-delimited instead of needing C-style unescaping. Untracked files are
// expanded individually (-uall) for per-file badges, but ignored paths use
// "traditional" mode so an ignored directory (e.g. node_modules) is reported
// as a single entry instead of git recursing through every file inside it.
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
  const branch = await getBranch(root);
  return { root, branch, statuses };
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
  relPath: string,
  isDir: boolean,
): GitFileStatus | undefined {
  const exact = statuses.get(relPath);
  if (exact) return exact;
  const dirPrefix = `${relPath}/`;
  let best: GitFileStatus | undefined;
  for (const [p, status] of statuses) {
    const matches = isDir ? p.startsWith(dirPrefix) : relPath.startsWith(`${p}/`);
    if (!matches) continue;
    if (!best || PRIORITY.indexOf(status) < PRIORITY.indexOf(best)) best = status;
  }
  return best;
}
