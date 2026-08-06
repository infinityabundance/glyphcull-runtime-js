//! Glyph measurement: advances, kerning, and mark attachment from the
//! MSDF atlas (SPEC.md §2.5).
//!
//! Scope (DESIGN.md D7): per-codepoint glyph selection with combining-mark
//! attachment (marks advance 0 and are positioned at the base glyph's
//! origin). Kerning pairs from the atlas are applied between adjacent
//! non-mark codepoints. A codepoint with no glyph record renders as a
//! fallback "tofu" box (no outline, advance = 0.5 em) — the compiler
//! reports missing codepoints at compile time, so this is a defensive
//! fallback, never a silent substitution.

import type { Atlas, GlyphRecord } from '../format/sections.js';
import { texelsPerEm } from '../format/sections.js';
import { isCombiningMark } from './breaks.js';

/** The measured geometry of one glyph in a run. */
export interface GlyphMetric {
  /** The codepoint (Unicode scalar value). */
  readonly codepoint: number;
  /** Advance in document pixels at the run's font size (kerning-adjusted). */
  readonly advancePx: number;
  /** Whether the glyph is a combining mark (advance 0, overlays the base). */
  readonly isMark: boolean;
  /** Whether the atlas has an outline for this codepoint. */
  readonly hasOutline: boolean;
  /** The glyph record when present (box, page, flags). */
  readonly glyph: GlyphRecord | undefined;
}

/** One measured text run. */
export interface MeasuredRun {
  readonly glyphs: readonly GlyphMetric[];
  /** Total advance width in pixels. */
  readonly widthPx: number;
}

/**
 * Measure a text run against an atlas at a font size. `letterSpacingPx` is
 * added after every non-mark glyph (SPEC.md §2.3, tag 15).
 */
export function measureRun(
  atlas: Atlas,
  text: string,
  fontSizePx: number,
  letterSpacingPx: number,
): MeasuredRun {
  const emToPx = fontSizePx;
  const glyphs: GlyphMetric[] = [];
  let widthPx = 0;
  let prev = -1;
  let lastNonMarkIndex = -1;

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const glyph = atlas.glyphs.get(cp);
    const isMark = isCombiningMark(cp) || (glyph?.combining ?? false);
    let advanceEm = glyph?.advance ?? 0.5;

    // Kerning: adjust the advance of the previous glyph by the pair amount.
    if (prev >= 0 && glyph !== undefined) {
      const pairAdjust = atlas.kerning.get(prev)?.get(cp);
      if (pairAdjust !== undefined && lastNonMarkIndex >= 0) {
        const previous = glyphs[lastNonMarkIndex]!;
        const extra = pairAdjust * emToPx;
        glyphs[lastNonMarkIndex] = {
          ...previous,
          advancePx: previous.advancePx + extra,
        };
        widthPx += extra;
      }
    }

    if (isMark) {
      // Marks advance 0 and attach to the base glyph's origin.
      advanceEm = 0;
    } else {
      if (letterSpacingPx !== 0) {
        widthPx += letterSpacingPx;
      }
      lastNonMarkIndex = glyphs.length;
    }

    const advancePx = advanceEm * emToPx;
    widthPx += advancePx;
    glyphs.push({
      codepoint: cp,
      advancePx,
      isMark,
      hasOutline: glyph !== undefined && !glyph.noOutline,
      glyph,
    });
    prev = cp;
  }

  return { glyphs, widthPx };
}

/** The atlas metrics needed for vertical layout, in em units. */
export interface FontMetrics {
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
}

/** Metrics of an atlas in em units. */
export function atlasMetrics(atlas: Atlas): FontMetrics {
  return { ascent: atlas.ascent, descent: atlas.descent, lineGap: atlas.lineGap };
}

/** The ratio of texels to em (for the renderer's distance→pixel mapping). */
export function texelsPerEmPx(atlas: Atlas): number {
  return texelsPerEm(atlas);
}
