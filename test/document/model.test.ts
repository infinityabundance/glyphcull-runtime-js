//! Document model tests: load-time validation and the trusted model view.

import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  DocumentError,
  isBlockKind,
  isInlineKind,
  isStructuralKind,
} from '../../src/document/model.js';
import { readPackage } from '../../src/format/reader.js';
import { ChunkKind } from '../../src/format/sections.js';
import { buildPackage, chnkPayload, contPayload, infoPayload } from '../testkit/builder.js';
import { pipelineGolden } from '../testkit/fixtures.js';

async function documentFrom(bytes: Uint8Array) {
  const parsed = await readPackage(bytes);
  if (!parsed.ok) throw parsed.error;
  return buildDocument(parsed.value);
}

/** A minimal valid document package: document root + one paragraph + one run. */
function minimalPackage(overrides: { chunkCount?: number } = {}) {
  const chunks = chnkPayload([
    { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2, depth: 0 },
    { id: 2, kind: ChunkKind.Paragraph, styleId: 0, parentId: 1, contentIndex: 1, depth: 1 },
  ]);
  const info = infoPayload({
    chunk_count: overrides.chunkCount ?? 2,
    style_count: 1,
    content_count: 1,
  });
  // STYL: 1 style record (id 0, 0 properties, 0-byte blob).
  const styl = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return buildPackage([
    { kind: 1, compression: 1, payload: info },
    { kind: 2, compression: 1, payload: chunks },
    { kind: 3, compression: 1, payload: styl },
    { kind: 4, compression: 1, payload: contPayload(['Hello, world!']) },
  ]);
}

