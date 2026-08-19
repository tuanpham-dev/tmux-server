import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import { agentWindows, fetchSessions, sendToAgent } from "../../_shared/agentTarget";

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

let extSettings: SettingsApi | null = null;
let getActiveContext: (() => ActiveContext) | null = null;

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

function readAgentPrograms(): string {
  const raw = extSettings?.get("livePreview.agentPrograms");
  return typeof raw === "string" && raw.trim() ? raw : "claude";
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("livePreview.sendAutoSubmit") === true;
}

interface PickedElement {
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
}

function buildElementContextBlock(basename: string, picked: PickedElement): string {
  const styleLines = Object.entries(picked.styles)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `Element ${picked.selector} in ${basename}:\n\`\`\`html\n${picked.outerHTML}\n\`\`\`\nComputed styles:\n${styleLines}`;
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
  const [inspecting, setInspecting] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sendError, setSendError] = useState<string | null>(null);

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
    // A reload (auto-refresh, manual Reload, or navigating within the
    // iframe) drops the previewed page's own armed state along with its
    // whole document — re-arm here if the toggle is still on.
    if (inspecting) {
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewInspect: true }, "*");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleInspect = useCallback(() => {
    setInspecting((prev) => {
      const next = !prev;
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewInspect: next }, "*");
      return next;
    });
  }, []);

  // Element picker (T12/T13): server.js's INSPECT_SCRIPT posts back the
  // clicked element once armed; resolve an agent pane in the active
  // project (server.js's SCROLL_SCRIPT handshake is the pattern this
  // mirrors — source-checked against this tab's own iframe).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const picked = (e.data as { __livePreviewPicked?: PickedElement })?.__livePreviewPicked;
      if (!picked) return;
      setInspecting(false);
      setSendState("sending");
      setSendError(null);
      const text = buildElementContextBlock(basename, picked);
      const activeCwd = getActiveContext?.()?.cwd ?? dir;
      fetchSessions()
        .then((sessions) => {
          const targets = agentWindows(sessions, activeCwd, readAgentPrograms());
          if (targets.length === 0) {
            throw new Error("No agent is running in this project — start one first.");
          }
          // Live Preview has no context-menu picker surface like DiffView's
          // showMenu — several candidates just target the first, consistent
          // with "pick one and go" for a lightweight inline toggle.
          return sendToAgent(targets[0].sessionName, text, readSendAutoSubmit(), { windowIndex: targets[0].windowIndex });
        })
        .then(() => setSendState("sent"))
        .catch((err: Error) => {
          setSendState("error");
          setSendError(err.message);
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [basename, dir]);

  useEffect(() => {
    if (sendState !== "sent") return;
    const id = window.setTimeout(() => setSendState("idle"), 1500);
    return () => window.clearTimeout(id);
  }, [sendState]);

  const controls = (
    <>
      <button className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
      <button
        className={`icon-button${inspecting ? " active" : ""}`}
        title={
          sendState === "error"
            ? `Couldn't send: ${sendError}`
            : sendState === "sent"
              ? "Sent to agent"
              : inspecting
                ? "Click an element to send it to the agent (Esc-free: click the button again to cancel)"
                : "Inspect element → send to agent"
        }
        onClick={toggleInspect}
      >
        <Icon name={sendState === "sent" ? "check" : "inspect"} />
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

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof HtmlPreview;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
  app: { getActiveContext: () => ActiveContext };
}) {
  extSettings = ctx.settings;
  getActiveContext = ctx.app.getActiveContext;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "livePreview",
    extensions: ["html", "htm"],
    mode: "preview",
    component: HtmlPreview,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}
