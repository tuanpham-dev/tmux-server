export interface AppSettings {
  fontFamily: string;
  fontSize: number;
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  uploadConflict: "rename" | "overwrite" | "ask";
  // "auto" shows the on-screen key bar only on coarse-pointer devices
  // (phones/tablets, and touch laptops).
  touchKeyBar: "auto" | "always" | "never";
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
  uploadConflict: "rename",
  touchKeyBar: "auto",
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
