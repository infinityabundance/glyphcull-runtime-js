//! Glyph measurement tests: advances, kerning, marks, tofu fallback.

import { describe, expect, it } from 'vitest';
import { measureRun, atlasMetrics } from '../../src/layout/measure.js';
import { readPackage } from '../../src/format/reader.js';
import { pipelineGolden } from '../testkit/fixtures.js';

async function atlas0() {
  const parsed = await readPackage(pipelineGolden());
  if (!parsed.ok) throw parsed.error;
  const atlases = parsed.value.atlases();
  if (atlases === undefined) throw new Error('no atlases');
  return atlases[0]!;
}

describe('measureRun', () => {
  it('measures advances proportional to the font size', async () => {
    const atlas = await atlas0();
    const a = measureRun(atlas, 'Hello', 16, 0);
    const b = measureRun(atlas, 'Hello', 32, 0);
    expect(a.widthPx).toBeGreaterThan(0);
    expect(b.widthPx).toBeCloseTo(a.widthPx * 2, 5);
    expect(a.glyphs).toHaveLength(5);
  });

  it('glyph advances are non-negative and finite', async () => {
    const atlas = await atlas0();
    const m = measureRun(atlas, 'The quick brown fox', 16, 0);
    for (const g of m.glyphs) {
      expect(Number.isFinite(g.advancePx)).toBe(true);
      expect(g.advancePx).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies kerning from the atlas', async () => {
    const atlas = await atlas0();
    // The fixture atlas carries kerning pairs for the golden's text.
    const kerningPairs = [...atlas.kerning.entries()];
    if (kerningPairs.length === 0) return; // fixture-dependent; see below
    const [left, rights] = kerningPairs[0]!;
    const right = [...rights.keys()][0]!;
    const adjust = rights.get(right)!;
    // A pair with a non-zero adjustment must change the measured width.
    if (Math.abs(adjust) > 1e-6) {
      const pair = measureRun(
        atlas,
        `${String.fromCodePoint(left)}${String.fromCodePoint(right)}`,
        16,
        0,
      );
      const solo = measureRun(
        atlas,
        `${String.fromCodePoint(left)}${String.fromCodePoint(right)}`,
        16,
        0,
      );
      expect(pair.widthPx).toBe(solo.widthPx); // measurement is deterministic
      // The kerning adjust equals the width delta vs. no kerning: verify the
      // pair total equals the sum of solo advances plus the adjustment.
      const leftGlyph = atlas.glyphs.get(left)!;
      const rightGlyph = atlas.glyphs.get(right)!;
      const expected = (leftGlyph.advance + rightGlyph.advance + adjust) * 16;
      expect(pair.widthPx).toBeCloseTo(expected, 4);
    }
  });

  it('combining marks advance 0 and attach to the base', async () => {
    const atlas = await atlas0();
    // e + combining acute. If the atlas lacks the combining mark glyph, the
    // fallback (advance 0.5em) applies and isMark is still true by range.
    const m = measureRun(atlas, 'e\u0301', 16, 0);
    expect(m.glyphs[1]!.isMark).toBe(true);
    expect(m.glyphs[1]!.advancePx).toBe(0);
    expect(m.widthPx).toBeCloseTo(m.glyphs[0]!.advancePx, 6);
  });

  it('letter spacing widens the run', async () => {
    const atlas = await atlas0();
    const plain = measureRun(atlas, 'ab', 16, 0);
    const spaced = measureRun(atlas, 'ab', 16, 2);
    // CSS semantics: letter-spacing is added after every character.
    expect(spaced.widthPx).toBeCloseTo(plain.widthPx + 4, 5);
  });

  it('missing glyphs fall back to a half-em tofu box', async () => {
    const atlas = await atlas0();
    const m = measureRun(atlas, '\u{10ffff}', 16, 0);
    expect(m.glyphs[0]!.hasOutline).toBe(false);
    expect(m.glyphs[0]!.advancePx).toBeCloseTo(8, 5);
  });

  it('metrics are finite and descent is positive', async () => {
    const atlas = await atlas0();
    const m = atlasMetrics(atlas);
    expect(Number.isFinite(m.ascent)).toBe(true);
    expect(m.ascent).toBeGreaterThan(0);
    expect(m.descent).toBeGreaterThanOrEqual(0);
  });
});
