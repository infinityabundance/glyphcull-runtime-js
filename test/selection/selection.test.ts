//! Selection tests (TESTING.md §2 unit/selection): hit testing at glyph
//! boundaries, position ordering/normalization, range→quad projection with
//! per-line merging, and the copy extraction policy (paragraphs → newlines,
//! table cells → tabs, rows → newlines) over the golden and synthetic
//! packages. Selection is logical — every function is pure and deterministic.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildDocument } from '../../src/document/model.js';
import type { DocumentModel } from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind } from '../../src/format/sections.js';
import { LayoutEngine } from '../../src/layout/layout.js';
import {
  comparePositions,
  copyText,
  hitTestPoint,
  isCollapsed,
  normalizeSelection,
  rangeQuads,
} from '../../src/selection/selection.js';
import type { Selection, TextPosition } from '../../src/selection/selection.js';
import { pipelineGolden } from '../testkit/fixtures.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';

/** A fully laid-out golden document. */
async function goldenSetup(): Promise<{ doc: DocumentModel; engine: LayoutEngine }> {
  const parsed = await readPackage(pipelineGolden());
  if (!parsed.ok) throw parsed.error;
  const model = buildDocument(parsed.value);
  if (!model.ok) throw model.error;
  const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
  engine.extendTo(Number.POSITIVE_INFINITY);
  return { doc: model.value, engine };
}

