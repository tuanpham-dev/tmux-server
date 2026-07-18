// ports: the PORTS explorer section, extracted from core (formerly
// client/src/components/PortsPanel.tsx). Registers as an "explorer"-located
// sidebar panel so it renders as an accordion section alongside
// SESSIONS/FILES, exactly where the built-in panel lived. Host hooks
// (serverFetch for this extension's own /list & /kill routes) arrive via
// module-level bridge variables set once in activate() — same pattern as
// the search and git-scm extensions.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useListNavigation } from "../../_shared/useListNavigation";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror the server responses) ----

interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  session: string;
}

interface TunnelAuth {
  cookie: string | null;
  authorization: string | null;
}

// First configured PROXY_DOMAIN (core /api/proxy-config), or null when
// unset — decides whether a port's URL is "<port>.<domain>" or the
// app-origin "/proxy/<port>/" fallback.
interface ProxyConfig {
  domain: string | null;
}

// ---- Fetch helpers ----

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
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function fetchPorts(): Promise<ListeningPort[]> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch("/list").then((res) => readJson<ListeningPort[]>(res));
}

function killPort(port: number): Promise<void> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(`/kill/${port}`, { method: "POST" }).then((res) => readJson<void>(res));
}

// Core routes — tunnel/proxy are core infrastructure; this panel only reads
// their config to compose URLs and the tunnel command.
function fetchTunnelAuth(): Promise<TunnelAuth> {
  return fetch("/api/tunnel-auth").then((res) => readJson<TunnelAuth>(res));
}

function fetchProxyConfig(): Promise<ProxyConfig> {
  return fetch("/api/proxy-config").then((res) => readJson<ProxyConfig>(res));
}

// ---- Panel ----

const POLL_MS = 30_000;
const NO_AUTH: TunnelAuth = { cookie: null, authorization: null };
const NO_PROXY_CONFIG: ProxyConfig = { domain: null };
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

