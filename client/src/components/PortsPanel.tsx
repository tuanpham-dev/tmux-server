import { useEffect, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import type { ListeningPort, TunnelAuth } from "../types";
import Icon from "./Icon";

interface Props {
  refreshKey: number;
}

const POLL_MS = 30_000;
const NO_AUTH: TunnelAuth = { cookie: null, authorization: null };
const MASK = "••••";

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
}

// Wraps a value in single quotes for a POSIX shell, escaping embedded single
// quotes with the standard '\'' idiom — cookie values can legally contain them.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function authHeaders(auth: TunnelAuth): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  if (auth.cookie) headers.push({ name: "Cookie", value: auth.cookie });
  if (auth.authorization) headers.push({ name: "Authorization", value: auth.authorization });
  return headers;
}

// Builds the copy-pasteable tunnel command. When `mask` is set, header values
// are replaced with a placeholder for on-screen display; `mask: false` is
// what actually gets copied to the clipboard.
function buildCommand(origin: string, ports: number[], auth: TunnelAuth, mask: boolean): string {
  const headers = authHeaders(auth).map((h) => ({ ...h, value: mask ? MASK : h.value }));
  const curlArgs = headers.map((h) => `-H ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  const nodeArgs = headers.map((h) => `--header ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  const curl = `curl -so /tmp/tunnel.mjs ${curlArgs ? `${curlArgs} ` : ""}${origin}/tunnel.mjs`;
  const node = `node /tmp/tunnel.mjs --url ${origin} ${nodeArgs ? `${nodeArgs} ` : ""}${ports.join(" ")}`;
  return `${curl} && ${node}`;
}

export default function PortsPanel({ refreshKey }: Props) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [revealed, setRevealed] = useState(false);

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
      // A failed auth fetch shouldn't break the ports list — fall back to no
      // headers, same as an unauthenticated deployment.
      api
        .fetchTunnelAuth()
        .then((next) => {
          if (cancelled) return;
          setAuth((prev) => {
            if (prev.cookie === next.cookie && prev.authorization === next.authorization) return prev;
            return next;
          });
        })
        .catch(() => {
          if (!cancelled) setAuth(NO_AUTH);
        });
    };

    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  // Re-mask whenever the underlying auth headers change (e.g. a rotated
  // session cookie), so a stale reveal doesn't linger on screen.
  useEffect(() => {
    setRevealed(false);
  }, [auth]);

  const toggle = (port: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };

  const selectedPorts = [...selected].sort((a, b) => a - b);
  const hasAuthHeaders = auth.cookie !== null || auth.authorization !== null;
  const origin = window.location.origin;
  const displayCommand =
    selectedPorts.length > 0 ? buildCommand(origin, selectedPorts, auth, !revealed) : null;

  const onCopy = () => {
    if (selectedPorts.length === 0) return;
    const realCommand = buildCommand(origin, selectedPorts, auth, false);
    copyText(realCommand)
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
      {displayCommand && (
        <div className="port-command">
          <code className="port-command-box">{displayCommand}</code>
          {hasAuthHeaders && (
            <button
              className="icon-button"
              title={revealed ? "Hide auth header values" : "Reveal auth header values"}
              onClick={() => setRevealed((prev) => !prev)}
            >
              <Icon name={revealed ? "eye-closed" : "eye"} />
            </button>
          )}
          <button className="port-copy-button" onClick={onCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
