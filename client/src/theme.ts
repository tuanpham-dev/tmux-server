import type { ITheme } from "@xterm/xterm";

// Plastic Legacy (hadialqattan.plastic-legacy-1.0.0), extracted from the
// user's code-server instance. Terminal background/cursor/selection use VS
// Code's fallback chain since the theme doesn't define them.
export const terminalTheme: ITheme = {
  background: "#21252B",
  foreground: "#A9B2C3",
  cursor: "#A9B2C3",
  cursorAccent: "#21252B",
  selectionBackground: "#A9B2C333",
  black: "#21252B",
  red: "#E06C75",
  green: "#98C379",
  yellow: "#D19A66",
  blue: "#61AFEF",
  magenta: "#B57EDC",
  cyan: "#56B6C2",
  white: "#A9B2C3",
  brightBlack: "#5F6672",
  brightRed: "#D74E42",
  brightGreen: "#69c52e",
  brightYellow: "#E9D16C",
  brightBlue: "#1085FF",
  brightMagenta: "#8B00FF",
  brightCyan: "#08E8DE",
  brightWhite: "#D4D7D9",
};
