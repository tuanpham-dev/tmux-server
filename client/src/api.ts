import type {
  ExtensionInfo,
  FsFilesListing,
  FsGitRoot,
  FsListing,
  RegistrySourceResult,
  TmuxSession,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  // Check the body itself, not just status === 204: any success response can
  // legitimately have an empty body (e.g. a plain res.end()), and res.json()
  // throws a SyntaxError on empty text that silently aborts the caller.
  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export function fetchSessions(): Promise<TmuxSession[]> {
  return request("/api/sessions");
}

export function createSession(name?: string, cwd?: string): Promise<TmuxSession> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, cwd: cwd || undefined }),
  });
}

// The server-persisted settings document (~/.config/tmux-server/settings.json).
// Schema is client-owned: settings.ts fields + keybindings.ts overrides +
// extensionSettings.ts overrides. The index signature lets a save preserve
// any top-level key this client build doesn't know about yet (see App.tsx's
// read-merge-write save) — the server itself stays schema-oblivious.
export interface SettingsDoc {
  settings?: unknown;
  // unknown, not KeybindingOverrides: an older client may have written the
  // pre-multi-binding shape (command id → single combo string) — the reader
  // runs it through migrateKeybindingOverrides before trusting the shape.
  keybindings?: unknown;
  extensionSettings?: unknown;
  pinnedSessions?: unknown;
  [key: string]: unknown;
}

export function fetchSettingsDoc(): Promise<SettingsDoc> {
  return request("/api/settings");
}

export function putSettingsDoc(doc: SettingsDoc): Promise<void> {
  return request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
}

// Deep-merges `patch` over the server's on-disk document instead of
// replacing it outright (see server/src/settingsStore.ts's mergeSettingsDoc)
// — for a caller that wants to write just the keys it's changing without
// first fetching and reassembling the whole document itself.
export function patchSettingsDoc(patch: SettingsDoc): Promise<void> {
  return request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function killSession(name: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// Resolves with the new window's index — the bottom terminal panel attaches
// the window it just created (see hooks/useBottomPanel.ts); every other
// caller ignores it and lets the session poll surface the new window.
export function createWindow(name: string, cwd?: string): Promise<{ index: number }> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function openLazygit(name: string, cwd?: string): Promise<{ index: number }> {
  return request(`/api/sessions/${encodeURIComponent(name)}/lazygit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function selectWindow(name: string, index: number): Promise<void> {
  return request(
    `/api/sessions/${encodeURIComponent(name)}/windows/${index}/select`,
    { method: "POST" },
  );
}

export function killWindow(name: string, index: number): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows/${index}`, {
    method: "DELETE",
  });
}

export function openWindowTab(name: string, index: number): Promise<{ attachName: string }> {
  return request(
    `/api/sessions/${encodeURIComponent(name)}/windows/${index}/open-tab`,
    { method: "POST" },
  );
}

export function closeWindowTab(attachName: string): Promise<void> {
  return request(`/api/window-views/${encodeURIComponent(attachName)}`, { method: "DELETE" });
}

export function renameWindow(name: string, index: number, newName: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows/${index}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export function renameSession(name: string, newName: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export function listDir(dirPath: string): Promise<FsListing> {
  return request(`/api/fs?path=${encodeURIComponent(dirPath)}`);
}

// With `query`, the server fuzzy-filters and returns only the top matches
// (per-keystroke quick-switcher search); without it, the full capped listing.
export function listFiles(dirPath: string, query?: string): Promise<FsFilesListing> {
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  return request(`/api/fs/files?path=${encodeURIComponent(dirPath)}${q}`);
}

// Resolves the git repo root containing dirPath, or dirPath itself when it
// isn't inside a repo — roots the FILES panel / quick-switcher search.
export function getGitRoot(dirPath: string): Promise<FsGitRoot> {
  return request(`/api/fs/git-root?path=${encodeURIComponent(dirPath)}`);
}

export function openFile(
  session: string,
  filePath: string,
  keysPane?: string,
  line?: number,
): Promise<{ windowIndex: number | null; deferredPane?: string }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/open-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, keysPane, line }),
  });
}

