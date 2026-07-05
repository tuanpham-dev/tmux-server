// Server hook for the git-scm extension — a VS Code-style SOURCE CONTROL
// panel. Plain ESM (no build step), like live-preview's server hook: the
// server runs under tsx in both dev and prod, so this loads as-is.
//
// cwd trusted the same way /api/fs is: this is a single-user local dev
// tool gated on Host/Origin (see server/src/security.ts), and the client
// always supplies cwd from its own already-trusted active context — no
// extra path allowlisting is layered on top here.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASKPASS_PATH = path.join(__dirname, "askpass.cjs");

const DEFAULT_TIMEOUT = 15000;
const NETWORK_TIMEOUT = 30000;

// opts.allowNonZeroExit: `git diff --no-index` exits 1 (not 0) when it
// finds differences — the expected case, not a failure — so the diff
// endpoint opts out of the reject-on-nonzero-exit default.
// opts.env: extra env vars layered onto GIT_TERMINAL_PROMPT=0, used by
// push/pull/sync to wire up GIT_ASKPASS + the one-shot credential pair.
function git(args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      },
      (err, stdout, stderr) => {
        if (err && !(opts.allowNonZeroExit && err.code === 1)) {
          const wrapped = new Error(stderr.trim() || err.message);
          wrapped.stderr = stderr;
          reject(wrapped);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// git execs GIT_ASKPASS directly as a program (no shell) — "node <path>"
// fails with "cannot exec", confirmed empirically — so this must point at
// an executable file (askpass.cjs's own shebang + exec bit) rather than a
// command-with-arguments string.
function credentialEnv(username, password) {
  if (!username && !password) return {};
  return {
    GIT_ASKPASS: ASKPASS_PATH,
    GIT_SCM_ASKPASS_USERNAME: username ?? "",
    GIT_SCM_ASKPASS_PASSWORD: password ?? "",
  };
}

// Git's exact wording varies by version/host; matching the common cases and
// degrading to a plain error display otherwise (see the plan's confirmed
// trade-off) rather than trying to enumerate every phrasing.
function isAuthFailure(message) {
  return /could not read (username|password)|authentication failed|terminal prompts disabled|invalid username or password/i.test(
    message,
  );
}

const STATUS_LETTERS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified" };

function classifyChar(ch) {
  return STATUS_LETTERS[ch] || "modified";
}

// Consumes exactly `count` space-separated fields from the front of a
// porcelain-v2 -z record, returning [fields, remainder] — the remainder is
// the path, which is itself never split further since it may legitimately
// contain spaces (porcelain -z never quotes paths).
function takeFields(token, count) {
  const fields = [];
  let rest = token;
  for (let i = 0; i < count; i++) {
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      fields.push(rest);
      rest = "";
    } else {
      fields.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }
  }
  return [fields, rest];
}

// Parses `git status --porcelain=v2 --branch -z` output. Record shapes
// (verified empirically against git 2.47, including a real merge conflict
// and a real ahead/behind upstream — porcelain v2's docs are terse enough
// that field counts are worth confirming rather than assuming):
//   "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"                (ordinary)
//   "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>" + NUL + origPath
//   "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"      (conflict)
//   "? <path>"                                                     (untracked)
// A file can appear in both staged and unstaged (e.g. "MM": staged
// modification with further unstaged edits on top) — X and Y are recorded
// independently rather than picking one "winning" status.
function parseStatus(raw) {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const unstaged = [];
  const conflicted = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("# branch.head ")) {
      const name = token.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (token.startsWith("# branch.upstream ")) {
      upstream = token.slice("# branch.upstream ".length);
    } else if (token.startsWith("# branch.ab ")) {
      const m = token.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (token.startsWith("#")) {
      // branch.oid or an unrecognized header — nothing this panel needs.
    } else if (token[0] === "1") {
      const [fields, filePath] = takeFields(token.slice(2), 7);
      const [x, y] = fields[0];
      if (x !== ".") staged.push({ path: filePath, status: classifyChar(x) });
      if (y !== ".") unstaged.push({ path: filePath, status: classifyChar(y) });
    } else if (token[0] === "2") {
      const [fields, filePath] = takeFields(token.slice(2), 8);
      const [x, y] = fields[0];
      // The orig path is a separate NUL-terminated token immediately
      // following this one, not embedded in it — confirmed empirically.
      const origPath = tokens[++i];
      if (x !== ".") {
        staged.push({
          path: filePath,
          origPath: x === "R" || x === "C" ? origPath : undefined,
          status: classifyChar(x),
        });
      }
      if (y !== ".") unstaged.push({ path: filePath, status: classifyChar(y) });
    } else if (token[0] === "u") {
      const [, filePath] = takeFields(token.slice(2), 9);
      conflicted.push({ path: filePath, status: "conflicted" });
    } else if (token[0] === "?") {
      unstaged.push({ path: token.slice(2), status: "untracked" });
    }
    // "!" (ignored) never appears — --ignored is never passed.
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  return {
    branch,
    upstream,
    ahead,
    behind,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    conflicted: conflicted.sort(byPath),
  };
}

function requireCwd(req, res) {
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : req.body?.cwd;
  if (!cwd || typeof cwd !== "string") {
    res.status(400).json({ error: "cwd is required" });
    return null;
  }
  return cwd;
}

function requirePaths(req, res) {
  const paths = req.body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "paths must be a non-empty array of strings" });
    return null;
  }
  return paths;
}

