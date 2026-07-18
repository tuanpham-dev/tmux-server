import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { createRoot } from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import App from "./App";
import AuthGate from "./components/AuthGate";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import * as ReactNS from "react";
import { ensureContrastRatio } from "./contrast";
import { isSyntheticSelectStart, markSyntheticSelectStart } from "./engines/types";
import { cellFromPoint } from "./mouseReports";
import { sendWithInkSafeEnters, whenMatches } from "./lib/terminalInput";
import { findCandidates, isOpenGesture, MAX_STITCH_LINES, openUrl } from "./terminalLinks";

// Bundled preview extensions (image/markdown/json/csv/media/pdf) are built
// separately (see extensions/build.mjs) and must never bundle their own
// React — a second copy would break hooks/portals shared with the host.
// Their build aliases react/react-dom/react-jsx-runtime imports to thin
// shims that re-export these exact instances instead. Set before any
// extension can load (loadExtensions() only runs from an App effect, well
// after this module finishes evaluating).
// Terminal engine-support helpers for extension-implemented engines
// (xterm-engine/ghostty-engine, via the @tmux-server/engine-support build
// alias). These must be the HOST's instances: markSyntheticSelectStart tags
// events with a module-private Symbol isSyntheticSelectStart checks — a
// bundled copy would mint a different Symbol and silently never match.
const engineSupport = {
  cellFromPoint,
  findCandidates,
  isOpenGesture,
  openUrl,
  MAX_STITCH_LINES,
  markSyntheticSelectStart,
  isSyntheticSelectStart,
  ensureContrastRatio,
  whenMatches,
  sendWithInkSafeEnters,
};

declare global {
  interface Window {
    __tmuxServerModules?: {
      react: typeof ReactNS;
      "react-dom": typeof ReactDOM;
      // For extensions that mount their own floating UI (a popover) into a
      // root they own — createRoot must come from the host's copy too.
      "react-dom/client": typeof ReactDOMClient;
      "react/jsx-runtime": typeof ReactJsxRuntime;
      "@tmux-server/engine-support": typeof engineSupport;
    };
  }
}
window.__tmuxServerModules = {
  react: ReactNS,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": ReactJsxRuntime,
  "@tmux-server/engine-support": engineSupport,
};

registerSW({ immediate: true });

// Terminal engines are bundled extensions (extensions/xterm-engine,
// extensions/ghostty-engine) loaded through the extension host — nothing
// engine-related gates the app's initial render.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
