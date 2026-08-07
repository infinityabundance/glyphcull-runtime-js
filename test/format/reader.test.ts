//! Reader contract tests: the independent `.cull` reader against the
//! committed compiler fixtures, with the compiler's `cull inspect`
//! diagnostics pinned as the expected values.

import { describe, expect, it } from 'vitest';
import { attempt, CullError } from '../../src/format/errors.js';
import { inflateVerified } from '../../src/format/inflate.js';
import {
  Compression,
  HEADER_LEN,
  readPackage,
  SectionKind,
  validateStructure,
  VERSION,
} from '../../src/format/reader.js';
import {
  ChunkKind,
  ExtraKind,
  PayloadKind,
  resolveStyle,
  texelsPerEm,
} from '../../src/format/sections.js';
import { crc32 } from '../../src/format/crc32.js';
import { pipelineGolden, pipelineGoldenExpected, v1Minimal } from '../testkit/fixtures.js';
import { buildPackage, infoPayload } from '../testkit/builder.js';

describe('container structure', () => {
  it('parses the v1-minimal package (INFO-only)', () => {
    const bytes = v1Minimal();
    const result = validateStructure(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(VERSION);
    expect(result.value.entries).toHaveLength(1);
    expect(result.value.entries[0]!.kind).toBe(SectionKind.Info);
    expect(result.value.entries[0]!.compression).toBe(Compression.Zlib);
  });

  it('rejects a too-short buffer', () => {
    for (const len of [0, 1, 4, 15]) {
      const result = validateStructure(new Uint8Array(len));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('too-short');
    }
  });

  it('rejects bad magic', () => {
    const bytes = v1Minimal().slice();
    bytes[0] = 0x58; // 'X'
    const result = validateStructure(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('bad-magic');
  });

  it('rejects unsupported versions', () => {
    const bytes = v1Minimal().slice();
    bytes[4] = 2;
    bytes[5] = 0;
    const result = validateStructure(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unsupported-version');
  });

  it('rejects header CRC mismatch', () => {
    const bytes = v1Minimal().slice();
    bytes[8] = 99; // corrupt section_count after the CRC was computed
    const result = validateStructure(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('header-crc-mismatch');
  });

  it('rejects a truncated section table', () => {
    const bytes = v1Minimal().slice(0, HEADER_LEN + 8);
    const result = validateStructure(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('truncated');
  });

  it('rejects zero and over-limit section counts', () => {
    const withCount = (count: number): Uint8Array => {
      const bytes = v1Minimal().slice();
      const dv = new DataView(bytes.buffer);
      dv.setUint32(8, count, true);
      // Recompute the header CRC over bytes 0..12.
      dv.setUint32(12, crc32(bytes.subarray(0, 12)), true);
      return bytes;
    };
    for (const count of [0, 65, 0xffffffff]) {
      const result = validateStructure(withCount(count));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe(count === 0 ? 'invalid-value' : 'too-many-sections');
      }
    }
  });
});

describe('full package read', () => {
  it('parses the pipeline golden with the compiler-pinned diagnostics', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;

    expect(pkg.version).toBe(1);
    expect(pkg.entries.map((e) => e.kind)).toEqual(pipelineGoldenExpected.sectionKinds);

    const info = pkg.info();
    expect(info).toBeDefined();
    expect(info!.documentId).toBe(pipelineGoldenExpected.documentId);
    expect(info!.sourceDigest).toBe(pipelineGoldenExpected.sourceDigest);
    expect(info!.generator).toBe(pipelineGoldenExpected.generator);
    expect(info!.chunkCount).toBe(pipelineGoldenExpected.chunkCount);
    expect(info!.styleCount).toBe(pipelineGoldenExpected.styleCount);
    expect(info!.contentCount).toBe(pipelineGoldenExpected.contentCount);
    expect(info!.atlasCount).toBe(pipelineGoldenExpected.atlasCount);
    expect(info!.imageCount).toBe(pipelineGoldenExpected.imageCount);
  });

  it('decodes the chunk graph with exact counts and a link_target extra', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunks = result.value.chunkSection();
    expect(chunks).toBeDefined();
    expect(chunks!.chunks).toHaveLength(22);
    expect(chunks!.extras).toHaveLength(1);
    expect(chunks!.extras[0]!.kind).toBe(ExtraKind.LinkTarget);
    expect(chunks!.extras[0]!.data).toMatchObject({ url: 'https://example.com' });

    // Chunk kind census, pinned from `cull inspect`.
    const census = new Map<ChunkKind, number>();
    for (const chunk of chunks!.chunks) {
      census.set(chunk.kind, (census.get(chunk.kind) ?? 0) + 1);
    }
    expect(census.get(ChunkKind.Document)).toBe(1);
    expect(census.get(ChunkKind.Heading1)).toBe(1);
    expect(census.get(ChunkKind.Paragraph)).toBe(4);
    expect(census.get(ChunkKind.List)).toBe(1);
    expect(census.get(ChunkKind.ListItem)).toBe(2);
    expect(census.get(ChunkKind.CodeBlock)).toBe(1);
    expect(census.get(ChunkKind.Quote)).toBe(1);
    expect(census.get(ChunkKind.Run)).toBe(11);

    // Tree invariants hold on the parsed records.
    const byId = new Map(chunks!.chunks.map((c) => [c.id, c]));
    const root = byId.get(1)!;
    expect(root.kind).toBe(ChunkKind.Document);
    expect(root.depth).toBe(0);
    expect(root.parentId).toBe(0);
    let reachable = 0;
    const seen = new Set<number>();
    const stack = [root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) throw new CullError('internal', 'cycle in chunk tree');
      seen.add(id);
      reachable++;
      const chunk = byId.get(id)!;
      // Walk the sibling ring once via next links, stopping at last_child.
      let child = chunk.firstChildId;
      while (child !== 0) {
        stack.push(child);
        if (child === chunk.lastChildId) break;
        child = byId.get(child)!.nextId;
      }
    }
    expect(reachable).toBe(chunks!.chunks.length);
    for (const chunk of chunks!.chunks) {
      expect(chunk.ordinal).toBe(chunk.id - 1);
      if (chunk.id !== 1) {
        expect(chunk.depth).toBe(byId.get(chunk.parentId)!.depth + 1);
      }
    }
  });

  it('decodes styles with defaults applied', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const styles = result.value.styles();
    expect(styles).toHaveLength(11);
    const resolved = styles!.map((s) => resolveStyle(s));
    // The golden stylesheet sets p { color: #336699 }; the paragraph style
    // carries it, and the document default style does not.
    expect(resolved.some((s) => s.color === 0x336699ff)).toBe(true);
    // Defaults for unspecified properties.
    expect(resolved[0]!.fontSizePx).toBe(16);
    expect(resolved[0]!.lineHeight).toBe(1.5);
    expect(resolved[0]!.fontWeight).toBe(400);
    expect(resolved[0]!.color).toBe(0x000000ff);
  });

  it('decodes content payloads', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.value.content();
    expect(content).toHaveLength(12);
    expect(content!.every((p) => p.kind === PayloadKind.TextUtf8)).toBe(true);
    const texts = content!.map((p) => (p.kind === PayloadKind.TextUtf8 ? p.text : ''));
    expect(texts).toContain('one');
    expect(texts).toContain('two');
    expect(texts.join('')).toContain('code block');
  });

  it('decodes the three atlases with pinned descriptors', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atlases = result.value.atlases();
    expect(atlases).toHaveLength(3);
    for (const expected of pipelineGoldenExpected.atlases) {
      const atlas = atlases![expected.fontId];
      expect(atlas).toBeDefined();
      expect(atlas!.weight).toBe(expected.weight);
      expect(atlas!.italic).toBe(expected.italic);
      expect(atlas!.glyphs.size).toBe(expected.glyphs);
      expect(atlas!.kerning.size).toBeLessThanOrEqual(expected.kerning);
      expect(atlas!.pageWidth).toBe(expected.pageWidth);
      expect(texelsPerEm(atlas!)).toBe(32);
      expect(atlas!.pages).toHaveLength(expected.pages);
      expect(atlas!.pages[0]!.length).toBe(atlas!.pageWidth * atlas!.pageHeight * 4);
    }
  });

  it('verifies the SEAL against every covered section', async () => {
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;
    expect(pkg.seal()).toBeDefined();
    expect(pkg.seal()!.hashes).toHaveLength(5);
    expect(pkg.seal()!.mode).toBe(1);
    expect(pkg.seal()!.algo).toBe(0);
  });

  it('tampering with any section is a typed error', async () => {
    const bytes = pipelineGolden().slice();
    // Flip one byte in each section's stored payload.
    const result = await readPackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;
    for (const entry of pkg.entries) {
      const mutated = bytes.slice();
      const at = entry.offset + Math.floor(entry.storedLen / 2);
      mutated[at] = (mutated[at]! ^ 0x55) >>> 0;
      const r = await readPackage(mutated);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // Every mutation must be a typed reader error.
        expect(r.error).toBeInstanceOf(CullError);
        expect(
          ['crc-mismatch', 'decompress-mismatch', 'zlib-adler-mismatch', 'truncated'].includes(
            r.error.kind,
          ),
        ).toBe(true);
      }
    }
  });

  it('tampering with the SEAL overall hash fails seal verification', async () => {
    const bytes = pipelineGolden().slice();
    const result = await readPackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;
    const sealKind: number = SectionKind.Seal;
    const sealEntry = pkg.entries.find((e) => e.kind === sealKind)!;
    const mutated = bytes.slice();
    const overallStart = sealEntry.offset + sealEntry.storedLen - 32;
    mutated[overallStart] = (mutated[overallStart]! ^ 0xff) >>> 0;
    // The per-section CRC would catch the tamper first; recompute it so the
    // SEAL verification path itself is exercised.
    const sealPayload = mutated.subarray(sealEntry.offset, sealEntry.offset + sealEntry.storedLen);
    const entryCrcOffset = HEADER_LEN + sealEntry.index * 32 + 28;
    new DataView(mutated.buffer).setUint32(entryCrcOffset, crc32(sealPayload), true);
    const r = await readPackage(mutated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('seal-mismatch');
  });

  it('keeps raw-section payloads as zero-copy views', async () => {
    const bytes = pipelineGolden();
    const result = await readPackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;
    for (const entry of pkg.entries) {
      if (entry.compression === Compression.None) {
        const payload = pkg.section(entry.kind)!;
        // Views share the input buffer (same underlying ArrayBuffer).
        expect(payload.buffer).toBe(bytes.buffer);
      }
    }
  });
});

