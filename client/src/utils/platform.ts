export const isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

// Secondary-open modifier for a click gesture (preview instead of editor,
// or a row's non-default action): Alt everywhere, Cmd as the mac-native
// equivalent, or Ctrl+Shift as a WM-safe fallback — many Linux window
// managers (XFCE, GNOME, KDE) grab plain Alt+click globally for window
// dragging, so it never reaches the browser at all. Not used where Cmd (or
// Ctrl) already means something else at that click site (the terminal's
// Cmd+click "open link" gesture, the FILES tree's Cmd/Ctrl+click "toggle
// select") — those sites branch on altKey/shiftKey directly instead.
export function isSecondaryClick(e: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): boolean {
  return e.altKey || (e.ctrlKey && e.shiftKey) || (isMac && e.metaKey);
}
