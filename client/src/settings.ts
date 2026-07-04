export interface AppSettings {
  fontFamily: string;
  fontSize: number;
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  // xterm line height multiplier / letter spacing in px.
  lineHeight: number;
  letterSpacing: number;
  // 1 disables it; 4.5 is the VS Code/code-server default (WCAG AA) —
  // without it, e.g. lazygit's selected row keeps its original foreground
  // colors on the blue selection background and becomes unreadable.
  minimumContrastRatio: number;
  uploadConflict: "rename" | "overwrite" | "ask";
  // "auto" shows the on-screen key bar only on coarse-pointer devices
  // (phones/tablets, and touch laptops).
  touchKeyBar: "auto" | "always" | "never";
  // Gates the "Kill Session"/"Kill Window" confirm dialogs. Unsaved-changes
  // confirms (dirty CSV tabs) are never gated — that's data loss, not a
  // preference.
  confirmBeforeKill: boolean;
  // What closing the active tab activates: the previously active tab (VS
  // Code-style MRU) or the positional neighbor.
  tabCloseActivation: "recent" | "adjacent";
  // Default cwd for new sessions. Empty = server default (NEW_SESSION_CWD
  // from server/.env, else the server's own cwd). Validated server-side; a
  // non-existent path silently falls back rather than failing the create.
  newSessionCwd: string;
  // Git status badges/colors in the FILES tree. Off also skips the server's
  // porcelain status scan — worthwhile on very large repos.
  fileTreeGitStatus: boolean;
}

// Defaults mirror the user's code-server settings.json (editor.fontFamily,
// terminal.integrated.fontSize, terminal.integrated.fontWeightBold). "Symbols
// Nerd Font Mono" is bundled for Powerline/prompt icon glyphs IBM Plex Mono
// lacks. "Noto Color Emoji" is NOT bundled (too large for the PWA precache)
// — it renders only if installed locally, otherwise falls through to
// "Droid Sans Mono"/monospace.
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily:
    "'IBM Plex Mono', 'Symbols Nerd Font Mono', 'Noto Color Emoji', 'Droid Sans Mono', monospace",
  fontSize: 14,
  fontWeightBold: "normal",
  cursorStyle: "block",
  cursorBlink: true,
  lineHeight: 1,
  letterSpacing: 0,
  minimumContrastRatio: 4.5,
  uploadConflict: "rename",
  touchKeyBar: "auto",
  confirmBeforeKill: true,
  tabCloseActivation: "recent",
  newSessionCwd: "",
  fileTreeGitStatus: true,
};

const KEY = "settings";
const KEYBINDINGS_KEY = "keybindings";

export function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

// Keybinding overrides (command id → serialized combo), NOT the resolved
// map — unset commands fall through to their defaults in keybindings.ts, so
// a future default change reaches users who never customized that command.
export function loadKeybindingOverrides(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYBINDINGS_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveKeybindingOverrides(overrides: Record<string, string>): void {
  localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify(overrides));
}
