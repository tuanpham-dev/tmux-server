import { useEffect, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import type { ListeningPort } from "../types";

interface Props {
  refreshKey: number;
}

const POLL_MS = 30_000;

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
}

export default function PortsPanel({ refreshKey }: Props) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      api
        .fetchPorts()
        .then((next) => {
          if (cancelled) return;
          setPorts(next);
          setError(null);
          const live = new Set(next.map((p) => p.port));
          setSelected((prev) => {
            const pruned = new Set([...prev].filter((port) => live.has(port)));
            return pruned.size === prev.size ? prev : pruned;
          });
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };

    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  const toggle = (port: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };

  const selectedPorts = [...selected].sort((a, b) => a - b);
  const command =
    selectedPorts.length > 0
      ? `curl -so /tmp/tunnel.mjs ${window.location.origin}/tunnel.mjs && node /tmp/tunnel.mjs --url ${window.location.origin} ${selectedPorts.join(" ")}`
      : null;

  const onCopy = () => {
    if (!command) return;
    copyText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="ports-panel">
      {error && <div className="ports-error">{error}</div>}
      <ul className="port-list">
        {ports.map((p) => (
          <li key={p.port}>
            <button
              className={`port-item${selected.has(p.port) ? " selected" : ""}`}
              title={p.pid ? `pid ${p.pid}` : undefined}
              onClick={() => toggle(p.port)}
            >
              <span className="port-number">{p.port}</span>
              {p.process && <span className="port-process">{p.process}</span>}
              {!isLoopback(p.address) && <span className="port-address">{p.address}</span>}
            </button>
          </li>
        ))}
        {ports.length === 0 && !error && <li className="session-empty">No listening ports</li>}
      </ul>
      {command && (
        <div className="port-command">
          <code className="port-command-box">{command}</code>
          <button className="port-copy-button" onClick={onCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
