export interface AppSettings {
  fontFamily: string;
  fontSize: number;
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  ctrlBInTerminal: boolean;
  uploadConflict: "rename" | "overwrite" | "ask";
}

// Defaults mirror the user's code-server settings.json (editor.fontFamily,
// terminal.integrated.fontSize, terminal.integrated.fontWeightBold), with
// two bundled fallback fonts filling gaps IBM Plex Mono has: "Symbols Nerd
// Font Mono" for Powerline/prompt icon glyphs, "Noto Color Emoji" for
// standard Unicode emoji (e.g. a sailboat in a shell prompt).
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily:
    "'IBM Plex Mono', 'Symbols Nerd Font Mono', 'Noto Color Emoji', 'Droid Sans Mono', monospace",
  fontSize: 14,
  fontWeightBold: "normal",
  cursorStyle: "block",
  cursorBlink: true,
  ctrlBInTerminal: false,
  uploadConflict: "rename",
};

const KEY = "settings";

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
