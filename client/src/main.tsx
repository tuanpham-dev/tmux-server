import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
// Split into ~50 unicode-range chunks; the browser only fetches whichever
// chunk covers a codepoint actually used (e.g. one ~250KB file for a
// sailboat emoji in a prompt), not the full ~26MB font.
import "@fontsource/noto-color-emoji";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
