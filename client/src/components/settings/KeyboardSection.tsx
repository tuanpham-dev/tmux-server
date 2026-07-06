import { useEffect, useState } from "react";
import { useExtensionRegistry } from "../../extensions";
import {
  COMMANDS,
  formatBinding,
  recorderState,
  resolveBindings,
  serializeEvent,
  type Command,
} from "../../keybindings";
import Icon from "../Icon";
import { useSettingsContext } from "./context";

export default function KeyboardSection({ active }: { active: boolean }) {
  const { keybindingOverrides, onKeybindingOverridesChange } = useSettingsContext();
  const [filter, setFilter] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);

  // Extension-registered commands join the built-in list everywhere this
  // section lists/resolves/records commands — see App.tsx's matching merge
  // for the dispatcher side.
  const { commands: extCommands } = useExtensionRegistry();
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBinding: c.defaultBinding ?? "",
    scope: "global",
  }));
  const allCommands: Command[] = [...COMMANDS, ...extCommandDefs];

  const resolved = resolveBindings(keybindingOverrides, extCommandDefs);
  // combo → command ids sharing it, for the conflict warning. An empty
  // binding (an extension command with no defaultBinding, never assigned
  // one) is intentionally excluded — several of those otherwise look like
  // mutual conflicts under the shared "" key.
  const byBinding: Record<string, string[]> = {};
  for (const cmd of allCommands) {
    if (resolved[cmd.id]) (byBinding[resolved[cmd.id]] ??= []).push(cmd.id);
  }

  // Chord recorder. The window-level capture listener plus the module-level
  // recorderState flag (checked by App's dispatcher and read here) means the
  // captured combo never also triggers the command it's currently bound to.
  useEffect(() => {
    recorderState.recording = recordingId !== null;
    if (recordingId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = serializeEvent(e);
      if (!combo) return; // modifier alone — keep waiting for the chord
      const cmd = allCommands.find((c) => c.id === recordingId);
      const next = { ...keybindingOverrides };
      // Recording the default back is "no override", so a future default
      // change still reaches this command.
      if (cmd && combo === cmd.defaultBinding) delete next[recordingId];
      else next[recordingId] = combo;
      onKeybindingOverridesChange(next);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      recorderState.recording = false;
    };
  }, [recordingId, keybindingOverrides, onKeybindingOverridesChange]);

  // Leaving the tab mid-recording cancels it (this section itself unmounts,
  // and its own cleanup fires, whenever the user navigates to another nav
  // item — see SettingsView's conditional render — so only the "whole
  // Settings tab became inactive" case needs watching here).
  useEffect(() => {
    if (!active) setRecordingId(null);
  }, [active]);

  const resetBinding = (id: string) => {
    const next = { ...keybindingOverrides };
    delete next[id];
    onKeybindingOverridesChange(next);
  };

  const filterLower = filter.trim().toLowerCase();
  const visibleCommands = allCommands.filter(
    (cmd) =>
      !filterLower ||
      cmd.label.toLowerCase().includes(filterLower) ||
      formatBinding(resolved[cmd.id]).toLowerCase().includes(filterLower),
  );

  return (
    <>
      <h2 className="settings-section-title">Keyboard Shortcuts</h2>

      <input
        className="dialog-input keybinding-filter"
        placeholder="Type to search keybindings"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="keybinding-table">
        {visibleCommands.map((cmd) => {
          const binding = resolved[cmd.id];
          const overridden = keybindingOverrides[cmd.id] !== undefined;
          const isRecording = recordingId === cmd.id;
          const conflicts = (byBinding[binding] ?? []).filter((id) => id !== cmd.id);
          const conflictLabels = conflicts
            .map((id) => allCommands.find((c) => c.id === id)?.label ?? id)
            .join(", ");
          return (
            <div
              key={cmd.id}
              className="keybinding-row"
              onDoubleClick={() => setRecordingId(cmd.id)}
            >
              <span className="keybinding-label">{cmd.label}</span>
              {conflicts.length > 0 && !isRecording && (
                <span
                  className="keybinding-conflict"
                  title={`Also bound to: ${conflictLabels}`}
                >
                  <Icon name="warning" />
                </span>
              )}
              <span className={`keybinding-chip${isRecording ? " recording" : ""}`}>
                {isRecording ? "Press key combination…" : formatBinding(binding)}
              </span>
              <button
                className="icon-button keybinding-action"
                title={isRecording ? "Cancel recording (Esc)" : "Change keybinding"}
                onClick={() => setRecordingId(isRecording ? null : cmd.id)}
              >
                <Icon name="edit" />
              </button>
              <button
                className="icon-button keybinding-action"
                title="Reset to default"
                style={{ visibility: overridden ? "visible" : "hidden" }}
                onClick={() => resetBinding(cmd.id)}
              >
                <Icon name="discard" />
              </button>
            </div>
          );
        })}
        {visibleCommands.length === 0 && (
          <div className="keybinding-empty">No matching keybindings</div>
        )}
      </div>
    </>
  );
}