/** Build a document from sections (single default style). */
async function documentFrom(
  chunks: Parameters<typeof chnkPayload>[0],
  opts: { texts?: string[] } = {},
) {
  const bytes = buildPackage([
    {
      kind: 1,
      compression: 1,
      payload: infoPayload({
        chunk_count: chunks.length,
        style_count: 1,
        content_count: opts.texts?.length ?? 0,
      }),
    },
    { kind: 2, compression: 1, payload: chnkPayload(chunks) },
    { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    { kind: 4, compression: 1, payload: contPayload(opts.texts ?? []) },
  ]);
  const parsed = await readPackage(bytes);
  if (!parsed.ok) throw parsed.error;
  const model = buildDocument(parsed.value);
  if (!model.ok) throw model.error;
  return model.value;
}

const pos = (chunkId: number, offset: number): TextPosition => ({ chunkId, offset });

describe('positions and ordering', () => {
  it('orders by document order, then offset', async () => {
    const { doc } = await goldenSetup();
    expect(comparePositions(doc, pos(3, 3), pos(3, 5))).toBe(-1);
    expect(comparePositions(doc, pos(3, 5), pos(3, 3))).toBe(1);
    expect(comparePositions(doc, pos(3, 4), pos(3, 4))).toBe(0);
    // Runs are document-order leaves: run 3 (heading) precedes run 5.
    expect(comparePositions(doc, pos(3, 6), pos(5, 0))).toBe(-1);
    expect(comparePositions(doc, pos(22, 0), pos(3, 0))).toBe(1);
  });

  it('property: comparison is antisymmetric', async () => {
    const { doc } = await goldenSetup();
    fc.assert(
      fc.property(
        fc.record({
          chunkId: fc.integer({ min: 1, max: 22 }),
          offset: fc.integer({ min: 0, max: 20 }),
        }),
        fc.record({
          chunkId: fc.integer({ min: 1, max: 22 }),
          offset: fc.integer({ min: 0, max: 20 }),
        }),
        (a, b) => comparePositions(doc, a, b) === -comparePositions(doc, b, a),
      ),
    );
  });

  it('normalizeSelection orders reversed anchors', async () => {
    const { doc } = await goldenSetup();
    const a = pos(3, 1);
    const b = pos(22, 4);
    expect(normalizeSelection(doc, a, b)).toEqual({ start: a, end: b });
    expect(normalizeSelection(doc, b, a)).toEqual({ start: a, end: b });
  });

  it('isCollapsed only for identical positions', () => {
    expect(isCollapsed({ start: pos(3, 2), end: pos(3, 2) })).toBe(true);
    expect(isCollapsed({ start: pos(3, 2), end: pos(3, 3) })).toBe(false);
  });
});

describe('hitTestPoint', () => {
  it('hits the nearest glyph center', async () => {
    const { engine } = await goldenSetup();
    const heading = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Heading1)!;
    const line = heading.lines[0]!;
    for (const glyph of line.glyphs) {
      if (glyph.markOf !== undefined) continue;
      // A point in the glyph's left half lands on the glyph itself.
      const hit = hitTestPoint(engine, { x: glyph.x + glyph.advancePx * 0.25, y: glyph.y });
      expect(hit).toEqual({ chunkId: glyph.runChunkId, offset: glyph.offsetInText });
    }
  });

  it('bounds: before the first glyph and after the last glyph of a line', async () => {
    const { engine } = await goldenSetup();
    const heading = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Heading1)!;
    const line = heading.lines[0]!;
    const first = line.glyphs[0]!;
    const last = line.glyphs[line.glyphs.length - 1]!;
    expect(hitTestPoint(engine, { x: first.x - 10, y: line.baseline })).toEqual({
      chunkId: first.runChunkId,
      offset: 0,
    });
    expect(hitTestPoint(engine, { x: last.x + last.advancePx + 10, y: line.baseline })).toEqual({
      chunkId: last.runChunkId,
      offset: last.offsetInText + 1,
    });
  });

  it('boundary: exactly at a glyph center lands after that glyph', async () => {
    const { engine } = await goldenSetup();
    const heading = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Heading1)!;
    const line = heading.lines[0]!;
    const first = line.glyphs[0]!;
    const center = first.x + first.advancePx / 2;
    expect(hitTestPoint(engine, { x: center - 0.1, y: line.baseline })).toEqual({
      chunkId: first.runChunkId,
      offset: first.offsetInText,
    });
    expect(hitTestPoint(engine, { x: center, y: line.baseline })).toEqual({
      chunkId: first.runChunkId,
      offset: first.offsetInText + 1,
    });
  });

  it('clamps vertically to the nearest line (above and below the document)', async () => {
    const { engine } = await goldenSetup();
    const records = [...engine.recordsAll().values()].sort((a, b) => a.y - b.y);
    const firstLine = records.find((r) => r.lines.length > 0)!.lines[0]!;
    const lastRecord = records[records.length - 1]!;
    const lastLine = lastRecord.lines[lastRecord.lines.length - 1]!;
    expect(hitTestPoint(engine, { x: firstLine.baseline, y: -1000 })?.chunkId).toBe(
      firstLine.glyphs[0]!.runChunkId,
    );
    expect(hitTestPoint(engine, { x: lastLine.runs[0]!.x, y: 1_000_000 })?.chunkId).toBe(
      lastLine.glyphs[lastLine.glyphs.length - 1]!.runChunkId,
    );
  });

  it('returns undefined for a document without text', async () => {
    const doc = await documentFrom([{ id: 1, kind: ChunkKind.Document, flags: 1 << 4 }]);
    const engine = new LayoutEngine(doc, { dpr: 1, contentWidth: 800 });
    engine.extendTo(Number.POSITIVE_INFINITY);
    expect(hitTestPoint(engine, { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('rangeQuads', () => {
  it('a collapsed selection yields no quads', async () => {
    const { engine } = await goldenSetup();
    const selection = normalizeSelection(engine.document, pos(3, 2), pos(3, 2));
    expect(rangeQuads(engine, selection)).toEqual([]);
  });

  it('a full-line selection produces one merged quad per line', async () => {
    const { engine } = await goldenSetup();
    const heading = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Heading1)!;
    const line = heading.lines[0]!;
    const selection: Selection = { start: pos(3, 0), end: pos(3, 6) };
    const quads = rangeQuads(engine, selection);
    expect(quads).toHaveLength(1);
    const quad = quads[0]!;
    expect(quad.y).toBeCloseTo(line.y, 6);
    expect(quad.h).toBeCloseTo(line.heightPx, 6);
    // The quad spans the run: from the first glyph to the last glyph's end.
    const first = line.glyphs[0]!;
    const last = line.glyphs[line.glyphs.length - 1]!;
    expect(quad.x).toBeCloseTo(first.x, 6);
    expect(quad.x + quad.w).toBeCloseTo(last.x + last.advancePx, 6);
  });

  it('a partial selection clips to the covered glyphs', async () => {
    const { engine } = await goldenSetup();
    const paragraph = [...engine.recordsAll().values()].find(
      (r) => r.kind === ChunkKind.Paragraph && r.lines.length > 0,
    )!;
    const line = paragraph.lines[0]!;
    const run = line.runs[0]!; // 'Deterministic' (chunk 5, chars 0-12)
    const selection: Selection = { start: pos(run.chunkId, 2), end: pos(run.chunkId, 5) };
    const quads = rangeQuads(engine, selection);
    expect(quads.length).toBeGreaterThanOrEqual(1);
    const quad = quads[0]!;
    expect(quad.w).toBeGreaterThan(0);
    expect(quad.w).toBeLessThan(run.width);
    expect(quad.x).toBeGreaterThanOrEqual(run.x);
    expect(quad.x + quad.w).toBeLessThanOrEqual(run.x + run.width + 0.5);
  });

  it('spans multiple blocks in document order', async () => {
    const { engine } = await goldenSetup();
    // From the start of the heading to the end of the quote.
    const selection: Selection = { start: pos(3, 0), end: pos(22, 5) };
    const quads = rangeQuads(engine, selection);
    expect(quads.length).toBeGreaterThan(1);
    for (let i = 1; i < quads.length; i++) {
      expect(quads[i]!.y).toBeGreaterThanOrEqual(quads[i - 1]!.y);
    }
  });

  it('merges adjacent styled runs of one line into a single quad', async () => {
    const { engine } = await goldenSetup();
    const paragraph = [...engine.recordsAll().values()].find(
      (r) => r.kind === ChunkKind.Paragraph && r.lines.length > 0,
    )!;
    // The whole paragraph text: all runs of all its lines.
    const firstRun = paragraph.lines[0]!.runs[0]!;
    const lastLine = paragraph.lines[paragraph.lines.length - 1]!;
    const lastRun = lastLine.runs[lastLine.runs.length - 1]!;
    const selection: Selection = {
      start: pos(firstRun.chunkId, firstRun.start),
      end: pos(lastRun.chunkId, lastRun.end),
    };
    const quads = rangeQuads(engine, selection);
    expect(quads).toHaveLength(paragraph.lines.length);
    for (const quad of quads) expect(quad.w).toBeGreaterThan(0);
  });

  it('is deterministic', async () => {
    const { engine } = await goldenSetup();
    const selection: Selection = { start: pos(3, 1), end: pos(22, 3) };
    expect(rangeQuads(engine, selection)).toEqual(rangeQuads(engine, selection));
  });
});

describe('copyText', () => {
  it('copies a single run (the heading)', async () => {
    const { doc } = await goldenSetup();
    expect(copyText(doc, { start: pos(3, 0), end: pos(3, 6) })).toBe('Golden');
  });

  it('copies a partial run slice', async () => {
    const { doc } = await goldenSetup();
    expect(copyText(doc, { start: pos(3, 1), end: pos(3, 4) })).toBe('old');
  });

  it('joins styled runs of a paragraph without separators', async () => {
    const { doc } = await goldenSetup();
    expect(copyText(doc, { start: pos(5, 0), end: pos(11, 1) })).toBe(
      'Deterministic golden fixture with a link.',
    );
  });

  it('separates blocks with newlines, preserving document order', async () => {
    const { doc } = await goldenSetup();
    expect(copyText(doc, { start: pos(3, 0), end: pos(22, 5) })).toBe(
      'Golden\nDeterministic golden fixture with a link.\none\ntwo\ncode block\n\nquote',
    );
  });

  it('a collapsed selection copies the empty string', async () => {
    const { doc } = await goldenSetup();
    expect(copyText(doc, { start: pos(3, 2), end: pos(3, 2) })).toBe('');
  });

  it('table policy: cells → tabs within a row, rows → newlines', async () => {
    const chunks = [
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      {
        id: 2,
        kind: ChunkKind.Table,
        flags: 1 << 4,
        parentId: 1,
        firstChildId: 3,
        lastChildId: 4,
        depth: 1,
      },
      {
        id: 3,
        kind: ChunkKind.TableRow,
        flags: 1 << 4,
        parentId: 2,
        prevId: 0,
        nextId: 4,
        firstChildId: 5,
        lastChildId: 6,
        depth: 2,
      },
      {
        id: 4,
        kind: ChunkKind.TableRow,
        flags: 1 << 4,
        parentId: 2,
        prevId: 3,
        nextId: 0,
        firstChildId: 7,
        lastChildId: 8,
        depth: 2,
      },
      {
        id: 5,
        kind: ChunkKind.TableCell,
        parentId: 3,
        prevId: 0,
        nextId: 6,
        firstChildId: 9,
        lastChildId: 9,
        depth: 3,
      },
      {
        id: 6,
        kind: ChunkKind.TableCell,
        parentId: 3,
        prevId: 5,
        nextId: 0,
        firstChildId: 10,
        lastChildId: 10,
        depth: 3,
      },
      {
        id: 7,
        kind: ChunkKind.TableCell,
        parentId: 4,
        prevId: 0,
        nextId: 8,
        firstChildId: 11,
        lastChildId: 11,
        depth: 3,
      },
      {
        id: 8,
        kind: ChunkKind.TableCell,
        parentId: 4,
        prevId: 7,
        nextId: 0,
        firstChildId: 12,
        lastChildId: 12,
        depth: 3,
      },
      {
        id: 9,
        kind: ChunkKind.Paragraph,
        parentId: 5,
        firstChildId: 13,
        lastChildId: 13,
        depth: 4,
      },
      {
        id: 10,
        kind: ChunkKind.Paragraph,
        parentId: 6,
        firstChildId: 14,
        lastChildId: 14,
        depth: 4,
      },
      {
        id: 11,
        kind: ChunkKind.Paragraph,
        parentId: 7,
        firstChildId: 15,
        lastChildId: 15,
        depth: 4,
      },
      {
        id: 12,
        kind: ChunkKind.Paragraph,
        parentId: 8,
        firstChildId: 16,
        lastChildId: 16,
        depth: 4,
      },
      { id: 13, kind: ChunkKind.Run, parentId: 9, contentIndex: 1, depth: 5 },
      { id: 14, kind: ChunkKind.Run, parentId: 10, contentIndex: 2, depth: 5 },
      { id: 15, kind: ChunkKind.Run, parentId: 11, contentIndex: 3, depth: 5 },
      { id: 16, kind: ChunkKind.Run, parentId: 12, contentIndex: 4, depth: 5 },
    ];
    const doc = await documentFrom(chunks, { texts: ['a', 'b', 'c', 'd'] });
    expect(copyText(doc, { start: pos(13, 0), end: pos(14, 1) })).toBe('a\tb');
    expect(copyText(doc, { start: pos(13, 0), end: pos(15, 1) })).toBe('a\tb\nc');
    expect(copyText(doc, { start: pos(13, 0), end: pos(16, 1) })).toBe('a\tb\nc\td');
  });

  it('br chunks copy as explicit newlines', async () => {
    const chunks = [
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Paragraph, parentId: 1, firstChildId: 3, lastChildId: 5, depth: 1 },
      { id: 3, kind: ChunkKind.Run, parentId: 2, prevId: 0, nextId: 4, contentIndex: 1, depth: 2 },
      { id: 4, kind: ChunkKind.Br, parentId: 2, prevId: 3, nextId: 5, depth: 2 },
      { id: 5, kind: ChunkKind.Run, parentId: 2, prevId: 4, nextId: 0, contentIndex: 2, depth: 2 },
    ];
    const doc = await documentFrom(chunks, { texts: ['before', 'after'] });
    expect(copyText(doc, { start: pos(3, 0), end: pos(5, 5) })).toBe('before\nafter');
  });

  it('property: copying a block equals its laid-out run texts', async () => {
    const { doc, engine } = await goldenSetup();
    for (const record of engine.recordsAll().values()) {
      if (record.lines.length === 0) continue;
      // The last text-bearing line (a code block's final empty line has no runs).
      const lastLine = [...record.lines].reverse().find((l) => l.runs.length > 0);
      if (lastLine === undefined) continue;
      const firstRun = record.lines[0]!.runs[0]!;
      const lastRun = lastLine.runs[lastLine.runs.length - 1]!;
      const selection: Selection = {
        start: pos(firstRun.chunkId, firstRun.start),
        end: pos(lastRun.chunkId, lastRun.end),
      };
      // Copying a block's full span yields its run texts joined (paragraph
      // boundaries inside the block are implicit — soft line breaks carry the
      // source spaces; a trailing source newline is not a laid-out run).
      const expected = record.lines.flatMap((l) => l.runs.map((r) => r.text)).join('');
      expect(copyText(doc, selection)).toBe(expected);
    }
  });

  it('property: copying is deterministic for random selections', async () => {
    const { doc } = await goldenSetup();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 22 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 22 }),
        fc.integer({ min: 0, max: 20 }),
        (a, b, c, d) => {
          const selection = normalizeSelection(doc, pos(a, b), pos(c, d));
          expect(copyText(doc, selection)).toBe(copyText(doc, selection));
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
