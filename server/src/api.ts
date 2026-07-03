import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
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
} from "./files.js";
import { getRepoStatuses, statusForEntry } from "./git.js";
import { listPorts } from "./ports.js";
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
  try {
    res.status(201).json(await createSession(name));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
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
    await createWindow(req.params.name, cwd);
    res.status(204).end();
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
  try {
    if (!(await isFile(filePath))) {
      res.status(400).json({ error: "path is not a file" });
      return;
    }
    // keysPane completes a deferred open (see OpenFileResult.deferredPane):
    // the client already surfaced that pane's window/tab, so it's now safe
    // to inject the keystrokes the initial scan held back.
    if (keysPane) {
      await openFileInPaneWithKeys(keysPane, filePath);
      res.status(200).json({ windowIndex: null });
      return;
    }
    const result = await openFileInWindow(req.params.name, filePath);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.get("/ports", async (_req, res) => {
  try {
    res.json(await listPorts());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
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
    const repo = await getRepoStatuses(dirPath);
    const withStatus = repo
      ? entries.map((entry) => {
          const relPath = path.relative(repo.root, path.join(dirPath, entry.name));
          const gitStatus = statusForEntry(repo.statuses, relPath, entry.dir);
          return gitStatus ? { ...entry, gitStatus } : entry;
        })
      : entries;
    res.json({ path: dirPath, entries: withStatus, branch: repo?.branch ?? null });
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
