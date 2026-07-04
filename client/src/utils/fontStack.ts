// Parse/serialize helpers for the CSS font-family stack stored as the plain
// string settings.fontFamily — shared by SettingsView's structured picker
// (which needs to read/write individual family names) and utils/fonts.ts
// (which needs to know which extension-contributed families are actually
// selected). The stack itself stays the single source of truth; these are
// pure functions, not state.

// Splits on top-level commas and strips wrapping quotes for display. Font-
// family values never contain a comma inside a single family name, so a
// plain split is safe (matches the CSS spec's own comma-separated-list
// grammar for this property).
export function parseFontStack(stack: string): string[] {
  return stack
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
      }
      return s;
    });
}

// Re-quotes any family containing whitespace, a comma, or a quote character
// so the result round-trips losslessly through parseFontStack.
export function serializeFontStack(families: string[]): string {
  return families
    .map((f) => (/[\s,'"]/.test(f) ? `'${f.replace(/'/g, "\\'")}'` : f))
    .join(", ");
}

// Appends a freeform fallback CSS stack (as typed into the Settings fallback
// field) after the primary families a font-picker option resolved to (one
// family for a plain font, several for an extension group) — re-quoting the
// whole result so it round-trips through parseFontStack regardless of how
// the fallback text was formatted.
export function composeFontStack(primaryFamilies: string[], fallbackCss: string): string {
  return serializeFontStack([...primaryFamilies, ...parseFontStack(fallbackCss)]);
}

export interface FontStackOption {
  value: string;
  // Empty for the "use fallback fonts" option (see FALLBACK_ONLY_VALUE) —
  // contributes nothing to the primary portion of the stack, and is never a
  // match target in splitFontStack below (a 0-length prefix always "matches"
  // trivially, which would make it win over every real option).
  families: string[];
}

// The primary select's escape valve: no built-in/extension font picked, the
// entire stack comes from the freeform fallback field instead. Also what
// splitFontStack falls back to when the stored stack's leading family (or
// families) don't match any currently available option — e.g. a font typed
// by hand, or one whose extension got disabled/uninstalled — so there's
// always a valid select value with no separate "custom" mode to fall into.
export const FALLBACK_ONLY_VALUE = "__fallback_only__";

export interface FontStackSplit {
  // Always one of the passed-in options' `value`s (including, commonly,
  // FALLBACK_ONLY_VALUE) — never an arbitrary string, so the select always
  // has a matching <option>.
  primaryValue: string;
  primaryFamilies: string[];
  // Whatever's left after primaryFamilies, re-serialized — shown verbatim in
  // the Settings fallback text field. Equals the entire stack when
  // primaryValue is FALLBACK_ONLY_VALUE.
  fallback: string;
}

// Splits a stored settings.fontFamily stack into "primary" (the leading
// family or families, matched against a font option so a multi-family
// extension group round-trips as one selection) and "fallback" (everything
// after). The stack itself is the only state; this is a pure derivation, not
// stored separately, so the picker and a hand-edited stack can never drift.
export function splitFontStack(stack: string, options: FontStackOption[]): FontStackSplit {
  const tokens = parseFontStack(stack);

  // Longest matching prefix wins — e.g. a 2-family group is preferred over a
  // single-family option that only matches its first member.
  let best: FontStackOption | null = null;
  for (const option of options) {
    if (option.families.length === 0 || option.families.length > tokens.length) continue;
    const matches = option.families.every((family, i) => tokens[i] === family);
    if (matches && (!best || option.families.length > best.families.length)) best = option;
  }

  if (best) {
    return {
      primaryValue: best.value,
      primaryFamilies: best.families,
      fallback: serializeFontStack(tokens.slice(best.families.length)),
    };
  }
  return { primaryValue: FALLBACK_ONLY_VALUE, primaryFamilies: [], fallback: serializeFontStack(tokens) };
}
