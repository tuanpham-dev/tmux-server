import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { api } from "./api.js";
import { loadEnabledServerHooks } from "./extensions.js";
import {
  handleProxyRequest,
  handleProxyUpgrade,
  parseProxyPath,
  portFromReferer,
} from "./proxy.js";
import {
  AUTH_COOKIE_NAME,
  cookieDomainFor,
  isAllowedHost,
  isAllowedOrigin,
  isAuthExemptPath,
  isAuthGateEnabled,
  isOriginExemptPath,
  isValidAuthToken,
  portFromProxyHost,
  tokenFromRequest,
} from "./security.js";
import { startViewSweeper } from "./viewSweeper.js";
import { handleAttach } from "./wsAttach.js";
import { handleTunnel } from "./wsTunnel.js";

// Optional server/.env (gitignored), e.g. NEW_SESSION_CWD — resolved relative
// to this file so it's found no matter which directory the server starts from.
// Consumers read process.env at call time, so loading after the imports above
// is safe.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env"));
} catch {
  // No .env file — every variable it could set has a fallback.
}

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3001);

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
}

const app = express();
// Host guards against DNS rebinding; Origin guards against a browser tab on
// some other site making a request here (WebSockets ignore same-origin
// policy entirely, and a handful of no-body POST endpoints are reachable
// cross-origin as "simple requests"). Requests with no Origin (curl, the
// tunnel CLI) aren't from a browser context this protects against, so they
// pass — see security.ts.
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  // /public/ routes (e.g. live-preview's serve/mtime) enforce their own
  // capability-token authorization instead of trusting Origin — see
  // isOriginExemptPath's module comment for why that's safe.
  if (!isOriginExemptPath(req.path) && !isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  next();
});
// Optional shared-secret gate (off unless AUTH_TOKEN is set — see
// security.ts). A valid ?token= on ANY path (not just /api) mints the
// cookie, since the entry point is typically the SPA shell at "/". Only
// /api/* is actually rejected without it: the SPA shell and /tunnel.mjs are
// public code with nothing to protect, and /api/ext/*/public/* enforces its
// own capability token (see isAuthExemptPath).
app.use((req, res, next) => {
  if (!isAuthGateEnabled()) {
    next();
    return;
  }
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  if (queryToken && isValidAuthToken(queryToken)) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    res.cookie(AUTH_COOKIE_NAME, queryToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: proto?.split(",")[0]?.trim() === "https",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
      // Undefined when PROXY_DOMAIN is unset or the current host isn't one
      // of its configured domains — leaves the cookie host-only, today's
      // behavior. Set, this shares the cookie across every "<port>.<domain>"
      // origin so a proxied dev server on a different subdomain is already
      // authenticated.
      domain: cookieDomainFor(req.headers.host),
    });
  }
  // Gated the same as /api/*: a /proxy or /absproxy path, or a
  // PROXY_DOMAIN subdomain request naming a port — both reach a local
  // process, same as an API call would.
  const isProxyRequest =
    parseProxyPath(req.path) !== null || portFromProxyHost(req.headers.host) !== null;
  if ((!req.path.startsWith("/api/") && !isProxyRequest) || isAuthExemptPath(req.path)) {
    next();
    return;
  }
  const authHeader = req.headers["x-auth-token"];
  const token = tokenFromRequest(
    req.headers.cookie,
    Array.isArray(authHeader) ? authHeader[0] : authHeader,
    queryToken,
  );
  if (!isValidAuthToken(token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});
// Reverse proxy to a locally-listening port, code-server style — mounted
// ahead of express.json() so proxied request bodies stream through
// untouched rather than being buffered/parsed here.
app.use((req, res, next) => {
  const subdomainPort = portFromProxyHost(req.headers.host);
  if (subdomainPort !== null) {
    if (subdomainPort === PORT) {
      res.status(400).json({ error: "cannot proxy the server's own port" });
      return;
    }
    handleProxyRequest(req, res, subdomainPort, req.url ?? "/", null);
    return;
  }
  const parsed = parseProxyPath(req.path);
  if (parsed) {
    if (parsed.port === PORT) {
      res.status(400).json({ error: "cannot proxy the server's own port" });
      return;
    }
    const search = req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const prefix = parsed.absolute ? null : `/proxy/${parsed.port}`;
    handleProxyRequest(req, res, parsed.port, parsed.rest + search, prefix);
    return;
  }
  next();
});
app.use(express.json());
app.use("/api", api);

