// Extension-based file-kind checks, shared between App.tsx (FILES-tree click
// dispatch, context menu items) and FileTree.tsx (which needs to decide
// whether to render the hover preview icon per row) — colocated here rather
// than in App.tsx to avoid a circular import (App -> Sidebar -> FileTree).

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

export function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(filePath));
}
