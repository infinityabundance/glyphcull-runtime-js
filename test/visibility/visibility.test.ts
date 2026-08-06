//! Visibility system tests: geometric + semantic culling, the frontier,
//! determinism, and the responsibility boundary (culling never mutates).

import { describe, expect, it } from 'vitest';
import { buildDocument } from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind } from '../../src/format/sections.js';
import {
  computeVisibleSet,
  expandedViewport,
  intersects,
} from '../../src/visibility/visibility.js';
import type { Rect, Viewport } from '../../src/visibility/visibility.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';

/** Build a document: root with N paragraphs (plus an optional hidden one). */
async function docWithParagraphs(count: number, opts: { hiddenIds?: number[] } = {}) {
  const hiddenIds = opts.hiddenIds ?? [];
  const chunks = chnkPayload([
    {
      id: 1,
      kind: ChunkKind.Document,
      flags: 1 << 4,
      firstChildId: 2,
      lastChildId: count + 1,
    },
    ...Array.from({ length: count }, (_, i) => {
      const id = i + 2;
      return {
        id,
        kind: ChunkKind.Paragraph,
        parentId: 1,
        prevId: i === 0 ? 0 : id - 1,
        nextId: i === count - 1 ? 0 : id + 1,
        firstChildId: 0,
        lastChildId: 0,
        contentIndex: 1,
        depth: 1,
        flags: hiddenIds.includes(id) ? 1 : 0,
      };
    }),
  ]);
  const bytes = buildPackage([
    {
      kind: 1,
      compression: 1,
      payload: infoPayload({ chunk_count: count + 1, style_count: 1, content_count: 1 }),
    },
    { kind: 2, compression: 1, payload: chunks },
    { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    { kind: 4, compression: 1, payload: contPayload(['x']) },
  ]);
  const parsed = await readPackage(bytes);
  if (!parsed.ok) throw parsed.error;
  const model = buildDocument(parsed.value);
  if (!model.ok) throw model.error;
  return model.value;
}

/** A geometry source: every chunk at a fixed horizontal strip. */
function geometryAt(ys: Record<number, Rect>): { rect: (id: number) => Rect | undefined } {
  return { rect: (id) => ys[id] };
}

describe('geometric culling', () => {
  it('reports exactly the chunks whose rects intersect the viewport', async () => {
    const doc = await docWithParagraphs(5);
    // Paragraphs at y = 0, 100, 200, 300, 400 (h = 50).
    const ys: Record<number, Rect> = {};
    for (let i = 0; i < 5; i++) {
      ys[i + 2] = { x: 0, y: i * 100, w: 400, h: 50 };
    }
    const viewport: Viewport = { x: 0, y: 125, w: 400, h: 100 };
    const result = computeVisibleSet(doc, geometryAt(ys), viewport, 0);
    // y=100 (100..150), y=200 (200..250) intersect 125..225.
    expect(result.visible).toEqual([1, 3, 4]);
    expect(result.hidden).toEqual([]);
    expect(result.notYetVisible).toEqual([]);
  });

  it('the margin expands the viewport', async () => {
    const doc = await docWithParagraphs(3);
    const ys: Record<number, Rect> = {
      2: { x: 0, y: 0, w: 400, h: 50 },
      3: { x: 0, y: 100, w: 400, h: 50 },
      4: { x: 0, y: 200, w: 400, h: 50 },
    };
    const viewport: Viewport = { x: 0, y: 60, w: 400, h: 50 };
    // Without margin: only y=100 intersects. With margin 60: y=0 also.
    const tight = computeVisibleSet(doc, geometryAt(ys), viewport, 0);
    expect(tight.visible).toEqual([1, 3]);
    const loose = computeVisibleSet(doc, geometryAt(ys), viewport, 60);
    expect(loose.visible).toEqual([1, 2, 3]);
  });

  it('intersection is inclusive of shared edges', () => {
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const b: Rect = { x: 10, y: 5, w: 10, h: 10 };
    expect(intersects(a, b)).toBe(false); // edges only touch
    const c: Rect = { x: 9, y: 5, w: 10, h: 10 };
    expect(intersects(a, c)).toBe(true);
  });

  it('expandedViewport grows on every side', () => {
    const viewport: Viewport = { x: 10, y: 20, w: 100, h: 50 };
    expect(expandedViewport(viewport, 5)).toEqual({ x: 5, y: 15, w: 110, h: 60 });
  });
});

describe('semantic culling', () => {
  it('excludes hidden chunks and their whole subtree', async () => {
    const doc = await docWithParagraphs(3, { hiddenIds: [3] });
    const ys: Record<number, Rect> = {
      2: { x: 0, y: 0, w: 400, h: 50 },
      3: { x: 0, y: 100, w: 400, h: 50 },
      4: { x: 0, y: 200, w: 400, h: 50 },
    };
    const viewport: Viewport = { x: 0, y: 0, w: 400, h: 300 };
    const result = computeVisibleSet(doc, geometryAt(ys), viewport, 0);
    expect(result.hidden).toEqual([3]);
    expect(result.visible).toEqual([1, 2, 4]);
  });
});

describe('materialization frontier', () => {
  it('chunks without geometry are not-yet-visible, never absent', async () => {
    const doc = await docWithParagraphs(3);
    // Only the first paragraph is materialized.
    const ys: Record<number, Rect> = {
      2: { x: 0, y: 0, w: 400, h: 50 },
    };
    const viewport: Viewport = { x: 0, y: 0, w: 400, h: 300 };
    const result = computeVisibleSet(doc, geometryAt(ys), viewport, 0);
    expect(result.visible).toEqual([1, 2]);
    expect(result.notYetVisible).toEqual([3, 4]);
    // They are not hidden and not visible.
    expect(result.hidden).toEqual([]);
  });
});

describe('determinism and boundary', () => {
  it('is a pure function: identical inputs give identical outputs', async () => {
    const doc = await docWithParagraphs(4);
    const ys: Record<number, Rect> = {};
    for (let i = 0; i < 4; i++) ys[i + 2] = { x: 0, y: i * 80, w: 400, h: 40 };
    const viewport: Viewport = { x: 0, y: 100, w: 400, h: 120 };
    const a = computeVisibleSet(doc, geometryAt(ys), viewport, 10);
    const b = computeVisibleSet(doc, geometryAt(ys), viewport, 10);
    expect(a).toEqual(b);
  });

  it('never mutates the geometry source or the document (read-only boundary)', async () => {
    const doc = await docWithParagraphs(3);
    const ys: Record<number, Rect> = {
      2: { x: 0, y: 0, w: 400, h: 50 },
      3: { x: 0, y: 100, w: 400, h: 50 },
      4: { x: 0, y: 200, w: 400, h: 50 },
    };
    let reads = 0;
    const geometry = {
      rect: (id: number): Rect | undefined => {
        reads++;
        return ys[id];
      },
    };
    const docSnapshot = JSON.stringify(doc.chunks);
    const ysSnapshot = JSON.stringify(ys);
    computeVisibleSet(doc, geometry, { x: 0, y: 0, w: 400, h: 200 }, 0);
    expect(JSON.stringify(doc.chunks)).toBe(docSnapshot);
    expect(JSON.stringify(ys)).toBe(ysSnapshot);
    expect(reads).toBe(4); // root + 3 paragraphs (root has no rect: 1 read per chunk)
  });
});
