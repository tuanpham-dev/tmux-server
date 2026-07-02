import type { TmuxSession } from "./types";

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

export function createSession(name?: string): Promise<TmuxSession> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function killSession(name: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function createWindow(name: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows`, { method: "POST" });
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
