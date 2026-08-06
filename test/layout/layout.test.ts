//! Layout engine tests: full-document layout of the golden package, the
//! sequential frontier, lists, code blocks, determinism, and geometry.

import { describe, expect, it } from 'vitest';
import { buildDocument } from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind, ListStyle } from '../../src/format/sections.js';
import { LayoutEngine, listMarkerText } from '../../src/layout/layout.js';
import { pipelineGolden } from '../testkit/fixtures.js';

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
