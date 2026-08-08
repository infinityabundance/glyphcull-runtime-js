//! Layout engine tests: full-document layout of the golden package, the
//! sequential frontier, lists, code blocks, determinism, and geometry.

import { describe, expect, it } from 'vitest';
import { buildDocument } from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind, ListStyle } from '../../src/format/sections.js';
import { LayoutEngine, listMarkerText } from '../../src/layout/layout.js';
import { lineStartShift, measureRun } from '../../src/layout/measure.js';
import { pipelineGolden } from '../testkit/fixtures.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';

async function goldenEngine(opts: { contentWidth?: number } = {}) {
  const parsed = await readPackage(pipelineGolden());
  if (!parsed.ok) throw parsed.error;
  const model = buildDocument(parsed.value);
  if (!model.ok) throw model.error;
  return new LayoutEngine(model.value, { dpr: 1, contentWidth: opts.contentWidth ?? 800 });
}

describe('LayoutEngine', () => {
  it('lays out the whole golden document with increasing y positions', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    expect(engine.frontierExhausted).toBe(true);
    const records = [...engine.recordsAll().values()].sort((a, b) => a.y - b.y);
    expect(records.length).toBeGreaterThan(0);
    let prevY = -1;
    for (const record of records) {
      expect(record.y).toBeGreaterThanOrEqual(prevY);
      prevY = record.y;
      expect(Number.isFinite(record.w)).toBe(true);
      expect(record.h).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces text lines with glyph instances for paragraphs', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const paragraph = [...engine.recordsAll().values()].find(
      (r) => r.kind === ChunkKind.Paragraph && r.lines.length > 0,
    );
    expect(paragraph).toBeDefined();
    expect(paragraph!.lines.length).toBeGreaterThan(0);
    for (const line of paragraph!.lines) {
      expect(line.glyphs.length).toBeGreaterThan(0);
      expect(line.baseline).toBeGreaterThan(line.y);
      for (const glyph of line.glyphs) {
        expect(Number.isFinite(glyph.x)).toBe(true);
        expect(Number.isFinite(glyph.y)).toBe(true);
        expect(glyph.atlasId).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('lays out the heading with a single line near the top', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const heading = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Heading1);
    expect(heading).toBeDefined();
    expect(heading!.lines.length).toBe(1);
    // The heading's margin-top offsets it from the document origin.
    expect(heading!.y).toBeGreaterThanOrEqual(0);
    expect(heading!.y).toBeLessThan(50);
    // The heading text is 'Golden'.
    const text = heading!.lines[0]!.runs.map((r) => r.text).join('');
    expect(text).toBe('Golden');
  });

  it('Phase G: the first glyph of the first line starts inside the viewport', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const firstRecord = [...engine.recordsAll().values()]
      .filter((r) => r.lines.length > 0)
      .sort((a, b) => a.y - b.y)[0]!;
    const firstLine = firstRecord.lines[0]!;
    expect(firstLine.glyphs.length).toBeGreaterThan(0);
    const first = firstLine.glyphs[0]!;
    // The glyph pen (advance origin) is at or right of the line origin.
    expect(first.x).toBeGreaterThanOrEqual(0);
    // The ink (bearing applied) is inside the viewport: never clipped left.
    expect(first.x).toBeLessThan(100);
  });

  it('Phase G: lineStartShift guards negative left bearings and ignores positive ones', () => {
    // Positive / zero bearings: no shift (the ink starts at or right of the pen).
    expect(lineStartShift(0.05, 192)).toBe(0);
    expect(lineStartShift(0, 192)).toBe(0);
    // Negative bearing: the ink would start left of the pen; the shift is the
    // overhang plus one document pixel of anti-aliasing margin.
    expect(lineStartShift(-0.1, 192)).toBeCloseTo(0.1 * 192 + 1, 6);
    expect(lineStartShift(-0.05, 96)).toBeCloseTo(0.05 * 96 + 1, 6);
    // Scale dependence: the overhang grows with the font size.
    expect(lineStartShift(-0.1, 384)).toBeGreaterThan(lineStartShift(-0.1, 192));
  });

  it('frontier: extendTo lays out only the blocks needed to cover the viewport', async () => {
    const engine = await goldenEngine();
    engine.extendTo(50); // cover only the top 50px
    expect(engine.frontierExhausted).toBe(false);
    const before = engine.recordsAll().size;
    engine.extendTo(10_000);
    expect(engine.recordsAll().size).toBeGreaterThan(before);
    expect(engine.frontierExhausted).toBe(true);
  });

  it('materialize is idempotent and advances the frontier once', async () => {
    const engine = await goldenEngine();
    const first = engine.nextFrontierBlock();
    expect(first).toBeDefined();
    const a = engine.materialize(first!);
    const b = engine.materialize(first!);
    expect(a).toBe(b);
    expect(engine.nextFrontierBlock()).not.toBe(first);
  });

  it('exposes run geometry for visibility and hit testing', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const paragraph = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Paragraph);
    expect(paragraph).toBeDefined();
    const runChunkId = paragraph!.lines[0]!.runs[0]!.chunkId;
    const rect = engine.rect(runChunkId);
    expect(rect).toBeDefined();
    expect(rect!.w).toBeGreaterThan(0);
    expect(rect!.h).toBeGreaterThan(0);
  });

  it('lists produce markers', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const items = [...engine.recordsAll().values()].filter((r) => r.kind === ChunkKind.ListItem);
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.marker).toBeDefined();
      expect(item.children.length).toBe(1); // the implicit paragraph
      expect(item.children[0]!.kind).toBe(ChunkKind.Paragraph);
      expect(item.children[0]!.lines[0]!.runs.length).toBeGreaterThan(0);
    }
  });

  it('code blocks are preformatted (no wrapping)', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const code = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.CodeBlock);
    expect(code).toBeDefined();
    // 'code block\n' splits into two preformatted lines (the trailing newline
    // is preserved verbatim); the first carries the text.
    expect(code!.lines.length).toBe(2);
    expect(code!.lines[0]!.runs[0]!.text).toBe('code block');
    expect(code!.lines[0]!.ratio).toBe(0);
    // Every line is a single (non-wrapped) run.
    for (const line of code!.lines) {
      expect(line.runs.length).toBeLessThanOrEqual(1);
    }
  });

  it('quotes indent their children', async () => {
    const engine = await goldenEngine();
    engine.extendTo(Number.POSITIVE_INFINITY);
    const quote = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Quote);
    expect(quote).toBeDefined();
    expect(quote!.children.length).toBeGreaterThan(0);
    expect(quote!.children[0]!.x).toBeGreaterThan(quote!.x);
  });

  it('is deterministic: identical input yields identical layouts', async () => {
    const a = await goldenEngine();
    const b = await goldenEngine();
    a.extendTo(Number.POSITIVE_INFINITY);
    b.extendTo(Number.POSITIVE_INFINITY);
    expect([...a.recordsAll().entries()]).toEqual([...b.recordsAll().entries()]);
  });

  it('sizes table columns from the natural width of the cell text (per-run)', async () => {
    // A 2×2 table whose cells wrap their text in paragraph → run chunks (the
    // normal compiled shape). Column widths must come from the measured text,
    // not the two-em floor that a direct-text-only probe would produce.
    const chunks = chnkPayload([
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
        firstChildId: 7,
        lastChildId: 8,
        depth: 2,
      },
      {
        id: 5,
        kind: ChunkKind.TableCell,
        parentId: 3,
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
        firstChildId: 10,
        lastChildId: 10,
        depth: 3,
      },
      {
        id: 7,
        kind: ChunkKind.TableCell,
        parentId: 4,
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
    ]);
    // The synthetic package reuses the pipeline golden's GLYF section so the
    // default font atlas exists and text can actually be measured.
    const goldenParsed = await readPackage(pipelineGolden());
    if (!goldenParsed.ok) throw goldenParsed.error;
    const glyf = goldenParsed.value.section(5)!;
    const bytes = buildPackage([
      {
        kind: 1,
        compression: 1,
        payload: infoPayload({
          atlas_count: 3,
          chunk_count: 16,
          style_count: 1,
          content_count: 4,
        }),
      },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { kind: 4, compression: 1, payload: contPayload(['alpha', 'beta', 'gamma', 'delta']) },
      { kind: 5, compression: 0, payload: glyf },
    ]);
    const parsed = await readPackage(bytes);
    if (!parsed.ok) throw parsed.error;
    const model = buildDocument(parsed.value);
    if (!model.ok) throw model.error;
    const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
    engine.extendTo(Number.POSITIVE_INFINITY);
    const table = [...engine.recordsAll().values()].find((r) => r.kind === ChunkKind.Table);
    expect(table).toBeDefined();
    const columns = table!.table!.columns;
    expect(columns.length).toBe(2);
    // "gamma" (5 chars) is the widest first-column cell: the column is its
    // measured natural width — far above the 32px two-em floor of the old
    // direct-text-only probe.
    const defaultStyle = model.value.styles[0]!;
    const atlas = model.value.atlases[defaultStyle.fontId];
    expect(atlas).toBeDefined();
    const gamma = measureRun(atlas!, 'gamma', defaultStyle.fontSizePx, defaultStyle.letterSpacing);
    // Above the old two-em floor (32px at 16px text) and exactly the
    // measured natural width of the widest cell.
    expect(columns[0]!).toBeGreaterThan(32);
    expect(columns[0]!).toBeCloseTo(gamma.widthPx, 0);
    // The table spans exactly its columns (no scale applied at 800px).
    expect(table!.w).toBeCloseTo(
      columns.reduce((a, b) => a + b, 0),
      3,
    );
    // The widest bar-like run is on one line: the gamma paragraph has a
    // single line whose width fits the column.
    const cell7 = [...engine.recordsAll().values()].find((r) => r.chunkId === 7);
    const para11 = [...engine.recordsAll().values()].find((r) => r.chunkId === 11);
    expect(cell7).toBeDefined();
    expect(para11).toBeDefined();
    for (const line of para11!.lines) {
      expect(line.width).toBeLessThanOrEqual(columns[0]! + 0.5);
    }
  });
});

describe('listMarkerText', () => {
  it('renders disc/circle/square and counters', () => {
    expect(listMarkerText(ListStyle.Disc, 1)).toBe('\u2022');
    expect(listMarkerText(ListStyle.Circle, 1)).toBe('\u25e6');
    expect(listMarkerText(ListStyle.Square, 1)).toBe('\u25aa');
    expect(listMarkerText(ListStyle.Decimal, 3)).toBe('3.');
    expect(listMarkerText(ListStyle.LowerAlpha, 1)).toBe('a.');
    expect(listMarkerText(ListStyle.LowerAlpha, 27)).toBe('aa.');
    expect(listMarkerText(ListStyle.UpperAlpha, 2)).toBe('B.');
    expect(listMarkerText(ListStyle.LowerRoman, 4)).toBe('iv.');
    expect(listMarkerText(ListStyle.LowerRoman, 9)).toBe('ix.');
    expect(listMarkerText(ListStyle.UpperRoman, 49)).toBe('XLIX.');
    expect(listMarkerText(ListStyle.None, 1)).toBe('');
  });
});
