// Engine resolution over the extension registry (plans/minimal-core-
// extension-extraction.md): both engines live in bundled extensions
// (xterm-engine — a required builtin, the guaranteed floor — and
// ghostty-engine), registered via ctx.registerTerminalEngine. Core keeps
// only this resolution plus the seam types (./types).
import { extensionTerminalEngines, whenExtensionsSettled } from "../extensions";
import type { CreateTerminalEngine } from "./types";

// The required builtin's namespaced id — the fallback for an unknown/
// stale stored engine id (e.g. its extension was uninstalled), and one
// side of the "auto" per-device resolution in TerminalView.
export const XTERM_ENGINE_ID = "ext.tmux-server.xterm-engine.xterm";
export const GHOSTTY_ENGINE_ID = "ext.tmux-server.ghostty-engine.ghostty";

// Resolves a stored engine id to its factory. Waits for the extensions-
// settled gate first — engine registration happens during async extension
// activation, and resolving before it completes would misread "still
// activating" as "missing" (the sidebar-panel prune race, relearned).
// Unknown ids fall back to the required xterm engine; null only when even
// that isn't registered (a corrupt/incomplete install), which TerminalView
// surfaces as an explicit error rather than a silent blank.
export async function loadEngine(id: string): Promise<CreateTerminalEngine | null> {
  await whenExtensionsSettled();
  const exact = extensionTerminalEngines.find((e) => e.id === id);
  if (exact) return exact.create;
  const fallback = extensionTerminalEngines.find((e) => e.id === XTERM_ENGINE_ID);
  return (fallback ?? extensionTerminalEngines[0])?.create ?? null;
}