// code-server-style: a configured PROXY_DOMAIN routes "<port>.<domain>"
// straight to that port (every app works unmodified); otherwise fall back to
// the app-origin path proxy "/proxy/<port>/" (absolute-path assets need the
// Referer fallback or a domain — see core server/src/proxy.ts).
function proxyUrl(port: number, proxyConfig: ProxyConfig): string {
  if (proxyConfig.domain) {
    return `${window.location.protocol}//${port}.${proxyConfig.domain}/`;
  }
  return `${window.location.origin}/proxy/${port}/`;
}

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function PortsPanel({ actionsTarget, showMenu, confirmDialog }: PanelProps) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [revealed, setRevealed] = useState(false);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  // The header Refresh button (portaled into actionsTarget) bumps this to
  // force a reload — the role Sidebar's own per-panel refresh key played
  // before extraction.
  const [refreshKey, setRefreshKey] = useState(0);
  // Guards state updates from a fetch started before unmount but resolving
  // after — mirrors the effect's own `cancelled` flag, needed here too since
  // loadPorts is also invoked directly (not just from the effect) after kill.
  // Reset true on every mount (not just the initial ref value) — StrictMode's
  // dev double-invoke (mount, cleanup, mount) would otherwise leave this
  // stuck false after the cleanup from the first mount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPorts = useCallback(() => {
    fetchPorts()
      .then((next) => {
        if (!mountedRef.current) return;
        setPorts(next);
        setError(null);
        const live = new Set(next.map((p) => p.port));
        setSelected((prev) => {
          const pruned = new Set([...prev].filter((port) => live.has(port)));
          return pruned.size === prev.size ? prev : pruned;
        });
      })
      .catch((err) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      loadPorts();
      // A failed auth fetch shouldn't break the ports list — fall back to no
      // headers, same as an unauthenticated deployment.
      fetchTunnelAuth()
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
      // Likewise for proxy config — no configured domain is a valid state,
      // not an error, so falling back is correct here too.
      fetchProxyConfig()
        .then((next) => {
          if (cancelled) return;
          setProxyConfig((prev) => (prev.domain === next.domain ? prev : next));
        })
        .catch(() => {
          if (!cancelled) setProxyConfig(NO_PROXY_CONFIG);
        });
    };

    load();
    // The initial load above and any refreshKey-triggered reload (a user
    // action, so the tab is visible) always run; only the background 30s
    // ticks skip while hidden — resuming immediately on regaining
    // visibility instead of waiting out the rest of the interval.
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshKey, loadPorts]);

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

  const onOpenPort = (port: number) => {
    window.open(proxyUrl(port, proxyConfig), "_blank", "noopener");
  };

  const onCopyPortUrl = (port: number) => {
    copyText(proxyUrl(port, proxyConfig))
      .then(() => {
        setCopiedPort(port);
        window.setTimeout(() => setCopiedPort((prev) => (prev === port ? null : prev)), 1500);
      })
      .catch(() => {});
  };

  const onKillPort = (p: ListeningPort) => {
    const confirm =
      confirmDialog ?? ((message: string) => Promise.resolve(window.confirm(message)));
    confirm(`Kill ${p.process ?? "process"} (pid ${p.pid}) listening on port ${p.port}?`, "Kill")
      .then((ok) => {
        if (!ok) return;
        setKilling((prev) => new Set(prev).add(p.port));
        return killPort(p.port)
          .then(() => loadPorts())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            setKilling((prev) => {
              const next = new Set(prev);
              next.delete(p.port);
              return next;
            });
          });
      })
      .catch(() => {});
  };

  const portRowId = (port: number) => `port:${port}`;
  const portsById = useMemo(() => new Map(ports.map((p) => [portRowId(p.port), p])), [ports]);
  const rowIds = useMemo(() => ports.map((p) => portRowId(p.port)), [ports]);

  const portMenuItems = (p: ListeningPort): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open in Browser", onClick: () => onOpenPort(p.port) },
      { label: "Copy URL", onClick: () => onCopyPortUrl(p.port) },
    ];
    if (p.pid !== undefined) {
      items.push({ label: "Kill Process", danger: true, onClick: () => onKillPort(p) });
    }
    return items;
  };

  const nav = useListNavigation({
    rowIds,
    onActivate: (id) => {
      const p = portsById.get(id);
      if (p) toggle(p.port);
    },
    onContextMenuKey: (id, rect) => {
      const p = portsById.get(id);
      if (p) showMenu?.(rect.left + 8, rect.bottom, portMenuItems(p));
    },
  });

  return (
    <div className="ports-panel">
      {actionsTarget &&
        createPortal(
          <button
            className="icon-button"
            title="Refresh"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <Icon name="refresh" />
          </button>,
          actionsTarget,
        )}
      {error && <div className="ports-error">{error}</div>}
      <ul className="port-list" onKeyDown={nav.onKeyDown}>
        {ports.map((p) => {
          const rowProps = nav.getRowProps(portRowId(p.port));
          return (
            <li key={p.port} className={`port-row${selected.has(p.port) ? " selected" : ""}`}>
              <button
                className="port-item"
                title={p.pid ? `pid ${p.pid}` : undefined}
                onClick={() => toggle(p.port)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  nav.focusRow(portRowId(p.port));
                  showMenu?.(e.clientX, e.clientY, portMenuItems(p));
                }}
                tabIndex={rowProps.tabIndex}
                ref={rowProps.ref}
                onFocus={rowProps.onFocus}
              >
                <span className="port-number">{p.port}</span>
                {p.process && <span className="port-process">{p.process}</span>}
                <span className="port-session">{p.session}</span>
                {!isLoopback(p.address) && <span className="port-address">{p.address}</span>}
              </button>
              <div className="port-actions">
                <button
                  className="icon-button port-action-button"
                  title="Open in browser"
                  tabIndex={-1}
                  onClick={() => onOpenPort(p.port)}
                >
                  <Icon name="link-external" />
                </button>
                <button
                  className="icon-button port-action-button"
                  title={copiedPort === p.port ? "Copied" : "Copy URL"}
                  tabIndex={-1}
                  onClick={() => onCopyPortUrl(p.port)}
                >
                  <Icon name={copiedPort === p.port ? "check" : "copy"} />
                </button>
                {p.pid !== undefined && (
                  <button
                    className="icon-button port-action-button"
                    title="Kill process"
                    disabled={killing.has(p.port)}
                    tabIndex={-1}
                    onClick={() => onKillPort(p)}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {ports.length === 0 && !error && (
          <li className="session-empty">No listening ports in tmux sessions</li>
        )}
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

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer";
    defaultCollapsed?: boolean;
    focusBinding?: string;
    component: (props: PanelProps) => ReturnType<typeof PortsPanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "ports",
    title: "Ports",
    icon: "plug",
    location: "explorer",
    // Matches the built-in panel's pre-extraction default (see the old
    // DEFAULT_PANEL_STATE in Sidebar.tsx: ports started collapsed).
    defaultCollapsed: true,
    component: PortsPanel,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
}
