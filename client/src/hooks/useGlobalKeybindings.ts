import { useEffect, useRef, type MutableRefObject } from "react";
import type { RegisteredCommand } from "../extensions";
import { recorderState, serializeEvent } from "../keybindings";

// Every global shortcut in one capture-phase dispatcher, driven by the
// rebindable keybindings map (keybindings.ts). A matched combo gets
// preventDefault + stopPropagation so it wins over both browser defaults
// (Ctrl+P print; Ctrl+Tab/Ctrl+W are overridable only in the installed
// PWA) and xterm's own key handling — Ctrl+Tab reaching tmux would feed it
// a literal Tab, Ctrl+W would send ^W to the shell. The terminal.* combos
// are dispatched inside TerminalView's xterm handler instead, with one
// exception: whatever combo terminal.copy is bound to gets a window-level
// preventDefault (no stop — the event must still reach xterm, which does
// the actual copy) to suppress Chrome/Firefox's Ctrl+Shift+C "inspect
// element" default. Freshness via refs so the mount-once listener always
// sees current bindings and handlers.
//
// `handlers` is built by the caller (App.tsx), which owns every action hook
// (session/window CRUD, tab management) this dispatcher needs to invoke —
// keeping the construction there avoids this hook's parameter list growing
// with every new command, and lets App.tsx reuse the exact same record for
// the command palette's entries.
export function useGlobalKeybindings(
  bindingsRef: MutableRefObject<Record<string, string>>,
  handlers: Record<string, () => void>,
  extCommands: RegisteredCommand[],
) {
  const globalCommandsRef = useRef<Record<string, () => void>>({});
  globalCommandsRef.current = {
    ...handlers,
    ...Object.fromEntries(extCommands.map((c) => [c.id, c.run])),
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The Keyboard settings recorder owns the keyboard while capturing a
      // chord — recording Ctrl+W must not also close the tab.
      if (recorderState.recording) return;
      const combo = serializeEvent(e);
      if (!combo) return;
      const bindings = bindingsRef.current;
      if (combo === bindings["terminal.copy"]) {
        e.preventDefault();
        return;
      }
      for (const [id, run] of Object.entries(globalCommandsRef.current)) {
        if (bindings[id] === combo) {
          e.preventDefault();
          e.stopPropagation();
          run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
