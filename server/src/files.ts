import { constants } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const HOME = process.env.HOME ?? "";

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export interface FsEntry {
  name: string;
  dir: boolean;
}

export async function listDir(dirPath: string): Promise<FsEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== ".git")
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// Joins baseDir + relativePath, rejecting any relative path that is absolute
// or escapes baseDir via "..". Both uploads and mkdir route through this so
// a crafted relative path can't write outside the chosen destination.
export function resolveDestination(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("path must be relative");
  }
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path escapes destination directory");
  }
  return resolved;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Finds the next free "name (N).ext" for a path that already exists.
export async function uniquePath(target: string): Promise<string> {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let n = 1;
  let candidate: string;
  do {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  } while (await exists(candidate));
  return candidate;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}
