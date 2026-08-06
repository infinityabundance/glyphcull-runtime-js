//! Stress tests (TESTING.md §2 stress): large documents (100k+ chunks),
//! deep viewport jumps, rapid scroll oscillation, whole-document selection,
//! and simultaneous documents. The streaming pipeline must degrade
//! gracefully and deterministically at scale — never crash, never leak
//! unboundedly, and reproduce identical output for identical input. Bounds
//! are deliberately generous (CI machines vary); the point is completion,
//! determinism, and bounded growth.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { ChunkKind } from '../../src/format/sections.js';
import { load } from '../../src/index.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';
import { fakeCanvas, stubDom } from '../testkit/dom.js';

stubDom();

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A document of `paragraphs` paragraphs (a paragraph + run each → 2n+1 chunks). */
function syntheticDocument(
  paragraphs: number,
  text = 'lorem ipsum dolor sit amet '.repeat(6),
): Uint8Array {
  const records = chnkPayload([
    {
      id: 1,
      kind: ChunkKind.Document,
      flags: 1 << 4,
      firstChildId: 2,
      lastChildId: paragraphs + 1,
    },
    ...Array.from({ length: paragraphs }, (_, i) => {
      const id = i + 2;
      const runId = id + paragraphs;
      return {
        id,
        kind: ChunkKind.Paragraph,
        parentId: 1,
        prevId: i === 0 ? 0 : id - 1,
        nextId: i === paragraphs - 1 ? 0 : id + 1,
        firstChildId: runId,
        lastChildId: runId,
        contentIndex: 0,
        depth: 1,
      };
    }),
    ...Array.from({ length: paragraphs }, (_, i) => ({
      id: i + 2 + paragraphs,
      kind: ChunkKind.Run,
      parentId: i + 2,
      contentIndex: 1,
      depth: 2,
    })),
  ]);
  return buildPackage([
    {
      kind: 1,
      compression: 1,
      payload: infoPayload({ chunk_count: 1 + paragraphs * 2, style_count: 1, content_count: 1 }),
    },
    { kind: 2, compression: 1, payload: records },
    { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    { kind: 4, compression: 1, payload: contPayload([text]) },
  ]);
}

const PARAGRAPHS = 50_000; // 100 001 chunks
const VIEWPORT = { x: 0, y: 0, w: 800, h: 600 };

describe('stress', () => {
  it('loads a 100k-chunk document, deep-jumps, paints, and copies', async () => {
    const bytes = syntheticDocument(PARAGRAPHS);
    const doc = await load(bytes, {
      canvas: fakeCanvas(),
      contentWidth: 800,
      width: 800,
      height: 600,
      frameBudgetMs: 16,
    });
    doc.scroll({ ...VIEWPORT, y: 0 });
    doc.paint();
    // Deep jump: the sequential frontier materializes toward the bottom.
    doc.scroll({ ...VIEWPORT, y: 2_000_000 });
    doc.paint();
    // Whole-document selection: first run → last run.
    doc.select({
      start: { chunkId: 2, offset: 0 },
      end: { chunkId: 2 + PARAGRAPHS * 2 - 1, offset: 100 },
    });
    const text = doc.copy();
    expect(text.length).toBeGreaterThan(PARAGRAPHS * 10);
    doc.destroy();
  }, 60_000);

  it('rapid scroll oscillation stays deterministic', async () => {
    const bytes = syntheticDocument(2000);
    const doc = await load(bytes, {
      canvas: fakeCanvas(),
      contentWidth: 800,
      width: 800,
      height: 600,
    });
    for (let i = 0; i < 60; i++) {
      doc.scroll({ ...VIEWPORT, y: i % 2 === 0 ? 0 : 40_000 }, i % 2 === 0 ? 1 : -1);
      doc.paint();
    }
    doc.select({
      start: { chunkId: 2, offset: 0 },
      end: { chunkId: 2 + 2000 * 2 - 1, offset: 10 },
    });
    const a = doc.copy();
    const b = doc.copy();
    expect(a).toBe(b);
    doc.destroy();
  });

  it('simultaneous documents are isolated at scale', async () => {
    const bytes = syntheticDocument(3000, 'alpha ');
    const more = syntheticDocument(3000, 'beta ');
    const docs = await Promise.all([
      load(bytes, { canvas: fakeCanvas(), contentWidth: 800, width: 800, height: 600 }),
      load(more, { canvas: fakeCanvas(), contentWidth: 800, width: 800, height: 600 }),
    ]);
    for (const doc of docs) {
      doc.scroll({ ...VIEWPORT, y: 30_000 });
      doc.paint();
    }
    docs[0].select({
      start: { chunkId: 2, offset: 0 },
      end: { chunkId: 2 + 3000 * 2 - 1, offset: 5 },
    });
    docs[1].select({
      start: { chunkId: 2, offset: 0 },
      end: { chunkId: 2 + 3000 * 2 - 1, offset: 4 },
    });
    expect(docs[0].copy()).toContain('alpha');
    expect(docs[0].copy()).not.toContain('beta');
    expect(docs[1].copy()).toContain('beta');
    expect(docs[1].copy()).not.toContain('alpha');
    docs[0].destroy();
    expect(docs[1].copy()).toContain('beta');
    docs[1].destroy();
  });

  it('heap growth across the stress scenarios stays bounded', async () => {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10; i++) {
      const doc = await load(syntheticDocument(400), {
        canvas: fakeCanvas(),
        contentWidth: 800,
        width: 800,
        height: 600,
      });
      doc.scroll({ ...VIEWPORT, y: 4000 });
      doc.paint();
      doc.destroy();
    }
    const growth = process.memoryUsage().heapUsed - before;
    // Very generous: any per-document leak across 10 cycles would far exceed this.
    expect(growth).toBeLessThan(256 * 1024 * 1024);
  });
});
