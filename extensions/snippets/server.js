// Server hook for the snippets extension — one route: type text into a
// session's active pane via tmux send-keys. Extensions talk only to their
// own activate() context, so this is deliberately a copy of
// command-history/server.js's route rather than a cross-extension import —
// the same reasoning that keeps each extension's tmux() helper local (see
// tasks/server.js's module comment).
import { execFile } from "node:child_process";

const TMUX_TIMEOUT = 5000;
const MAX_TEXT_LENGTH = 4096;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export function activate({ router }) {
  router.post("/type", async (req, res) => {
    const { session, text, submit } = req.body ?? {};
    if (typeof session !== "string" || !session || typeof text !== "string" || !text) {
      res.status(400).json({ error: "session and text are required" });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: "text too long" });
      return;
    }
    try {
      // -l = literal; "--" ends option parsing so text starting with "-"
      // isn't read as a flag. Enter is a separate non-literal send.
      await tmux(["send-keys", "-t", `=${session}:`, "-l", "--", text]);
      if (submit === true) {
        await tmux(["send-keys", "-t", `=${session}:`, "Enter"]);
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
