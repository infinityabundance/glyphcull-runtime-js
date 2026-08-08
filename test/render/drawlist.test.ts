//! Draw list tests (TESTING.md §2 unit/render): deterministic construction
//! (double-build byte equality), z-order (selection beneath content,
//! backgrounds before glyphs), command geometry, list-marker emission, and
//! resilience to missing stamps. Draw list tests run in Node against the
//! golden package; the browser harness validates actual pixels.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildDocument } from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind, texelsPerEm } from '../../src/format/sections.js';
import { prepareGlyph } from '../../src/glyphs/cache.js';
import type { GlyphStamp } from '../../src/glyphs/cache.js';
import { LayoutEngine } from '../../src/layout/layout.js';
import type { GlyphInstance } from '../../src/layout/layout.js';
import { DrawListBuilder } from '../../src/render/drawlist.js';
import type { DrawCommand, DrawList, TextureResolver } from '../../src/render/drawlist.js';
import type { SelectionQuad } from '../../src/selection/selection.js';
import { pipelineGolden } from '../testkit/fixtures.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';

/** The selection highlight color the builder emits (fill under content). */
const SELECTION_COLOR = 0x3399ff66;

/** A fully laid-out golden document: engine + block ids in document order. */
async function goldenSetup() {
  const parsed = await readPackage(pipelineGolden());
  if (!parsed.ok) throw parsed.error;
  const model = buildDocument(parsed.value);
  if (!model.ok) throw model.error;
  const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
  engine.extendTo(Number.POSITIVE_INFINITY);
  const visibleIds = [...engine.recordsAll().keys()].sort((a, b) => a - b);
  return { engine, visibleIds };
}

/** A deterministic texture resolver: page (atlasId, pageIndex) and image ids. */
function resolver(): TextureResolver {
  return {
    atlasPage: (atlasId, pageIndex) => atlasId * 100 + pageIndex,
    image: (imageId) => 2000 + imageId,
  };
}

/** The stamps callback: prepare the stamp the cache would own. */
function stampFor(engine: LayoutEngine) {
  return (chunkId: number, glyph: GlyphInstance): GlyphStamp | undefined => {
    void chunkId;
    const atlas = engine.document.atlases[glyph.atlasId];
    if (atlas === undefined) return undefined;
    return prepareGlyph(atlas, glyph.codepoint, glyph.fontSizePx, glyph.color);
  };
}

/** The byte-exact serialization used for determinism comparisons. */
function serialize(list: DrawList): string {
  return JSON.stringify(list.commands);
}

/** Glyph commands only. */
function glyphsOf(list: DrawList): Extract<DrawCommand, { type: 'glyph' }>[] {
  return list.commands.filter(
    (c): c is Extract<DrawCommand, { type: 'glyph' }> => c.type === 'glyph',
  );
}

