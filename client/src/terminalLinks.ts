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

export interface Candidate {
  kind: "url" | "path";
  startIdx: number;
  endIdx: number;
  text: string;
  target: string; // URL, or path with any :line[:col] suffix stripped
  line?: number;
}

export function findCandidates(text: string): Candidate[] {
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
// etc.) shouldn't make every hover walk thousands of rows. Consumed by the
// engine extensions' own stitchers (each engine's buffer API differs) via
// the @tmux-server/engine-support shim.
export const MAX_STITCH_LINES = 500;

export function isOpenGesture(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
