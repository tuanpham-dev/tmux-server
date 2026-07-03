// WebSockets ignore same-origin policy: any page open in a browser on this
// machine can open ws://127.0.0.1:3001/ws/attach and inject keystrokes into
// tmux, regardless of the server's bind address. A handful of no-body POST
// endpoints (kill-session, etc.) are similarly reachable cross-origin as
// "simple requests". Gate both on Host (blocks DNS rebinding) and Origin
// (blocks browser-driven cross-origin requests) against an explicit
// allowlist — loopback by default, extended via ALLOWED_HOSTS for reverse
// proxies (nginx's documented config already forwards the real Host).
const DEFAULT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseAllowedHosts(): Set<string> {
  const extra = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}

const allowedHosts = parseAllowedHosts();

// Strips a port suffix, respecting bracketed IPv6 literals (e.g.
// "[::1]:3001" -> "[::1]", "example.com:443" -> "example.com").
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader.toLowerCase() : hostHeader.slice(0, end + 1).toLowerCase();
  }
  const colon = hostHeader.lastIndexOf(":");
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return allowedHosts.has(hostnameOf(hostHeader));
}

// No Origin header means the request didn't come from a browser context that
// enforces one (curl, the tunnel CLI, direct WS clients) — nothing for this
// check to protect against, so it passes. A browser always sends Origin on
// both fetch/XHR (cross-origin) and WebSocket upgrades.
export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"), matching
    // the form hostnameOf() produces from a Host header.
    return allowedHosts.has(new URL(originHeader).hostname.toLowerCase());
  } catch {
    return false;
  }
}
