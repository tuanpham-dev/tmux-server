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

// A repo scan is whole-repo work keyed by the repo ROOT, so every directory in
// the same repo produces the identical answer — yet it ran once per "/api/fs"
// request. The FILES tree re-lists the root plus every expanded folder on each
// 3s poll, in every open tab, so the same scan (three git forks, one of them a
// full working-tree walk) was recomputed dozens of times a second for an answer
// that hadn't changed. Cache it per root, briefly, and share one in-flight scan
// among every caller that asks while it runs.
//
// The TTL is short enough that badges still feel live on the 3s poll, and any
// filesystem mutation this server performs drops the cache outright
// (invalidateGitCache), so an edit made through the UI shows up immediately
// rather than waiting it out. Edits made OUTSIDE the app (an editor, a build)
// are picked up on the next poll after the TTL — same as before, within a
// second.
const STATUS_TTL_MS = 1000;
// dir -> repo root. Effectively immutable for a given directory, so this is
// cached far longer; it exists to kill the `git rev-parse` fork on every call.
const ROOT_TTL_MS = 30_000;
// getTrackedDirs' answer (a full `git ls-files` walk) only affects the
// "fully ignored vs. mixed" dimming distinction, and only changes when the
// index changes — a much longer TTL than STATUS_TTL_MS is safe here. A
// server-made mutation still invalidates immediately via invalidateGitCache;
// this only bounds staleness from commits/adds made outside the app.
const TRACKED_DIRS_TTL_MS = 30_000;

const rootCache = new Map<string, { at: number; root: string | null }>();
const statusCache = new Map<string, { at: number; value: RepoStatus | null }>();
const statusInFlight = new Map<string, Promise<RepoStatus | null>>();
const branchCache = new Map<string, { at: number; branch: string | null }>();
const trackedDirsCache = new Map<string, { at: number; dirs: Set<string> }>();

// Called after any mutation this server makes to a working tree (write, rename,
// delete, paste, upload) so the next listing reflects it without waiting out
// the TTL.
export function invalidateGitCache(): void {
  statusCache.clear();
  branchCache.clear();
  trackedDirsCache.clear();
}

async function repoRoot(anyDirInRepo: string): Promise<string | null> {
  const cached = rootCache.get(anyDirInRepo);
  if (cached && Date.now() - cached.at < ROOT_TTL_MS) return cached.root;
  let root: string | null;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], anyDirInRepo)).trim() || null;
  } catch {
    root = null;
  }
  rootCache.set(anyDirInRepo, { at: Date.now(), root });
  return root;
}

// Branch-only variant of getRepoStatuses, for callers that skip the (much
// more expensive) porcelain status scan but still want the branch pill
// populated — i.e. /api/fs?git=0 when the git-status setting is off.
export async function getRepoBranch(anyDirInRepo: string): Promise<string | null> {
  const root = await repoRoot(anyDirInRepo);
  if (!root) return null;
  const cached = branchCache.get(root);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.branch;
  let branch: string | null;
  try {
    branch = await getBranch(root);
  } catch {
    branch = null;
  }
  branchCache.set(root, { at: Date.now(), branch });
  return branch;
}

export interface RepoStatus {
  root: string;
  branch: string | null;
  statuses: Map<string, GitFileStatus>;
  trackedDirs: Set<string>;
  // Worst-status rollup per containing directory (see buildDirStatuses) —
  // precomputed once per scan so statusForEntry's directory case is a
  // single Map lookup instead of a scan over every changed path.
  dirStatuses: Map<string, GitFileStatus>;
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

// TRACKED_DIRS_TTL_MS-cached wrapper — the full `git ls-files` walk this
// backs is the most expensive part of getTrackedDirs, and its answer is
// stable far longer than a status scan's.
async function getTrackedDirsCached(root: string): Promise<Set<string>> {
  const cached = trackedDirsCache.get(root);
  if (cached && Date.now() - cached.at < TRACKED_DIRS_TTL_MS) return cached.dirs;
  const dirs = await getTrackedDirs(root);
  trackedDirsCache.set(root, { at: Date.now(), dirs });
  return dirs;
}

// Runs once per "/api/fs" request for whatever directory is being listed.
//
// Two separate git calls instead of one to avoid blowing past execFile's
// default 1 MB maxBuffer:
//
// 1. `git status --porcelain=v1 -z -uall` — modified/added/deleted/untracked.
//    -uall recurses into *untracked* directories so each file gets its own
//    badge; crucially it does NOT recurse into *ignored* directories, so
//    node_modules / dist / etc. never appear here at all. Output stays tiny.
//
// 2. `git ls-files -i --others --directory --exclude-standard -z` — ignored
//    directories only, one collapsed entry per directory (e.g. "node_modules/"),
//    never listing the files inside them. Tiny regardless of repo size.
//
// Previously a single `git status -uall --ignored=traditional` was used, but
// combining -uall with --ignored caused git to expand every file inside every
// ignored directory (node_modules, dist, .backups …) into individual "!! …"
// lines — easily producing 1 MB+ of output that made execFile throw silently.
export async function getRepoStatuses(anyDirInRepo: string): Promise<RepoStatus | null> {
  const root = await repoRoot(anyDirInRepo);
  if (!root) return null;

  const cached = statusCache.get(root);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const pending = statusInFlight.get(root);
  if (pending) return pending;

  const scan = scanRepoStatuses(root)
    .then((value) => {
      statusCache.set(root, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      statusInFlight.delete(root);
    });
  statusInFlight.set(root, scan);
  return scan;
}

async function scanRepoStatuses(root: string): Promise<RepoStatus | null> {
  // --- 1. modified / added / deleted / untracked (no ignored) ---
  let statusOut: string;
  try {
    statusOut = await git(["status", "--porcelain=v1", "-z", "-uall"], root);
  } catch {
    return null;
  }

  const statuses = new Map<string, GitFileStatus>();
  const tokens = statusOut.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const code = token.slice(0, 2);
    const filePath = token.slice(3).replace(/\/$/, "");
    statuses.set(filePath, classify(code));
    // Renames/copies emit the original path as a separate NUL-terminated
    // token right after; skip it so it isn't misread as its own entry.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      i++;
    }
  }

