import { useEffect, useState } from "react";
import {
  disablePush,
  enablePush,
  getCurrentSubscription,
  pushUnavailableReason,
} from "../../pushSubscribe";
import type { AppSettings } from "../../settings";
import { useSettingsContext } from "./context";

// Local component state, not a synced AppSettings field — see
// pushSubscribe.ts's module comment for why a subscription can't be a
// cross-device preference. "unavailable" carries the specific reason so the
// UI can explain rather than just disappear (LESSONS-adjacent: fail loud).
type PushUiState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "subscribed" }
  | { kind: "unsubscribed" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

function PushNotificationToggle() {
  const [state, setState] = useState<PushUiState>({ kind: "loading" });

  useEffect(() => {
    const reason = pushUnavailableReason();
    if (reason) {
      setState({ kind: "unavailable", reason });
      return;
    }
    getCurrentSubscription()
      .then((sub) => setState({ kind: sub ? "subscribed" : "unsubscribed" }))
      .catch((err) => setState({ kind: "error", message: String(err) }));
  }, []);

  const toggle = async (checked: boolean) => {
    setState({ kind: "busy" });
    try {
      if (checked) await enablePush();
      else await disablePush();
      setState({ kind: checked ? "subscribed" : "unsubscribed" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return <div className="settings-hint">{state.reason}</div>;
  }

  return (
    <>
      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={state.kind === "subscribed"}
          disabled={state.kind === "busy"}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>Push notifications on this device when a pane rings the bell</span>
      </label>
      {state.kind === "error" && <div className="settings-hint">{state.message}</div>}
    </>
  );
}

export default function BehaviorSection() {
  const { settings, set } = useSettingsContext();

  return (
    <>
      <h2 className="settings-section-title">Behavior</h2>

      <label className="settings-row">
        <span className="settings-label">On upload name conflict</span>
        <select
          className="dialog-input settings-select"
          value={settings.uploadConflict}
          onChange={(e) => set("uploadConflict", e.target.value as AppSettings["uploadConflict"])}
        >
          <option value="rename">Keep both (rename new file)</option>
          <option value="overwrite">Overwrite existing file</option>
          <option value="ask">Ask every time</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Image paste/drop upload directory</span>
        <input
          className="dialog-input"
          placeholder="{cwd}/uploads"
          value={settings.pasteDropUploadDir}
          onChange={(e) => set("pasteDropUploadDir", e.target.value)}
        />
      </label>
      <div className="settings-hint">
        {"{cwd} expands to the pane's directory, {gitroot} to its git repo root; empty means {cwd}/uploads"}
      </div>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.confirmBeforeKill}
          onChange={(e) => set("confirmBeforeKill", e.target.checked)}
        />
        <span>Confirm before killing sessions and windows</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">After closing the active tab</span>
        <select
          className="dialog-input settings-select"
          value={settings.tabCloseActivation}
          onChange={(e) =>
            set("tabCloseActivation", e.target.value as AppSettings["tabCloseActivation"])
          }
        >
          <option value="recent">Activate previously used tab</option>
          <option value="adjacent">Activate adjacent tab</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Open new tabs</span>
        <select
          className="dialog-input settings-select"
          value={settings.newTabPlacement}
          onChange={(e) =>
            set("newTabPlacement", e.target.value as AppSettings["newTabPlacement"])
          }
        >
          <option value="end">At the end of the tab bar</option>
          <option value="afterActive">To the right of the active tab</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.tabGroupsBySession}
          onChange={(e) => set("tabGroupsBySession", e.target.checked)}
        />
        <span>Group tabs by session in the tab bar</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">Default new-session directory</span>
        <input
          className="dialog-input"
          placeholder="Server default"
          value={settings.newSessionCwd}
          onChange={(e) => set("newSessionCwd", e.target.value)}
        />
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.paletteSortByUsage}
          onChange={(e) => set("paletteSortByUsage", e.target.checked)}
        />
        <span>Sort command palette by most-used</span>
      </label>

      <PushNotificationToggle />
    </>
  );
}
