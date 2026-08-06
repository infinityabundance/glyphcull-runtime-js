//! Known-answer tests for the reader primitives: CRC-32, Adler-32, SHA-256.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync, unzipSync } from 'node:zlib';
import { adler32 } from '../../src/format/adler32.js';
import { crc32 } from '../../src/format/crc32.js';
import { hex, sha256, unhex } from '../../src/format/sha256.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the standard known-answer vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('is order-sensitive and stable', () => {
    const a = crc32(bytes('abc'));
    const b = crc32(bytes('acb'));
    expect(a).not.toBe(b);
    expect(crc32(bytes('abc'))).toBe(a);
  });

  it('matches the compiler fixture section CRCs (independent cross-check)', async () => {
    const { readPackage } = await import('../../src/format/reader.js');
    const { pipelineGolden } = await import('../testkit/fixtures.js');
    const result = await readPackage(pipelineGolden());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Recompute every decoded payload's CRC and compare to the table.
    for (const entry of result.value.entries) {
      const payload = result.value.section(entry.kind);
      expect(payload).toBeDefined();
      expect(crc32(payload!)).toBe(entry.crc32);
    }
  });
});

describe('adler32', () => {
  it('matches RFC 1950 §2.3 known-answer vectors', () => {
    expect(adler32(new Uint8Array(0))).toBe(1);
    expect(adler32(bytes('Wikipedia'))).toBe(0x11e60398);
    expect(adler32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x5bdc0fda);
  });

  it('handles inputs longer than one chunk (mod-65521 behavior)', () => {
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    // Cross-check against node's zlib.
    const compressed = deflateSync(big, { level: 9 });
    const round = unzipSync(compressed);
    expect(Buffer.compare(round, Buffer.from(big))).toBe(0);
    // The last 4 bytes of the zlib stream are the big-endian Adler-32.
    const view = new DataView(compressed.buffer, compressed.byteOffset + compressed.length - 4, 4);
    expect(adler32(big)).toBe(view.getUint32(0, false));
  });
});

describe('sha256', () => {
  it('matches FIPS 180-4 example vectors', () => {
    expect(hex(sha256(bytes('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(bytes('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(hex(sha256(bytes('The quick brown fox jumps over the lazy dog')))).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('matches node:crypto for 10,000 pseudo-random inputs', () => {
    for (let n = 0; n < 10_000; n++) {
      const len = (n * 37) % 200;
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = (n * 31 + i * 7) % 256;
      const expected = createHash('sha256').update(data).digest('hex');
      expect(hex(sha256(data))).toBe(expected);
    }
  });

  it('handles lengths that cross the padding boundary', () => {
    // 55, 56, 63, 64, 65, 119, 120, 121 bytes exercise the padding edge cases.
    for (const len of [55, 56, 63, 64, 65, 119, 120, 121, 1000]) {
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = (i * 13) % 256;
      const expected = createHash('sha256').update(data).digest('hex');
      expect(hex(sha256(data))).toBe(expected);
    }
  });
});

describe('hex', () => {
  it('round-trips', () => {
    const data = new Uint8Array([0, 1, 0x0a, 0xff, 0x80, 0x55]);
    expect(unhex(hex(data))).toEqual(data);
  });

  it('rejects malformed input', () => {
    expect(() => unhex('abc')).toThrow(RangeError);
    expect(() => unhex('zz')).toThrow(RangeError);
  });
});
