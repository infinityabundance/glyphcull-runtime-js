//! Runtime benchmarks (TESTING.md §2 performance): the committed suite for
//! load, first paint, sustained scroll frame time, materialization
//! throughput, and copy. CI runs `bench:smoke` (a single run reporting
//! absolute numbers); full runs compare ratios locally. Node has no GPU
//! surfaces, so the renderers report a lost context and paint measures the
//! pipeline up to the draw list — the browser harness benchmarks the GPU
//! path separately.

import { bench, describe } from 'vitest';
import { readPackage } from '../src/format/reader.js';
import { buildDocument } from '../src/document/model.js';
import { LayoutEngine } from '../src/layout/layout.js';
import { ChunkKind } from '../src/format/sections.js';
import { load } from '../src/index.js';
import { pipelineGolden } from '../test/testkit/fixtures.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../test/testkit/builder.js';
import { fakeCanvas, stubDom } from '../test/testkit/dom.js';

stubDom();

/** Load the golden and return a ready handle. */
async function goldenHandle() {
  return load(pipelineGolden(), {
    canvas: fakeCanvas(),
    contentWidth: 800,
    width: 800,
    height: 600,
  });
}

/** A synthetic document of `paragraphs` paragraphs (2 chunks each). */
function bigDocument(paragraphs: number) {
  const chunks = chnkPayload([
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
  const bytes = buildPackage([
    {
      kind: 1,
      compression: 1,
      payload: infoPayload({ chunk_count: chunks.length, style_count: 1, content_count: 1 }),
    },
    { kind: 2, compression: 1, payload: chunks },
    { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    { kind: 4, compression: 1, payload: contPayload(['a'.repeat(160)]) },
  ]);
  return bytes;
}

describe('load', () => {
  bench('load the golden document', async () => {
    const doc = await goldenHandle();
    doc.destroy();
  });
});

describe('paint', () => {
  bench('first paint after load', async () => {
    const doc = await goldenHandle();
    doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    doc.paint();
    doc.destroy();
  });

  bench('paint a steady frame', async () => {
    const doc = await goldenHandle();
    doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    doc.paint();
    doc.paint();
    doc.destroy();
  });
});

describe('scroll', () => {
  bench('scroll frame (viewport step)', async () => {
    const doc = await goldenHandle();
    for (let y = 0; y < 2000; y += 60) {
      doc.scroll({ x: 0, y, w: 800, h: 600 }, 1);
    }
    doc.destroy();
  });
});

describe('materialization', () => {
  bench('materialize 1000 paragraphs (throughput)', async () => {
    const bytes = bigDocument(1000);
    const doc = await load(bytes, {
      canvas: fakeCanvas(),
      contentWidth: 800,
      width: 800,
      height: 600,
    });
    doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    // Jump to the bottom: the frontier materializes the whole document.
    doc.scroll({ x: 0, y: 200_000, w: 800, h: 600 });
    doc.destroy();
  });
});

describe('layout (reference)', () => {
  bench('lay out the golden document', async () => {
    const parsed = await readPackage(pipelineGolden());
    if (!parsed.ok) throw parsed.error;
    const model = buildDocument(parsed.value);
    if (!model.ok) throw model.error;
    const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
    engine.extendTo(Number.POSITIVE_INFINITY);
  });
});

describe('copy', () => {
  bench('copy the full golden document', async () => {
    const doc = await goldenHandle();
    doc.select({ start: { chunkId: 3, offset: 0 }, end: { chunkId: 22, offset: 5 } });
    doc.copy();
    doc.destroy();
  });
});
