// Extension-based file-kind checks, shared between App.tsx (FILES-tree click
// dispatch, context menu items) and FileTree.tsx (which needs to decide
// whether to render the hover preview icon per row) — colocated here rather
// than in App.tsx to avoid a circular import (App -> Sidebar -> FileTree).

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const JSON_EXTENSIONS = new Set(["json"]);
const YAML_EXTENSIONS = new Set(["yml", "yaml"]);
const CSV_EXTENSIONS = new Set(["csv", "tsv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);
const PDF_EXTENSIONS = new Set(["pdf"]);

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

export function isJsonPath(filePath: string): boolean {
  return JSON_EXTENSIONS.has(extensionOf(filePath));
}

export function isYamlPath(filePath: string): boolean {
  return YAML_EXTENSIONS.has(extensionOf(filePath));
}

export function isCsvPath(filePath: string): boolean {
  return CSV_EXTENSIONS.has(extensionOf(filePath));
}

export function isAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(filePath));
}

export function isVideoPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(filePath));
}

export function isMediaPath(filePath: string): boolean {
  return isAudioPath(filePath) || isVideoPath(filePath);
}

export function isPdfPath(filePath: string): boolean {
  return PDF_EXTENSIONS.has(extensionOf(filePath));
}

// Kinds reached via the hover icon / "Preview" context-menu item (default
// click still opens nvim for these).
export function isPreviewablePath(filePath: string): boolean {
  return isMarkdownPath(filePath) || isJsonPath(filePath) || isYamlPath(filePath) || isCsvPath(filePath);
}
