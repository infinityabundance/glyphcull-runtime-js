//! Browser post-effects validation (TESTING.md §2 rendering): the WebGL
//! renderer draws the document into an offscreen texture and a full-screen
//! fragment shader presents it (render/gl.ts, render/effects.ts). This spec
//! proves, from the actual framebuffer:
//!   - the `clean` post pass is the identity — the offscreen → drawing-buffer
//!     copy reproduces the CPU reference compositor within tolerance;
//!   - `glitch` genuinely alters pixels AND animates with the runtime clock;
//!   - `pixelated` genuinely alters pixels, is time-independent, and produces
//!     hard block structure (the shader's block-quantized sampling);
//!   - `retro` genuinely alters pixels and is time-independent;
//!   - none of the modes fill the frame (ink stays bounded at glyph edges).
//! Run `npm run build` first so `dist/` is current. The server is started by
//! playwright.config.ts (`scripts/browser-harness/server.mjs`).

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const HARNESS = 'http://localhost:4187/post-harness.html';

interface PostResult {
  differs: boolean;
  animated: boolean;
  bleedFraction: number;
  blockUniformity?: number;
}

async function runHarness(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { __glyphcullPost?: { state: string } }).__glyphcullPost;
      return state?.state === 'done';
    },
    undefined,
    { timeout: 60_000 },
  );
  return page.evaluate(
    () =>
      (window as unknown as { __glyphcullPost: { results: Record<string, unknown> } })
        .__glyphcullPost.results,
  );
}

test('post effects: clean is the identity; the modes genuinely process the frame', async ({
  page,
}) => {
  const clean = await runHarness(page, `${HARNESS}?post=`);
  const cleanResult = clean.clean as { ok: boolean; meanAbs: number; pixels: number };
  expect(
    cleanResult.ok,
    `clean post pass must be the identity: ${JSON.stringify(cleanResult)}`,
  ).toBe(true);

  for (const mode of ['glitch', 'pixelated', 'retro'] as const) {
    const results = await runHarness(page, `${HARNESS}?post=${mode}`);
    const r = results[mode] as PostResult;
    expect(r.differs, `${mode} must alter the framebuffer`).toBe(true);
    // Spatial modes legitimately move ink a few device px at glyph edges;
    // the bound keeps the effect from filling the empty frame.
    const bleedLimit = mode === 'pixelated' ? 0.25 : 0.08;
    expect(r.bleedFraction, `${mode} must not fill the frame`).toBeLessThan(bleedLimit);
    if (mode === 'glitch') {
      expect(r.animated, 'glitch must animate with the runtime clock').toBe(true);
    } else {
      // Geometry-only modes are deterministic at a fixed frame.
      expect(r.animated, `${mode} must be time-independent`).toBe(false);
    }
    if (mode === 'pixelated') {
      expect(r.blockUniformity, 'pixelated must produce hard block structure').toBeGreaterThan(0.9);
    }
  }
});
