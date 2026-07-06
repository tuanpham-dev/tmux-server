// Single-chord keybindings for every app-level shortcut, VS Code-style.
// A binding serializes to e.g. "ctrl+shift+KeyB": modifiers in fixed order
// (ctrl, shift, alt, meta), then the physical key's KeyboardEvent.code.
// e.code is used for ALL keys (letters, digits, punctuation, Tab, Enter…):
// it's keyboard-layout-stable, and named keys' codes match their key values
// on standard keyboards anyway.

export interface Command {
  id: string;
  label: string;
  defaultBinding: string;
  // Terminal-scoped commands are dispatched from xterm's own key handler in
  // TerminalView, not the global window dispatcher (which only suppresses
  // the browser default for terminal.copy — see App.tsx).
  scope: "global" | "terminal";
}

export const COMMANDS: Command[] = [
  { id: "sidebar.toggle", label: "Toggle Sidebar", defaultBinding: "ctrl+shift+KeyB", scope: "global" },
  { id: "quickSwitcher.toggle", label: "Toggle Quick Switcher", defaultBinding: "ctrl+KeyP", scope: "global" },
  { id: "commandPalette.toggle", label: "Show Command Palette", defaultBinding: "ctrl+shift+KeyP", scope: "global" },
  { id: "quickSwitcher.selectNext", label: "Quick Switcher: Select Next Item", defaultBinding: "alt+KeyJ", scope: "global" },
  { id: "quickSwitcher.selectPrevious", label: "Quick Switcher: Select Previous Item", defaultBinding: "alt+KeyK", scope: "global" },
  { id: "tab.next", label: "Next Tab", defaultBinding: "ctrl+Tab", scope: "global" },
  { id: "tab.previous", label: "Previous Tab", defaultBinding: "ctrl+shift+Tab", scope: "global" },
  { id: "tab.close", label: "Close Tab", defaultBinding: "ctrl+KeyW", scope: "global" },
  { id: "tab.closeOthers", label: "Tab: Close Others", defaultBinding: "", scope: "global" },
  { id: "settings.open", label: "Open Settings", defaultBinding: "ctrl+Comma", scope: "global" },
  { id: "session.new", label: "Session: New", defaultBinding: "", scope: "global" },
  { id: "session.kill", label: "Session: Kill Current", defaultBinding: "", scope: "global" },
  { id: "session.rename", label: "Session: Rename Current…", defaultBinding: "", scope: "global" },
  { id: "session.togglePin", label: "Session: Pin/Unpin Current", defaultBinding: "", scope: "global" },
  { id: "window.new", label: "Window: New", defaultBinding: "", scope: "global" },
  { id: "window.kill", label: "Window: Kill Current", defaultBinding: "", scope: "global" },
  { id: "window.rename", label: "Window: Rename Current…", defaultBinding: "", scope: "global" },
  { id: "terminal.copy", label: "Terminal: Copy Selection", defaultBinding: "ctrl+shift+KeyC", scope: "terminal" },
  { id: "terminal.find", label: "Terminal: Find", defaultBinding: "ctrl+shift+KeyF", scope: "terminal" },
  { id: "terminal.newline", label: "Terminal: Insert Newline", defaultBinding: "shift+Enter", scope: "terminal" },
];

// Overrides only (command id → combo); resolveBindings() merges over
// defaults. Persisted via settings.ts and the server settings doc.
export type KeybindingOverrides = Record<string, string>;

// extraCommands is the extension command registry (extensions.ts) — kept as
// a parameter rather than imported directly so this module (loaded at
// startup, before extension activation) has no dependency on it.
export function resolveBindings(
  overrides: KeybindingOverrides,
  extraCommands: Command[] = [],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const cmd of [...COMMANDS, ...extraCommands]) {
    map[cmd.id] = overrides[cmd.id] ?? cmd.defaultBinding ?? "";
  }
  return map;
}

// Keydowns of a modifier alone (or synthetic events with no code) can't
// form a chord.
const NON_CHORD_CODES = new Set([
  "",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

export function serializeEvent(e: KeyboardEvent): string | null {
  if (NON_CHORD_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("meta");
  parts.push(e.code);
  return parts.join("+");
}

const CODE_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      switch (part) {
        case "ctrl":
          return "Ctrl";
        case "shift":
          return "Shift";
        case "alt":
          return "Alt";
        case "meta":
          return "Meta";
        default:
          if (part.startsWith("Key")) return part.slice(3);
          if (part.startsWith("Digit")) return part.slice(5);
          return CODE_LABELS[part] ?? part;
      }
    })
    .join("+");
}

// True while the Keyboard settings recorder is capturing a chord. The global
// dispatcher and TerminalView's key handler both check this so the combo
// being recorded doesn't also trigger the command it currently belongs to
// (e.g. recording Ctrl+W must not close the settings tab). A module-level
// flag rather than React state: the dispatcher lives in a mount-once
// listener and this avoids threading one more ref through three components.
export const recorderState = { recording: false };
