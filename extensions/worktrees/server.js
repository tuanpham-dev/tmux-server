// Server hook for the worktrees extension — lists, creates, and removes git
// worktrees of the active repo. Plain ESM (no build step), like ports'/tasks'/
// git-scm's hooks: the server runs under tsx in both dev and prod, so this
// loads as-is.
//
// git and tmux are driven with execFile(cmd, [...]) — never a shell string —
// since branch names and paths are user data.
//
// This hook deliberately never *mutates* tmux. Its one tmux call is a read-only
// list-panes used to attribute sessions to worktrees; killing a session goes
// through the client's ctx.app.killSession so core closes the window-tab
// cascade (a raw `tmux kill-session` leaves window-tabs attached to the
// synthetic tmuxserver-view-* sessions whose shared windows outlive it).
//
// cwd/paths are trusted the same way /api/fs, git-scm, and tasks are: a
// single-user local dev tool gated on Host/Origin (server/src/security.ts),
// with cwd supplied by the client's already-trusted active context. The hard
// gates are on mutation: /create refuses a target that already exists, and
// /remove refuses any path git itself doesn't report as a worktree of this
// repo, and refuses the main worktree.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT = 15000;
const TMUX_TIMEOUT = 5000;

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const git = (args, cwd) => run("git", args, cwd, GIT_TIMEOUT);
const tmux = (args) => run("tmux", args, undefined, TMUX_TIMEOUT);

// Same phrasings core's emptyIfNoServer swallows: with no tmux server there is
// simply nothing to attribute.
function emptyIfNoServer(err) {
  if (/no server running|error connecting|no current target/i.test(err.message)) return "";
  throw err;
}

async function repoRoot(cwd) {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return null;
  }
}

// The shared .git directory (identical for every worktree of a repo, unlike
// --git-dir which points at .git/worktrees/<name> inside a linked worktree) —
// where info/exclude lives.
async function gitCommonDir(cwd) {
  const raw = (await git(["rev-parse", "--git-common-dir"], cwd)).trim();
  return path.resolve(cwd, raw);
}

// `git worktree list --porcelain` emits blank-line-separated records of
// "key value" lines: worktree <path>, HEAD <sha>, branch <ref> | detached,
// plus bare/locked/prunable markers. The first record is always the main
// worktree.
function parseWorktrees(raw) {
  const records = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const sep = line.indexOf(" ");
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1);
    if (key === "worktree") current = { path: value, branch: null, head: null, detached: false, locked: false, prunable: false };
    else if (!current) continue;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "HEAD") current.head = value;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) records.push(current);
  return records.map((wt, i) => ({ ...wt, main: i === 0 }));
}

async function isDirty(dir) {
  try {
    return (await git(["status", "--porcelain"], dir)).trim().length > 0;
  } catch {
    // A worktree whose directory is gone (prunable) can't be statted — not
    // dirty as far as the UI is concerned; the prunable flag already tells
    // that story.
    return false;
  }
}

// Local branches, each with the worktree currently checked out at it (empty
// when none) — drives the create form's "existing branch" picker, which must
// exclude branches already checked out somewhere (git refuses those).
async function listBranches(cwd) {
  try {
    const raw = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)\t%(worktreepath)"], cwd);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, worktreePath] = line.split("\t");
        return { name, checkedOutAt: worktreePath || null };
      });
  } catch {
    // %(worktreepath) needs git >= 2.23; degrade to names only rather than
    // failing the whole listing.
    try {
      const raw = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)"], cwd);
      return raw
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name, checkedOutAt: null }));
    } catch {
      return [];
    }
  }
}

// Which tmux session (if any) is working inside each worktree: a session owns
// a worktree when any of its panes' cwd is at or under that worktree's path.
// Read-only — see this file's header on why mutation never happens here.
async function sessionsByPath(worktrees) {
  const owners = new Map();
  let raw;
  try {
    raw = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"]).catch(emptyIfNoServer);
  } catch {
    return owners;
  }
  // Longest path first: the default location nests worktrees *inside* the
  // repo, so a pane in .worktrees/feature also matches the main worktree's
  // prefix. The most specific match is the real owner.
  const bySpecificity = [...worktrees].sort((a, b) => b.path.length - a.path.length);
  const candidates = new Map();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [session, paneCwd] = line.split("\t");
    // Synthetic per-window-tab sessions mirror a real session's panes; they'd
    // otherwise show up as a second, internal-looking owner.
    if (!session || session.startsWith("tmuxserver-view-") || !paneCwd) continue;
    for (const wt of bySpecificity) {
      if (paneCwd === wt.path || paneCwd.startsWith(wt.path + path.sep)) {
        const seen = candidates.get(wt.path);
        if (seen) seen.add(session);
        else candidates.set(wt.path, new Set([session]));
        break;
      }
    }
  }
  // Several sessions can share one worktree (most often the main one — every
  // session started in the repo lands there). Show the one this panel would
  // have created for that branch when it exists, so the row's chip and its
  // click target don't depend on tmux's listing order.
  for (const wt of worktrees) {
    const sessions = candidates.get(wt.path);
    if (!sessions) continue;
    const preferred = wt.branch ? sessionNameFor(wt.branch) : null;
    owners.set(wt.path, preferred && sessions.has(preferred) ? preferred : [...sessions][0]);
  }
  return owners;
}

