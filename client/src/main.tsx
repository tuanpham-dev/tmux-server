import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import App from "./App";
import AuthGate from "./components/AuthGate";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { registerSW } from "virtual:pwa-register";
import * as ReactNS from "react";

// Bundled preview extensions (image/markdown/json/csv/media/pdf) are built
// separately (see extensions/build.mjs) and must never bundle their own
// React — a second copy would break hooks/portals shared with the host.
// Their build aliases react/react-dom/react-jsx-runtime imports to thin
// shims that re-export these exact instances instead. Set before any
// extension can load (loadExtensions() only runs from an App effect, well
// after this module finishes evaluating).
declare global {
  interface Window {
    __tmuxServerModules?: {
      react: typeof ReactNS;
      "react-dom": typeof ReactDOM;
      "react/jsx-runtime": typeof ReactJsxRuntime;
    };
  }
}
window.__tmuxServerModules = {
  react: ReactNS,
  "react-dom": ReactDOM,
  "react/jsx-runtime": ReactJsxRuntime,
};

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
