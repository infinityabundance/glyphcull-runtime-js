//! Host text presentation (DESIGN.md D12 — hosts adapt, the runtime
//! executes): a host may re-ink the document for its own presentation (a
//! dark reader, a brand palette) without touching the package. The document
//! carries resolved colors; `theme.ink` replaces the **document's default
//! ink** — the color the compiler uses for body text, headings, list
//! markers, and rules when the source does not color them (`#000000`) —
//! everywhere it appears. Every other color (links, highlights,
//! backgrounds), every image, and all geometry are preserved.
//!
//! The rule is exact-match and deterministic: `color === DEFAULT_INK` is
//! re-inked, nothing else. A monochrome document themes fully; a colored
//! document keeps its accents. No theme → the document renders exactly as
//! compiled (the identity mapping), so existing behavior and goldens are
//! unchanged.

/** The compiler's default resolved text color (ResolvedStyle::default). */
export const DEFAULT_INK = 0x0000_00ff;

/** A parsed host theme (internal; hosts pass the string form to `load`). */
export interface Theme {
  /** The ink color as RGBA. */
  readonly ink: number;
}

/**
 * Parse a host ink string: `#rrggbb` (opaque) or `#rrggbbaa` (RGBA).
 * Returns `undefined` for anything else.
 */
export function parseThemeInk(value: string): number | undefined {
  const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
  if (match === null) return undefined;
  const hex = match[1]!;
  return hex.length === 6 ? Number.parseInt(hex + 'ff', 16) : Number.parseInt(hex, 16);
}

/** The presented color of a document color under a theme (identity when none). */
export function themedColor(color: number, theme: Theme | undefined): number {
  return theme !== undefined && color === DEFAULT_INK ? theme.ink : color;
}
