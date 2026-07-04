// Extensions live as folders under ~/.config/tmux-server/extensions/<folder>/,
// each with a VS Code-shaped package.json. `contributes.themes` /
// `contributes.iconThemes` are served as-is to the client (which does all
// theme parsing/mapping) — this module only discovers manifests, tracks
// enabled state, handles .tsix install/uninstall, and mounts/unmounts
// per-extension server hooks. See README's Extensions section for the
// manifest format.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Router, type NextFunction, type Request, type Response } from "express";

const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
);
export const extensionsDir = path.join(configDir, "extensions");
const stateFilePath = path.join(configDir, "extensions-state.json");

// Bundled extensions shipped in the repo (image/markdown/json/csv/media/pdf
// previews, etc.) — discovered alongside user-installed ones. A user-dir
// extension with the same id takes precedence (lets a .tsix reinstall
// override or restore an uninstalled builtin) — see discoverExtensions.
const bundledExtensionsDir = path.resolve(import.meta.dirname, "../../extensions");

// Extension ids (publisher.name, or the folder name as a fallback) are used
// as URL path segments (/api/ext/:id, /api/extensions/:id/file/*) — reject
// anything that isn't a plain token so an id can never smuggle a path
// separator or traversal segment into those routes.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

interface ThemeContribution {
  label: string;
  uiTheme?: string;
  path: string;
}

interface IconThemeContribution {
  id: string;
  label: string;
  path: string;
}

interface ExtensionManifest {
  name?: string;
  publisher?: string;
  version?: string;
  displayName?: string;
  description?: string;
  contributes?: {
    themes?: ThemeContribution[];
    iconThemes?: IconThemeContribution[];
  };
  tmuxServer?: {
    client?: string;
    server?: string;
  };
}

export interface ExtensionInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  enabled: boolean;
  themes: { label: string; path: string }[];
  iconThemes: { id: string; label: string; path: string }[];
  // Extension-relative path to the client ESM entry, or null if this
  // extension has no client contribution — the client dynamic-imports it
  // via extensionFileUrl(id, clientEntry). hasServer stays a plain boolean:
  // the client never needs the server entry's path, only whether calling
  // extensionApiBase(id) is worthwhile.
  clientEntry: string | null;
  hasClient: boolean;
  hasServer: boolean;
  // Shipped from the repo's extensions/ dir rather than user-installed —
  // see bundledExtensionsDir. Uninstalling one tombstones it in the state
  // file instead of deleting repo files (see uninstallExtension).
  builtin: boolean;
}

function resolveId(manifest: ExtensionManifest, folder: string): string {
  if (manifest.publisher && manifest.name) {
    const candidate = `${manifest.publisher}.${manifest.name}`;
    if (isSafeId(candidate)) return candidate;
  }
  return folder;
}

// A builtin's state entry is "uninstalled" (tombstoned — hidden from the
// list, repo files untouched) rather than deleted like a user extension's
// state key. true/false is the ordinary enabled/disabled toggle for either
// kind.
type ExtensionState = boolean | "uninstalled";

