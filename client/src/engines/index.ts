// The only cross-engine touchpoint (plans/terminal-engine-setting.md): a
// dynamic import per engine, so the non-selected one never loads its
// package, and dropping an engine later is deleting its module, its
// package.json entries, and its one line here.
import type { CreateTerminalEngine } from "./types";

export type TerminalEngineName = "ghostty" | "xterm";

export async function loadEngine(name: TerminalEngineName): Promise<CreateTerminalEngine> {
  if (name === "xterm") {
    const mod = await import("./xterm");
    return mod.createXtermEngine;
  }
  const mod = await import("./ghostty");
  return mod.createGhosttyEngine;
}
