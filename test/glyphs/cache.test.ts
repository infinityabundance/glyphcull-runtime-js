//! Glyph cache tests: stamp preparation, budgeting, LRU eviction, and
//! lifecycle coupling (releaseChunk).

import { describe, expect, it } from 'vitest';
import { GlyphCache, prepareGlyph } from '../../src/glyphs/cache.js';
import { readPackage } from '../../src/format/reader.js';
import { texelsPerEm } from '../../src/format/sections.js';
import { pipelineGolden } from '../testkit/fixtures.js';

async function goldenAtlas(fontId: number) {
  const parsed = await readPackage(pipelineGolden());
  if (!parsed.ok) throw parsed.error;
  const atlases = parsed.value.atlases();
  if (atlases === undefined) throw new Error('no atlases');
  return atlases[fontId]!;
}

/** A codepoint present in the golden's atlas 0 ('Deterministic…'). */
const D = 'D'.codePointAt(0)!;
const E = 'e'.codePointAt(0)!;

/** A codepoint definitely absent from the golden atlas. */
const MISSING = 0x10ffff;

describe('prepareGlyph', () => {
  it('produces a stamp consistent with the placement convention', async () => {
    const atlas = await goldenAtlas(0);
    const glyph = atlas.glyphs.get(D);
    expect(glyph).toBeDefined();
    const stamp = prepareGlyph(atlas, D, 16, 0x000000ff)!;
    expect(stamp).toBeDefined();
    const scale = 16 / texelsPerEm(atlas);
    expect(stamp.quadW).toBeCloseTo(glyph!.boxW * scale, 4);
    expect(stamp.quadH).toBeCloseTo(glyph!.boxH * scale, 4);
    expect(stamp.offsetX).toBeCloseTo(glyph!.bearingX * 16 - atlas.padding * scale, 4);
    expect(stamp.offsetY).toBeCloseTo(glyph!.bearingY * 16 + atlas.padding * scale, 4);
    expect(stamp.advancePx).toBeCloseTo(glyph!.advance * 16, 4);
    // UVs are within [0, 1].
    const [u0, v0, u1, v1] = stamp.uv;
    expect(u0).toBeGreaterThanOrEqual(0);
    expect(v0).toBeGreaterThanOrEqual(0);
    expect(u1).toBeLessThanOrEqual(1);
    expect(v1).toBeLessThanOrEqual(1);
    expect(u1).toBeGreaterThan(u0);
    expect(v1).toBeGreaterThan(v0);
  });

  it('returns undefined for missing codepoints (tofu handled by layout)', async () => {
    const atlas = await goldenAtlas(0);
    expect(prepareGlyph(atlas, MISSING, 16, 0)).toBeUndefined();
  });

  it('scales the quad with the font size', async () => {
    const atlas = await goldenAtlas(0);
    const small = prepareGlyph(atlas, D, 16, 0)!;
    const large = prepareGlyph(atlas, D, 32, 0)!;
    expect(large.quadW).toBeCloseTo(small.quadW * 2, 4);
    expect(large.advancePx).toBeCloseTo(small.advancePx * 2, 4);
  });

  it('separates stamps by color (the cache key quad)', async () => {
    const atlas = await goldenAtlas(0);
    const a = prepareGlyph(atlas, D, 16, 0xff0000ff)!;
    const b = prepareGlyph(atlas, D, 16, 0x00ff00ff)!;
    expect(a.key.color).not.toBe(b.key.color);
  });
});

describe('GlyphCache', () => {
  it('stores and fetches stamps with LRU touch', async () => {
    const atlas = await goldenAtlas(0);
    const cache = new GlyphCache(1 << 20);
    const stamp = prepareGlyph(atlas, D, 16, 0)!;
    cache.put(stamp.key, stamp, 7);
    expect(cache.has(stamp.key)).toBe(true);
    expect(cache.get(stamp.key)).toBe(stamp);
    expect(cache.size).toBe(1);
  });

  it('enforces the byte budget by evicting the least recently used', async () => {
    const atlas = await goldenAtlas(0);
    // Budget fits exactly one stamp.
    const cache = new GlyphCache(200);
    const stamps = [D, E, 't'.codePointAt(0)!].map((cp) => prepareGlyph(atlas, cp, 16, 0)!);
    cache.put(stamps[0]!.key, stamps[0]!, 1);
    cache.put(stamps[1]!.key, stamps[1]!, 2);
    // A and B: the first is evicted when B arrives.
    expect(cache.has(stamps[0]!.key)).toBe(false);
    expect(cache.has(stamps[1]!.key)).toBe(true);
    // Touching B, then inserting C evicts B.
    cache.get(stamps[1]!.key);
    cache.put(stamps[2]!.key, stamps[2]!, 3);
    expect(cache.has(stamps[1]!.key)).toBe(false);
    expect(cache.has(stamps[2]!.key)).toBe(true);
    expect(cache.usedBytes).toBeLessThanOrEqual(cache.budget);
  });

  it('an unlimited budget never evicts', async () => {
    const atlas = await goldenAtlas(0);
    const cache = new GlyphCache(Number.MAX_SAFE_INTEGER);
    const stamps = [D, E, 't'.codePointAt(0)!, 'o'.codePointAt(0)!, 'n'.codePointAt(0)!].map((cp) =>
      prepareGlyph(atlas, cp, 16, 0)!,
    );
    for (const s of stamps) cache.put(s.key, s, 1);
    expect(cache.size).toBe(5);
  });

  it('releaseChunk frees the chunk-owned stamps and keeps shared ones', async () => {
    const atlas = await goldenAtlas(0);
    const cache = new GlyphCache(1 << 20);
    const stampA = prepareGlyph(atlas, D, 16, 0)!;
    const stampB = prepareGlyph(atlas, E, 16, 0)!;
    cache.put(stampA.key, stampA, 10);
    cache.put(stampB.key, stampB, 20);
    // 'A' shared by chunks 10 and 11.
    cache.put(stampA.key, stampA, 11);
    const freed = cache.releaseChunk(10);
    expect(freed).toBe(0); // A survives via chunk 11
    expect(cache.has(stampA.key)).toBe(true);
    expect(cache.ownersOf(stampA.key).sort()).toEqual([11]);
    const freedB = cache.releaseChunk(20);
    expect(freedB).toBe(stampB.sizeBytes);
    expect(cache.has(stampB.key)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('clear drops everything', async () => {
    const atlas = await goldenAtlas(0);
    const cache = new GlyphCache(1 << 20);
    const stamp = prepareGlyph(atlas, D, 16, 0)!;
    cache.put(stamp.key, stamp, 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.usedBytes).toBe(0);
  });

  it('rejects a negative budget', () => {
    expect(() => new GlyphCache(-1)).toThrow(RangeError);
  });
});