// Path segment for a branch: "feature/x" would otherwise nest a directory.
function branchSlug(branch) {
  return branch.replace(/[/\\]/g, "-");
}

// The session name the panel proposes for a branch. Must stay byte-identical
// to src/client.tsx's own sessionNameFor — the two are compared against each
// other when attributing a session to a worktree.
function sessionNameFor(branch) {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveLocation(template, repo, branch) {
  const filled = template
    .replaceAll("{repo}", repo)
    .replaceAll("{branch}", branchSlug(branch));
  return path.resolve(repo, filled);
}

// Keeps an in-repo worktree directory out of `git status` without touching the
// user's committed .gitignore: info/exclude is repo-local and never committed.
// The pattern is the top folder of the resolved location ("/.worktrees/"), or
// the exact relative path when the location sits directly in the repo root.
async function ensureExcluded(repo, target) {
  const rel = path.relative(repo, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const top = rel.split(path.sep)[0];
  const pattern = rel === top ? `/${top}` : `/${top}/`;
  let excludeFile;
  try {
    excludeFile = path.join(await gitCommonDir(repo), "info", "exclude");
  } catch {
    return;
  }
  let current = "";
  try {
    current = fs.readFileSync(excludeFile, "utf8");
  } catch {
    // No info/exclude yet (or unreadable) — created below.
  }
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludeFile, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort: a read-only .git shouldn't block creating the worktree.
  }
}

// `git worktree remove` deletes the checkout but not the folder holding it, so
// the default "{repo}/.worktrees/{branch}" location leaves an empty
// .worktrees/ behind once the last one goes. Removes that container when it is
// inside the repo, isn't the repo root itself, and is empty — anything else is
// left alone.
function pruneEmptyContainer(repo, worktreePath) {
  const parent = path.dirname(worktreePath);
  const rel = path.relative(repo, parent);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    // Not empty, not there, or not ours to remove — nothing to clean up.
  }
}

export function activate({ router, log, getSettings }) {
  // Every worktree of the repo containing ?cwd, with dirty/session state, plus
  // the local branches the create form offers. repo: null means "not a git
  // repo" — the panel renders its empty state rather than an error.
  router.get("/list", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.json({ repo: null, worktrees: [], branches: [] });
      return;
    }
    try {
      const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], repo));
      const owners = await sessionsByPath(worktrees);
      const withState = await Promise.all(
        worktrees.map(async (wt) => ({
          ...wt,
          dirty: await isDirty(wt.path),
          session: owners.get(wt.path) ?? null,
        })),
      );
      res.json({ repo, worktrees: withState, branches: await listBranches(repo) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creates a worktree for `branch` — a new branch off `base` (mode "new") or
  // an existing one (mode "existing") — at the configured location. The
  // session itself is created client-side via ctx.app.openSessionWindow, so
  // this route stops at the checkout.
  router.post("/create", async (req, res) => {
    const { cwd, branch, base, mode } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    const settings = await getSettings();
    const template =
      typeof settings["worktrees.location"] === "string" && settings["worktrees.location"].trim()
        ? settings["worktrees.location"].trim()
        : "{repo}/.worktrees/{branch}";
    const target = resolveLocation(template, repo, branch.trim());
    if (fs.existsSync(target)) {
      res.status(409).json({ error: `${target} already exists` });
      return;
    }
    await ensureExcluded(repo, target);
    const args =
      mode === "existing"
        ? ["worktree", "add", target, branch.trim()]
        : ["worktree", "add", "-b", branch.trim(), target, ...(typeof base === "string" && base.trim() ? [base.trim()] : [])];
    try {
      await git(args, repo);
      log?.(`created worktree ${target} (${branch.trim()})`);
      res.json({ path: target, branch: branch.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Removes a worktree's checkout, keeping its branch — deleting branches is a
  // separate, git-scm-sized decision. Any session inside it is expected to have
  // been killed client-side first (ctx.app.killSession).
  router.post("/remove", async (req, res) => {
    const { cwd, path: target, force } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof target !== "string" || !path.isAbsolute(target)) {
      res.status(400).json({ error: "cwd and path (absolute paths) are required" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    let worktrees;
    try {
      worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], repo));
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // The gate: only a path git itself reports as a worktree of this repo can
    // be removed, and never the main one.
    const match = worktrees.find((wt) => path.resolve(wt.path) === path.resolve(target));
    if (!match) {
      res.status(404).json({ error: `${target} is not a worktree of ${repo}` });
      return;
    }
    if (match.main) {
      res.status(400).json({ error: "the main worktree can't be removed" });
      return;
    }
    try {
      await git(["worktree", "remove", ...(force ? ["--force"] : []), match.path], repo);
      await git(["worktree", "prune"], repo).catch(() => {});
      pruneEmptyContainer(repo, match.path);
      log?.(`removed worktree ${match.path}`);
      res.json({ removed: match.path });
    } catch (err) {
      // git's own message names the reason (dirty tree, locked, …); the panel
      // offers the force retry off the back of it.
      res.status(500).json({ error: err.message });
    }
  });
}