describe('document model', () => {
  it('builds a valid model from the pipeline golden', async () => {
    const result = await documentFrom(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value;
    expect(doc.info.chunkCount).toBe(22);
    expect(doc.root.kind).toBe(ChunkKind.Document);
    expect(doc.chunks.length).toBe(22);
    expect(doc.styles.length).toBe(11);
    expect(doc.content.length).toBe(12);
    expect(doc.atlases.length).toBe(3);
    // The root's children are all reachable exactly once.
    expect(doc.allIds()).toHaveLength(22);
    expect(new Set(doc.allIds()).size).toBe(22);
  });

  it('plainText concatenates descendant text in document order', async () => {
    const result = await documentFrom(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value;
    const text = doc.plainText(1);
    expect(text).toContain('Deterministic');
    expect(text).toContain('golden');
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(text).toContain('code block');
    expect(text).toContain('quote');
    // Document order: heading, paragraph, list items, code block, quote.
    expect(text.indexOf('Deterministic')).toBeLessThan(text.indexOf('one'));
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('code block'));
    expect(text.indexOf('code block')).toBeLessThan(text.indexOf('quote'));
  });

  it('exposes extras per chunk', async () => {
    const result = await documentFrom(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value;
    const withExtras = [...doc.extras.keys()];
    expect(withExtras).toHaveLength(1);
    const extras = doc.extrasFor(withExtras[0]!);
    expect(extras[0]!.kind).toBe(1); // link_target
    expect(extras[0]!.data).toMatchObject({ url: 'https://example.com' });
  });

  it('classifies chunk kinds per the SPEC', () => {
    expect(isStructuralKind(ChunkKind.Document)).toBe(true);
    expect(isStructuralKind(ChunkKind.List)).toBe(true);
    expect(isStructuralKind(ChunkKind.Table)).toBe(true);
    expect(isStructuralKind(ChunkKind.TableRow)).toBe(true);
    expect(isStructuralKind(ChunkKind.Paragraph)).toBe(false);
    expect(isInlineKind(ChunkKind.Run)).toBe(true);
    expect(isInlineKind(ChunkKind.Link)).toBe(true);
    expect(isInlineKind(ChunkKind.Br)).toBe(true);
    expect(isInlineKind(ChunkKind.Paragraph)).toBe(false);
    expect(isBlockKind(ChunkKind.Paragraph)).toBe(true);
    expect(isBlockKind(ChunkKind.Heading1)).toBe(true);
    expect(isBlockKind(ChunkKind.Image)).toBe(true);
    expect(isBlockKind(ChunkKind.Hr)).toBe(true);
    expect(isBlockKind(ChunkKind.Run)).toBe(false);
    expect(isBlockKind(ChunkKind.Document)).toBe(false);
  });

  it('rejects a package without CHNK', async () => {
    const bytes = buildPackage([{ kind: 1, compression: 1, payload: infoPayload() }]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DocumentError);
      expect(result.error.kind).toBe('missing-section');
    }
  });

  it('rejects an empty chunk graph', async () => {
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 0 }) },
      { kind: 2, compression: 1, payload: chnkPayload([]) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-chunk-graph');
  });

  it('rejects a dangling style reference', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Paragraph, parentId: 1, styleId: 7, contentIndex: 1, depth: 1 },
    ]);
    const bytes = buildPackage([
      {
        kind: 1,
        compression: 1,
        payload: infoPayload({ chunk_count: 2, style_count: 1, content_count: 1 }),
      },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 4, compression: 1, payload: contPayload(['x']) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('dangling-reference');
  });

  it('rejects a dangling content reference', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Paragraph, parentId: 1, contentIndex: 9, depth: 1 },
    ]);
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 2, content_count: 1 }) },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 4, compression: 1, payload: contPayload(['x']) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('dangling-reference');
  });

  it('rejects an image chunk referencing a text payload', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Image, parentId: 1, contentIndex: 1, depth: 1 },
    ]);
    const bytes = buildPackage([
      {
        kind: 1,
        compression: 1,
        payload: infoPayload({ chunk_count: 2, style_count: 1, content_count: 1 }),
      },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { kind: 4, compression: 1, payload: contPayload(['not an image']) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-content');
  });

  it('rejects INFO/CHNK count mismatches', async () => {
    const bytes = buildPackage([
      {
        kind: 1,
        compression: 1,
        payload: infoPayload({ chunk_count: 99, style_count: 1, content_count: 1 }),
      },
      {
        kind: 2,
        compression: 1,
        payload: chnkPayload([
          { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
          { id: 2, kind: ChunkKind.Paragraph, parentId: 1, contentIndex: 1, depth: 1 },
        ]),
      },
      { kind: 3, compression: 1, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { kind: 4, compression: 1, payload: contPayload(['x']) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('count-mismatch');
  });

  it('rejects a graph with a cycle', async () => {
    // Root's first_child is itself: an immediate cycle.
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 1, lastChildId: 1 },
    ]);
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 1 }) },
      { kind: 2, compression: 1, payload: chunks },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-chunk-graph');
  });

  it('rejects a graph with an unreachable chunk', async () => {
    // Two siblings at the root with the same parent but the second is not
    // linked in the first's ring — it becomes unreachable.
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Paragraph, parentId: 1, depth: 1 },
      { id: 3, kind: ChunkKind.Paragraph, parentId: 1, depth: 1 },
    ]);
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload({ chunk_count: 3 }) },
      { kind: 2, compression: 1, payload: chunks },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-chunk-graph');
  });

  it('rejects a font_id beyond the atlas table', async () => {
    const chunks = chnkPayload([
      { id: 1, kind: ChunkKind.Document, flags: 1 << 4, firstChildId: 2, lastChildId: 2 },
      { id: 2, kind: ChunkKind.Paragraph, parentId: 1, styleId: 1, contentIndex: 1, depth: 1 },
    ]);
    // Style 1 sets font_id=5 but there are no atlases.
    const styl = new Uint8Array([
      2,
      0,
      0,
      0, // 2 styles
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // style 0: id 0, 0 props, blob 0 bytes
      1,
      0,
      0,
      0,
      1,
      0,
      6,
      0,
      1,
      0,
      5,
      0,
      0,
      0, // style 1: id 1, 1 prop, blob 6 bytes (tag 1 + u32 5)
    ]);
    const bytes = buildPackage([
      {
        kind: 1,
        compression: 1,
        payload: infoPayload({ chunk_count: 2, style_count: 2, content_count: 1 }),
      },
      { kind: 2, compression: 1, payload: chunks },
      { kind: 3, compression: 1, payload: styl },
      { kind: 4, compression: 1, payload: contPayload(['x']) },
    ]);
    const result = await documentFrom(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // No GLYF section exists, so font_id 5 is dangling.
      expect(result.error.kind).toBe('dangling-reference');
    }
  });

  it('documents are isolated (no shared mutable state)', async () => {
    const a = await documentFrom(minimalPackage());
    const b = await documentFrom(minimalPackage());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
    expect(a.value.info).not.toBe(b.value.info);
  });
});
