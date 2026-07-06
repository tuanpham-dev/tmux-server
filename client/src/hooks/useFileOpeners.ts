import { useCallback, useEffect } from "react";
import * as api from "../api";
import {
  findFileViewerFor,
  setOpenFileTabHandler,
  setOpenViewerTabHandler,
  setRefreshFilesHandler,
  type RegisteredFileViewer,
} from "../extensions";
import type { Tab } from "../types";

// File-opening dispatch: FILES-tree clicks, the "Preview" escape hatch, and
// the extension-facing ctx.app.openFileTab/openViewerTab/refreshFiles wiring
// all funnel through here. Takes the tab-opening primitives (openWindowTab,
// openExtViewerTab, setActiveTabId) from useTabs and refresh from
// useSessions as explicit parameters rather than reaching into those hooks
// directly.
export function useFileOpeners(
  activeRealTab: Tab | null,
  extFileViewers: RegisteredFileViewer[],
  showError: (err: unknown) => void,
  refresh: () => Promise<void>,
  openWindowTab: (session: string, index: number) => Promise<string | null>,
  setActiveTabId: (id: string) => void,
  openExtViewerTab: (viewerId: string, filePath: string, title?: string) => void,
  setFilesRefreshKey: (updater: (k: number) => number) => void,
) {
  // The "Preview" escape hatch (hover icon / context-menu item / Shift+Enter)
  // for a path some "preview"-mode viewer claims — markdown/json/yaml/csv
  // today. A no-op if no such viewer is registered (extension disabled, or
  // called before activation finishes).
  const openPreviewViewerTab = useCallback(
    (filePath: string) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "preview");
      if (viewer) openExtViewerTab(viewer.id, filePath);
    },
    [extFileViewers, openExtViewerTab],
  );

  // Gates FileTree's hover preview icon — registry-driven replacement for
  // the old fileKinds.ts isPreviewablePath.
  const isPreviewable = useCallback(
    (filePath: string) => findFileViewerFor(filePath, extFileViewers, "preview") !== null,
    [extFileViewers],
  );

  const openFileInSession = useCallback(
    async (filePath: string, line?: number) => {
      if (!activeRealTab) return;
      try {
        // attachName so a window-tab opens the file against the exact
        // pinned window, not whichever window the real session's own
        // (independently-diverged) current-window pointer happens to be on.
        const { windowIndex, deferredPane } = await api.openFile(activeRealTab.attachName, filePath, undefined, line);
        if (windowIndex !== null) {
          // Either a busy pane got a fresh nvim window, or an nvim already
          // running in another window was reused — either way, surface that
          // window's tab (activating it if already open) rather than
          // leaving the user to hunt for it in the sidebar. activeRealTab.sessionName
          // (the real session), not attachName, since that's what window-tabs
          // are keyed on.
          await refresh();
          await openWindowTab(activeRealTab.sessionName, windowIndex);
        } else {
          // null means the file opened directly in activeRealTab's own
          // window (an editor/shell already there). That's normally also
          // the tab on screen, but if an image tab is the one currently
          // active (see activeRealTab above), switch to activeRealTab so the
          // edit is actually visible instead of landing silently offscreen.
          setActiveTabId(activeRealTab.id);
        }
        if (deferredPane) {
          // The found nvim's RPC socket wasn't reachable, so the server held
          // off injecting keystrokes until its window's tab was visible —
          // complete it now (same line, so the deferred keystroke-based
          // open still jumps to it).
          await api.openFile(activeRealTab.attachName, filePath, deferredPane, line);
        }
      } catch (err) {
        showError(err);
      }
    },
    [activeRealTab, showError, refresh, openWindowTab, setActiveTabId],
  );

  // FILES-tree click dispatch: any path a "default"-mode viewer claims
  // (image/media/pdf today) opens directly in its viewer tab — nvim on
  // binary content is useless. Everything else (including markdown/json/
  // yaml/csv, "preview"-mode viewers) keeps opening in nvim as before,
  // reached via the hover icon / "Preview" menu item instead. `line`
  // (terminal ctrl+click on a "file:line" link) is ignored by the viewer-tab
  // branch — it has no line-jump concept.
  const openFileOrViewer = useCallback(
    (filePath: string, line?: number) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "default");
      if (viewer) {
        openExtViewerTab(viewer.id, filePath);
        return;
      }
      openFileInSession(filePath, line);
    },
    [extFileViewers, openExtViewerTab, openFileInSession],
  );

  // ctx.app.openFileTab(path) (extensions.ts) routes through the exact same
  // dispatch a FILES-tree click uses, so an extension command that opens a
  // file gets identical built-in-viewer-first behavior.
  useEffect(() => {
    setOpenFileTabHandler(openFileOrViewer);
  }, [openFileOrViewer]);

  // ctx.app.openViewerTab/refreshFiles (extensions.ts) — see
  // openExtViewerTab's title param and filesRefreshKey in App.
  useEffect(() => {
    setOpenViewerTabHandler(openExtViewerTab);
    setRefreshFilesHandler(() => setFilesRefreshKey((k) => k + 1));
  }, [openExtViewerTab, setFilesRefreshKey]);

  // Quick switcher's Shift+Enter action (also terminal ctrl+shift+click —
  // see TerminalView's onOpenFileSecondary). Mirrors the "Preview" escape
  // hatch for markdown/json/yaml/csv (see fileMenuItems in useFileActions);
  // images/media/PDFs have no secondary action here — they always land on
  // their viewer regardless of the modifier, unlike the FILES-tree context
  // menu's image "Open in Editor" item.
  const openFileOrViewerSecondary = useCallback(
    (filePath: string, line?: number) => {
      const viewer = findFileViewerFor(filePath, extFileViewers, "preview");
      if (viewer) {
        openExtViewerTab(viewer.id, filePath);
        return;
      }
      openFileOrViewer(filePath, line);
    },
    [extFileViewers, openExtViewerTab, openFileOrViewer],
  );

  return {
    openPreviewViewerTab,
    isPreviewable,
    openFileInSession,
    openFileOrViewer,
    openFileOrViewerSecondary,
  };
}
