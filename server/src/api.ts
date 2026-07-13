import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Router, type Response } from "express";
import {
  ConflictError,
  createEmptyFile,
  deletePath,
  ensureDir,
  exists,
  expandHome,
  isDirectory,
  isFile,
  listDir,
  renamePath,
  resolveDestination,
  uniquePath,
  walkFiles,
} from "./files.js";
import {
  extensionHookMiddleware,
  installFromTsixFile,
  listExtensions,
  resolveExtensionFile,
  setExtensionEnabled,
  uninstallExtension,
} from "./extensions.js";
import { getRepoBranch, getRepoStatuses, listRepoFiles, statusForEntry } from "./git.js";
import { findTmuxPort, listTmuxPorts } from "./ports.js";
import { getRegistryCatalog, getRegistryIcon, getRegistryReadme, resolveTsixForInstall } from "./registry.js";
import { primaryProxyDomain } from "./security.js";
import { mergeSettingsDoc, readSettingsDoc, writeSettingsDoc } from "./settingsStore.js";
import {
  createSession,
  createWindow,
  createWindowTab,
  killSession,
  killWindow,
  killWindowTab,
  listSessions,
  openFileInPaneWithKeys,
  openLazygitWindow,
  openFileInWindow,
  paneCurrentPath,
  renameSession,
  renameWindow,
  selectWindow,
} from "./tmux.js";

export const api = Router();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendFsError(res: Response, err: unknown): void {
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
  } else {
    res.status(400).json({ error: errMessage(err) });
  }
}

