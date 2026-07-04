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