describe('truncation corpus', () => {
  it('every proper prefix of the v1-minimal package fails with a typed error', async () => {
    const bytes = v1Minimal();
    for (let len = 0; len < bytes.length; len++) {
      const prefix = bytes.slice(0, len);
      const r = await readPackage(prefix);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(CullError);
    }
  });

  it('structural truncations of the pipeline golden fail', async () => {
    const bytes = pipelineGolden();
    const result = await readPackage(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.value;
    // Truncate at every structural boundary: header, each entry, each section
    // start/end ±1, and section midpoints.
    const points = new Set<number>();
    points.add(HEADER_LEN - 1);
    for (const entry of pkg.entries) {
      points.add(entry.offset - 1);
      points.add(entry.offset);
      points.add(entry.offset + 1);
      points.add(entry.offset + Math.floor(entry.storedLen / 2));
      points.add(entry.offset + entry.storedLen - 1);
      points.add(entry.offset + entry.storedLen);
      points.add(entry.offset + entry.storedLen + 1);
    }
    for (const point of points) {
      if (point >= bytes.length - 1) continue;
      const prefix = bytes.slice(0, point);
      const r = await readPackage(prefix);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(CullError);
    }
  });
});

describe('section payload strictness', () => {
  it('rejects a zlib stream with a bad header', async () => {
    await expect(
      inflateVerified(new Uint8Array([0x78, 0x01, 0, 0, 0, 0]), 0, 0),
    ).rejects.toBeInstanceOf(CullError);
  });

  it('rejects a truncated zlib stream', async () => {
    const { deflateSync } = await import('node:zlib');
    const stream = deflateSync(Buffer.from('hello hello hello'), { level: 9 });
    const truncated = stream.subarray(0, stream.length - 3);
    await expect(inflateVerified(truncated, 15, 0)).rejects.toBeInstanceOf(CullError);
  });

  it('rejects a decoded length mismatch', async () => {
    const { deflateSync } = await import('node:zlib');
    const stream = deflateSync(Buffer.from('hello hello hello'), { level: 9 });
    await expect(inflateVerified(stream, 100, 0)).rejects.toBeInstanceOf(CullError);
  });

  it('rejects a corrupted Adler-32 trailer', async () => {
    const { deflateSync } = await import('node:zlib');
    const stream = deflateSync(Buffer.from('hello hello hello'), { level: 9 });
    const mutated = Uint8Array.from(stream);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1]! ^ 0xff) >>> 0;
    // The platform inflate verifies the Adler-32 itself, so the failure may
    // surface as a platform decode error (wrapped as decompress-mismatch) or
    // our explicit check (zlib-adler-mismatch). Either way: typed and precise.
    await expect(inflateVerified(mutated, 15, 0)).rejects.toMatchObject({
      kind: 'decompress-mismatch',
    });
  });
});

