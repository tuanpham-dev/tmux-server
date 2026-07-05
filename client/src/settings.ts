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
  // Where a newly opened tab is inserted: appended at the end of the tab
  // bar, or immediately to the right of the active tab.
  newTabPlacement: "end" | "afterActive";
  // Chrome-style tab groups: each session's tabs sit behind a colored,
  // collapsible chip in the tab bar. Off by default — pure opt-in.
  tabGroupsBySession: boolean;
  // Default cwd for new sessions. Empty = server default (NEW_SESSION_CWD
  // from server/.env, else the server's own cwd). Validated server-side; a
  // non-existent path silently falls back rather than failing the create.
  newSessionCwd: string;
  // Git status badges/colors in the FILES tree. Off also skips the server's
  // porcelain status scan — worthwhile on very large repos.
  fileTreeGitStatus: boolean;
  // `${extensionId}:${themeLabel}` from an installed extension's
  // contributes.themes — see theme.ts. Defaults to the bundled
  // tmux-server.plastic-legacy-theme extension; "" (or any unresolvable
  // value) falls back to the hard-coded Plastic Legacy values in
  // styles.css's :root, which are pixel-identical to that extension.
  colorTheme: string;
  // `${extensionId}:${iconThemeId}` from an installed extension's
  // contributes.iconThemes — see utils/iconThemes.ts. Defaults to the
  // bundled tmux-server.seti-icons extension; "" means no icon theme (blank
  // spacer icons, not a fallback to Seti).
  iconTheme: string;
}

// Defaults mirror the user's code-server settings.json (editor.fontFamily,
// terminal.integrated.fontSize, terminal.integrated.fontWeightBold). IBM
// Plex Mono, Plastic Legacy, and Seti are bundled extensions (see
// extensions/ibm-plex-mono, plastic-legacy-theme, seti-icons) rather than
// built into the client bundle — selected-only asset loading applies to all
// three like any other extension. The fallback tail after IBM Plex Mono is
// each major OS's own default monospace font — Menlo (macOS, since Lion),
// Consolas (Windows, since Vista), DejaVu Sans Mono / Liberation Mono (the
// two most commonly pre-installed on Linux, no single distro-wide default
// exists) — so an unavailable bundled font still lands on something native
// to the machine before falling through to the browser's generic mapping.
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: "'IBM Plex Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
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
  newTabPlacement: "end",
  tabGroupsBySession: false,
  newSessionCwd: "",
  fileTreeGitStatus: true,
  colorTheme: "tmux-server.plastic-legacy-theme:Plastic Legacy",
  iconTheme: "tmux-server.seti-icons:seti",
};

// A stored value from before the built-in theme/icon theme/font were
// extracted into bundled extensions: colorTheme/iconTheme "" used to mean
// "the built-in one", which is now a value colorTheme still tolerates
// (falls back to hard-coded :root colors) but iconTheme does not (means "no
// icon theme" instead of Seti) — leaving it unmigrated would silently drop
// a returning user's file icons. The old default font stack maps forward
// too; a stack the user actually customized (including one that merely
// starts with 'IBM Plex Mono') is left alone.
const LEGACY_DEFAULT_FONT_FAMILY =
  "'IBM Plex Mono', 'Symbols Nerd Font Mono', 'Noto Color Emoji', 'Droid Sans Mono', monospace";

export function migrateSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  if (next.colorTheme === "") next.colorTheme = DEFAULT_SETTINGS.colorTheme;
  if (next.iconTheme === "") next.iconTheme = DEFAULT_SETTINGS.iconTheme;
  if (next.fontFamily === LEGACY_DEFAULT_FONT_FAMILY) next.fontFamily = DEFAULT_SETTINGS.fontFamily;
  return next;
}

const KEY = "settings";
const KEYBINDINGS_KEY = "keybindings";
const EXTENSION_SETTINGS_KEY = "extensionSettings";

export function loadSettings(): AppSettings {
  try {
    return migrateSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") });
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

// Sparse per-extension setting overrides: `extensionId -> key -> value`.
// Only values that differ from the manifest's declared default are stored —
// same rationale as keybinding overrides above — so a future default change
// still reaches a user who never customized that setting.
export type ExtensionSettingsValues = Record<string, Record<string, unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadExtensionSettings(): ExtensionSettingsValues {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXTENSION_SETTINGS_KEY) ?? "{}");
    if (!isPlainObject(parsed)) return {};
    const result: ExtensionSettingsValues = {};
    for (const [extId, values] of Object.entries(parsed)) {
      if (isPlainObject(values)) result[extId] = values;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveExtensionSettings(values: ExtensionSettingsValues): void {
  localStorage.setItem(EXTENSION_SETTINGS_KEY, JSON.stringify(values));
}
