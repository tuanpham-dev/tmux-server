// Server hook for the command-history extension — one route: type text into
// a session's active pane via tmux send-keys. History data itself comes from
// core's GET /api/command-events (fed by shell integration); this hook only
// exists because typing into a terminal from a sidebar panel or the quick
// switcher has no client-side channel (TerminalAccessoryContext.sendInput is
// accessory-only). Plain ESM, execFile with an argv array (never a shell
// string) since the typed text is arbitrary user data — same posture as
// tasks/server.js.
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
      // -l = literal (no key-name lookup); "--" ends option parsing so text
      // starting with "-" isn't read as a flag. The Enter keypress is a
      // separate non-literal send, only on submit.
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