// Validates terminal-link file-path candidates against the session's active
// pane cwd — see the matching server route for the resolution rules. Result
// array is index-aligned with `paths`; a null entry means "not a real file,
// don't linkify it".
export function resolvePaths(session: string, paths: string[]): Promise<{ results: (string | null)[] }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/resolve-paths`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

export function makeDir(destDir: string, relativePath: string): Promise<void> {
  return request(
    `/api/mkdir?dir=${encodeURIComponent(destDir)}&path=${encodeURIComponent(relativePath)}`,
    { method: "POST" },
  );
}

export function createFile(destDir: string, relativePath: string): Promise<{ path: string }> {
  return request(
    `/api/newfile?dir=${encodeURIComponent(destDir)}&path=${encodeURIComponent(relativePath)}`,
    { method: "POST" },
  );
}

export function renameEntry(targetPath: string, newName: string): Promise<{ path: string }> {
  return request("/api/fs/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: targetPath, newName }),
  });
}

export function deleteEntry(targetPath: string): Promise<void> {
  return request(`/api/fs?path=${encodeURIComponent(targetPath)}`, { method: "DELETE" });
}

// Server-held FILES-tree clipboard — see server/src/api.ts's fsClipboard.
// Copy/cut write here; paste reads the server's own state, so it works
// across browsers/tabs pointed at the same server.
export function setFsClipboard(paths: string[], mode: "copy" | "cut"): Promise<void> {
  return request("/api/fs/clipboard", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, mode }),
  });
}

export function getFsClipboard(): Promise<{ paths: string[]; mode: "copy" | "cut" | null }> {
  return request("/api/fs/clipboard");
}

export function clearFsClipboard(): Promise<void> {
  return request("/api/fs/clipboard", { method: "DELETE" });
}

export function pasteFsClipboard(
  destDir: string,
): Promise<{ pasted: string[]; errors: { path: string; message: string }[] }> {
  return request("/api/fs/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destDir }),
  });
}

// FILES-tree drag-and-drop move/copy — a separate route from the clipboard
// above on purpose, so a drag never clobbers a pending cut/copy.
export function transferEntries(
  paths: string[],
  destDir: string,
  mode: "move" | "copy",
): Promise<{ done: string[]; errors: { path: string; message: string }[] }> {
  return request("/api/fs/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, destDir, mode }),
  });
}

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

// Raw file contents as text (for the markdown preview) — request<T>() above
// always JSON.parses the body, so it can't serve this; reuses the same
// /api/download route ImageView already uses for image bytes.
export async function fetchFileText(targetPath: string): Promise<string> {
  const res = await fetch(downloadUrl(targetPath));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// Renders a file inline instead of downloading it — for content an <iframe>
// navigates to (PdfView), where Content-Disposition: attachment would
// trigger a download instead of rendering. <img>/<video> subresource loads
// don't need this: they ignore that header regardless.
export function inlineUrl(targetPath: string): string {
  return `/api/download?inline=1&path=${encodeURIComponent(targetPath)}`;
}

// Writes content back to targetPath via the existing upload route in
// overwrite mode — no dedicated "write file" endpoint needed. Used by
// JsonView's Format & Save and CsvView's Save.
export function saveFileText(targetPath: string, content: string): Promise<{ path: string }> {
  const slash = targetPath.lastIndexOf("/");
  const dir = targetPath.slice(0, slash);
  const name = targetPath.slice(slash + 1);
  return uploadFile(dir, name, new Blob([content], { type: "text/plain" }), "overwrite");
}

// Thrown when the server refuses to upload because the destination already
// exists and the caller asked for "fail" conflict semantics (used to drive
// the ask-before-overwrite flow).
export class UploadConflictError extends Error {
  constructor() {
    super("file already exists");
    this.name = "UploadConflictError";
  }
}

// XHR, not fetch: only XHR exposes upload progress events, which the
// byte-level progress banner needs.
export function uploadFile(
  destDir: string,
  relativePath: string,
  file: File | Blob,
  conflict: "rename" | "overwrite" | "fail",
  onProgress?: (loadedBytes: number) => void,
): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url =
      `/api/upload?dir=${encodeURIComponent(destDir)}` +
      `&path=${encodeURIComponent(relativePath)}&conflict=${conflict}`;
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 409) {
        reject(new UploadConflictError());
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ? JSON.parse(xhr.responseText) : { path: "" });
        return;
      }
      let message = `${xhr.status} ${xhr.statusText}`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body; keep the status message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.send(file);
  });
}

export function fetchExtensions(): Promise<ExtensionInfo[]> {
  return request("/api/extensions");
}

export function installExtensionTsix(file: File | Blob): Promise<ExtensionInfo> {
  return request("/api/extensions/install", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

export function uninstallExtension(id: string): Promise<void> {
  return request(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
  return request(`/api/extensions/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

// Resolves an extension-relative path (theme JSON, icon font/SVG, the
// client entry module) to a fetchable/importable URL.
export function extensionFileUrl(id: string, relPath: string): string {
  return `/api/extensions/${encodeURIComponent(id)}/file/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// Extension registries: user-configured sources, each serving an index.json
// catalog — see server/src/registry.ts.
// `sources`, when passed, bypasses the server's settings-doc read — see
// server/src/registry.ts's getRegistryCatalog doc comment on why an
// add/remove-then-refresh needs this instead of relying on the (debounced)
// persisted doc.
export function fetchRegistry(refresh?: boolean, sources?: string[]): Promise<RegistrySourceResult[]> {
  const params = new URLSearchParams();
  if (refresh) params.set("refresh", "1");
  if (sources) params.set("sources", JSON.stringify(sources));
  const qs = params.toString();
  return request(`/api/registry${qs ? `?${qs}` : ""}`).then(
    (body) => (body as { sources: RegistrySourceResult[] }).sources,
  );
}

// The app's built-in default registry (EXTENSION_REGISTRY env on the server,
// else the shipped GitHub Pages catalog), or null if disabled. Merged ahead of
// the user's own sources for display/fetch — see App.tsx.
export function fetchDefaultRegistry(): Promise<string | null> {
  return request("/api/registry/default").then(
    (body) => (body as { registry: string | null }).registry,
  );
}

export function installFromRegistry(source: string, id: string): Promise<ExtensionInfo> {
  return request("/api/registry/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, id }),
  });
}

// Bypasses the JSON request() helper — the response body is markdown text,
// not JSON.
export async function fetchRegistryReadme(source: string, id: string): Promise<string> {
  const url = `/api/registry/readme?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  return res.text();
}

// Direct-use URL for an <img src> — the icon proxy streams image bytes, not
// JSON, so this isn't routed through request().
export function registryIconUrl(source: string, id: string): string {
  return `/api/registry/icon?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
}

// The mount point for an extension's server hook, if it has one and is
// enabled — 404s otherwise (see extensionHookMiddleware).
export function extensionApiBase(id: string): string {
  return `/api/ext/${encodeURIComponent(id)}`;
}

// Web-push notifications (plans/codeman-mobile-features.md Phase 4).
export function fetchPushVapidKey(): Promise<{ publicKey: string }> {
  return request("/api/push/vapid-key");
}

export function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  return request("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
}

export function unsubscribePush(endpoint: string): Promise<void> {
  return request("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}
