import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import {
  ensureDir,
  exists,
  expandHome,
  isDirectory,
  isFile,
  listDir,
  resolveDestination,
  uniquePath,
} from "./files.js";
import {
  createSession,
  createWindow,
  killSession,
  killWindow,
  listSessions,
  openFileInWindow,
  renameSession,
  renameWindow,
  selectWindow,
} from "./tmux.js";

export const api = Router();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  try {
    await createWindow(req.params.name);
    res.status(204).end();
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
  try {
    if (!(await isFile(filePath))) {
      res.status(400).json({ error: "path is not a file" });
      return;
    }
    await openFileInWindow(req.params.name, filePath);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
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
    res.json({ path: dirPath, entries: await listDir(dirPath) });
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