async function readState(): Promise<Record<string, ExtensionState>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFilePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, ExtensionState>)
      : {};
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, ExtensionState>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const tmp = `${stateFilePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, stateFilePath);
}

async function readManifest(folderPath: string): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(path.join(folderPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ExtensionManifest) : null;
  } catch {
    return null;
  }
}

async function listFoldersIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface DiscoveredExtension {
  folderPath: string;
  manifest: ExtensionManifest;
  builtin: boolean;
}

// Bundled extensions first, then user-installed ones layered on top by id —
// a user-dir extension always wins over a builtin with the same id, which
// is how installing a .tsix restores or overrides a tombstoned builtin.
async function discoverExtensions(): Promise<Map<string, DiscoveredExtension>> {
  const found = new Map<string, DiscoveredExtension>();
  for (const folder of await listFoldersIn(bundledExtensionsDir)) {
    const folderPath = path.join(bundledExtensionsDir, folder);
    const manifest = await readManifest(folderPath);
    if (!manifest) continue;
    found.set(resolveId(manifest, folder), { folderPath, manifest, builtin: true });
  }
  for (const folder of await listFoldersIn(extensionsDir)) {
    const folderPath = path.join(extensionsDir, folder);
    const manifest = await readManifest(folderPath);
    if (!manifest) continue;
    found.set(resolveId(manifest, folder), { folderPath, manifest, builtin: false });
  }
  return found;
}

function toInfo(manifest: ExtensionManifest, id: string, enabled: boolean, builtin: boolean): ExtensionInfo {
  return {
    id,
    displayName: manifest.displayName || manifest.name || id,
    version: manifest.version || "0.0.0",
    description: manifest.description || "",
    enabled,
    themes: (manifest.contributes?.themes ?? []).map((t) => ({ label: t.label, path: t.path })),
    iconThemes: (manifest.contributes?.iconThemes ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      path: t.path,
    })),
    clientEntry: manifest.tmuxServer?.client ?? null,
    hasClient: Boolean(manifest.tmuxServer?.client),
    hasServer: Boolean(manifest.tmuxServer?.server),
    builtin,
  };
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
  const state = await readState();
  const results: ExtensionInfo[] = [];
  for (const [id, { manifest, builtin }] of await discoverExtensions()) {
    // A tombstoned builtin is hidden entirely rather than listed disabled —
    // uninstalling it should look identical to it never having existed.
    if (builtin && state[id] === "uninstalled") continue;
    // A freshly dropped-in or installed extension is active by default;
    // only an explicit `false` in the state file turns it off.
    results.push(toInfo(manifest, id, state[id] !== false, builtin));
  }
  return results;
}

async function findExtensionFolder(id: string): Promise<DiscoveredExtension | null> {
  return (await discoverExtensions()).get(id) ?? null;
}

// Resolves an extension-relative path (theme JSON, icon font, client/server
// entry) to an absolute path, rejecting traversal outside the extension's
// own folder.
export async function resolveExtensionFile(id: string, relPath: string): Promise<string | null> {
  const found = await findExtensionFolder(id);
  if (!found) return null;
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(found.folderPath, relPath);
  const base = path.resolve(found.folderPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function runUnzip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("unzip", ["-q", "-o", zipPath, "-d", destDir]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error('installing .tsix extensions requires the "unzip" command, which was not found on PATH'));
      } else {
        reject(err);
      }
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `unzip exited with code ${code}`));
    });
  });
}

// tsixPath is a temp file (already written by the caller); this consumes
// and removes it either way.
export async function installFromTsixFile(tsixPath: string): Promise<ExtensionInfo> {
  const workDir = path.join(tmpdir(), `tmux-server-ext-${randomUUID()}`);
  try {
    await mkdir(workDir, { recursive: true });
    await runUnzip(tsixPath, workDir);
    // A .tsix is a zip with the extension's actual contents under extension/.
    const extractedRoot = path.join(workDir, "extension");
    const manifest = await readManifest(extractedRoot);
    if (!manifest) throw new Error("invalid extension: missing extension/package.json");
    if (!manifest.name) throw new Error('invalid extension: package.json is missing "name"');

    const folder = isSafeId(manifest.name) ? manifest.name : `ext-${randomUUID().slice(0, 8)}`;
    await mkdir(extensionsDir, { recursive: true });
    const dest = path.join(extensionsDir, folder);
    await rm(dest, { recursive: true, force: true });
    // Not a rename: the OS temp dir and ~/.config commonly live on
    // different filesystems/devices (containers, separate /tmp mounts), and
    // fs.rename() across devices fails with EXDEV. cp() copies across any
    // boundary; the whole workDir (including extractedRoot) is removed in
    // the finally block below either way.
    await cp(extractedRoot, dest, { recursive: true });

    const id = resolveId(manifest, folder);
    const state = await readState();
    state[id] = true;
    await writeState(state);

    const info = (await listExtensions()).find((e) => e.id === id);
    if (!info) throw new Error("extension installed but could not be read back");
    return info;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(tsixPath, { force: true }).catch(() => {});
  }
}

export async function uninstallExtension(id: string): Promise<void> {
  const found = await findExtensionFolder(id);
  if (!found) throw new Error("extension not found");
  unmountServerHook(id);
  const state = await readState();
  if (found.builtin) {
    // Tombstone rather than delete repo files — a future .tsix install with
    // the same id overrides this entry (discoverExtensions layers user-dir
    // extensions on top of builtins) and restores it.
    state[id] = "uninstalled";
  } else {
    await rm(found.folderPath, { recursive: true, force: true });
    delete state[id];
  }
  await writeState(state);
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
  const found = await findExtensionFolder(id);
  if (!found) throw new Error("extension not found");
  const state = await readState();
  state[id] = enabled;
  await writeState(state);

  if (enabled) {
    await mountServerHookIfNeeded(id, found.folderPath, found.manifest);
  } else {
    unmountServerHook(id);
  }

  return toInfo(found.manifest, id, enabled, found.builtin);
}

// ---- Server hooks ----
// Mounted routers, keyed by extension id — present only while the
// extension's server hook is active. Disabling/uninstalling deletes the
// entry so requests 404 immediately; the imported module itself stays
// resident in the process until restart (ESM has no unload), which is why
// the client shows a "restart the server" hint after disabling one — see
// README.
const serverHooks = new Map<string, Router>();

export function getServerHookRouter(id: string): Router | undefined {
  return serverHooks.get(id);
}

export function extensionHookMiddleware(req: Request, res: Response, next: NextFunction): void {
  const router = serverHooks.get(req.params.extId);
  if (!router) {
    res.status(404).json({ error: "extension not found or has no active server hook" });
    return;
  }
  router(req, res, next);
}

export async function mountServerHookIfNeeded(
  id: string,
  folderPath: string,
  manifest: ExtensionManifest,
): Promise<void> {
  if (serverHooks.has(id)) return;
  const serverEntry = manifest.tmuxServer?.server;
  if (!serverEntry) return;
  try {
    const entryPath = path.resolve(folderPath, serverEntry);
    const mod: unknown = await import(pathToFileURL(entryPath).href);
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${id}: server entry has no activate() export`);
      return;
    }
    const router = Router();
    activate({
      router,
      log: (...args: unknown[]) => console.log(`[ext:${id}]`, ...args),
    });
    serverHooks.set(id, router);
  } catch (err) {
    console.error(`extension ${id}: failed to load server hook:`, err);
  }
}

export function unmountServerHook(id: string): void {
  serverHooks.delete(id);
}

export async function loadEnabledServerHooks(): Promise<void> {
  for (const ext of await listExtensions()) {
    if (!ext.enabled || !ext.hasServer) continue;
    const found = await findExtensionFolder(ext.id);
    if (found) await mountServerHookIfNeeded(ext.id, found.folderPath, found.manifest);
  }
}
