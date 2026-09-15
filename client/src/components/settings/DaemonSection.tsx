import { useSettingsContext } from "./context";
import { useTerminalBackends } from "./useTerminalBackends";

// Settings of the bundled terminal daemon, the default terminal engine. They
// are read by the daemon only, so another engine (chosen under Terminal
// Backend) ignores them; they stay editable and apply once the daemon is back.
export default function DaemonSection() {
  const { settings, set, extensions } = useSettingsContext();
  const running = useTerminalBackends(extensions).find((b) => b.active);

  return (
    <>
      <h2 className="settings-section-title">Terminal Daemon</h2>
      {running && running.id !== "daemon" && (
        <div className="settings-hint">
          The server is running on {running.label} now. These settings apply once the backend is the bundled terminal
          daemon again (Terminal Backend).
        </div>
      )}

      <label className="settings-row">
        <span className="settings-label">Shell</span>
        <input
          className="dialog-input"
          placeholder="Your account's shell"
          value={settings.terminalShell}
          onChange={(e) => set("terminalShell", e.target.value)}
        />
      </label>
      <div className="settings-hint">
        The program new terminal windows start, e.g. /bin/zsh. Windows already open keep their shell.
      </div>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.restoreSessionsOnStart}
          onChange={(e) => set("restoreSessionsOnStart", e.target.checked)}
        />
        <span>Bring back sessions after a restart</span>
      </label>
      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.saveScrollback}
          disabled={!settings.restoreSessionsOnStart}
          onChange={(e) => set("saveScrollback", e.target.checked)}
        />
        <span>Include each window's output</span>
      </label>
      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.resumeAgentsOnRestore}
          disabled={!settings.restoreSessionsOnStart}
          onChange={(e) => set("resumeAgentsOnRestore", e.target.checked)}
        />
        <span>Resume AI agents that were running</span>
      </label>
      <div className="settings-hint">
        Terminals keep running when the server restarts. After a reboot, or if the terminal daemon stops, sessions
        come back in their folders with their windows and names. Output is kept up to 2,000 lines per window in
        files only your account can read; turn it off and none is written. Resuming types an agent's resume command
        (for example claude --continue) into a window that was running it.
      </div>
    </>
  );
}
