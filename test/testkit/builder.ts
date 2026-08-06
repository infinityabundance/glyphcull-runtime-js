//! A minimal package builder for reader tests.
//!
//! Test-only: the production writer is the compiler. This builder produces
//! structurally valid containers so tests can construct malformed or unusual
//! cases the golden fixtures cannot express (unknown kinds, duplicate
//! sections, absent SEAL, reserved flags).

import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/format/crc32.js';

export interface TestSection {
  kind: number;
  /** 0 = none, 1 = zlib. */
  compression: 0 | 1;
  payload: Uint8Array;
}

const HEADER_LEN = 16;
const ENTRY_LEN = 32;

/**
 * Assemble a package: header + section table + payloads. Sections appear in
 * the given order; `decoded_len`/CRC are computed from the payloads.
 */
export function buildPackage(sections: TestSection[]): Uint8Array {
  const tableLen = sections.length * ENTRY_LEN;
  let offset = HEADER_LEN + tableLen;
  const stored: { stored: Uint8Array; decodedLen: number }[] = [];
  for (const section of sections) {
    if (section.compression === 1) {
      const compressed = deflateSync(section.payload, { level: 9 });
      stored.push({ stored: compressed, decodedLen: section.payload.length });
    } else {
      stored.push({ stored: section.payload, decodedLen: section.payload.length });
    }
  }

  const total = offset + stored.reduce((acc, s) => acc + s.stored.length, 0);
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);

  bytes.set([0x43, 0x55, 0x4c, 0x4c], 0); // "CULL"
  dv.setUint16(4, 1, true); // version
  dv.setUint16(6, 0, true); // flags
  dv.setUint32(8, sections.length, true); // section_count
  dv.setUint32(12, crc32(bytes.subarray(0, 12)), true); // header crc

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const entry = HEADER_LEN + i * ENTRY_LEN;
    dv.setUint32(entry, section.kind, true);
    bytes[entry + 4] = section.compression;
    bytes[entry + 5] = 0; // flags
    dv.setUint16(entry + 6, 0, true); // reserved
    dv.setUint32(entry + 8, offset, true); // offset (u64 low)
    dv.setUint32(entry + 12, 0, true); // offset (u64 high)
    dv.setUint32(entry + 16, stored[i]!.stored.length, true); // stored_len (u64 low)
    dv.setUint32(entry + 20, 0, true); // stored_len (u64 high)
    dv.setUint32(entry + 24, stored[i]!.decodedLen, true);
    dv.setUint32(entry + 28, crc32(section.payload), true);
    bytes.set(stored[i]!.stored, offset);
    offset += stored[i]!.stored.length;
  }

  return bytes;
}

/** INFO payload in the deterministic JSON subset (SPEC.md §2.1). */
export function infoPayload(overrides: Record<string, number | string> = {}): Uint8Array {
  const base: Record<string, number | string> = {
    atlas_count: 0,
    chunk_count: 0,
    content_count: 0,
    document_id: '0123456789abcdef0123456789abcdef',
    format_version: 1,
    generator: 'test-builder',
    generator_version: '0.0.0',
    image_count: 0,
    source_digest: '00'.repeat(32),
    style_count: 0,
  };
  const merged = { ...base, ...overrides };
  // Keys sorted lexicographically, no whitespace, minimal escaping.
  const body = Object.keys(merged)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(merged[key])}`)
    .join(',');
  return new TextEncoder().encode(`{${body}}`);
}

/** An empty CHNK payload. */
export function emptyChnkPayload(): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, 0, true);
  new DataView(out.buffer).setUint32(4, 0, true);
  return out;
}
