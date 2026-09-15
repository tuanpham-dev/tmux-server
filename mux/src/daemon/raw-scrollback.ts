// Byte-exact scrollback sidecar (T1.6). The SerializeAddon reconstructs the
// terminal's *cells*, which loses escape sequences that aren't cell attributes
// — notably OSC 8 hyperlink URLs and OSC 133 prompt marks. To replay history
// verbatim (so restored/reattached scrollback keeps working links and
// prompt-jump targets), we keep a capped log of the raw PTY bytes and replay it
// after a terminal reset.
//
// Two correctness rules make raw replay safe:
//   1. Replay must START at a "safe offset" — a point where the parser is at
//      ground state (not mid-escape). A byte position immediately after a
//      newline (0x0A) qualifies: escape/control sequences never contain a raw
//      newline, so just-after-\n is always parser ground state. We only ever
//      trim the ring forward to such a boundary, so the retained buffer always
//      begins cleanly.
//   2. Raw replay is only used when the window is currently on the NORMAL
//      buffer. If an alt-screen app (vim, less) is in front, the caller falls
//      back to SerializeAddon (which forces the normal buffer) — matching the
//      existing "restore shows the shell beneath the app" behavior. We track
//      alt-screen state by scanning for the DEC private mode set/reset codes.

const NL = 0x0a;

// DEC private modes that switch to/from the alternate screen buffer. We match
// the full CSI sequences as byte patterns in the stream.
const ALT_ENTER = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'].map((s) => Buffer.from(s, 'latin1'));
const ALT_EXIT = ['\x1b[?1049l', '\x1b[?1047l', '\x1b[?47l'].map((s) => Buffer.from(s, 'latin1'));

// Reset the terminal before a raw replay: soft/full reset, leave alt screen,
// show cursor, clear screen + client scrollback. Same prefix family the server
// already uses for serialize replays.
export const RESET_PREFIX = '\x1b[!p\x1b[?1049l\x1b[?25h\x1b[0m\x1b[H\x1b[2J\x1b[3J';

export class RawScrollback {
  #cap: number;
  #buf: Buffer;
  #alt = false;

  constructor(capBytes: number, seed?: Buffer) {
    this.#cap = Math.max(1024, capBytes);
    this.#buf = seed && seed.length > 0 ? this.#trim(seed) : Buffer.alloc(0);
  }

  /** True if the stream is currently showing the alternate screen buffer. */
  get onAltScreen(): boolean { return this.#alt; }

  /** Retained raw bytes — always starting at a safe (post-newline) boundary. */
  bytes(): Buffer { return this.#buf; }

  /** Append a PTY output chunk, updating alt-screen state and trimming to cap. */
  push(chunk: Buffer): void {
    this.#scanAlt(chunk);
    this.#buf = this.#trim(Buffer.concat([this.#buf, chunk]));
  }

  // Track alt-screen enter/exit. A mode sequence could in principle be split
  // across two chunks; that is vanishingly rare for these short CSI codes and a
  // miss only means one replay falls back to serialize — never corruption. We
  // keep a small tail overlap to catch most splits.
  #tail = Buffer.alloc(0);
  #scanAlt(chunk: Buffer): void {
    const hay = this.#tail.length > 0 ? Buffer.concat([this.#tail, chunk]) : chunk;
    // Find the last enter/exit in this window and let it win.
    let lastPos = -1;
    let lastVal = this.#alt;
    for (const pat of ALT_ENTER) {
      let i = hay.indexOf(pat);
      while (i !== -1) { if (i > lastPos) { lastPos = i; lastVal = true; } i = hay.indexOf(pat, i + 1); }
    }
    for (const pat of ALT_EXIT) {
      let i = hay.indexOf(pat);
      while (i !== -1) { if (i > lastPos) { lastPos = i; lastVal = false; } i = hay.indexOf(pat, i + 1); }
    }
    if (lastPos !== -1) this.#alt = lastVal;
    // Keep the last 7 bytes (longest pattern - 1) to bridge a split next time.
    const keep = Buffer.concat([this.#tail, chunk]);
    this.#tail = keep.length <= 7 ? keep : Buffer.from(keep.subarray(keep.length - 7));
  }

  // Trim the front to at most #cap bytes, cutting forward to the first newline
  // boundary so the retained buffer starts at parser ground state. If no
  // newline exists in the overflow region (a single huge line), fall back to a
  // hard cut — replay then starts mid-line but still at a byte boundary, which
  // renders as a partial first line, not corruption.
  #trim(buf: Buffer): Buffer {
    if (buf.length <= this.#cap) return buf;
    const overflow = buf.length - this.#cap;
    const nl = buf.indexOf(NL, overflow);
    const cut = nl === -1 ? overflow : nl + 1;
    return buf.subarray(cut);
  }
}