api.get("/sessions", async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/sessions", async (req, res) => {
  const name = typeof req.body?.name === "string" && req.body.name.trim() !== ""
    ? req.body.name.trim()
    : undefined;
  // Optional cwd from the client's "default new session dir" setting. The
  // setting can point at a path that doesn't exist (typo, different
  // machine) — fall back to the server default rather than failing the
  // create over a preference.
  const rawCwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  let cwd: string | undefined;
  if (rawCwd) {
    const expanded = expandHome(rawCwd);
    if (await isDirectory(expanded)) cwd = expanded;
  }
  try {
    res.status(201).json(await createSession(name, cwd));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Settings persistence: one JSON document, client-owned schema (see
// settingsStore.ts). Lives under /api so the host/origin guards apply.
// PUT replaces the whole document (standard PUT semantics — the body IS
// the new representation); PATCH deep-merges the body over the on-disk
// document instead, so a caller sending a partial body can't silently drop
// every sibling key it didn't mention. The client's own write-back
// (useSettingsSync.ts) already fetch-merges client-side before calling PUT
// with the complete doc, so it's unaffected either way — PATCH exists for
// callers that want to send just what changed.
api.get("/settings", async (_req, res) => {
  try {
    res.json(await readSettingsDoc());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.put("/settings", async (req, res) => {
  try {
    await writeSettingsDoc(req.body);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.patch("/settings", async (req, res) => {
  try {
    await mergeSettingsDoc(req.body);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Extensions: manifests discovered under ~/.config/tmux-server/extensions/.
// See extensions.ts for the format and security posture (running an
// extension's server hook is running code as the server user — same threat
// model as the terminal this app already gives you).
api.get("/extensions", async (_req, res) => {
  try {
    res.json(await listExtensions());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/extensions/install", async (req, res) => {
  const tmpPath = path.join(tmpdir(), `tmux-server-upload-${randomUUID()}.tsix`);
  const out = createWriteStream(tmpPath);
  req.pipe(out);
  out.on("finish", async () => {
    try {
      res.status(201).json(await installFromTsixFile(tmpPath));
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
    }
  });
  out.on("error", (err) => {
    unlink(tmpPath).catch(() => {});
    res.status(500).json({ error: errMessage(err) });
  });
  req.on("error", (err) => {
    out.destroy();
    unlink(tmpPath).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
  });
});

api.delete("/extensions/:id", async (req, res) => {
  try {
    await uninstallExtension(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/extensions/:id/enabled", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  try {
    res.json(await setExtensionEnabled(req.params.id, req.body.enabled));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Serves an extension's own files (theme JSON, icon fonts/SVGs, the client
// JS entry point) — resolveExtensionFile rejects traversal outside the
// extension's folder the same way resolveDestination does for the FILES
// panel.
api.get("/extensions/:id/file/*", async (req, res) => {
  const relPath = (req.params as unknown as { 0: string })[0] ?? "";
  const target = await resolveExtensionFile(req.params.id, relPath);
  if (!target) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "file not found" });
  });
});

// Dispatches to a live extension's server hook router, or 404 if the
// extension has none/is disabled — see extensions.ts's serverHooks map.
api.use("/ext/:extId", extensionHookMiddleware);

// Extension registries: user-configured sources (settings doc's
// extensionRegistries) each serving an index.json catalog of installable
// extensions — see registry.ts for the source/entry resolution and its
// security posture (every request re-validates source against the current
// settings doc; no client-supplied path/URL is ever read directly).
api.get("/registry", async (req, res) => {
  // See getRegistryCatalog's doc: an optional client-supplied source list,
  // sidestepping the settings doc's debounced write-back.
  let sourcesOverride: string[] | undefined;
  if (typeof req.query.sources === "string") {
    try {
      const parsed: unknown = JSON.parse(req.query.sources);
      if (Array.isArray(parsed) && parsed.every((s): s is string => typeof s === "string")) {
        sourcesOverride = parsed;
      }
    } catch {
      // Malformed sources param — fall back to the persisted settings doc.
    }
  }
  try {
    res.json({ sources: await getRegistryCatalog(req.query.refresh === "1", sourcesOverride) });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/registry/install", async (req, res) => {
  const { source, id } = req.body ?? {};
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    const tsixPath = await resolveTsixForInstall(source, id);
    res.status(201).json(await installFromTsixFile(tsixPath));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.get("/registry/readme", async (req, res) => {
  const { source, id } = req.query;
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    res.type("text/markdown").send(await getRegistryReadme(source, id));
  } catch (err) {
    res.status(404).json({ error: errMessage(err) });
  }
});

api.get("/registry/icon", async (req, res) => {
  const { source, id } = req.query;
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    const { data, contentType } = await getRegistryIcon(source, id);
    res.type(contentType).send(data);
  } catch (err) {
    res.status(404).json({ error: errMessage(err) });
  }
});

api.delete("/sessions/:name", async (req, res) => {
  try {
    await killSession(req.params.name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows", async (req, res) => {
  const cwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  try {
    const index = await createWindow(req.params.name, cwd);
    res.status(201).json({ index });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/lazygit", async (req, res) => {
  const cwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  try {
    res.json({ index: await openLazygitWindow(req.params.name, cwd) });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/select", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    await selectWindow(req.params.name, index);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/open-tab", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    const attachName = await createWindowTab(req.params.name, index);
    res.status(201).json({ attachName });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.delete("/window-views/:attachName", async (req, res) => {
  try {
    await killWindowTab(req.params.attachName);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/rename", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  const newName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!newName) {
    res.status(400).json({ error: "new name is required" });
    return;
  }
  try {
    await renameWindow(req.params.name, index, newName);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.delete("/sessions/:name/windows/:index", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    await killWindow(req.params.name, index);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/rename", async (req, res) => {
  const newName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!newName) {
    res.status(400).json({ error: "new name is required" });
    return;
  }
  try {
    await renameSession(req.params.name, newName);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/open-file", async (req, res) => {
  const raw = typeof req.body?.path === "string" ? req.body.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const filePath = expandHome(raw);
  const keysPane = typeof req.body?.keysPane === "string" ? req.body.keysPane : null;
  // Ctrl+click on a "file:line" terminal link (see resolve-paths below) —
  // only a positive integer is honored, anything else opens without a jump.
  const line =
    typeof req.body?.line === "number" && Number.isInteger(req.body.line) && req.body.line > 0
      ? req.body.line
      : undefined;
  try {
    if (!(await isFile(filePath))) {
      res.status(400).json({ error: "path is not a file" });
      return;
    }
    // keysPane completes a deferred open (see OpenFileResult.deferredPane):
    // the client already surfaced that pane's window/tab, so it's now safe
    // to inject the keystrokes the initial scan held back.
    if (keysPane) {
      await openFileInPaneWithKeys(keysPane, filePath, line);
      res.status(200).json({ windowIndex: null });
      return;
    }
    const result = await openFileInWindow(req.params.name, filePath, line);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Validates terminal-link file-path candidates for the ctrl+click link
// provider (see client/src/terminalLinks.ts): relative candidates resolve
// against the session's active pane cwd (mirroring createWindow's own
// #{pane_current_path} lookup), then each is checked with isFile so only
// real files become clickable — a path-shaped string in scrollback output
// (e.g. a comment, a log line) never turns into a false-positive link.
api.post("/sessions/:name/resolve-paths", async (req, res) => {
  const candidates = Array.isArray(req.body?.paths)
    ? req.body.paths.filter((p: unknown): p is string => typeof p === "string")
    : [];
  try {
    const cwd = await paneCurrentPath(req.params.name);
    const results = await Promise.all(
      candidates.map(async (raw: string) => {
        const expanded = expandHome(raw);
        const abs = path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
        return (await isFile(abs)) ? abs : null;
      }),
    );
    res.status(200).json({ results });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.get("/ports", async (_req, res) => {
  try {
    res.json(await listTmuxPorts());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// What the PORTS panel needs to build a proxy URL for a port — currently
// just the first configured PROXY_DOMAIN, if any (see security.ts). No
// domain means the panel falls back to /proxy/<port>/ on the app's own
// origin.
api.get("/proxy-config", (_req, res) => {
  res.json({ domain: primaryProxyDomain() });
});

const KILL_GRACE_MS = 5_000;

api.post("/ports/:port/kill", async (req, res) => {
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: "invalid port" });
    return;
  }
  const entry = await findTmuxPort(port);
  if (!entry || entry.pid === undefined) {
    res.status(404).json({ error: "port not found in tmux sessions" });
    return;
  }
  const pid = entry.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
    return;
  }
  res.status(204).end();
  // Grace period for a clean shutdown; escalate to SIGKILL only if the same
  // pid is still holding the port afterward (an already-exited or since-
  // reused pid is left alone).
  setTimeout(() => {
    findTmuxPort(port)
      .then((stillThere) => {
        if (stillThere?.pid === pid) process.kill(pid, "SIGKILL");
      })
      .catch(() => {});
  }, KILL_GRACE_MS).unref();
});

// Reflects the caller's own Cookie/Authorization headers back as JSON, so the
// PORTS panel can bake them into the copied tunnel command when tmux-server is
// fronted by a reverse-proxy auth layer. This deliberately punctures HttpOnly
// (page JS can now read the session cookie) — acceptable under this app's
// trust model, where anyone past the auth layer already has a full shell via
// the terminal itself. Each response only ever contains what that request
// carried, so there's no cross-user data to leak.
api.get("/tunnel-auth", (req, res) => {
  res.json({
    cookie: req.headers.cookie ?? null,
    authorization: req.headers.authorization ?? null,
  });
});

// Probed by the client's AuthGate on boot. Reaching this handler at all
// means the request already cleared the auth gate middleware in index.ts
// (or the gate is off) — there's nothing left to check here.
api.get("/auth", (_req, res) => {
  res.status(204).end();
});

api.get("/fs", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const dirPath = expandHome(raw);
  try {
    if (!(await isDirectory(dirPath))) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }
    const entries = await listDir(dirPath);
    // git=0 (the "show git status" setting turned off) skips the porcelain
    // status scan — the expensive part on large repos — but still resolves
    // the branch so the sidebar's branch pill keeps working.
    const withGit = req.query.git !== "0";
    const repo = withGit ? await getRepoStatuses(dirPath) : null;
    const withStatus = repo
      ? entries.map((entry) => {
          const relPath = path.relative(repo.root, path.join(dirPath, entry.name));
          const gitStatus = statusForEntry(repo.statuses, repo.trackedDirs, relPath, entry.dir);
          return gitStatus ? { ...entry, gitStatus } : entry;
        })
      : entries;
    const branch = repo ? repo.branch : withGit ? null : await getRepoBranch(dirPath);
    res.json({ path: dirPath, entries: withStatus, branch });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Backs the quick switcher's file search: recursively lists files under
// `path`, gitignore-aware via `git ls-files` in a repo, falling back to a
// capped directory walk otherwise.
const FS_FILES_CAP = 10000;

api.get("/fs/files", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const dirPath = expandHome(raw);
  try {
    if (!(await isDirectory(dirPath))) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }
    const repoFiles = await listRepoFiles(dirPath, FS_FILES_CAP);
    const { files, truncated } = repoFiles ?? (await walkFiles(dirPath, FS_FILES_CAP));
    res.json({ path: dirPath, files, truncated });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/mkdir", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }
  try {
    const target = resolveDestination(expandHome(dir), relPath);
    await ensureDir(target);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/fs/rename", async (req, res) => {
  const raw = typeof req.body?.path === "string" ? req.body.path : "";
  const newName = typeof req.body?.newName === "string" ? req.body.newName.trim() : "";
  if (!raw || !newName) {
    res.status(400).json({ error: "path and newName are required" });
    return;
  }
  try {
    const dest = await renamePath(expandHome(raw), newName);
    res.status(200).json({ path: dest });
  } catch (err) {
    sendFsError(res, err);
  }
});

api.delete("/fs", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    await deletePath(expandHome(raw));
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/newfile", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }
  try {
    const target = resolveDestination(expandHome(dir), relPath);
    await ensureDir(path.dirname(target));
    await createEmptyFile(target);
    res.status(201).json({ path: target });
  } catch (err) {
    sendFsError(res, err);
  }
});

api.get("/download", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const targetPath = expandHome(raw);
  try {
    if (await isDirectory(targetPath)) {
      const name = path.basename(targetPath);
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${name}.zip"`);
      // "-r - <name>" zips the folder (relative to cwd, so entries inside the
      // archive are rooted at <name>/) and streams the archive to stdout.
      const zip = spawn("zip", ["-r", "-", name], {
        cwd: path.dirname(targetPath),
        stdio: ["ignore", "pipe", "ignore"],
      });
      zip.stdout.pipe(res);
      zip.on("error", (err) => {
        if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
      });
      res.on("close", () => zip.kill());
      return;
    }
    if (!(await isFile(targetPath))) {
      res.status(400).json({ error: "path is not a file or directory" });
      return;
    }
    // inline=1 (PdfView's iframe) needs no Content-Disposition: attachment —
    // unlike an <img>/<video> subresource load, an iframe *navigation*
    // honors that header and would download the file instead of rendering
    // it. sendFile derives the right Content-Type from the extension and
    // sets no disposition header at all.
    if (req.query.inline === "1") {
      res.sendFile(targetPath);
      return;
    }
    res.download(targetPath, path.basename(targetPath));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/upload", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  const conflict = req.query.conflict === "overwrite" || req.query.conflict === "fail"
    ? req.query.conflict
    : "rename";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }

  let target: string;
  try {
    target = resolveDestination(expandHome(dir), relPath);
    await ensureDir(path.dirname(target));
    if (conflict === "rename") {
      target = await uniquePath(target);
    } else if (conflict === "fail" && (await exists(target))) {
      res.status(409).json({ error: "file already exists" });
      return;
    }
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
    return;
  }

  const out = createWriteStream(target);
  req.pipe(out);
  out.on("finish", () => {
    res.status(201).json({ path: target });
  });
  out.on("error", (err) => {
    unlink(target).catch(() => {});
    res.status(500).json({ error: errMessage(err) });
  });
  req.on("error", (err) => {
    out.destroy();
    unlink(target).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
  });
});
