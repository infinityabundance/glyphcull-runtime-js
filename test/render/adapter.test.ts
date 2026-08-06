//! Renderer adapter unit tests: color component conversion and CSS colors.
//! The renderers themselves (WebGL, Canvas 2D) are browser-only and are
//! validated in the Playwright harness; their shared seam stays testable here.

import { describe, expect, it } from 'vitest';
import { rgbaComponents, straightComponents } from '../../src/render/adapter.js';
import { rgbaCss } from '../../src/render/canvas2d.js';

describe('rgbaComponents', () => {
  it('premultiplies the color channels', () => {
    // 0x80 = 128/255; premultiplied = (128/255)².
    const [r, g, b, a] = rgbaComponents(0x80808080);
    expect(a).toBeCloseTo(128 / 255, 6);
    expect(r).toBeCloseTo((128 / 255) * (128 / 255), 6);
    expect(g).toBeCloseTo((128 / 255) * (128 / 255), 6);
    expect(b).toBeCloseTo((128 / 255) * (128 / 255), 6);
  });

  it('is transparent when alpha is 0 regardless of color', () => {
    expect(rgbaComponents(0x12345600)).toEqual([0, 0, 0, 0]);
  });

  it('is the raw color when opaque', () => {
    const [r, g, b, a] = rgbaComponents(0x336699ff);
    expect(a).toBe(1);
    expect(r).toBeCloseTo(0x33 / 255, 6);
    expect(g).toBeCloseTo(0x66 / 255, 6);
    expect(b).toBeCloseTo(0x99 / 255, 6);
  });
});

describe('straightComponents', () => {
  it('returns the un-premultiplied channels', () => {
    const [r, , , a] = straightComponents(0x80808080);
    expect(r).toBeCloseTo(128 / 255, 6);
    expect(a).toBeCloseTo(128 / 255, 6);
  });

  it('is consistent with rgbaComponents (premult = straight × alpha)', () => {
    const color = 0x33669980;
    const s = straightComponents(color);
    const p = rgbaComponents(color);
    expect(p[0]).toBeCloseTo(s[0] * s[3], 6);
    expect(p[1]).toBeCloseTo(s[1] * s[3], 6);
    expect(p[2]).toBeCloseTo(s[2] * s[3], 6);
    expect(p[3]).toBeCloseTo(s[3], 6);
  });
});

describe('rgbaCss', () => {
  it('renders an RGBA u32 as a CSS color string', () => {
    expect(rgbaCss(0x336699ff)).toBe('rgba(51, 102, 153, 1)');
    expect(rgbaCss(0x3399ff66)).toBe('rgba(51, 153, 255, 0.4)');
    expect(rgbaCss(0x00000000)).toBe('rgba(0, 0, 0, 0)');
  });
});
