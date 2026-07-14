import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import { useListNavigation } from "../hooks/useListNavigation";
import type { ListeningPort, MenuItem, ProxyConfig, TunnelAuth } from "../types";
import Icon from "./Icon";

export interface PortsPanelHandle {
  // Moves keyboard focus onto the focused-or-first row — called by
  // sidebar.focusPorts (App.tsx), mirroring SessionListHandle.focusList.
  focusList: () => void;
}

interface Props {
  refreshKey: number;
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
}

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
// Referer fallback or a domain — see server/src/proxy.ts).
function proxyUrl(port: number, proxyConfig: ProxyConfig): string {
  if (proxyConfig.domain) {
    return `${window.location.protocol}//${port}.${proxyConfig.domain}/`;
  }
  return `${window.location.origin}/proxy/${port}/`;
}

const PortsPanel = forwardRef<PortsPanelHandle, Props>(function PortsPanel(
  { refreshKey, confirmDialog, onShowMenu },
  ref,
) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [revealed, setRevealed] = useState(false);
  const [killing, setKilling] = useState<Set<number>>(new Set());
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
    api
      .fetchPorts()
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
      // Likewise for proxy config — no configured domain is a valid state,
      // not an error, so falling back is correct here too.
      api
        .fetchProxyConfig()
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
    confirmDialog(
      `Kill ${p.process ?? "process"} (pid ${p.pid}) listening on port ${p.port}?`,
      "Kill",
    )
      .then((ok) => {
        if (!ok) return;
        setKilling((prev) => new Set(prev).add(p.port));
        return api
          .killPort(p.port)
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
      if (p) onShowMenu(rect.left + 8, rect.bottom, portMenuItems(p));
    },
  });

  // A "focus" request can arrive the instant this panel (re)mounts — the
  // PORTS accordion section unmounts it while collapsed, so
  // sidebar.focusPorts's expand-then-focus always mounts a fresh instance —
  // before its own async loadPorts() has resolved, when rowIds is still
  // empty. Deferred here to the first render where a row actually exists.
  const pendingFocusRef = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      focusList: () => {
        const target = nav.focusedId ?? rowIds[0];
        if (target) nav.focusRow(target);
        else pendingFocusRef.current = true;
      },
    }),
    [nav, rowIds],
  );
  useEffect(() => {
    if (pendingFocusRef.current && rowIds.length > 0) {
      pendingFocusRef.current = false;
      nav.focusRow(rowIds[0]);
    }
  }, [rowIds, nav]);

  return (
    <div className="ports-panel">
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
                  onShowMenu(e.clientX, e.clientY, portMenuItems(p));
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
});

export default PortsPanel;
