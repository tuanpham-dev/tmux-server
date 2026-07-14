import { describe, expect, it } from "vitest";
import type { ExtensionFontEntry } from "../types";
import { entriesForMode } from "./fonts";

const src = [{ path: "./f.woff2", format: "woff2" }];

const regular: ExtensionFontEntry = { family: "F", src };
const regularExt: ExtensionFontEntry = { family: "F", src, unicodeRange: "U+0100-024F" };
const medium: ExtensionFontEntry = { family: "F", src, weight: "500" };
const bold: ExtensionFontEntry = { family: "F", src, weight: "bold" };
const italic: ExtensionFontEntry = { family: "F", src, style: "italic" };
const boldItalic: ExtensionFontEntry = { family: "F", src, weight: "bold", style: "italic" };

describe("entriesForMode", () => {
  it("passes everything through unchanged when bold stays bold", () => {
    const out = entriesForMode([regular, medium, bold, italic, boldItalic], false);
    expect(out).toHaveLength(5);
    expect(out.map((o) => o.weight)).toEqual(["normal", "500", "bold", "normal", "bold"]);
  });

  it("keeps only regular-weight entries per style, spanning all weights", () => {
    const out = entriesForMode([regular, medium, bold, italic, boldItalic], true);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.weight === "1 1000")).toBe(true);
    expect(out.map((o) => o.entry.style ?? "normal").sort()).toEqual(["italic", "normal"]);
  });

  it("keeps every unicode-range slice of the regular weight", () => {
    const out = entriesForMode([regular, regularExt, bold], true);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.entry.unicodeRange)).toEqual([undefined, "U+0100-024F"]);
  });

  it("registers a style as-is when it has no regular-weight entry", () => {
    const out = entriesForMode([regular, bold, boldItalic], true);
    // normal style collapses to the spanning regular; italic has only a
    // bold face, kept with its declared weight.
    expect(out).toHaveLength(2);
    const italicOut = out.find((o) => o.entry.style === "italic");
    expect(italicOut?.weight).toBe("bold");
  });
});
