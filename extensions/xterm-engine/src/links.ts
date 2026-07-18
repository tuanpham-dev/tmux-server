// xterm.js link-provider adapter — moved from core terminalLinks.ts (whose
// generic candidate detection stayed core, shared via the
// @tmux-server/engine-support shim) when the engine became this extension.
import type { IBufferRange, ILink as XtermILink, ILinkProvider as XtermILinkProvider, Terminal as XtermTerminal } from "@xterm/xterm";
import { findCandidates, isOpenGesture, MAX_STITCH_LINES } from "@tmux-server/engine-support";

// xterm.js counterpart to stitchLine above — same wrapped-row-stitching
// logic, but against xterm's IBuffer/IBufferLine shapes (getLine/
// translateToString match ghostty-web's signatures exactly; only the
// Terminal type differs).
export function stitchXtermLine(term: XtermTerminal, y: number): { text: string; startLine: number } | null {
  const buffer = term.buffer.active;
  let startLine = y;
  for (let i = 0; i < MAX_STITCH_LINES && buffer.getLine(startLine)?.isWrapped; i++) {
    startLine--;
  }
  const cols = term.cols;
  const parts: string[] = [];
  let endLine = startLine;
  for (let i = 0; i < MAX_STITCH_LINES; i++) {
    const line = buffer.getLine(endLine);
    if (!line) break;
    parts.push(line.translateToString(false, 0, cols));
    const next = buffer.getLine(endLine + 1);
    if (!next?.isWrapped) break;
    endLine++;
  }
  if (!parts.length) return null;
  return { text: parts.join(""), startLine };
}

// 0-based buffer-index -> xterm's IBufferCellPosition, which (unlike
// ghostty-web's 0-based, raw-compared range) is documented 1-based on both
// axes — verified against @xterm/xterm 6.0.0's typings (IBufferCellPosition:
// "The x/y position within the buffer (1-based)").
function indexToXtermPosition(
  startLine: number,
  cols: number,
  idx: number,
  rowOffset: number,
): { x: number; y: number } {
  return { y: rowOffset + startLine + Math.floor(idx / cols) + 1, x: (idx % cols) + 1 };
}

export interface XtermTerminalLinksHandlers {
  resolvePaths: (paths: string[]) => Promise<(string | null)[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // Fired with the ILink under the pointer (or null on leave) — same shape
  // as ghostty-web's onHoverChange, so the caller's tooltip can read
  // link.text and its own activate(e, link.text) either way.
  onHoverChange: (link: XtermILink | null) => void;
}

export function buildXtermLinkProvider(
  term: XtermTerminal,
  handlers: XtermTerminalLinksHandlers,
): XtermILinkProvider {
  return {
    provideLinks(y, callback) {
      // xterm's buffer indexes scrollback rows from 0 too, with the visible
      // screen starting at buffer.baseY (ghostty-web's getScrollbackLength()
      // equivalent) — tmux owns real scrollback, so the local buffer never
      // meaningfully scrolls, but reading baseY rather than assuming 0 stays
      // correct if it ever does.
      const rowOffset = term.buffer.active.baseY;
      const screenY = y - rowOffset;
      if (screenY < 0 || screenY >= term.rows) {
        callback(undefined);
        return;
      }
      const stitched = stitchXtermLine(term, screenY);
      if (!stitched) {
        callback(undefined);
        return;
      }
      const { text, startLine } = stitched;
      const candidates = findCandidates(text);
      if (!candidates.length) {
        callback(undefined);
        return;
      }

      const pathCandidates = candidates.filter((c) => c.kind === "path");
      const resolve = pathCandidates.length
        ? handlers.resolvePaths(pathCandidates.map((c) => c.target))
        : Promise.resolve<(string | null)[]>([]);

      resolve
        .then((resolved) => {
          const links: XtermILink[] = [];
          let pathIdx = 0;
          for (const c of candidates) {
            let openTarget: string | undefined = c.target;
            let line: number | undefined = c.line;
            if (c.kind === "path") {
              openTarget = resolved[pathIdx] ?? undefined;
              pathIdx++;
              if (!openTarget) continue;
            }
            const range: IBufferRange = {
              start: indexToXtermPosition(startLine, term.cols, c.startIdx, rowOffset),
              end: indexToXtermPosition(startLine, term.cols, c.endIdx - 1, rowOffset),
            };
            const kind = c.kind;
            const target = openTarget;
            const link: XtermILink = {
              range,
              text: c.text,
              activate(event) {
                if (!isOpenGesture(event)) return;
                if (kind === "url") {
                  handlers.onOpenUrl(target);
                } else if (event.shiftKey) {
                  handlers.onOpenFileSecondary(target, line);
                } else {
                  handlers.onOpenFile(target, line);
                }
              },
              hover: () => handlers.onHoverChange(link),
              leave: () => handlers.onHoverChange(null),
            };
            links.push(link);
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
}
