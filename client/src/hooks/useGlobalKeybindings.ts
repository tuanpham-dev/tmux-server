import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
export function useGlobalKeybindings(
  bindingsRef: MutableRefObject<Record<string, string>>,
  setSidebarVisible: Dispatch<SetStateAction<boolean>>,
  setShowSwitcher: Dispatch<SetStateAction<boolean>>,
  cycleTab: (delta: number) => void,
  activeTabId: string | null,
  closeTab: (id: string) => void,
  openSettingsTab: () => void,
  extCommands: RegisteredCommand[],
) {
  const globalCommandsRef = useRef<Record<string, () => void>>({});
  globalCommandsRef.current = {
    "sidebar.toggle": () => setSidebarVisible((v) => !v),
    "quickSwitcher.toggle": () => setShowSwitcher((v) => !v),
    "tab.next": () => cycleTab(1),
    "tab.previous": () => cycleTab(-1),
    "tab.close": () => {
      if (activeTabId) closeTab(activeTabId);
    },
    "settings.open": openSettingsTab,
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
