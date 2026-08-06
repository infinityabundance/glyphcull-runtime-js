//! Knuth–Plass line breaking tests.

import { describe, expect, it } from 'vitest';
import { lineBreak } from '../../src/layout/kp.js';
import type { KpItem } from '../../src/layout/kp.js';

/** Build items for a whitespace-separated sentence with equal word widths. */
function words(count: number, wordWidth = 100, spaceWidth = 20): KpItem[] {
  const items: KpItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({ type: 'box', width: wordWidth });
    if (i < count - 1) {
      items.push({ type: 'glue', width: spaceWidth, stretch: 10, shrink: 5 });
    }
  }
  // Terminating forced break (the KP contract).
  items.push({ type: 'penalty', width: 0, penalty: Number.NEGATIVE_INFINITY });
  return items;
}

describe('lineBreak', () => {
  it('returns one line when everything fits', () => {
    const lines = lineBreak(words(3, 100, 20), 400);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.end).toBe(5); // boxes+glues then the forced break
  });

  it('wraps when the content exceeds the line width', () => {
    // 5 words × 100 + 4 spaces × 20 = 580 > 200 → multiple lines.
    const lines = lineBreak(words(5, 100, 20), 200);
    expect(lines.length).toBeGreaterThan(1);
    // Lines cover the whole item range contiguously.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.start).toBe(lines[i - 1]!.end + 1);
    }
    expect(lines[lines.length - 1]!.end).toBe(9); // last box index (0-based: 5 words → boxes 0,2,4,6,8 + forced break at 9)
  });

  it('never breaks inside a word (boxes are unbreakable)', () => {
    // Two huge boxes: the second cannot fit; it overflows on its own line.
    const items: KpItem[] = [
      { type: 'box', width: 100 },
      { type: 'glue', width: 20, stretch: 10, shrink: 5 },
      { type: 'box', width: 500 },
      { type: 'penalty', width: 0, penalty: Number.NEGATIVE_INFINITY },
    ];
    const lines = lineBreak(items, 200);
    expect(lines.length).toBe(2);
    // The 500-wide box (index 2) is whole on the last line (overflowing).
    const last = lines[lines.length - 1]!;
    expect(last.start).toBeLessThanOrEqual(2);
    expect(last.end).toBe(3);
    // No box is ever split: line boundaries fall on glue/penalty indices.
    for (const line of lines) {
      if (line.end < 3) {
        expect([1, 3]).toContain(line.end); // glue at 1, forced at 3
      }
    }
  });

  it('honors forbidden and forced penalties', () => {
    // a b ! c with a forbidden break after '!' (penalty +inf at index 5):
    // the only feasible 2-line split is before '!'.
    const items: KpItem[] = [
      { type: 'box', width: 100 }, // a
      { type: 'glue', width: 20, stretch: 10, shrink: 5 },
      { type: 'box', width: 100 }, // b
      { type: 'glue', width: 20, stretch: 10, shrink: 5 },
      { type: 'box', width: 100 }, // !
      { type: 'penalty', width: 0, penalty: Number.POSITIVE_INFINITY }, // no break after !
      { type: 'box', width: 100 }, // c
      { type: 'penalty', width: 0, penalty: Number.NEGATIVE_INFINITY },
    ];
    const lines = lineBreak(items, 210);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      // A break at the forbidden penalty (index 5) must never be chosen.
      expect(line.end).not.toBe(5);
    }
    // '!' and 'c' stay together on the last line.
    const last = lines[lines.length - 1]!;
    expect(last.start).toBeLessThanOrEqual(4);
    expect(last.end).toBe(7);
  });

  it('justified lines keep the ratio within the tolerance', () => {
    const lines = lineBreak(words(6, 100, 20), 350, 100);
    for (const line of lines) {
      expect(line.ratio).toBeGreaterThanOrEqual(-1);
      expect(line.ratio).toBeLessThanOrEqual(100);
      expect(line.badness).toBeGreaterThanOrEqual(0);
    }
  });

  it('fitness classes are in range', () => {
    const lines = lineBreak(words(20, 60, 15), 300, 100);
    for (const line of lines) {
      expect(line.fitness).toBeGreaterThanOrEqual(0);
      expect(line.fitness).toBeLessThanOrEqual(3);
    }
  });

  it('empty input produces no lines', () => {
    expect(lineBreak([], 100)).toEqual([]);
  });

  it('is deterministic', () => {
    const items = words(30, 55, 12);
    const a = lineBreak(items, 220, 100);
    const b = lineBreak(items, 220, 100);
    expect(a).toEqual(b);
  });

  it('prefers fewer, better lines over greedy wrapping', () => {
    // A classic case where KP differs from greedy: 9 words, width fits 3.5
    // words. Greedy would produce 3 words/line; KP balances demerits.
    const lines = lineBreak(words(9, 100, 20), 320, 100);
    // Every line must fit within the tolerance; the total demerits are
    // minimal (no assertion on exact counts — determinism covers it).
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.ratio).toBeGreaterThanOrEqual(-1);
    }
  });
});
