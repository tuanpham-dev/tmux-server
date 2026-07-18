// ghostty-engine: the ghostty-web (WASM) terminal engine as a bundled
// extension. Ordinary builtin — disabling it falls the app back to the
// required xterm-engine. See src/engine.ts (moved verbatim from core
// client/src/engines/ghostty.ts) and src/shims.ts (the CanvasRenderer
// display-setting shims that moved with it).
import type { CreateTerminalEngine } from "../../_shared/terminalEngineTypes";
import { createGhosttyEngine } from "./engine";

interface ExtensionContext {
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
}

export function activate(ctx: ExtensionContext): void {
  ctx.registerTerminalEngine({ id: "ghostty", label: "Ghostty", create: createGhosttyEngine });
}

export function deactivate(): void {
  // Nothing to tear down: the engine registry entry is removed by the host,
  // and live engine instances are disposed by their own TerminalViews.
}
