// xterm-engine: the xterm.js terminal engine as a bundled extension — a
// REQUIRED builtin (manifest tmuxServer.required), since it's the app's
// guaranteed rendering floor: the engine registry always resolves to this
// engine when the selected one is missing. See src/engine.ts for the
// implementation (moved verbatim from core client/src/engines/xterm.ts).
import { injectStylesheet } from "../../_shared/injectStylesheet";
import type { CreateTerminalEngine } from "../../_shared/terminalEngineTypes";
import { createXtermEngine } from "./engine";

let removeStylesheet: (() => void) | null = null;

interface ExtensionContext {
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  // dist/client.css carries @xterm/xterm's own stylesheet (bundled from the
  // engine's `import "@xterm/xterm/css/xterm.css"`).
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerTerminalEngine({ id: "xterm", label: "xterm.js", create: createXtermEngine });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
}
