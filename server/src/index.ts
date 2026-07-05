import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { api } from "./api.js";
import { loadEnabledServerHooks } from "./extensions.js";
import { isAllowedHost, isAllowedOrigin, isOriginExemptPath } from "./security.js";
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
app.use(express.json());
app.use("/api", api);

const tunnelCli = path.resolve(import.meta.dirname, "../../cli/tunnel.mjs");
app.get("/tunnel.mjs", (_req, res) => {
  res.type("text/javascript").sendFile(tunnelCli);
});

const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url ?? "", "http://localhost");
  if (pathname === "/ws/attach") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAttach(ws, req);
    });
  } else if (pathname === "/ws/tunnel") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTunnel(ws);
    });
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
