import setiTheme from "../components/vs-seti-icon-theme.json";

interface IconDef {
  fontCharacter?: string;
  fontColor?: string;
}

const iconDefinitions = setiTheme.iconDefinitions as Record<string, IconDef>;
const fileExtensions = setiTheme.fileExtensions as Record<string, string>;
const fileNames = setiTheme.fileNames as Record<string, string>;
const folderNames = setiTheme.folderNames as Record<string, string>;
const folderNamesExpanded = setiTheme.folderNamesExpanded as Record<string, string>;

const defaultFileKey = setiTheme.file;
const defaultFolderKey = setiTheme.folder;
const defaultFolderExpandedKey = setiTheme.folderExpanded;

function convertGlyph(fontChar: string | undefined): string {
  if (!fontChar) return "";
  // Strip backslashes if present
  const hex = fontChar.replace(/\\/g, "");
  return String.fromCharCode(parseInt(hex, 16));
}

export function getFileIconInfo(fileName: string): { char: string; color: string } {
  const lowerName = fileName.toLowerCase();

  // 1. Exact file name match
  let iconKey = fileNames[lowerName];

  // 2. Extension match
  if (!iconKey) {
    const parts = lowerName.split(".");
    // Multi-dot extension check (e.g. spec.ts)
    if (parts.length > 2) {
      const ext2 = parts.slice(-2).join(".");
      iconKey = fileExtensions[ext2];
    }
    // Single-dot extension check
    if (!iconKey && parts.length > 1) {
      const ext = parts[parts.length - 1];
      iconKey = fileExtensions[ext];
    }
  }

  // 3. Fallback
  if (!iconKey) {
    iconKey = defaultFileKey;
  }

  const def = iconDefinitions[iconKey];
  return {
    char: convertGlyph(def?.fontCharacter),
    color: def?.fontColor || "#d4d7d6",
  };
}

export function getFolderIconInfo(folderName: string, isExpanded: boolean): { char: string; color: string } {
  const lowerName = folderName.toLowerCase();

  // 1. Match specific folder name
  const map = isExpanded ? folderNamesExpanded : folderNames;
  let iconKey = map[lowerName];

  // 2. Fallback
  if (!iconKey) {
    iconKey = isExpanded ? defaultFolderExpandedKey : defaultFolderKey;
  }

  const def = iconDefinitions[iconKey];
  return {
    char: convertGlyph(def?.fontCharacter),
    color: def?.fontColor || "#ccc",
  };
}
