//! Text breaking tests: tokenization vectors for the UAX #29-grounded
//! subset (words, punctuation, CJK, forced breaks).

import { describe, expect, it } from 'vitest';
import { BreakClass, isCombiningMark, tokenizeForBreaking } from '../../src/layout/breaks.js';

const text = (s: string): string[] => tokenizeForBreaking(s).map((t) => t.text);
const breaks = (s: string): BreakClass[] => tokenizeForBreaking(s).map((t) => t.breakAfter);

describe('tokenizeForBreaking', () => {
  it('keeps words intact and breaks at spaces', () => {
    expect(text('hello world')).toEqual(['hello', ' ', 'world']);
    expect(breaks('hello world')).toEqual([
      BreakClass.Allowed,
      BreakClass.Space,
      BreakClass.Forbidden,
    ]);
  });

  it('collapses whitespace runs into one glue token', () => {
    expect(text('a   b')).toEqual(['a', '   ', 'b']);
  });

  it('attaches closing punctuation to the preceding word', () => {
    expect(text('Hello, world!')).toEqual(['Hello,', ' ', 'world!']);
    expect(breaks('Hello, world!')).toEqual([
      BreakClass.Allowed,
      BreakClass.Space,
      BreakClass.Forbidden,
    ]);
  });

  it('does not break after opening punctuation', () => {
    expect(text('(parenthetical')).toEqual(['(parenthetical']);
  });

  it('does not break inside contractions', () => {
    expect(text('don\u2019t')).toEqual(['don\u2019t']);
  });

  it('breaks between CJK ideographs and attaches CJK punctuation', () => {
    const tokens = tokenizeForBreaking('\u4e2d\u6587\u3002\u4e2d');
    expect(tokens.map((t) => t.text)).toEqual(['\u4e2d', '\u6587\u3002', '\u4e2d']);
    expect(tokens[0]!.breakAfter).toBe(BreakClass.Allowed);
    expect(tokens[1]!.breakAfter).toBe(BreakClass.Allowed);
    expect(tokens[2]!.breakAfter).toBe(BreakClass.Forbidden);
  });

  it('treats explicit newlines as forced breaks', () => {
    const tokens = tokenizeForBreaking('a\nb');
    expect(tokens.map((t) => t.breakAfter)).toEqual([
      BreakClass.Allowed,
      BreakClass.Forced,
      BreakClass.Forbidden,
    ]);
  });

  it('handles empty and whitespace-only text', () => {
    expect(tokenizeForBreaking('')).toEqual([]);
    expect(tokenizeForBreaking('   ')).toEqual([{ text: '   ', breakAfter: BreakClass.Space }]);
  });

  it('is deterministic', () => {
    const s = 'The quick brown fox, jumps over the lazy dog.';
    expect(tokenizeForBreaking(s)).toEqual(tokenizeForBreaking(s));
  });
});

describe('isCombiningMark', () => {
  it('recognizes common combining ranges', () => {
    expect(isCombiningMark(0x0301)).toBe(true); // combining acute
    expect(isCombiningMark(0x20d0)).toBe(true); // combining left arrow above
    expect(isCombiningMark(0xfe20)).toBe(true); // combining ligature left half
    expect(isCombiningMark(0x0041)).toBe(false); // 'A'
    expect(isCombiningMark(0x4e2d)).toBe(false); // CJK ideograph
  });
});
