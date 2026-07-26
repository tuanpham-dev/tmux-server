// Server hook for the tasks extension — discovers package.json scripts across
// the active directory's workspace and runs them in named tmux windows. Plain
// ESM (no build step), like ports'/git-scm's hooks: the server runs under tsx
// in both dev and prod, so this loads as-is.
//
// tmux is driven with execFile("tmux", [...]) — never a shell string — since
// window names and script names are user data. Core's tmux helpers are
// deliberately not imported: extensions talk only to their activate() context,
// so the "no server running" tolerance below is this extension's own copy of
// core's emptyIfNoServer.
//
// cwd/dir are trusted the same way /api/fs and git-scm are: a single-user local
// dev tool gated on Host/Origin (server/src/security.ts), with cwd supplied by
// the client's already-trusted active context. The one hard gate is /run, which
// only ever types a script that is declared in the target package.json.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

const TMUX_TIMEOUT = 5000;

// A window whose foreground process is one of these is sitting at a prompt —
// the script it was created for has exited, so it can be re-typed into rather
// than replaced.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

// Script names are typed into a shell, so anything outside this set has to be
// quoted (see shellQuote in extensions/ports/src/client.tsx for the same idiom).
const BARE_SCRIPT = /^[A-Za-z0-9_.:-]+$/;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// Same three phrasings core's emptyIfNoServer swallows: with no tmux server (or
// no session for "-t" to resolve against) there is simply nothing to list.
function emptyIfNoServer(err) {
  if (/no server running|error connecting|no current target/i.test(err.message)) return "";
  throw err;
}

// POSIX single-quoting: close, escape, reopen ('\'') — the only form that is
// safe for every byte a script name can contain.
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Must match byte-for-byte between /scripts (running detection) and /run
// (window lookup) — the name IS the handle on a task's window.
function taskWindowName(script, dir) {
  return `${script} [${path.basename(dir)}]`;
}

