import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import { findFileViewerFor, requestFindInFolder, type RegisteredFileViewer } from "../extensions";
import type { AppSettings } from "../settings";
import type { MenuItem } from "../types";
import { collectDropped, uploadAll, type DroppedItems } from "../upload";

// File-entry actions (rename/delete/create/copy/download), the FILES-tree
// context menus built on them, and the upload/drop pipeline. Takes
// setFilesRefreshKey as a parameter rather than owning that state itself —
// useSessions' onAfterRefresh callback and useFileOpeners' extension wiring
// both need the setter before this hook (which depends on their outputs:
// openFileInSession/openPreviewViewerTab) can be called, so the state has
// to live in App instead.
export function useFileActions(
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>,
  settingsRef: MutableRefObject<AppSettings>,
  setFilesRefreshKey: Dispatch<SetStateAction<number>>,
  extFileViewers: RegisteredFileViewer[],
  openFileInSession: (filePath: string, line?: number) => Promise<void>,
  openPreviewViewerTab: (filePath: string) => void,
) {
  const [uploadProgress, setUploadProgress] = useState<{
    currentName: string;
    loadedBytes: number;
    totalBytes: number;
  } | null>(null);
  // Set whenever a delete/rename (single or bulk) lands, so FileTree can drop
  // the now-stale paths (and their descendants) from its expanded/dirCache/
  // selection state instead of waiting for a refetch to notice they're gone.
  const [prunePath, setPrunePath] = useState<{ paths: string[] } | null>(null);

  const renameFileEntry = useCallback(
    async (entryPath: string) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      const newName = (await promptDialog("New name", base))?.trim();
      if (!newName || newName === base) return;
      try {
        await api.renameEntry(entryPath, newName);
        setPrunePath({ paths: [entryPath] });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const deleteFileEntry = useCallback(
    async (entryPath: string, isDir: boolean) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      if (!(await confirmDialog(`Delete ${isDir ? "folder" : "file"} "${base}"?`, "Delete")))
        return;
      try {
        await api.deleteEntry(entryPath);
        setPrunePath({ paths: [entryPath] });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey],
  );

  const deleteFileEntries = useCallback(
    async (entries: { path: string; isDir: boolean }[]) => {
      if (entries.length === 0) return;
      const label =
        entries.length === 1
          ? `Delete ${entries[0].isDir ? "folder" : "file"} "${entries[0].path.slice(entries[0].path.lastIndexOf("/") + 1)}"?`
          : `Delete ${entries.length} items?`;
      if (!(await confirmDialog(label, "Delete"))) return;
      const succeeded: string[] = [];
      const errors: string[] = [];
      for (const { path } of entries) {
        try {
          await api.deleteEntry(path);
          succeeded.push(path);
        } catch {
          errors.push(path);
        }
      }
      if (succeeded.length > 0) {
        setPrunePath({ paths: succeeded });
        setFilesRefreshKey((k) => k + 1);
      }
      if (errors.length === 1) {
        showError(`Delete failed: ${errors[0]}`);
      } else if (errors.length > 1) {
        showError(`${errors.length} items failed to delete`);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey],
  );

  const createFileInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New file name"))?.trim();
      if (!name) return;
      try {
        await api.createFile(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const createFolderInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New folder name"))?.trim();
      if (!name) return;
      try {
        await api.makeDir(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const copyFilePath = useCallback(
    (entryPath: string) => {
      copyText(entryPath).catch(showError);
    },
    [showError],
  );

  const copyFileRelativePath = useCallback(
    (entryPath: string, rootDir: string) => {
      const rel = entryPath.startsWith(rootDir + "/")
        ? entryPath.slice(rootDir.length + 1)
        : entryPath === rootDir
          ? "."
          : entryPath;
      copyText(rel).catch(showError);
    },
    [showError],
  );

  const downloadFileEntry = useCallback((entryPath: string) => {
    const a = document.createElement("a");
    a.href = api.downloadUrl(entryPath);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const fileTreeRootMenuItems = useCallback(
    (rootDir: string): MenuItem[] => [
      { label: "New File…", onClick: () => createFileInDir(rootDir) },
      { label: "New Folder…", onClick: () => createFolderInDir(rootDir) },
    ],
    [createFileInDir, createFolderInDir],
  );

  const handleUpload = useCallback(
    async (items: DroppedItems, destDir: string) => {
      if (items.files.length === 0 && items.dirs.length === 0) return;
      setUploadProgress({
        currentName: "",
        loadedBytes: 0,
        totalBytes: items.files.reduce((sum, f) => sum + f.file.size, 0),
      });
      const result = await uploadAll(items, destDir, settingsRef.current.uploadConflict, {
        onProgress: (loadedBytes, totalBytes, currentName) => {
          setUploadProgress({ currentName, loadedBytes, totalBytes });
        },
        onConflict: (relativePath) =>
          confirmDialog(`"${relativePath}" already exists. Overwrite?`, "Overwrite"),
      });
      setUploadProgress(null);
      setFilesRefreshKey((k) => k + 1);
      if (result.errors.length === 1) {
        showError(`Upload failed: ${result.errors[0].relativePath} — ${result.errors[0].message}`);
      } else if (result.errors.length > 1) {
        showError(`${result.errors.length} files failed to upload`);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey, settingsRef],
  );

  // Folder drops target a specific FILES-panel folder; the drop's DataTransfer
  // is read synchronously (before any await) since browsers invalidate it once
  // the event handler yields.
  const handleFileTreeDrop = useCallback(
    (destDir: string, dataTransfer: DataTransfer) => {
      collectDropped(dataTransfer)
        .then((items) => handleUpload(items, destDir))
        .catch(showError);
    },
    [handleUpload, showError],
  );

  const handleFilesRefresh = useCallback(() => {
    setFilesRefreshKey((k) => k + 1);
  }, [setFilesRefreshKey]);

  const findInFolder = useCallback((entryPath: string, rootDir: string) => {
    const rel = entryPath.startsWith(rootDir + "/")
      ? entryPath.slice(rootDir.length + 1)
      : entryPath === rootDir
        ? "."
        : entryPath;
    // rel === "." (the root folder itself) needs no include-glob restriction
    // — that's already the search panel's unscoped default.
    requestFindInFolder(rel === "." ? "" : `${rel}/**`);
  }, []);

  const fileMenuItems = useCallback(
    (entryPath: string, isDir: boolean, rootDir: string): MenuItem[] => {
      const items: MenuItem[] = [];
      if (isDir) {
        items.push(
          { label: "New File…", onClick: () => createFileInDir(entryPath) },
          { label: "New Folder…", onClick: () => createFolderInDir(entryPath) },
          { label: "Find in Folder…", onClick: () => findInFolder(entryPath, rootDir) },
        );
      }
      items.push(
        { label: "Rename…", onClick: () => renameFileEntry(entryPath) },
        { label: "Copy Path", onClick: () => copyFilePath(entryPath) },
        { label: "Copy Relative Path", onClick: () => copyFileRelativePath(entryPath, rootDir) },
        { label: "Download", onClick: () => downloadFileEntry(entryPath) },
      );
      // Images/media/PDFs open in their viewer by default (see
      // openFileOrViewer) — editorFallback is the escape hatch to edit e.g.
      // an SVG's source in nvim; media/PDF opt out of it (nvim on binary
      // content isn't useful) via their own registration.
      const defaultViewer = !isDir ? findFileViewerFor(entryPath, extFileViewers, "default") : null;
      if (defaultViewer?.editorFallback) {
        items.push({ label: "Open in Editor", onClick: () => openFileInSession(entryPath) });
      }
      // Markdown/JSON/YAML/CSV open in nvim by default (unchanged) — Preview
      // is the opt-in path to the rendered view, mirroring the hover icon in
      // FileTree.
      if (!isDir && findFileViewerFor(entryPath, extFileViewers, "preview")) {
        items.push({ label: "Preview", onClick: () => openPreviewViewerTab(entryPath) });
      }
      items.push({ label: "Delete", danger: true, onClick: () => deleteFileEntry(entryPath, isDir) });
      return items;
    },
    [
      createFileInDir,
      createFolderInDir,
      findInFolder,
      renameFileEntry,
      copyFilePath,
      copyFileRelativePath,
      downloadFileEntry,
      openFileInSession,
      openPreviewViewerTab,
      deleteFileEntry,
      extFileViewers,
    ],
  );

  // Bulk counterpart of fileMenuItems, shown when the FILES-tree right-click
  // target is part of a multi-row selection — a smaller action set (no
  // rename/preview/find-in-folder, which don't make sense across a mixed
  // selection of files and folders).
  const fileMultiMenuItems = useCallback(
    (entries: { path: string; isDir: boolean }[]): MenuItem[] => [
      {
        label: "Copy Paths",
        onClick: () => copyText(entries.map((e) => e.path).join("\n")).catch(showError),
      },
      { label: "Download", onClick: () => entries.forEach((e) => downloadFileEntry(e.path)) },
      {
        label: `Delete ${entries.length} items`,
        danger: true,
        onClick: () => deleteFileEntries(entries),
      },
    ],
    [showError, downloadFileEntry, deleteFileEntries],
  );

  return {
    uploadProgress,
    prunePath,
    handleUpload,
    handleFileTreeDrop,
    handleFilesRefresh,
    renameFileEntry,
    deleteFileEntry,
    deleteFileEntries,
    createFileInDir,
    createFolderInDir,
    copyFilePath,
    copyFileRelativePath,
    downloadFileEntry,
    fileTreeRootMenuItems,
    fileMenuItems,
    fileMultiMenuItems,
  };
}
