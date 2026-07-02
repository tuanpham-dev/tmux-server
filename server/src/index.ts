import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { api } from "./api.js";
import { handleAttach } from "./wsAttach.js";
import { handleTunnel } from "./wsTunnel.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3001);

const app = express();
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

server.listen(PORT, HOST, () => {
  console.log(`tmux-server server listening on http://${HOST}:${PORT}`);
});