// null for a missing or malformed package.json — a directory whose manifest
// can't be parsed is treated as "not a package" rather than failing the
// whole request.
function readPackage(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPackage(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

function findNearestPackageJson(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (hasPackage(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspacePatterns(pkg) {
  const field = pkg?.workspaces;
  if (Array.isArray(field)) return field.filter((p) => typeof p === "string");
  if (field && typeof field === "object" && Array.isArray(field.packages)) {
    return field.packages.filter((p) => typeof p === "string");
  }
  return null;
}

// The workspace root is the nearest ancestor (fromDir itself included — the
// root package is also a package) declaring `workspaces`; null means fromDir
// stands alone.
function findWorkspaceRoot(fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const pkg = readPackage(dir);
    if (pkg && workspacePatterns(pkg)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

// Lockfiles live at the workspace root, so detection is always anchored there
// (callers pass the root when there is one, the lone package otherwise).
function detectPackageManager(rootDir) {
  for (const [file, pm] of LOCKFILES) {
    if (fs.existsSync(path.join(rootDir, file))) return pm;
  }
  return "npm";
}

// Workspace globs are expanded per the npm/yarn convention: positive patterns
// match candidate directories, "!" patterns subtract from them. node_modules is
// always excluded — a pattern like "packages/**" would otherwise both walk and
// match vendored packages.
async function expandWorkspaces(root, patterns) {
  const positive = patterns.filter((p) => !p.startsWith("!"));
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  if (positive.length === 0) return [];
  let matches;
  try {
    matches = await fg(positive, {
      cwd: root,
      onlyDirectories: true,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ["**/node_modules/**", ...negative],
    });
  } catch {
    return [];
  }
  // path.resolve normalizes away any trailing separator so dirs compare equal
  // to the walk-up results.
  return matches.map((m) => path.resolve(m)).filter(hasPackage);
}

function describePackage(dir, root, activeDir, runningNames) {
  const pkg = readPackage(dir) ?? {};
  const scripts = Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => typeof command === "string")
    .map(([name, command]) => ({
      name,
      command,
      running: runningNames.has(taskWindowName(name, dir)),
    }));
  return {
    dir,
    name: typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(dir),
    relDir: path.relative(root, dir) || ".",
    active: dir === activeDir,
    scripts,
  };
}

function parseWindows(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [windowId, windowName, paneId, command] = line.split("\t");
      return { windowId, windowName, paneId, command };
    });
}

// One list-windows per request answers both "is this script running" for every
// row and "which window do I reuse" for /run. "=<session>:" pins the target to
// an exact session name (no fnmatch/prefix fallback).
async function listWindows(session) {
  const raw = await tmux([
    "list-windows",
    "-t",
    `=${session}:`,
    "-F",
    "#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_command}",
  ]).catch(emptyIfNoServer);
  return parseWindows(raw);
}

function isRunning(win) {
  return !SHELLS.has(win.command);
}

async function sendCommand(paneId, command) {
  // -l types the line literally (no key-name interpretation); Enter is a
  // separate call because a literal send can't also carry a key name.
  await tmux(["send-keys", "-t", paneId, "-l", command]);
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

export function activate({ router, log }) {
  // Every package the active directory's workspace contains, with per-script
  // running flags. session is optional: without it nothing is "running", which
  // is also the degraded answer when tmux can't be queried at all.
  router.get("/scripts", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    const session = typeof req.query.session === "string" ? req.query.session : "";

    try {
      const nearestDir = findNearestPackageJson(cwd);
      if (!nearestDir) {
        res.json({ packageManager: null, packages: [] });
        return;
      }
      const workspaceRoot = findWorkspaceRoot(nearestDir);
      const root = workspaceRoot ?? nearestDir;

      const runningNames = new Set();
      if (session) {
        try {
          for (const win of await listWindows(session)) {
            if (isRunning(win)) runningNames.add(win.windowName);
          }
        } catch {
          // tmux unavailable/erroring — every row degrades to running:false.
        }
      }

      const dirs = [];
      if (workspaceRoot) {
        const members = await expandWorkspaces(root, workspacePatterns(readPackage(root)) ?? []);
        // The active package is kept even when no workspace glob covers it —
        // it is the one package the user is certainly looking at.
        const unique = new Set([...members, nearestDir]);
        unique.delete(root);
        dirs.push(
          ...[...unique]
            .map((dir) => describePackage(dir, root, nearestDir, runningNames))
            .sort((a, b) => a.relDir.localeCompare(b.relDir)),
        );
      }
      // Root package first, members after it in relDir order.
      dirs.unshift(describePackage(root, root, nearestDir, runningNames));

      res.json({ packageManager: detectPackageManager(root), packages: dirs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Runs a declared script in its own tmux window, reusing the window from a
  // previous run when the name still matches: a live script is only switched
  // to, a finished one is re-typed into (typing into the surviving shell keeps
  // the previous output scrollback alive, unlike `new-window <command>`).
  router.post("/run", async (req, res) => {
    const { session, dir, script } = req.body ?? {};
    if (typeof session !== "string" || !session || typeof dir !== "string" || !path.isAbsolute(dir) || typeof script !== "string" || !script) {
      res.status(400).json({ error: "session, dir (absolute path), and script are required" });
      return;
    }

    const pkg = readPackage(dir);
    // The security gate: only scripts the package itself declares are ever
    // typed into a shell.
    if (!pkg || typeof pkg.scripts?.[script] !== "string") {
      res.status(404).json({ error: `no script "${script}" in ${dir}/package.json` });
      return;
    }

    const pm = detectPackageManager(findWorkspaceRoot(dir) ?? dir);
    const command = `${pm} run ${BARE_SCRIPT.test(script) ? script : shellQuote(script)}`;
    const name = taskWindowName(script, dir);

    try {
      const existing = (await listWindows(session)).find((win) => win.windowName === name);
      if (existing) {
        // "=session:@id", not the bare window id: task windows are shared
        // into grouped view sessions (tmuxserver-view-*), and a bare id
        // resolves against tmux's own "current session" — observed selecting
        // the window inside a view session while the real session stayed put.
        // Same targeting rule as core selectWindowById (server/src/tmux.ts).
        if (isRunning(existing)) {
          await tmux(["select-window", "-t", `=${session}:${existing.windowId}`]);
          res.json({ reused: true, running: true });
          return;
        }
        await sendCommand(existing.paneId, command);
        await tmux(["select-window", "-t", `=${session}:${existing.windowId}`]);
        res.json({ reused: true, running: false });
        return;
      }
      // -n pins the name (tmux turns automatic-rename off for it), which is
      // what makes the reuse match survive across runs; new-window selects the
      // window it creates.
      const paneId = (
        await tmux(["new-window", "-t", `=${session}:`, "-c", dir, "-n", name, "-P", "-F", "#{pane_id}"])
      ).trim();
      await sendCommand(paneId, command);
      res.json({ reused: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  log("tasks server hook active");
}
