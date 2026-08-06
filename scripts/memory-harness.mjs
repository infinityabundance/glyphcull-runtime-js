#!/usr/bin/env node
//! Memory regression harness (TESTING.md §2 memory, PERFORMANCE.md): loads,
//! paints, scrolls, selects, copies, and destroys the golden document in
//! cycles under `--expose-gc`, asserting that retained heap growth stays
//! below the committed baseline after warmup. Every Document is
//! self-contained (Architecture.md §6); a leak shows up as per-cycle growth
//! that destroy() should have released.
//!
//! Run with `npm run test:memory` (builds dist, then `node --expose-gc`).
//! Exits non-zero when the growth baseline is exceeded or an operation
//! throws — the CI gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { load } = await import(join(root, 'dist', 'index.js'));

/** A canvas whose contexts are unavailable (Node has no GPU surfaces). */
function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    getContext: () => null,
    addEventListener: () => undefined,
  };
}

globalThis.document = { createElement: () => fakeCanvas() };

const WARMUP = 3;
const CYCLES = 8;
// The committed baseline: retained growth per cycle after warmup must stay
// below 1 MiB (the golden is ~850 KiB of fixture; a per-cycle document leak
// would far exceed this).
const MAX_GROWTH_BYTES = 1 * 1024 * 1024;

function gc() {
  globalThis.gc?.();
}

function heapUsed() {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

async function run() {
  const bytes = readFileSync(join(root, 'test', 'fixtures', 'pipeline-golden.cull'));
  const cycle = async () => {
    const doc = await load(bytes, {
      canvas: fakeCanvas(),
      contentWidth: 800,
      width: 800,
      height: 600,
    });
    doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    doc.paint();
    doc.scroll({ x: 0, y: 120, w: 800, h: 600 });
    doc.paint();
    doc.select({ start: { chunkId: 3, offset: 0 }, end: { chunkId: 22, offset: 5 } });
    const copied = doc.copy();
    if (copied.length === 0) throw new Error('copy produced no text');
    doc.destroy();
  };

  // Warmup: JIT + caches settle.
  for (let i = 0; i < WARMUP; i++) await cycle();

  const before = heapUsed();
  for (let i = 0; i < CYCLES; i++) {
    await cycle();
    const after = heapUsed();
    const growth = after - before;
    console.log(
      `cycle ${i + 1}/${CYCLES}: heap ${(after / 1024 / 1024).toFixed(2)} MiB (growth ${(growth / 1024).toFixed(0)} KiB)`,
    );
    if (growth > MAX_GROWTH_BYTES) {
      throw new Error(
        `retained heap grew ${(growth / 1024).toFixed(0)} KiB across ${i + 1} cycles (> ${(MAX_GROWTH_BYTES / 1024).toFixed(0)} KiB baseline); a document is leaking`,
      );
    }
  }
  console.log('memory harness: retained growth within baseline');
}

run().catch((error) => {
  console.error('memory harness failed:', error);
  process.exitCode = 1;
});