describe('DrawListBuilder', () => {
  it('is deterministic: double-build byte equality over the full document', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const a = builder.build(engine, visibleIds, stampFor(engine));
    const b = builder.build(engine, visibleIds, stampFor(engine));
    expect(serialize(a)).toBe(serialize(b));
    expect(a.commands.length).toBeGreaterThan(0);
  });

  it('emits selection quads first, beneath all content (z-order)', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const selection: SelectionQuad[] = [
      { x: 10, y: 20, w: 100, h: 16 },
      { x: 10, y: 60, w: 40, h: 16 },
    ];
    const list = builder.build(engine, visibleIds, stampFor(engine), selection);
    expect(list.commands[0]).toMatchObject({
      type: 'fill',
      x: 10,
      y: 20,
      w: 100,
      h: 16,
      color: SELECTION_COLOR,
    });
    expect(list.commands[1]).toMatchObject({
      type: 'fill',
      x: 10,
      y: 60,
      w: 40,
      h: 16,
      color: SELECTION_COLOR,
    });
    // No glyph precedes the selection (selection is beneath the content).
    const firstGlyph = list.commands.findIndex((c) => c.type === 'glyph');
    if (firstGlyph !== -1) expect(firstGlyph).toBeGreaterThan(1);
  });

  it('glyph commands carry the stamp quad, uv, color, and the pxRange input', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const list = builder.build(engine, visibleIds, stampFor(engine));
    const paragraph = [...engine.recordsAll().values()].find(
      (r) => r.kind === ChunkKind.Paragraph && r.lines.length > 0,
    );
    expect(paragraph).toBeDefined();
    const glyph = paragraph!.lines[0]!.glyphs.find((g) => g.markOf === undefined && g.hasOutline);
    expect(glyph).toBeDefined();
    const atlas = engine.document.atlases[glyph!.atlasId]!;
    const stamp = prepareGlyph(atlas, glyph!.codepoint, glyph!.fontSizePx, glyph!.color)!;
    const commands = glyphsOf(list);
    const command = commands.find((c) => c.uv.join(',') === stamp.uv.join(','));
    expect(command).toBeDefined();
    if (command !== undefined) {
      expect(command.w).toBeCloseTo(stamp.quadW, 4);
      expect(command.h).toBeCloseTo(stamp.quadH, 4);
      expect(command.color).toBe(glyph!.color);
      // The pxRange shader input is document px per texel (the shader
      // multiplies by dpr for the device-px AA width).
      expect(command.pxPerTexel).toBeCloseTo(glyph!.fontSizePx / texelsPerEm(atlas), 6);
    }
    // Every command's uv stays inside the page.
    for (const c of commands) {
      const [u0, v0, u1, v1] = c.uv;
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u1).toBeLessThanOrEqual(1);
      expect(v1).toBeLessThanOrEqual(1);
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
    }
  });

  it('emits exactly one command per laid-out outlined glyph plus the markers', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const list = builder.build(engine, visibleIds, stampFor(engine));
    let laidOut = 0;
    for (const record of engine.recordsAll().values()) {
      for (const line of record.lines) {
        for (const instance of line.glyphs) {
          if (instance.markOf === undefined && instance.hasOutline) laidOut++;
        }
      }
    }
    // The golden has two disc list items; each emits its '•' marker glyph.
    expect(glyphsOf(list)).toHaveLength(laidOut + 2);
  });

  it('emits list markers as glyph commands from the bullet stamp', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const list = builder.build(engine, visibleIds, stampFor(engine));
    const items = [...engine.recordsAll().values()].filter((r) => r.kind === ChunkKind.ListItem);
    expect(items.length).toBe(2);
    const glyphs = glyphsOf(list);
    for (const item of items) {
      // The marker renders from the disc stamp (UV match): the quad is
      // offset from the marker origin by the stamp's bearing/padding.
      const atlas = engine.document.atlases[item.style.fontId]!;
      const stamp = prepareGlyph(atlas, 0x2022, item.style.fontSizePx, item.style.color)!;
      const found = glyphs.some((g) => g.uv.join(',') === stamp.uv.join(','));
      expect(found).toBe(true);
    }
  });

  it('passes ruler geometry through as a ruler command', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Hr, parentId: 1, depth: 1 },
    ]);
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 2, style_count: 1 }) },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { kind: 4, compression: 1, payload: contPayload([]) },
    ]);
    const parsed = await readPackage(bytes);
    if (!parsed.ok) throw parsed.error;
    const model = buildDocument(parsed.value);
    if (!model.ok) throw model.error;
    const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
    engine.extendTo(Number.POSITIVE_INFINITY);
    const builder = new DrawListBuilder({ texture: resolver() });
    const list = builder.build(engine, [1, 2], stampFor(engine));
    const ruler = list.commands.find((c) => c.type === 'ruler');
    expect(ruler).toBeDefined();
    expect(ruler!.type).toBe('ruler');
    expect(ruler!.w).toBeGreaterThan(0);
    expect(ruler!.color).toBeGreaterThan(0);
  });

  it('skips missing stamps without dropping the build (mid-flight scheduler)', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    const none = (): undefined => undefined;
    const list = builder.build(engine, visibleIds, none);
    // No text-run glyph commands; only the two disc markers (block geometry,
    // never gated by the cache) survive.
    expect(glyphsOf(list)).toHaveLength(2);
    // Partial coverage: only the first block with laid-out text resolves.
    const firstWithLines = [...engine.recordsAll().entries()]
      .sort((a, b) => a[0] - b[0])
      .find(([, r]) => r.lines.some((l) => l.glyphs.length > 0));
    expect(firstWithLines).toBeDefined();
    const first = firstWithLines![0];
    const partial = (chunkId: number, glyph: GlyphInstance): GlyphStamp | undefined =>
      chunkId === first ? stampFor(engine)(chunkId, glyph) : undefined;
    const partialList = builder.build(engine, visibleIds, partial);
    const full = builder.build(engine, visibleIds, stampFor(engine));
    expect(glyphsOf(partialList).length).toBeGreaterThan(0);
    expect(glyphsOf(partialList).length).toBeLessThan(glyphsOf(full).length);
  });

  it('property: same inputs ⇒ identical serialization for random subsets', async () => {
    const { engine, visibleIds } = await goldenSetup();
    const builder = new DrawListBuilder({ texture: resolver() });
    fc.assert(
      fc.property(
        fc.subarray(visibleIds, { minLength: 0, maxLength: visibleIds.length }),
        fc.array(
          fc.record({
            x: fc.integer({ min: 0, max: 2000 }),
            y: fc.integer({ min: 0, max: 2000 }),
            w: fc.integer({ min: 1, max: 200 }),
            h: fc.integer({ min: 1, max: 50 }),
          }),
          { maxLength: 4 },
        ),
        (subset, selection) => {
          const a = builder.build(engine, subset, stampFor(engine), selection);
          const b = builder.build(engine, subset, stampFor(engine), selection);
          expect(serialize(a)).toBe(serialize(b));
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('theme re-inks only the document default ink; other colors survive', async () => {
    const { engine, visibleIds } = await goldenSetup();
    // The golden stylesheet colors paragraphs #336699; headings, list items,
    // and the disc markers keep the compiler default ink #000000.
    const plain = new DrawListBuilder({ texture: resolver() });
    const themed = new DrawListBuilder({ texture: resolver(), theme: { ink: 0xffff_ffff } });
    const plainGlyphs = glyphsOf(plain.build(engine, visibleIds, stampFor(engine)));
    const themedGlyphs = glyphsOf(themed.build(engine, visibleIds, stampFor(engine)));
    expect(plainGlyphs.length).toBeGreaterThan(0);
    const plainColors = new Set(plainGlyphs.map((g) => g.color));
    expect(plainColors.has(0x0000_00ff)).toBe(true); // default ink is present
    expect(plainColors.has(0x3366_99ff)).toBe(true); // styled paragraph color is present
    const themedColors = new Set(themedGlyphs.map((g) => g.color));
    expect(themedColors.has(0xffff_ffff)).toBe(true); // default ink re-inked
    expect(themedColors.has(0x3366_99ff)).toBe(true); // non-default color preserved
    expect(themedColors.has(0x0000_00ff)).toBe(false); // default ink fully replaced
    // Geometry is untouched: same count, same uv stream and x positions.
    expect(themedGlyphs).toHaveLength(plainGlyphs.length);
    for (let i = 0; i < plainGlyphs.length; i++) {
      expect(themedGlyphs[i]!.uv).toEqual(plainGlyphs[i]!.uv);
      expect(themedGlyphs[i]!.x).toBe(plainGlyphs[i]!.x);
    }
  });

  it('theme re-inks rulers (ink content); markers are covered above via the golden', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Hr, parentId: 1, depth: 1 },
    ]);
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 2, style_count: 1 }) },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { kind: 4, compression: 1, payload: contPayload([]) },
    ]);
    const parsed = await readPackage(bytes);
    if (!parsed.ok) throw parsed.error;
    const model = buildDocument(parsed.value);
    if (!model.ok) throw model.error;
    const engine = new LayoutEngine(model.value, { dpr: 1, contentWidth: 800 });
    engine.extendTo(Number.POSITIVE_INFINITY);
    const builder = new DrawListBuilder({ texture: resolver(), theme: { ink: 0xffff_ffff } });
    const list = builder.build(engine, [1, 2], stampFor(engine));
    const ruler = list.commands.find((c) => c.type === 'ruler');
    expect(ruler).toBeDefined();
    expect(ruler!.color).toBe(0xffff_ffff);
  });
});
