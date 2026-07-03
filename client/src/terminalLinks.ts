import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// Prefixed forms (/abs, ~/, ./, ../) are unambiguous — greedily consume
// everything up to whitespace/quote/bracket. ":" is excluded from the class
// so a trailing ":line[:col]" suffix (matched separately below) isn't eaten
// into the path itself.
const PREFIXED_PATH = /(?:~\/|\.{1,2}\/|\/)[^\s"'`<>|:]+/;
// Bare relative path with at least one "/" (e.g. "src/app.ts").
const SLASHED_PATH = /\b[\w.-]+\/[\w./-]+/;
// Bare filename with an extension (e.g. "README.md"). The extension must
// start with a letter, not a digit — otherwise "3.14" reads as a file named
// "3" with extension "14".
const NAMED_FILE = /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/;

const PATH_RE = new RegExp(
  `(?:${PREFIXED_PATH.source}|${SLASHED_PATH.source}|${NAMED_FILE.source})(?::(\\d+)(?::\\d+)?)?`,
  "g",
);

const URL_RE = /\bhttps?:\/\/[^\s"'`<>|]+/g;

// Trailing punctuation that's almost always sentence/bracket decoration
// rather than part of the link itself (mirrors how browsers/mail clients
// trim autolinked URLs).
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

interface Candidate {
  kind: "url" | "path";
  startIdx: number;
  endIdx: number;
  text: string;
  target: string; // URL, or path with any :line[:col] suffix stripped
  line?: number;
}

function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of text.matchAll(URL_RE)) {
    const trimmed = trimTrailing(m[0]);
    if (!trimmed.length) continue;
    const startIdx = m.index!;
    out.push({ kind: "url", startIdx, endIdx: startIdx + trimmed.length, text: trimmed, target: trimmed });
  }

  for (const m of text.matchAll(PATH_RE)) {
    let raw = m[0];
    const lineStr = m[1];
    // Trim trailing punctuation only when there's no :line suffix already
    // anchoring the match's real end (a suffix digit is never punctuation).
    const trimmed = lineStr ? raw : trimTrailing(raw);
    if (!trimmed.length) continue;
    raw = trimmed;
    const startIdx = m.index!;
    const target = lineStr ? raw.slice(0, raw.indexOf(":" + lineStr)) : raw;
    out.push({
      kind: "path",
      startIdx,
      endIdx: startIdx + raw.length,
      text: raw,
      target,
      line: lineStr ? Number(lineStr) : undefined,
    });
  }

  return out;
}

function trimTrailing(s: string): string {
  return s.replace(TRAILING_PUNCT, "");
}

// Defensive cap on how many buffer rows a single wrapped logical line can
// stitch across — a pathological giant single-line blob (minified JSON,
// etc.) shouldn't make every hover walk thousands of rows.
const MAX_STITCH_LINES = 500;

// xterm calls provideLinks once per hovered *row*, but a long line can wrap
// across several rows and a path/URL can span the wrap boundary. Walk to the
// start of the logical line, then concatenate every wrapped row's full
// (unwrapped-width) text so buffer-index math stays a fixed `cols`-wide
// stride per row.
function stitchLine(term: Terminal, y: number): { text: string; startLine: number } | null {
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

// 0-based buffer-index -> 1-based ILink buffer position, per xterm's
// IBufferCellPosition contract.
function indexToPosition(startLine: number, cols: number, idx: number): { x: number; y: number } {
  return { y: startLine + Math.floor(idx / cols) + 1, x: (idx % cols) + 1 };
}

export interface TerminalLinksHandlers {
  resolvePaths: (paths: string[]) => Promise<(string | null)[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // Fired with the ILink under the pointer (or null on leave), so the
  // terminal's own mouse-mode interception (see TerminalView's onCapture)
  // can activate it directly without letting a ctrl+click reach tmux.
  onHoverChange: (link: ILink | null) => void;
}

export function isOpenGesture(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function buildLinkProvider(term: Terminal, handlers: TerminalLinksHandlers): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const stitched = stitchLine(term, bufferLineNumber - 1);
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
          const links: ILink[] = [];
          let pathIdx = 0;
          for (const c of candidates) {
            let openTarget: string | undefined = c.target;
            let line: number | undefined = c.line;
            if (c.kind === "path") {
              openTarget = resolved[pathIdx] ?? undefined;
              pathIdx++;
              if (!openTarget) continue; // not a real file — no link
            }
            const range = {
              start: indexToPosition(startLine, term.cols, c.startIdx),
              end: indexToPosition(startLine, term.cols, c.endIdx - 1),
            };
            const kind = c.kind;
            const target = openTarget;
            // `link` is referenced from within its own hover/leave closures
            // below — safe because those only run later, once the object
            // (and this const binding) is fully initialized.
            const link: ILink = {
              range,
              text: c.text,
              decorations: { underline: true, pointerCursor: true },
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