describe('unknown sections and structural strictness', () => {
  it('skips reserved section kinds (forward compatibility)', async () => {
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload() },
      { kind: 99, compression: 0, payload: new TextEncoder().encode('future data') },
    ]);
    const r = await readPackage(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unknown).toHaveLength(1);
    expect(r.value.unknown[0]!.kind).toBe(99);
    expect(r.value.info()).toBeDefined();
  });

  it('rejects duplicate section kinds', async () => {
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload() },
      { kind: 1, compression: 1, payload: infoPayload() },
    ]);
    const r = await readPackage(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('duplicate-section');
  });

  it('rejects reserved flags in section entries', async () => {
    const bytes = buildPackage([{ kind: 1, compression: 1, payload: infoPayload() }]);
    const mutated = bytes.slice();
    mutated[HEADER_LEN + 5] = 1; // entry flags byte
    const r = await readPackage(mutated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-flags');
  });

  it('rejects a critical unknown section kind and skips a noncritical one', async () => {
    // Noncritical (flags bit 0 clear): skipped, forward compatible.
    const bytes = buildPackage([
      { kind: 1, compression: 1, payload: infoPayload() },
      { kind: 99, compression: 0, payload: new TextEncoder().encode('future') },
    ]);
    const ok = await readPackage(bytes);
    expect(ok.ok).toBe(true);
    // Critical (flags bit 0 set on the unknown entry): rejected.
    const critical = bytes.slice();
    critical[HEADER_LEN + 32 + 5] = 0x01; // second entry's flags byte
    const r = await readPackage(critical);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unknown-critical-section');
  });

  it('rejects out-of-order known sections', async () => {
    const bytes = buildPackage([
      { kind: SectionKind.Cont, compression: 1, payload: new TextEncoder().encode('c') },
      { kind: SectionKind.Info, compression: 1, payload: infoPayload() },
    ]);
    const r = await readPackage(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-section-order');
  });

  it('rejects a package missing the required INFO section', async () => {
    const bytes = buildPackage([
      { kind: SectionKind.Cont, compression: 1, payload: new TextEncoder().encode('c') },
    ]);
    const r = await readPackage(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('missing-required-section');
  });

  it('rejects a package whose INFO has unknown or wrong-typed keys', async () => {
    const infoOf = async (payload: Uint8Array) => {
      const r = await readPackage(buildPackage([{ kind: 1, compression: 0, payload }]));
      if (!r.ok) return r;
      // INFO decoding is lazy; force it through the typed-result boundary.
      return attempt(() => r.value.info());
    };

    // Wrong type for a required key.
    const wrongType = new TextEncoder().encode(
      '{"format_version":1,"generator":"g","generator_version":"v",' +
        '"source_digest":"' +
        '00'.repeat(32) +
        '","document_id":"' +
        '01'.repeat(16) +
        '",' +
        '"chunk_count":"not-a-number","style_count":0,"content_count":0,"atlas_count":0,"image_count":0}',
    );
    const r1 = await infoOf(wrongType);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe('invalid-value');

    // Trailing data after the object.
    const trailing = new TextEncoder().encode(
      '{"format_version":1,"generator":"g","generator_version":"v",' +
        '"source_digest":"' +
        '00'.repeat(32) +
        '","document_id":"' +
        '01'.repeat(16) +
        '",' +
        '"chunk_count":0,"style_count":0,"content_count":0,"atlas_count":0,"image_count":0} extra',
    );
    const r2 = await infoOf(trailing);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('invalid-value');

    // Duplicate key.
    const dup = new TextEncoder().encode(
      '{"format_version":1,"generator":"g","generator_version":"v",' +
        '"source_digest":"' +
        '00'.repeat(32) +
        '","document_id":"' +
        '01'.repeat(16) +
        '",' +
        '"chunk_count":0,"chunk_count":1,"style_count":0,"content_count":0,"atlas_count":0,"image_count":0}',
    );
    const r3 = await infoOf(dup);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.kind).toBe('invalid-value');
  });
});
