//! Host render effects (DESIGN.md D12 — hosts adapt, the runtime executes):
//! a bounded, deterministic-given-time presentation layer.
//!
//! Two effects exist:
//!
//! 1. **accent** — the host marks a color (`load(bytes, { effects: { accent:
//!    '#rrggbb' } })`); every glyph the document paints in that exact color
//!    renders with a **running highlight** — a light band that sweeps along
//!    the bar over time (used for the top-performer bar of a chart). The
//!    band's position is a pure function of the glyph's x and the animation
//!    time, so a paint at a fixed time is byte-deterministic; every other
//!    color, image, and background is untouched.
//!
//! 2. **post** — a WebGL fragment-shader post-processing pass applied after
//!    the document render (`gl.ts` renders the draw list into an offscreen
//!    texture, then a full-screen pass runs the selected mode before
//!    presenting): `clean` (identity), `glitch` (held-slice displacement
//!    bursts + chromatic separation + block tears + a rolling band),
//!    `pixelated` (block-quantized sampling), and `retro` (CRT scanlines +
//!    vignette + barrel + warm grade). Post is
//!    WebGL-only: the Canvas 2D fallback cannot run a shader and renders
//!    clean (the draw list itself — accent included — is renderer-agnostic).
//!
//! The demo host drives the animation by repainting on a rAF loop (each paint
//! advances the clock); the runtime never self-animates. No effects → the
//! identity (goldens and existing behavior unchanged).

/** The WebGL post-processing pass modes (host presentation, WebGL-only). */
export type PostEffect = 'clean' | 'glitch' | 'pixelated' | 'retro';

/** Every post mode, for option validation. */
export const POST_EFFECTS: readonly PostEffect[] = ['clean', 'glitch', 'pixelated', 'retro'];

/** Whether a value is a supported post mode. */
export function isPostEffect(value: unknown): value is PostEffect {
  return (POST_EFFECTS as readonly unknown[]).includes(value);
}

/** The parsed effects configuration (hosts pass the string form to `load`). */
export interface Effects {
  /** The accent color as RGBA: glyphs of this color animate. */
  readonly accent?: number;
  /** The WebGL post-processing pass applied after the document render. */
  readonly post?: PostEffect;
}

/** The highlight band width in document px (the sweep's spatial period). */
const BAND_PX = 140;
/** Seconds per full sweep across the bar. */
const SWEEP_SECONDS = 1.1;

/**
 * The presented color of a glyph under the effects: accent glyphs get a
 * running light band (a triangle wave over `x / BAND_PX + time / SWEEP`
 * interpolating toward white); everything else is unchanged. `time` is in
 * seconds; `0` yields a static band (deterministic).
 */
export function effectGlyphColor(
  color: number,
  effects: Effects | undefined,
  x: number,
  time: number,
): number {
  if (effects?.accent !== color) return color;
  const phase = (x / BAND_PX + time / SWEEP_SECONDS) % 2;
  const band = phase <= 1 ? phase : 2 - phase; // 0..1..0 triangle
  const k = band * band * 0.85;
  const r = ((color >>> 16) & 0xff) + (255 - ((color >>> 16) & 0xff)) * k;
  const g = ((color >>> 8) & 0xff) + (255 - ((color >>> 8) & 0xff)) * k;
  const b = (color & 0xff) + (255 - (color & 0xff)) * k;
  return (0xff00_0000 | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)) >>> 0;
}
