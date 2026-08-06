//! Browser rendering validation (TESTING.md §2 rendering): the harness page
//! paints the golden with the WebGL and Canvas 2D renderers and compares the
//! framebuffer against the CPU compositing reference built from the shared
//! MSDF reconstruction. Tolerance policy: mean abs ≤ 1/64 per channel over
//! the drawn pixels (coverage-aware). Also verifies WebGL context-loss
//! recovery (textures re-upload after restore). The server is started by
//! playwright.config.ts (`scripts/browser-harness/server.mjs`); run
//! `npm run build` first so `dist/` is current.

import { expect, test } from '@playwright/test';

const HARNESS = 'http://localhost:4187/harness.html';

test('WebGL and Canvas 2D render within tolerance of the reference rasterizer', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { __glyphcullValidation?: { state: string } })
        .__glyphcullValidation;
      return state?.state === 'done';
    },
    undefined,
    { timeout: 60_000 },
  );

  const result = await page.evaluate(
    () => (window as unknown as { __glyphcullValidation: unknown }).__glyphcullValidation,
  );
  const results = (result as { results: Record<string, { ok: boolean; renderer: string }> })
    .results;

  for (const renderer of ['webgl', 'canvas2d'] as const) {
    const r = results[renderer]!;
    expect(r.ok, `${renderer} rendering validation failed: ${JSON.stringify(r)}`).toBe(true);
    // Report the measured numbers for the CI log.
    console.log(`${renderer}: ${JSON.stringify(r)}`);
  }
});
