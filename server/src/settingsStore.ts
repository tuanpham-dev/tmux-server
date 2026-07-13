import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// The settings document is client-owned and opaque to the server: the client
// defines the schema (settings + keybinding overrides) and merges over its
// own defaults, so the server never needs a schema update when a setting is
// added. The server only guarantees the doc is a plain JSON object and small.
const MAX_BYTES = 64 * 1024;

const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
);
const settingsPath = path.join(configDir, "settings.json");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readSettingsDoc(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // Missing or corrupt file — the client treats {} as "use defaults".
    return {};
  }
}

export async function writeSettingsDoc(doc: unknown): Promise<void> {
  if (!isPlainObject(doc)) throw new Error("settings must be a JSON object");
  const json = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("settings document too large");
  await mkdir(configDir, { recursive: true });
  // Temp-then-rename so a crash mid-write can't leave a truncated file.
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(tmp, json);
  await rename(tmp, settingsPath);
}

// Recurses into plain-object values on both sides so a patch only has to
// name the keys it's actually changing, at any depth — e.g. patching one
// extension's settings ({ extensionSettings: { "foo.bar": {...} } })
// doesn't drop every other extension's entry, and patching one keybinding
// override doesn't drop the rest. Arrays and primitives are NOT merged
// recursively (an incoming array/primitive replaces the existing value
// wholesale) — index-merging a list like pinnedSessions would silently
// splice unrelated entries together, which is never what a caller wants.
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

// Merges `patch` over the on-disk document (see deepMerge) and persists the
// result, instead of replacing the document outright — the PATCH
// counterpart to writeSettingsDoc's PUT-style full replace. Lets a caller
// (an extension settings panel, a future integration, or the client's own
// write-back) send just the keys it's changing without first having to
// fetch-merge-PUT the whole document itself.
export async function mergeSettingsDoc(patch: unknown): Promise<void> {
  if (!isPlainObject(patch)) throw new Error("settings must be a JSON object");
  const current = await readSettingsDoc();
  await writeSettingsDoc(deepMerge(current, patch));
}
