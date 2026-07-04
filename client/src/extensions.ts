// Client-side extension registry: fetches the installed-extension list from
// the server, dynamic-imports each enabled extension's client entry, and
// hands it a small ctx API (commands, file viewers, sidebar panels, active
// context, a fetch scoped to its own server routes). Themes/icon themes are
// NOT activated here — theme.ts and utils/iconThemes.ts read the same
// `extensions` list directly and apply themes without running any
// extension code, since they're just JSON.
import * as ReactNS from "react";
import { extensionApiBase, extensionFileUrl, fetchExtensions } from "./api";
import type { ExtensionInfo } from "./types";

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface RegisteredCommand {
  // Namespaced ext.<extensionId>.<id> — see registerCommand.
  id: string;
  label: string;
  defaultBinding?: string;
  run: () => void;
}

export interface RegisteredFileViewer {
  id: string;
  extensionId: string;
  // Lowercase file extensions without the leading dot, e.g. ["demo"].
  extensions: string[];
  component: ReactNS.ComponentType<{ filePath: string; active: boolean }>;
}

export interface RegisteredSidebarPanel {
  // Namespaced ext.<extensionId>.<id> — used as the sidebar's PanelId.
  id: string;
  title: string;
  component: ReactNS.ComponentType<Record<string, never>>;
}

export interface ExtensionContext {
  React: typeof ReactNS;
  registerCommand(cmd: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    component: ReactNS.ComponentType<{ filePath: string; active: boolean }>;
  }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    component: ReactNS.ComponentType<Record<string, never>>;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openFileTab(path: string): void;
  };
  // fetch() scoped to this extension's own server hook, mounted at
  // /api/ext/<extensionId> — 404s if the extension has no server entry or
  // is disabled.
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
}

export const extensionCommands: RegisteredCommand[] = [];
export const extensionFileViewers: RegisteredFileViewer[] = [];
export const extensionSidebarPanels: RegisteredSidebarPanel[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) l();
}

// React components subscribe here (see useExtensionRegistry) to re-render
// once extension activation populates the registries above — activation is
// async and happens after first mount.
export function subscribeExtensionRegistry(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Matches by extension only (no override authority over built-in viewers —
// App.tsx checks images/media/PDF first, and only falls through to this for
// extensions no built-in viewer claims), first match wins.
export function findFileViewerFor(filePath: string, viewers: RegisteredFileViewer[]): RegisteredFileViewer | null {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
  if (!ext) return null;
  return viewers.find((v) => v.extensions.includes(ext)) ?? null;
}

export function useExtensionRegistry(): {
  commands: RegisteredCommand[];
  fileViewers: RegisteredFileViewer[];
  sidebarPanels: RegisteredSidebarPanel[];
} {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionRegistry(() => setTick((t) => t + 1)), []);
  // New array references only when the registry actually changes (tick),
  // not on every unrelated App re-render — consumers (e.g. Sidebar's
  // reconcile effect) depend on these by reference, and the underlying
  // arrays are mutated in place by registerCommand/etc., so returning them
  // directly would never look "changed" to a dependency array.
  return ReactNS.useMemo(
    () => ({
      commands: [...extensionCommands],
      fileViewers: [...extensionFileViewers],
      sidebarPanels: [...extensionSidebarPanels],
    }),
    [tick],
  );
}

let activeContextValue: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
const contextListeners = new Set<(ctx: ActiveContext) => void>();

// Called from App.tsx whenever the derived "active real tab" context
// changes (session/window/cwd) — see the activeRealTab/filesRootDir
// derivation it already computes for the FILES panel and lazygit pill.
export function setActiveContext(ctx: ActiveContext): void {
  activeContextValue = ctx;
  for (const l of contextListeners) l(ctx);
}

let openFileTabHandler: ((path: string) => void) | null = null;

// Wired once from App.tsx to whatever dispatch logic decides which viewer
// (nvim, an extension viewer, a built-in preview) opens a given path.
export function setOpenFileTabHandler(handler: (path: string) => void): void {
  openFileTabHandler = handler;
}

let installedExtensions: ExtensionInfo[] = [];

export function getInstalledExtensions(): ExtensionInfo[] {
  return installedExtensions;
}

function makeContext(ext: ExtensionInfo): ExtensionContext {
  return {
    React: ReactNS,
    registerCommand(cmd) {
      extensionCommands.push({ ...cmd, id: `ext.${ext.id}.${cmd.id}` });
      notify();
    },
    registerFileViewer(viewer) {
      extensionFileViewers.push({
        id: `ext.${ext.id}.${viewer.id}`,
        extensionId: ext.id,
        extensions: viewer.extensions.map((e) => e.toLowerCase()),
        component: viewer.component,
      });
      notify();
    },
    registerSidebarPanel(panel) {
      extensionSidebarPanels.push({
        id: `ext.${ext.id}.${panel.id}`,
        title: panel.title,
        component: panel.component,
      });
      notify();
    },
    app: {
      getActiveContext: () => activeContextValue,
      onDidChangeContext(cb) {
        contextListeners.add(cb);
        return () => contextListeners.delete(cb);
      },
      openFileTab(path) {
        openFileTabHandler?.(path);
      },
    },
    serverFetch(path, init) {
      return fetch(`${extensionApiBase(ext.id)}${path}`, init);
    },
  };
}

const activatedIds = new Set<string>();

async function activateClientExtension(ext: ExtensionInfo): Promise<void> {
  if (activatedIds.has(ext.id) || !ext.clientEntry) return;
  activatedIds.add(ext.id);
  try {
    const url = extensionFileUrl(ext.id, ext.clientEntry);
    // Vite must not try to statically analyze/pre-bundle this — the path is
    // only known at runtime, from the server's extension list.
    const mod: unknown = await import(/* @vite-ignore */ url);
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${ext.id}: client entry has no activate() export`);
      return;
    }
    (activate as (ctx: ExtensionContext) => void)(makeContext(ext));
  } catch (err) {
    console.error(`extension ${ext.id}: failed to load client entry:`, err);
  }
}

// Fetches the list once and activates every enabled extension's client
// entry. Themes/icon themes need no activation step — see the module
// comment — so this only concerns commands/viewers/panels.
export async function loadExtensions(): Promise<ExtensionInfo[]> {
  const list = await fetchExtensions();
  installedExtensions = list;
  notify();
  await Promise.all(
    list.filter((ext) => ext.enabled && ext.hasClient).map((ext) => activateClientExtension(ext)),
  );
  return list;
}