  // --- 2. ignored directories (collapsed, not expanded) ---
  // -i = --ignored, --others = show untracked/ignored, --directory = collapse
  // directory contents to a single trailing-slash entry.
  try {
    const ignoredOut = await git(
      ["ls-files", "-i", "--others", "--directory", "--exclude-standard", "-z"],
      root,
    );
    for (const token of ignoredOut.split("\0")) {
      if (!token) continue;
      // Strip trailing slash so directory keys match the rest of the map.
      statuses.set(token.replace(/\/$/, ""), "ignored");
    }
  } catch {
    // Ignored-dir detection is best-effort; a failure here doesn't break
    // the main status display.
  }

  const [branch, trackedDirs] = await Promise.all([getBranch(root), getTrackedDirsCached(root)]);
  const dirStatuses = buildDirStatuses(statuses);
  return { root, branch, statuses, trackedDirs, dirStatuses };
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

// Numeric rank matching PRIORITY's worst-first order — lower is worse, so
// an aggregate directory status is the *minimum* rank among any entry
// nested inside it.
const RANK: Record<GitFileStatus, number> = Object.fromEntries(
  PRIORITY.map((status, i) => [status, i]),
) as Record<GitFileStatus, number>;

// One rollup pass over the flat status map, run once per scan (not once per
// listDir entry — see statusForEntry below): each entry's status propagates
// up its ancestor chain as the worst aggregate status for every containing
// directory. Stops climbing a chain once it reaches an ancestor already at
// least as bad — dominance is transitive (an ancestor's aggregate is always
// at least as bad as any descendant directory's), so if this ancestor
// already reflects a status this bad or worse, whichever earlier entry
// caused that already propagated it past this point.
export function buildDirStatuses(statuses: Map<string, GitFileStatus>): Map<string, GitFileStatus> {
  const dirStatuses = new Map<string, GitFileStatus>();
  for (const [path, status] of statuses) {
    const rank = RANK[status];
    let idx = path.lastIndexOf("/");
    while (idx !== -1) {
      const dir = path.slice(0, idx);
      const current = dirStatuses.get(dir);
      if (current !== undefined && RANK[current] <= rank) break;
      dirStatuses.set(dir, status);
      idx = dir.lastIndexOf("/");
    }
  }
  return dirStatuses;
}

// relPath is the entry's path relative to the repo root. Checks for an exact
// match first, then falls back to nested matches: a directory looks up its
// precomputed worst-status rollup (dirStatuses, built once per scan by
// buildDirStatuses), while a file nested inside a collapsed ignored/
// untracked directory entry inherits that directory's status by walking its
// own ancestor chain — cheap since it's bounded by path depth, not the
// number of changed files.
export function statusForEntry(
  statuses: Map<string, GitFileStatus>,
  dirStatuses: Map<string, GitFileStatus>,
  trackedDirs: Set<string>,
  relPath: string,
  isDir: boolean,
): GitFileStatus | undefined {
  let result = statuses.get(relPath);
  if (!result) {
    if (isDir) {
      result = dirStatuses.get(relPath);
    } else {
      let idx = relPath.lastIndexOf("/");
      while (idx !== -1) {
        const dir = relPath.slice(0, idx);
        const candidate = statuses.get(dir);
        if (candidate !== undefined && (!result || RANK[candidate] < RANK[result])) {
          result = candidate;
        }
        idx = dir.lastIndexOf("/");
      }
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
