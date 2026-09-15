// What a terminal emulator sends back on its own when output asks it
// something: device attributes, cursor position and status reports, mode
// reports, version and setting queries, color and window-size answers.
// Replayed history is full of those questions (a TUI asks them when it
// starts), and the answers belong to a program that is long gone, so they
// must never be delivered to the shell as typed input. Keys a person types
// never take these shapes: arrows and function keys end in letters like
// A-D, P-S or ~, not in the report terminators matched here.
const REPLY = new RegExp(
  [
    "\\x1b\\[[?>=]?[\\d;]*c", // device attributes (DA1, DA2, DA3 as CSI)
    "\\x1b\\[\\??\\d+;\\d+R", // cursor position report
    "\\x1b\\[\\??\\d*n", // device status report
    "\\x1b\\[\\??[\\d;]*\\$y", // mode report (DECRPM)
    "\\x1b\\[[\\d;]*t", // window size and state answers
    "\\x1bP[\\s\\S]*?\\x1b\\\\", // DCS answers (XTVERSION, DECRQSS, DA3)
    "\\x1b\\][\\d;]+[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC answers (colors)
    "\\x1b\\[[IO]", // focus reports, switched on by a program in the history
  ].join("|"),
  "g",
);

/** The input with every automatic terminal reply removed. Only for input
 *  produced while history replays: a live program asked for focus reports. */
export function stripTerminalReplies(data: string): string {
  return data.replace(REPLY, "");
}
