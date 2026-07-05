import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let extSettings: SettingsApi | null = null;

// Parsed from ctx.assetUrl() at activate() time rather than hardcoded —
// ctx exposes no direct "this extension's server-hook base" accessor, but
// assetUrl(relPath) always returns "/api/extensions/<id>/file/<relPath>",
// so extracting <id> and rebuilding "/api/ext/<id>" survives a manifest
// rename at the cost of coupling to that URL shape.
let hookBase = "";

function readAutoRefresh(): boolean {
  const value = extSettings?.get("livePreview.autoRefresh");
  return value === undefined ? true : Boolean(value);
}

function readPollInterval(): number {
  const value = Number(extSettings?.get("livePreview.pollInterval"));
  if (!Number.isFinite(value)) return 1000;
  return Math.min(10000, Math.max(250, value));
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
}

function HtmlPreview({ filePath, active, toolbarTarget, openInEditor }: Props) {
  const slash = filePath.lastIndexOf("/");
  const dir = filePath.slice(0, slash);
  const basename = filePath.slice(slash + 1);

  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(readAutoRefresh);
  const [pollInterval, setPollInterval] = useState(readPollInterval);
  const lastMtime = useRef<number | null>(null);
  const scrollRef = useRef<[number, number] | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(
    () =>
      extSettings?.onDidChange(() => {
        setAutoRefresh(readAutoRefresh());
        setPollInterval(readPollInterval());
      }),
    [],
  );

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  // Mints (or reuses) a capability token for this folder via a normal
  // same-origin fetch from the app's own page — see server.js and
  // security.ts's isOriginExemptPath for why the iframe itself can't do
  // this (its opaque origin fails the app's Origin check by design).
  useEffect(() => {
    let cancelled = false;
    setToken(null);
    setError(null);
    fetch(`${hookBase}/token?dir=${encodeURIComponent(dir)}`)
      .then((res) => res.json())
      .then((data: { token?: string; error?: string }) => {
        if (cancelled) return;
        if (data.token) setToken(data.token);
        else setError(data.error ?? "failed to start preview");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Reload-on-change poll — shallow (the HTML's own folder only, not
  // subfolders), only while this tab is visible and autoRefresh is on. No
  // general file-watcher exists in this app; this is a deliberate tradeoff
  // (see plans/live-preview-extension.md).
  useEffect(() => {
    if (!active || !autoRefresh || !token) return;
    let cancelled = false;
    const poll = () => {
      fetch(`${hookBase}/public/mtime?token=${token}`)
        .then((res) => res.json())
        .then((data: { mtime?: number }) => {
          if (cancelled || typeof data.mtime !== "number") return;
          if (lastMtime.current !== null && data.mtime !== lastMtime.current) refresh();
          lastMtime.current = data.mtime;
        })
        .catch(() => {
          // Transient fetch failure — next tick retries; no need to surface.
        });
    };
    poll();
    const id = window.setInterval(poll, pollInterval);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, autoRefresh, pollInterval, token, refresh]);

  // Scroll-position handshake with the previewed page's injected script
  // (see server.js's SCROLL_SCRIPT) — restores position after a reload
  // instead of snapping back to the top every auto-refresh.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const pos = (e.data as { __livePreviewScroll?: [number, number] })?.__livePreviewScroll;
      if (Array.isArray(pos)) scrollRef.current = pos;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const handleIframeLoad = useCallback(() => {
    if (scrollRef.current) {
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewRestore: scrollRef.current }, "*");
    }
  }, []);

  const controls = (
    <>
      <button className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  return (
    <div className={`live-preview-host${active ? "" : " hidden"}`}>
      {error && <div className="live-preview-status live-preview-error">Couldn't load {basename}</div>}
      {!error && !token && <div className="live-preview-status">Loading…</div>}
      {!error && token && (
        <iframe
          key={reloadTick}
          ref={iframeRef}
          className="live-preview-frame"
          src={`${hookBase}/public/serve/${token}/${encodeURIComponent(basename)}`}
          title={basename}
          // allow-scripts only, no allow-same-origin — the previewed page
          // runs its own scripts but in an opaque origin, so it can't reach
          // this app's localStorage/APIs (its fetches carry Origin: null,
          // rejected everywhere except the token-gated /public/ routes it
          // needs — see security.ts's isOriginExemptPath).
          sandbox="allow-scripts"
          onLoad={handleIframeLoad}
        />
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof HtmlPreview;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  extSettings = ctx.settings;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "livePreview",
    extensions: ["html", "htm"],
    mode: "preview",
    component: HtmlPreview,
  });
}
