import { killWindowTab, listWindowTabAttachment } from "./tmux.js";

// Window-tab cleanup is normally client-driven (closing a tab kills its
// synthetic session directly), but an abandoned browser tab — closed
// without that handler running, or a crash — would otherwise leak its
// tmuxserver-view-* session forever. This sweep is a safety net, not the
// primary mechanism, so the threshold is deliberately generous: TerminalView
// reconnects across laptop sleep, which can mean hours of legitimate
// zero-attachment time, not seconds.
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function startViewSweeper(): void {
  const idleSince = new Map<string, number>();

  setInterval(() => {
    listWindowTabAttachment()
      .then((views) => {
        const seen = new Set(views.map((v) => v.name));
        for (const name of idleSince.keys()) {
          if (!seen.has(name)) idleSince.delete(name);
        }
        for (const { name, attached } of views) {
          if (attached > 0) {
            idleSince.delete(name);
            continue;
          }
          const since = idleSince.get(name);
          if (since === undefined) {
            idleSince.set(name, Date.now());
          } else if (Date.now() - since > IDLE_THRESHOLD_MS) {
            idleSince.delete(name);
            killWindowTab(name).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, CHECK_INTERVAL_MS);
}
