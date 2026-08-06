//! MSDF reconstruction (SPEC.md §2.5, normative): the coverage at a sample
//! is the median of the three channels mapped through a smoothstep with
//! screen-space width.
//!
//! ```text
//! median        = max(min(r, g), min(max(r, g), b))
//! texelToPx     = fontSizePx * dpr / texelsPerEm
//! distancePx    = (median - 0.5) * texelToPx
//! coverage      = smoothstep(-0.5, +0.5, distancePx)      (1 device px edge)
//! ```
//!
//! This pure module is the single source of truth: the WebGL shader is its
//! GLSL translation, the Canvas 2D fallback rasterizes glyphs with it on the
//! CPU, and the rendering validation compares both against it.
//!
//! Sampling convention: atlas page pixels are stored top-row first (y grows
//! down) and the WebGL texture is uploaded without flipping, so `v0` is the
//! box's top in page space — the CPU sampler and the GPU sampler agree
//! exactly. Texture filtering is bilinear per channel with edge clamping,
//! matching GLSL `texture2D` with `LINEAR`/`CLAMP_TO_EDGE`; the median is
//! applied *after* interpolation, exactly like the shader.

/** The median of three values (the MSDF reconstruction). */
export function median(r: number, g: number, b: number): number {
  return Math.max(Math.min(r, g), Math.min(Math.max(r, g), b));
}

/** Hermite smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The device pixels spanned by one atlas texel at a font size and DPR. */
export function texelToPx(fontSizePx: number, dpr: number, texelsPerEm: number): number {
  return (fontSizePx * dpr) / texelsPerEm;
}

/**
 * The reconstructed coverage of an MSDF sample.
 *
 * @param channels  the three distance channels (0..1; the edge is at 0.5)
 * @param texelToPx  device pixels per texel at the rendered size
 * @param aaWidthPx  the anti-aliasing edge width in device pixels (default 1)
 */
export function msdfCoverage(
  channels: readonly [number, number, number],
  texelToPx: number,
  aaWidthPx = 1,
): number {
  const distancePx = (median(channels[0], channels[1], channels[2]) - 0.5) * texelToPx;
  return smoothstep(-aaWidthPx / 2, aaWidthPx / 2, distancePx);
}

/**
 * Reconstruct a glyph bitmap from an atlas page at an arbitrary output
 * resolution. Output pixel `(ox, oy)` covers the texel footprint
 * `[boxX + ox·texelW/outW, boxX + (ox+1)·texelW/outW] × [boxY + …]`; each
 * pixel is supersampled on a `samplesPerTexel²` grid over its footprint and
 * the coverages are averaged. This is the CPU reference for rendering
 * validation: the WebGL shader evaluates the same function at fragment
 * centers (supersampling `1`), so both agree within the validation
 * tolerance.
 *
 * @param page  the RGBA8 atlas page pixels
 * @param pageWidth  the page width in texels
 * @param boxX  the glyph box left in texels
 * @param boxY  the glyph box top in texels
 * @param texelW  the glyph box width in texels
 * @param texelH  the glyph box height in texels
 * @param outW  the output width in pixels (≥ 1)
 * @param outH  the output height in pixels (≥ 1)
 * @param texelToPx  device pixels per texel at the rendered size
 * @param samplesPerTexel  samples along each axis per output pixel
 */
export function reconstruct(
  page: Uint8Array,
  pageWidth: number,
  boxX: number,
  boxY: number,
  texelW: number,
  texelH: number,
  outW: number,
  outH: number,
  texelToPx: number,
  samplesPerTexel = 4,
): Uint8Array {
  if (!(outW >= 1 && outH >= 1) || !Number.isInteger(outW) || !Number.isInteger(outH)) {
    throw new RangeError(`reconstruction size must be integer ≥ 1, got ${outW}×${outH}`);
  }
  const out = new Uint8Array(outW * outH);
  const ss = Math.max(1, samplesPerTexel);
  const stepX = texelW / outW;
  const stepY = texelH / outH;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const tx = boxX + (x + (sx + 0.5) / ss) * stepX;
          const ty = boxY + (y + (sy + 0.5) / ss) * stepY;
          acc += coverageAt(page, pageWidth, tx, ty, texelToPx);
        }
      }
      out[y * outW + x] = Math.round((acc / (ss * ss)) * 255);
    }
  }
  return out;
}

/**
 * The reference reconstruction at one output pixel per texel (the glyph box
 * rasterized 1:1 against the atlas). Equivalent to `reconstruct` with
 * `outW = boxW, outH = boxH`.
 */
export function reconstructGlyph(
  page: Uint8Array,
  pageWidth: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  texelToPx: number,
  samplesPerTexel = 4,
): Uint8Array {
  return reconstruct(
    page,
    pageWidth,
    boxX,
    boxY,
    boxW,
    boxH,
    boxW,
    boxH,
    texelToPx,
    samplesPerTexel,
  );
}

/**
 * The MSDF coverage at an arbitrary point in texel space — the exact function
 * the WebGL shader evaluates per fragment (bilinear per channel, median,
 * smoothstep). The rendering validation samples it at fragment centers
 * `boxX + (dx + 0.5 − quadX) · boxW / quadW` to reproduce the GPU exactly.
 */
export function coverageAt(
  page: Uint8Array,
  pageWidth: number,
  tx: number,
  ty: number,
  texelToPx: number,
): number {
  // Edge clamp to the last texel, matching CLAMP_TO_EDGE (glyph boxes sit
  // inside the page, but a box flush against a page edge must not read past
  // the buffer). Both taps clamp: when a sample sits exactly in the last
  // texel the second tap reads the same texel, like the GPU's edge clamp.
  const pageHeight = page.length / 4 / pageWidth;
  if (!(pageWidth > 0 && pageHeight >= 1)) return 0;
  const cx = Math.min(Math.max(tx, 0), pageWidth - 1);
  const cy = Math.min(Math.max(ty, 0), pageHeight - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, pageWidth - 1);
  const y1 = Math.min(y0 + 1, Math.ceil(pageHeight) - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * pageWidth + x0) * 4;
  const i10 = (y0 * pageWidth + x1) * 4;
  const i01 = (y1 * pageWidth + x0) * 4;
  const i11 = (y1 * pageWidth + x1) * 4;
  // Bilinear per channel (GLSL texture2D LINEAR), then the median: identical
  // to the shader's `median(texture2D(…).rgb)`.
  const r = lerp(lerp(page[i00]!, page[i10]!, fx), lerp(page[i01]!, page[i11]!, fx), fy) / 255;
  const g =
    lerp(lerp(page[i00 + 1]!, page[i10 + 1]!, fx), lerp(page[i01 + 1]!, page[i11 + 1]!, fx), fy) /
    255;
  const b =
    lerp(lerp(page[i00 + 2]!, page[i10 + 2]!, fx), lerp(page[i01 + 2]!, page[i11 + 2]!, fx), fy) /
    255;
  return msdfCoverage([r, g, b], texelToPx);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
