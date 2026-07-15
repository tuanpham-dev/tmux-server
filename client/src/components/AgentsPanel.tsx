import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AgentSummary } from "../types";

interface Props {
  cwd: string;
  // Where the triggering badge was clicked — same fixed-position-clamped-
  // to-viewport approach as ContextMenu.tsx, not a new pattern.
  anchor: { x: number; y: number };
  onClose: () => void;
}

const POLL_MS = 3000;

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

// Lightweight read-only agent list, positioned like ContextMenu.tsx rather
// than joining the sidebar's resizable/reorderable panel registry (Sessions/
// Files/Ports) — a per-window popover, not a permanent section.
export default function AgentsPanel({ cwd, anchor, onClose }: Props) {
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
      api
        .fetchSubagents(cwd)
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
    const timer = window.setInterval(poll, POLL_MS);
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
