import type {
  ExtensionInfo,
  FsFilesListing,
  FsListing,
  ListeningPort,
  TmuxSession,
  TunnelAuth,
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

export function fetchPorts(): Promise<ListeningPort[]> {
  return request("/api/ports");
}

export function fetchTunnelAuth(): Promise<TunnelAuth> {
  return request("/api/tunnel-auth");
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
  keybindings?: Record<string, string>;
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

export function listDir(dirPath: string, gitStatus = true): Promise<FsListing> {
  // git=0 skips the server's porcelain status scan (the expensive part on
  // large repos) while still resolving the branch for the pill.
  return request(`/api/fs?path=${encodeURIComponent(dirPath)}${gitStatus ? "" : "&git=0"}`);
}

export function listFiles(dirPath: string): Promise<FsFilesListing> {
  return request(`/api/fs/files?path=${encodeURIComponent(dirPath)}`);
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

// The mount point for an extension's server hook, if it has one and is
// enabled — 404s otherwise (see extensionHookMiddleware).
export function extensionApiBase(id: string): string {
  return `/api/ext/${encodeURIComponent(id)}`;
}
