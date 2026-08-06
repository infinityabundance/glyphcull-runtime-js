//! MSDF reconstruction tests: the median, smoothstep, texel scaling, a
//! synthetic-edge reconstruction profile (including downsampling and page-
//! edge clamping), and the equivalence of the reference convenience wrapper.

import { describe, expect, it } from 'vitest';
import {
  median,
  msdfCoverage,
  reconstruct,
  reconstructGlyph,
  smoothstep,
  texelToPx,
} from '../../src/render/msdf.js';

describe('median', () => {
  it('returns the middle value', () => {
    expect(median(0.1, 0.5, 0.9)).toBe(0.5);
    expect(median(0.9, 0.1, 0.5)).toBe(0.5);
    expect(median(0.5, 0.9, 0.1)).toBe(0.5);
    expect(median(0.1, 0.9, 0.9)).toBe(0.9);
  });
});

describe('smoothstep', () => {
  it('is 0/1 outside and Hermite inside', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 5);
  });
});

describe('texelToPx', () => {
  it('scales with font size and dpr', () => {
    expect(texelToPx(16, 1, 32)).toBe(0.5);
    expect(texelToPx(16, 2, 32)).toBe(1);
    expect(texelToPx(32, 1, 32)).toBe(1);
  });
});

describe('msdfCoverage', () => {
  it('is 1 inside the glyph and 0 far outside', () => {
    // Edge at channel 0.5; texelToPx 1 → distancePx = channel − 0.5. The AA
    // edge spans ±0.5 device px, so saturation needs |dist| ≥ 0.5.
    expect(msdfCoverage([1, 1, 1], 1)).toBeCloseTo(1, 5);
    expect(msdfCoverage([0, 0, 0], 1)).toBeCloseTo(0, 5);
    expect(msdfCoverage([0.5, 0.5, 0.5], 1)).toBeCloseTo(0.5, 5);
    // A channel 0.9 is 0.4 device px inside the edge → partial coverage.
    expect(msdfCoverage([0.9, 0.9, 0.9], 1)).toBeCloseTo(0.972, 3);
    expect(msdfCoverage([0.1, 0.1, 0.1], 1)).toBeCloseTo(0.028, 3);
  });

  it('the median prevents a single near channel from dominating', () => {
    // median(0.1, 0.1, 0.9) = 0.1: the corner stays far, exactly as if all
    // three channels were far.
    expect(msdfCoverage([0.1, 0.1, 0.9], 1)).toBe(msdfCoverage([0.1, 0.1, 0.1], 1));
    expect(msdfCoverage([0.9, 0.1, 0.1], 1)).toBe(msdfCoverage([0.1, 0.1, 0.1], 1));
    expect(msdfCoverage([0.9, 0.9, 0.1], 1)).toBe(msdfCoverage([0.9, 0.9, 0.9], 1));
  });

  it('widens the transition with the AA width', () => {
    expect(msdfCoverage([0.5, 0.5, 0.5], 1, 2)).toBeCloseTo(0.5, 5);
    // Half a device px inside a 2px-wide edge (dist = 0.25): t = 0.625.
    expect(msdfCoverage([0.75, 0.75, 0.75], 1, 2)).toBeCloseTo(0.684, 3);
    // The same channel at 1px AA is closer to saturation: the wider edge softens.
    expect(msdfCoverage([0.75, 0.75, 0.75], 1, 1)).toBeGreaterThan(
      msdfCoverage([0.75, 0.75, 0.75], 1, 2),
    );
  });
});

/** An 8×8 page with a vertical edge at x = 4: channel = clamp(0.5 + (x-4), 0, 1). */
function verticalEdgePage(): Uint8Array {
  const page = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const channel = Math.round(Math.min(1, Math.max(0, x - 3.5)) * 255);
      const i = (y * 8 + x) * 4;
      page[i] = channel;
      page[i + 1] = channel;
      page[i + 2] = channel;
      page[i + 3] = 255;
    }
  }
  return page;
}

describe('reconstructGlyph', () => {
  it('recovers a vertical edge profile from a synthetic field', () => {
    const page = verticalEdgePage();
    const out = reconstructGlyph(page, 8, 0, 0, 8, 8, 1, 4);
    // Coverage rises monotonically across the edge at x = 4 (1 device px per
    // texel, 1px AA edge): outside < 0.5 < inside, saturated past the edge.
    const c = (i: number): number => out[i]! / 255;
    expect(c(3)).toBeLessThan(0.5);
    expect(c(4)).toBeGreaterThan(0.5);
    expect(c(5)).toBeCloseTo(1, 2);
    expect(c(3)).toBeLessThan(c(4));
    expect(c(4)).toBeLessThan(c(5));
    // Pinned values (analytic texel-grid bilinear, 4×4 supersampling): the
    // edge spans exactly one output pixel.
    expect(c(3)).toBeCloseTo(0.187, 2);
    expect(c(4)).toBeCloseTo(0.816, 2);
  });

  it('is the same computation as reconstruct at equal resolution', () => {
    const page = verticalEdgePage();
    const a = reconstructGlyph(page, 8, 0, 0, 8, 8, 1, 4);
    const b = reconstruct(page, 8, 0, 0, 8, 8, 8, 8, 1, 4);
    expect(a).toEqual(b);
  });

  it('clamps at page edges instead of reading out of bounds', () => {
    // A box flush against the page corner: samples touch the last texel row
    // and column. Every output byte must be a finite 0..255 integer (no NaN
    // from out-of-bounds reads), and the far side of the edge is saturated.
    const page = verticalEdgePage();
    const out = reconstructGlyph(page, 8, 0, 0, 8, 8, 1, 1);
    expect(out.length).toBe(64);
    for (const byte of out) {
      expect(Number.isInteger(byte)).toBe(true);
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
    expect(out[0]!).toBe(0); // top-left, far outside the edge
    expect(out[63]!).toBe(255); // bottom-right, fully inside
  });
});

describe('reconstruct (arbitrary output resolution)', () => {
  it('downsamples: the edge falls between output pixels at half resolution', () => {
    const page = verticalEdgePage();
    // 8×8 texels → 4×4 pixels (2 texels per pixel), texelToPx 1.
    const out = reconstruct(page, 8, 0, 0, 8, 8, 4, 4, 1, 4);
    const c = (i: number): number => out[i]! / 255;
    expect(c(1)).toBeLessThan(0.5); // texel footprint [2,4): mostly outside
    expect(c(2)).toBeGreaterThan(0.5); // footprint [4,6): mostly inside
    expect(c(1)).toBeLessThan(c(2));
  });

  it('rejects a zero or fractional output size', () => {
    const page = verticalEdgePage();
    expect(() => reconstruct(page, 8, 0, 0, 8, 8, 0, 8, 1)).toThrow(RangeError);
    expect(() => reconstruct(page, 8, 0, 0, 8, 8, 8, 2.5, 1)).toThrow(RangeError);
  });

  it('a box larger than the page still produces finite coverage', () => {
    const page = verticalEdgePage();
    const out = reconstruct(page, 8, 0, 0, 10, 10, 5, 5, 1, 4);
    for (const byte of out) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});
