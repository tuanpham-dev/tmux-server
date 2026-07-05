// Server hook for the live-preview extension — serves an HTML file (and its
// sibling assets) by absolute path, and reports the max mtime of that folder
// for the client's reload-on-change poll. Plain ESM: the server runs under
// tsx in both dev and prod (see server/package.json), so no build step is
// needed here, unlike the client entry (see extensions/build.mjs).
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Injected into HTML responses so the previewed page can report its scroll
// position to the host tab and accept a restore command after a reload —
// sessionStorage isn't usable here since the iframe (sandbox="allow-scripts"
// only, no allow-same-origin — see client.tsx) has an opaque origin where
// storage access throws.
const SCROLL_SCRIPT = `<script>(function(){
  var last = [0, 0];
  window.addEventListener("scroll", function() {
    var next = [window.scrollX, window.scrollY];
    if (next[0] === last[0] && next[1] === last[1]) return;
    last = next;
    window.parent.postMessage({ __livePreviewScroll: next }, "*");
  }, { passive: true });
  window.addEventListener("message", function(e) {
    var pos = e && e.data && e.data.__livePreviewRestore;
    if (Array.isArray(pos)) window.scrollTo(pos[0], pos[1]);
  });
})();</script>`;

function injectScrollScript(html) {
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose !== -1) return html.slice(0, headClose) + SCROLL_SCRIPT + html.slice(headClose);
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose !== -1) return html.slice(0, bodyClose) + SCROLL_SCRIPT + html.slice(bodyClose);
  return html + SCROLL_SCRIPT;
}

// Joins root + relPath, rejecting anything that escapes root — same
// approach as server/src/files.ts's resolveDestination, reimplemented here
// since extension server hooks can't import server-core internals.
function resolveWithinRoot(root, relPath) {
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// dir -> token (reused so re-previewing the same folder doesn't keep minting
// fresh ones) and token -> dir (what /public/* actually authorizes against).
// No expiry: this is a single-user local dev tool, and each entry is just
// two short strings, bounded by how many distinct folders are ever
// previewed in the process's lifetime.
const dirTokens = new Map();
const tokenDirs = new Map();

export function activate({ router }) {
  // Origin-checked normally (not under /public/) — see
  // server/src/security.ts's isOriginExemptPath for why that matters: this
  // is the only way a token can come into existence, so an attacker's page
  // (which fails the app's normal Origin check) can never mint one.
  router.get("/token", async (req, res) => {
    const dir = typeof req.query.dir === "string" ? req.query.dir : "";
    if (!dir) {
      res.status(400).json({ error: "dir is required" });
      return;
    }
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) throw new Error("not a directory");
    } catch {
      res.status(400).json({ error: "dir does not exist" });
      return;
    }
    let token = dirTokens.get(dir);
    if (!token) {
      token = randomBytes(24).toString("base64url");
      dirTokens.set(dir, token);
      tokenDirs.set(token, dir);
    }
    res.json({ token });
  });

  // Origin-exempt (see isOriginExemptPath) — the sandboxed preview iframe's
  // opaque origin sends Origin: null on these requests, which the app's
  // global gate would otherwise reject. Authorization here is the token
  // itself, not Origin: only a request that already passed the normal
  // Origin check (via /token above) can have obtained one.
  router.get("/public/serve/:token/*", async (req, res) => {
    const root = tokenDirs.get(req.params.token);
    if (!root) {
      res.status(404).json({ error: "unknown or expired preview" });
      return;
    }
    const relPath = req.params[0] ?? "";
    const target = resolveWithinRoot(root, relPath);
    if (!target) {
      res.status(400).json({ error: "path escapes preview root" });
      return;
    }
    // ORB (Chrome's Opaque Response Blocking) requires an explicit opt-in
    // for subresource loads made from an opaque-origin (sandboxed iframe)
    // context, even when served by this same process.
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      try {
        const html = await readFile(target, "utf8");
        res.type("html").send(injectScrollScript(html));
      } catch {
        res.status(404).json({ error: "file not found" });
      }
      return;
    }
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "file not found" });
    });
  });

  router.get("/public/mtime", async (req, res) => {
    const dir = tokenDirs.get(typeof req.query.token === "string" ? req.query.token : "");
    if (!dir) {
      res.status(404).json({ error: "unknown or expired preview" });
      return;
    }
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let max = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name === ".git") continue;
        const s = await stat(path.join(dir, entry.name));
        if (s.mtimeMs > max) max = s.mtimeMs;
      }
      res.json({ mtime: max });
    } catch {
      res.status(400).json({ error: "cannot read directory" });
    }
  });
}