export function activate({ router, log }) {
  router.get("/status", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
      // -uall recurses into untracked directories so each file inside gets
      // its own row — default (--untracked-files=normal) collapses a whole
      // new directory into one "? dir/" entry instead, same trap the core
      // FILES tree's status call (server/src/git.ts) already works around.
      const raw = await git(["status", "--porcelain=v2", "--branch", "-uall", "-z"], root);
      res.json({ root, ...parseStatus(raw) });
    } catch {
      // Not a git repository — a plain empty-state response, not an error
      // (confirmed: no "Initialize Repository" affordance for v1).
      res.json({ root: null });
    }
  });

  router.post("/stage", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      await git(["add", "-A", "--", ...paths], cwd);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/unstage", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      try {
        await git(["reset", "-q", "HEAD", "--", ...paths], cwd);
      } catch {
        // Defensive fallback for git versions where HEAD doesn't resolve on
        // an unborn branch — the repo-with-no-commits-yet case.
        await git(["rm", "--cached", "-r", "--", ...paths], cwd);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scoped to unstaged (working-tree + untracked) changes only, matching
  // VS Code: a Staged Changes row offers Unstage, not Discard.
  router.post("/discard", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      // Untracked paths can't be `restore`d (they're not in the index or
      // HEAD); the client tells us which of the requested paths are
      // untracked so each gets the right command.
      const untracked = Array.isArray(req.body?.untracked)
        ? req.body.untracked.filter((p) => typeof p === "string")
        : [];
      const tracked = paths.filter((p) => !untracked.includes(p));
      if (tracked.length > 0) await git(["restore", "--worktree", "--", ...tracked], cwd);
      if (untracked.length > 0) await git(["clean", "-f", "--", ...untracked], cwd);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/commit", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "commit message is required" });
      return;
    }
    try {
      await git(["commit", "-m", message], cwd);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function currentBranch(cwd) {
    return (await git(["branch", "--show-current"], cwd)).trim();
  }

  async function runNetworkOp(cwd, username, password, kind) {
    const env = credentialEnv(username, password);
    if (kind === "pull") {
      await git(["pull", "--ff-only"], cwd, { env, timeout: NETWORK_TIMEOUT });
      return;
    }
    // push: auto-publish (`-u origin <branch>`) when no upstream is set yet
    // and an "origin" remote exists — mirrors VS Code's default publish
    // behavior — otherwise a plain push against the configured upstream.
    const status = parseStatus(await git(["status", "--porcelain=v2", "--branch", "-z"], cwd));
    if (!status.upstream) {
      try {
        await git(["remote", "get-url", "origin"], cwd);
      } catch {
        throw new Error("No upstream branch is configured, and no 'origin' remote exists to publish to.");
      }
      const branch = await currentBranch(cwd);
      await git(["push", "-u", "origin", branch], cwd, { env, timeout: NETWORK_TIMEOUT });
    } else {
      await git(["push"], cwd, { env, timeout: NETWORK_TIMEOUT });
    }
  }

  function networkHandler(kind) {
    return async (req, res) => {
      const cwd = requireCwd(req, res);
      if (!cwd) return;
      const { username, password } = req.body ?? {};
      try {
        if (kind === "sync") {
          await runNetworkOp(cwd, username, password, "pull");
          await runNetworkOp(cwd, username, password, "push");
        } else {
          await runNetworkOp(cwd, username, password, kind);
        }
        res.json({ ok: true });
      } catch (err) {
        const message = err.stderr || err.message;
        if (isAuthFailure(message)) {
          res.status(401).json({ error: message.trim(), authRequired: true });
        } else {
          res.status(500).json({ error: message });
        }
      }
    };
  }

  router.post("/push", networkHandler("push"));
  router.post("/pull", networkHandler("pull"));
  router.post("/sync", networkHandler("sync"));

  router.get("/diff", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const staged = req.query.staged === "1";
    const untracked = req.query.untracked === "1";
    const origPath = typeof req.query.origPath === "string" ? req.query.origPath : undefined;
    try {
      let diff;
      if (staged) {
        // Both pathspecs are required for a rename to actually render as a
        // rename — `git diff --cached -- newpath` alone shows a plain
        // "new file" diff instead, confirmed empirically.
        const pathArgs = origPath ? [origPath, filePath] : [filePath];
        diff = await git(["diff", "--cached", "--", ...pathArgs], cwd);
      } else if (untracked) {
        diff = await git(["diff", "--no-index", "--", "/dev/null", filePath], cwd, {
          allowNonZeroExit: true,
        });
      } else {
        diff = await git(["diff", "--", filePath], cwd);
      }
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  log("git-scm server hook active");
}