const tunnelCli = path.resolve(import.meta.dirname, "../../cli/tunnel.mjs");
app.get("/tunnel.mjs", (_req, res) => {
  res.type("text/javascript").sendFile(tunnelCli);
});

const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
if (existsSync(clientDist)) {
  const manifestPath = path.join(clientDist, "manifest.webmanifest");
  const indexHtmlPath = path.join(clientDist, "index.html");

  // Registered ahead of express.static below so a custom APP_NAME (see
  // server/.env) can override the name baked into these two files at build
  // time — read fresh each request since both files are tiny and this is a
  // low-traffic personal tool, not worth caching.
  app.get("/manifest.webmanifest", (_req, res, next) => {
    const appName = process.env.APP_NAME;
    if (!appName || !existsSync(manifestPath)) {
      next();
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.name = appName;
    manifest.short_name = appName;
    res.type("application/manifest+json").send(JSON.stringify(manifest));
  });

  // index: false — otherwise express.static serves index.html for "/"
  // itself (its default behavior), bypassing the templated catch-all below.
  app.use(express.static(clientDist, { index: false }));
  // Fallback for absolute-path assets (e.g. "/assets/x.js") requested by a
  // page served through /proxy/<port>/ or /absproxy/<port>/ — express.static
  // just missed above, so route it to the port named in the Referer instead
  // of falling through to the SPA shell. Same-origin Referer only (see
  // portFromReferer) and HTTP only (WebSocket upgrades rarely carry one).
  app.use((req, res, next) => {
    if (
      req.path.startsWith("/api/") ||
      req.path.startsWith("/ws/") ||
      req.path === "/tunnel.mjs" ||
      parseProxyPath(req.path) !== null
    ) {
      next();
      return;
    }
    const refererPort = portFromReferer(req.headers.referer, req.headers.host);
    if (refererPort !== null && refererPort !== PORT) {
      handleProxyRequest(req, res, refererPort, req.url ?? "/", null);
      return;
    }
    next();
  });
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    const appName = process.env.APP_NAME;
    if (!appName) {
      res.sendFile(indexHtmlPath);
      return;
    }
    const html = readFileSync(indexHtmlPath, "utf8").replace(
      /<title>.*?<\/title>/,
      `<title>${escapeHtml(appName)}</title>`,
    );
    res.type("html").send(html);
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    socket.destroy();
    return;
  }
  const { pathname, searchParams } = new URL(req.url ?? "", "http://localhost");
  if (isAuthGateEnabled()) {
    const authHeader = req.headers["x-auth-token"];
    const token = tokenFromRequest(
      req.headers.cookie,
      Array.isArray(authHeader) ? authHeader[0] : authHeader,
      searchParams.get("token") ?? undefined,
    );
    if (!isValidAuthToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  const subdomainPort = portFromProxyHost(req.headers.host);
  const parsedProxy = subdomainPort === null ? parseProxyPath(pathname) : null;
  if (pathname === "/ws/attach") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAttach(ws, req, PORT);
    });
  } else if (pathname === "/ws/tunnel") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTunnel(ws);
    });
  } else if (subdomainPort !== null) {
    if (subdomainPort === PORT) {
      socket.destroy();
      return;
    }
    handleProxyUpgrade(req, socket, head, subdomainPort, req.url ?? "/");
  } else if (parsedProxy) {
    if (parsedProxy.port === PORT) {
      socket.destroy();
      return;
    }
    handleProxyUpgrade(req, socket, head, parsedProxy.port, parsedProxy.rest);
  } else {
    socket.destroy();
  }
});

// Without this, a listen failure (e.g. EADDRINUSE from two rapid tsx-watch
// restarts racing on shutdown) throws uncaught and kills the process with an
// opaque stack trace — tsx watch only respawns on the next file save, so it
// stays dead. Logging plainly at least makes the cause diagnosable.
server.on("error", (err) => {
  console.error(`server failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`tmux-server server listening on http://${HOST}:${PORT}`);
});

startViewSweeper();
loadEnabledServerHooks().catch((err) => {
  console.error("failed to load extension server hooks:", err);
});
