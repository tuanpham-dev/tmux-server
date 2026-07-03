import { constants } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitFileStatus } from "./git.js";

// Thrown by renamePath/createEmptyFile when the destination already exists,
// so callers can map it to a 409 instead of a generic 400.
export class ConflictError extends Error {
  constructor(message = "a file or folder with that name already exists") {
    super(message);
    this.name = "ConflictError";
  }
}

const HOME = process.env.HOME ?? "";

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export interface FsEntry {
  name: string;
  dir: boolean;
  gitStatus?: GitFileStatus;
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

// Recursive fallback for the quick switcher's file search when rootDir isn't
// inside a git repo (so there's no .gitignore-aware `git ls-files` to lean
// on). Walks depth-first, skipping ".git", and stops as soon as it hits cap
// so a huge non-git directory can't stall the request.
export async function walkFiles(
  rootDir: string,
  cap: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  async function walk(dirPath: string, relPrefix: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === ".git") continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dirPath, entry.name), rel);
      } else {
        if (files.length >= cap) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  }

  await walk(rootDir, "");
  return { files, truncated };
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

// Renames within the same parent directory only; newName is a basename, not
// a path, so a crafted "../escape" can't move the entry elsewhere.
export async function renamePath(targetPath: string, newName: string): Promise<string> {
  if (!newName || newName.includes("/") || newName === "." || newName === "..") {
    throw new Error("invalid name");
  }
  const dest = path.join(path.dirname(targetPath), newName);
  if (await exists(dest)) {
    throw new ConflictError();
  }
  await rename(targetPath, dest);
  return dest;
}

export async function deletePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true });
}

export async function createEmptyFile(target: string): Promise<void> {
  if (await exists(target)) {
    throw new ConflictError();
  }
  await writeFile(target, "");
}
