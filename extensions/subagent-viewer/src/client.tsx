// subagent-viewer: running Claude Code subagent count badges on SESSIONS
// window rows (via the session-decoration extension point) plus the
// read-only details popover, extracted from core (formerly AgentsPanel.tsx
// + the tmux.ts listSessions `agents` enrichment). The popover renders into
// this extension's own React root — torn down in deactivate() — since a
// decoration's onClick has no host-rendered surface to portal into.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror server.js responses) ----

type AgentStatus = "running" | "completed";

interface AgentSummary {
  agentId: string;
  agentType: string;
  description: string;
  model: string | null;
  status: AgentStatus;
  tokens: number;
  toolCalls: number;
  lastActivityAt: string | null;
}

async function readJson<T>(res: Response): Promise<T> {
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
  return (await res.json()) as T;
}

// ---- Counts poll ----
//
// The decoration provider is synchronous, so counts come from this cache,
// refreshed on a 3s cadence (the same beat the sessions list itself polls
// on). Which cwds to ask about is learned from the provider's own calls:
// every render of a claude window row records its cwd here, and the next
// poll asks the server about every cwd seen recently. First badge can
// therefore lag one poll tick behind the row's first render — acceptable,
// and self-heals immediately.

const POLL_MS = 3_000;
// A cwd not rendered for this long (its window/session closed) drops out of
// the poll set.
const CWD_SEEN_TTL_MS = 15_000;

const seenCwds = new Map<string, number>();
let counts: Record<string, number> = {};
let pollTimer: number | null = null;
let refreshDecorations: (() => void) | null = null;

async function pollCounts(): Promise<void> {
  if (!serverFetch) return;
  const now = Date.now();
  for (const [cwd, at] of seenCwds) {
    if (now - at > CWD_SEEN_TTL_MS) seenCwds.delete(cwd);
  }
  const cwds = [...seenCwds.keys()];
  if (cwds.length === 0) {
    if (Object.keys(counts).length > 0) {
      counts = {};
      refreshDecorations?.();
    }
    return;
  }
  try {
    const res = await serverFetch("/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwds }),
    });
    const next = (await readJson<{ counts: Record<string, number> }>(res)).counts;
    const changed =
      Object.keys(next).length !== Object.keys(counts).length ||
      Object.entries(next).some(([k, v]) => counts[k] !== v);
    counts = next;
    if (changed) refreshDecorations?.();
  } catch {
    // Best-effort — a failed poll keeps the last counts; the next tick
    // retries.
  }
}

// ---- Details popover (formerly core AgentsPanel.tsx) ----

const DETAILS_POLL_MS = 3000;

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

interface PanelProps {
  cwd: string;
  // Where the triggering badge was clicked — same fixed-position-clamped-
  // to-viewport approach as the app's ContextMenu.
  anchor: { x: number; y: number };
  onClose: () => void;
}

function AgentsPanel({ cwd, anchor, onClose }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(anchor.x, innerWidth - rect.width - 4),
      y: Math.min(anchor.y, innerHeight - rect.height - 4),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, agents]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (!serverFetch) return;
      serverFetch(`/details?cwd=${encodeURIComponent(cwd)}`)
        .then((res) => readJson<AgentSummary[]>(res))
        .then((result) => {
          if (!cancelled) {
            setAgents(result);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    poll();
    const timer = window.setInterval(poll, DETAILS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cwd]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="agents-panel" style={{ left: pos.x, top: pos.y }}>
      <div className="agents-panel-title">Subagents</div>
      {error && <div className="agents-panel-empty">{error}</div>}
      {!error && agents === null && <div className="agents-panel-empty">Loading…</div>}
      {!error && agents !== null && agents.length === 0 && (
        <div className="agents-panel-empty">No agents found</div>
      )}
      {agents?.map((a) => (
        <div key={a.agentId} className="agents-panel-row">
          <span className={`agents-panel-status agents-panel-status-${a.status}`} />
          <div className="agents-panel-row-main">
            <div className="agents-panel-row-desc" title={a.description}>
              {a.description || a.agentId}
            </div>
            <div className="agents-panel-row-meta">
              {a.agentType}
              {a.model ? ` · ${a.model}` : ""} · {a.toolCalls} tool call{a.toolCalls === 1 ? "" : "s"} ·{" "}
              {a.tokens.toLocaleString()} tokens · {relativeTime(a.lastActivityAt)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Popover root management ----

let popoverHost: HTMLDivElement | null = null;
let popoverRoot: Root | null = null;

function closePopover(): void {
  popoverRoot?.unmount();
  popoverRoot = null;
  popoverHost?.remove();
  popoverHost = null;
}

function openPopover(cwd: string, anchor: { x: number; y: number }): void {
  closePopover();
  popoverHost = document.createElement("div");
  document.body.appendChild(popoverHost);
  popoverRoot = createRoot(popoverHost);
  popoverRoot.render(<AgentsPanel cwd={cwd} anchor={anchor} onClose={closePopover} />);
}

// ---- Activation ----

interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface ExtensionContext {
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (
      ctx: SessionDecorationContext,
    ) => { badge: string; tooltip?: string; className?: string } | undefined;
    onClick?: (anchorRect: DOMRect, ctx: SessionDecorationContext) => void;
  }): { refresh(): void };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  const handle = ctx.registerSessionDecorationProvider({
    id: "agents",
    provideWindowDecoration(win) {
      if (win.command !== "claude") return undefined;
      seenCwds.set(win.cwd, Date.now());
      const count = counts[win.cwd];
      if (!count) return undefined;
      return {
        badge: String(count),
        tooltip: `${count} subagent${count === 1 ? "" : "s"} running`,
      };
    },
    onClick(anchorRect, win) {
      openPopover(win.cwd, { x: anchorRect.left, y: anchorRect.bottom + 4 });
    },
  });
  refreshDecorations = handle.refresh;
  pollTimer = window.setInterval(() => void pollCounts(), POLL_MS);
  void pollCounts();
}

export function deactivate(): void {
  closePopover();
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
  refreshDecorations = null;
  seenCwds.clear();
  counts = {};
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
}
