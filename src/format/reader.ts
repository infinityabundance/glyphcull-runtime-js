//! The strict `.cull` package reader (SPEC.md §1.6) — an independent
//! implementation of the format contract.
//!
//! `readPackage` validates the header, the section table (bounds, compression,
//! decoded lengths, reserved bits, container limits), decodes every payload
//! (verifying the RFC 1950 zlib header, the authoritative `decoded_len`, and
//! the trailing Adler-32), verifies per-section CRC-32, and verifies the SEAL
//! hash tree when present. Unknown section kinds are preserved and skipped
//! (forward compatibility, SPEC.md §1.4).
//!
//! Every failure is a typed [`CullError`]; the reader never throws platform
//! exceptions on input. Uncompressed section payloads (GLYF, IMGS, SEAL) are
//! returned as views into the input buffer — zero-copy, so atlas pages can be
//! uploaded without copying.

import { CullError, attempt } from './errors.js';
import type { Result } from './errors.js';
import { crc32 } from './crc32.js';
import { inflateVerified } from './inflate.js';
import { sha256 } from './sha256.js';
import {
  MAX_CHUNK_COUNT,
  MAX_CONTENT_COUNT,
  MAX_FILE_LEN,
  MAX_GLYPH_COUNT,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_DIM,
  MAX_KERNING_COUNT,
  MAX_PAGE_DIM,
  MAX_SECTION_COUNT,
  MAX_SECTION_DECODED_LEN,
  MAX_STYLE_COUNT,
  MAX_TOTAL_DECODED,
} from './limits.js';
import {
  CHUNK_FLAG_STRUCTURAL,
  ChunkKind,
  ExtraKind,
  PayloadKind,
  PropertyTag,
} from './sections.js';
import type {
  Atlas,
  ChunkExtra,
  ChunkRecord,
  GlyphRecord,
  ImageRecord,
  Info,
  Seal,
  SectionHash,
  StyleRecord,
  StyleProperties,
} from './sections.js';

/** The ASCII magic bytes. */
export const MAGIC = 'CULL';
/** The current format version. */
export const VERSION = 1;
/** The header is 16 bytes (SPEC.md §1.1). */
export const HEADER_LEN = 16;
/** Each section table entry is 32 bytes (SPEC.md §1.2). */
export const SECTION_ENTRY_LEN = 32;
/** The header CRC covers bytes 0..12. */
const CRC_COVERED_LEN = 12;

/** The INFO JSON size cap (defensive; metadata is small). */
const MAX_INFO_LEN = 1 << 20;
/** Maximum extras in the CHNK section. */
const MAX_EXTRA_COUNT = 1 << 26;
/** Maximum chunk depth. */
const MAX_CHUNK_DEPTH = 1 << 16;
/** Maximum atlas count. */
const MAX_ATLAS_COUNT = 1 << 16;
/** Maximum family name bytes. */
const MAX_FAMILY_LEN = 1024;
/** Maximum properties per style record. */
const MAX_PROPERTIES_PER_STYLE = 64;
/** Maximum covered sections in a SEAL. */
const MAX_COVERED_SECTIONS = 64;
/** SEAL hash-tree mode / SHA-256 algorithm codes (SPEC.md §2.7). */
const SEAL_MODE_HASH_TREE = 1;
const SEAL_ALGO_SHA256 = 0;
/** Chunk record size (SPEC.md §2.2). */
const CHUNK_RECORD_LEN = 44;
/** Glyph record size (SPEC.md §2.5). */
const GLYPH_RECORD_LEN = 32;
/** SEAL per-section hash entry size (SPEC.md §2.7). */
const OVERALL_HASH_LEN = 32;

/** Compression codes (SPEC.md §1.2). */
export const enum Compression {
  None = 0,
  Zlib = 1,
}

/** Section kind codes (SPEC.md §1.4). */
export const enum SectionKind {
  Info = 1,
  Chnk = 2,
  Styl = 3,
  Cont = 4,
  Glyf = 5,
  Imgs = 6,
  Seal = 7,
}

/** Compression codes as plain numbers (for range checks). */
const COMPRESSION_NONE: number = Compression.None;
const COMPRESSION_ZLIB: number = Compression.Zlib;
/** Known section kind range (SPEC.md §1.4: 1..=7). */
const MIN_SECTION_KIND: number = SectionKind.Info;
const MAX_SECTION_KIND: number = SectionKind.Seal;
const SEAL_KIND: number = SectionKind.Seal;

/** Valid chunk kind range (SPEC.md §2.2: 1..=21). */
const MIN_CHUNK_KIND: number = ChunkKind.Document;
const MAX_CHUNK_KIND: number = ChunkKind.Hr;
/** Valid extra kind range (SPEC.md §2.2: 1..=4). */
const MIN_EXTRA_KIND: number = ExtraKind.LinkTarget;
const MAX_EXTRA_KIND: number = ExtraKind.ImageAlt;
/** Valid property tag range (SPEC.md §2.3: 1..=16). */
const MIN_PROPERTY_TAG: number = PropertyTag.FontId;
const MAX_PROPERTY_TAG: number = PropertyTag.WhiteSpace;
/** Payload kind codes (SPEC.md §2.4). */
const KIND_TEXT: number = PayloadKind.TextUtf8;
const KIND_IMAGE_REF: number = PayloadKind.ImageRef;

/** A validated section table entry. */
export interface SectionEntry {
  readonly index: number;
  readonly kind: number;
  readonly compression: Compression;
  /** The flags byte: bit 0 is `critical`, meaningful only for unknown kinds. */
  readonly flags: number;
  readonly offset: number;
  readonly storedLen: number;
  readonly decodedLen: number;
  readonly crc32: number;
}

/** A fully parsed and validated package. */
export class Package {
  /** The original input bytes (retained: raw-section payloads view into it). */
  readonly bytes: Uint8Array;
  readonly version: number;
  readonly flags: number;
  /** Section table entries in file order. */
  readonly entries: readonly SectionEntry[];
  /** Decoded known sections keyed by kind. */
  readonly sections: ReadonlyMap<number, Uint8Array>;
  /** Decoded sections with reserved/unknown kinds, in file order. */
  readonly unknown: readonly { kind: number; payload: Uint8Array }[];

  private cachedInfo: Info | undefined;
  private cachedChunks: { chunks: ChunkRecord[]; extras: ChunkExtra[] } | undefined;
  private cachedStyles: StyleRecord[] | undefined;
  private cachedContent: ContentPayload[] | undefined;
  private cachedAtlases: Atlas[] | undefined;
  private cachedImages: ImageRecord[] | undefined;
  private cachedSeal: Seal | undefined;

  constructor(
    bytes: Uint8Array,
    version: number,
    flags: number,
    entries: SectionEntry[],
    sections: Map<number, Uint8Array>,
    unknown: { kind: number; payload: Uint8Array }[],
  ) {
    this.bytes = bytes;
    this.version = version;
    this.flags = flags;
    this.entries = entries;
    this.sections = sections;
    this.unknown = unknown;
  }

  /** The raw payload of a known section, if present. */
  section(kind: number): Uint8Array | undefined {
    return this.sections.get(kind);
  }

  /** INFO metadata (parsed and validated on first access). */
  info(): Info | undefined {
    if (this.cachedInfo === undefined) {
      const payload = this.sections.get(SectionKind.Info);
      if (payload === undefined) return undefined;
      this.cachedInfo = decodeInfo(payload);
    }
    return this.cachedInfo;
  }

  /** CHNK chunk graph (parsed and validated on first access). */
  chunkSection(): { chunks: ChunkRecord[]; extras: ChunkExtra[] } | undefined {
    if (this.cachedChunks === undefined) {
      const payload = this.sections.get(SectionKind.Chnk);
      if (payload === undefined) return undefined;
      this.cachedChunks = decodeChnk(payload);
    }
    return this.cachedChunks;
  }

  /** STYL style records (parsed and validated on first access). */
  styles(): StyleRecord[] | undefined {
    if (this.cachedStyles === undefined) {
      const payload = this.sections.get(SectionKind.Styl);
      if (payload === undefined) return undefined;
      this.cachedStyles = decodeStyl(payload);
    }
    return this.cachedStyles;
  }

  /** CONT content payloads (parsed and validated on first access). */
  content(): ContentPayload[] | undefined {
    if (this.cachedContent === undefined) {
      const payload = this.sections.get(SectionKind.Cont);
      if (payload === undefined) return undefined;
      this.cachedContent = decodeCont(payload);
    }
    return this.cachedContent;
  }

  /** GLYF atlases (parsed and validated on first access). */
  atlases(): Atlas[] | undefined {
    if (this.cachedAtlases === undefined) {
      const payload = this.sections.get(SectionKind.Glyf);
      if (payload === undefined) return undefined;
      this.cachedAtlases = decodeGlyf(payload);
    }
    return this.cachedAtlases;
  }

  /** IMGS images (parsed and validated on first access). */
  images(): ImageRecord[] | undefined {
    if (this.cachedImages === undefined) {
      const payload = this.sections.get(SectionKind.Imgs);
      if (payload === undefined) return undefined;
      this.cachedImages = decodeImgs(payload);
    }
    return this.cachedImages;
  }

  /** SEAL integrity data (parsed on first access; verified at load). */
  seal(): Seal | undefined {
    if (this.cachedSeal === undefined) {
      const payload = this.sections.get(SectionKind.Seal);
      if (payload === undefined) return undefined;
      this.cachedSeal = decodeSeal(payload);
    }
    return this.cachedSeal;
  }
}

/** A decoded content payload (SPEC.md §2.4). */
export type ContentPayload =
  | { id: number; kind: PayloadKind.TextUtf8; text: string }
  | { id: number; kind: PayloadKind.ImageRef; imageId: number };

// ---------------------------------------------------------------------------
// Cursor

/** A bounds-checked little-endian cursor over a byte slice. */
class Cursor {
  private pos = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly end: number = data.length,
  ) {}

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private ensure(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new CullError(
        'truncated',
        `${what}: need ${n} bytes at ${this.pos}, only ${this.remaining} remain`,
      );
    }
  }

  u8(what: string): number {
    this.ensure(1, what);
    return this.data[this.pos++]!;
  }

  u16(what: string): number {
    this.ensure(2, what);
    const v = this.data[this.pos]! | (this.data[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  u32(what: string): number {
    this.ensure(4, what);
    const v =
      this.data[this.pos]! |
      (this.data[this.pos + 1]! << 8) |
      (this.data[this.pos + 2]! << 16) |
      (this.data[this.pos + 3]! * 0x1000000);
    this.pos += 4;
    return v >>> 0;
  }

  u64(what: string): number {
    const lo = this.u32(what);
    const hi = this.u32(what);
    // File size is capped at 4 GiB, so hi is always 0 in practice; the
    // arithmetic is exact for all values below 2^53.
    return lo + hi * 0x100000000;
  }

  f32(what: string): number {
    this.ensure(4, what);
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4);
    const v = view.getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  /** A view over the next `n` bytes (zero-copy). */
  bytes(n: number, what: string): Uint8Array {
    this.ensure(n, what);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Decode `n` bytes as UTF-8, rejecting malformed sequences. */
  utf8(n: number, what: string): string {
    const raw = this.bytes(n, what);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new CullError('invalid-utf8', `${what} is not valid UTF-8`);
    }
  }

  finish(what: string): void {
    if (this.remaining !== 0) {
      throw new CullError('invalid-value', `${what}: ${this.remaining} trailing bytes`);
    }
  }
}

// ---------------------------------------------------------------------------
// Header and table

function parseHeader(bytes: Uint8Array): { version: number; flags: number; sectionCount: number } {
  const c = new Cursor(bytes, HEADER_LEN);
  const magic = String.fromCharCode(c.u8('magic'), c.u8('magic'), c.u8('magic'), c.u8('magic'));
  if (magic !== MAGIC) {
    throw new CullError('bad-magic', `magic ${JSON.stringify(magic)} != "CULL"`);
  }
  const version = c.u16('version');
  if (version !== VERSION) {
    throw new CullError('unsupported-version', `version ${version} != ${VERSION}`);
  }
  const flags = c.u16('flags');
  const sectionCount = c.u32('section_count');
  const headerCrc = c.u32('header_crc32');
  const actual = crc32(bytes.subarray(0, CRC_COVERED_LEN));
  if (actual !== headerCrc) {
    throw new CullError(
      'header-crc-mismatch',
      `header crc32 0x${headerCrc.toString(16)} != recomputed 0x${actual.toString(16)}`,
    );
  }
  if (sectionCount > MAX_SECTION_COUNT) {
    throw new CullError(
      'too-many-sections',
      `section_count ${sectionCount} > ${MAX_SECTION_COUNT}`,
    );
  }
  if (sectionCount === 0) {
    throw new CullError('invalid-value', 'section_count must be at least 1');
  }
  return { version, flags, sectionCount };
}

function parseEntry(bytes: Uint8Array, index: number): SectionEntry {
  const c = new Cursor(bytes, SECTION_ENTRY_LEN);
  const kind = c.u32('section kind');
  const compressionCode = c.u8('compression');
  const entryFlags = c.u8('flags');
  const reserved = c.u16('reserved');
  const offset = c.u64('offset');
  const storedLen = c.u64('stored_len');
  const decodedLen = c.u32('decoded_len');
  const crc = c.u32('crc32');
  c.finish('section entry');

  if (compressionCode !== COMPRESSION_NONE && compressionCode !== COMPRESSION_ZLIB) {
    throw new CullError(
      'unsupported-compression',
      `section ${index}: compression code ${compressionCode} not in {0, 1}`,
      index,
    );
  }
  // The flags byte: bit 0 is `critical`, meaningful only for unknown section
  // kinds (SPEC.md §1.2 — a critical unknown section MUST be rejected; a
  // noncritical one is skipped). Reserved bits 1..7 must be zero, and known
  // kinds must carry no flags at all.
  const knownKind = kind >= MIN_SECTION_KIND && kind <= MAX_SECTION_KIND;
  if ((entryFlags & 0xfe) !== 0 || reserved !== 0 || (knownKind && entryFlags !== 0)) {
    throw new CullError(
      'invalid-flags',
      `section ${index}: reserved flags/reserved bits must be zero`,
      index,
    );
  }
  if (decodedLen > MAX_SECTION_DECODED_LEN) {
    throw new CullError(
      'decoded-len-exceeded',
      `section ${index}: decoded_len ${decodedLen} > ${MAX_SECTION_DECODED_LEN}`,
      index,
    );
  }
  if (decodedLen === 0) {
    throw new CullError('invalid-value', `section ${index}: decoded_len must be at least 1`, index);
  }
  return {
    index,
    kind,
    compression: compressionCode,
    flags: entryFlags,
    offset,
    storedLen,
    decodedLen,
    crc32: crc,
  };
}

/**
 * Validate the container structure (header + section table) without decoding
 * payloads. Synchronous — the entry point for streaming loads and the
 * truncation corpus.
 */
export function validateStructure(bytes: Uint8Array): Result<{
  version: number;
  flags: number;
  entries: SectionEntry[];
}> {
  return attempt(() => {
    if (bytes.length < HEADER_LEN) {
      throw new CullError('too-short', `package is ${bytes.length} bytes; header needs 16`);
    }
    if (bytes.length > MAX_FILE_LEN) {
      throw new CullError('invalid-value', `file exceeds the ${MAX_FILE_LEN}-byte cap`);
    }
    const header = parseHeader(bytes);
    const tableLen = header.sectionCount * SECTION_ENTRY_LEN;
    const tableEnd = HEADER_LEN + tableLen;
    if (bytes.length < tableEnd) {
      throw new CullError(
        'truncated',
        `section table ends at ${tableEnd}, file is ${bytes.length}`,
      );
    }
    const entries: SectionEntry[] = [];
    for (let i = 0; i < header.sectionCount; i++) {
      const start = HEADER_LEN + i * SECTION_ENTRY_LEN;
      entries.push(parseEntry(bytes.subarray(start, start + SECTION_ENTRY_LEN), i));
    }
    for (const entry of entries) {
      const end = entry.offset + entry.storedLen;
      if (!Number.isSafeInteger(end) || end > bytes.length) {
        throw new CullError(
          'out-of-bounds',
          `section ${entry.index}: offset ${entry.offset} + stored_len ${entry.storedLen} exceeds file size ${bytes.length}`,
          entry.index,
        );
      }
    }
    return { version: header.version, flags: header.flags, entries };
  });
}

// ---------------------------------------------------------------------------
// Section payload decoding

/** Decode a payload, or hand back the raw view for uncompressed sections. */
async function decodePayload(bytes: Uint8Array, entry: SectionEntry): Promise<Uint8Array> {
  const stored = bytes.subarray(entry.offset, entry.offset + entry.storedLen);
  if (entry.compression === Compression.Zlib) {
    return inflateVerified(stored, entry.decodedLen, entry.index);
  }
  if (stored.length !== entry.decodedLen) {
    throw new CullError(
      'decompress-mismatch',
      `section ${entry.index}: stored ${stored.length} bytes but decoded_len ${entry.decodedLen} (uncompressed)`,
      entry.index,
    );
  }
  return stored;
}

/** Strict JSON object parser for the INFO subset (SPEC.md §2.1). */
class InfoJson {
  private pos = 0;

  constructor(private readonly text: string) {}

  /** The parse position (exposed for trailing-data checks). */
  get position(): number {
    return this.pos;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) {
      throw new CullError(
        'invalid-value',
        `INFO JSON: expected '${ch}' at ${this.pos}, found ${JSON.stringify(this.text[this.pos])}`,
      );
    }
    this.pos++;
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw new CullError('invalid-value', 'INFO JSON: unterminated string');
      }
      this.pos++;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.pos];
        if (esc === undefined) {
          throw new CullError('invalid-value', 'INFO JSON: unterminated escape');
        }
        this.pos++;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'u': {
            const hex4 = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex4)) {
              throw new CullError('invalid-value', `INFO JSON: bad \\u escape at ${this.pos}`);
            }
            this.pos += 4;
            out += String.fromCharCode(parseInt(hex4, 16));
            break;
          }
          default:
            throw new CullError('invalid-value', `INFO JSON: bad escape \\${esc}`);
        }
      } else {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x20) {
          throw new CullError('invalid-value', 'INFO JSON: raw control character in string');
        }
        out += ch;
      }
    }
  }

  /** Parse `{ "key": value, ... }` with integer/string values, no whitespace. */
  parseObject(): Map<string, number | string> {
    this.expect('{');
    const out = new Map<string, number | string>();
    if (this.peek() === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      const key = this.parseString();
      if (out.has(key)) {
        throw new CullError('invalid-value', `INFO JSON: duplicate key ${JSON.stringify(key)}`);
      }
      this.expect(':');
      out.set(key, this.parseValue());
      const ch = this.peek();
      if (ch === '}') {
        this.pos++;
        return out;
      }
      if (ch !== ',') {
        throw new CullError('invalid-value', `INFO JSON: expected ',' or '}' at ${this.pos}`);
      }
      this.pos++;
    }
  }

  private parseValue(): number | string {
    const ch = this.peek();
    if (ch === '"') return this.parseString();
    if (ch !== undefined && ch >= '0' && ch <= '9') {
      let end = this.pos;
      while (end < this.text.length && this.text[end]! >= '0' && this.text[end]! <= '9') end++;
      const digits = this.text.slice(this.pos, end);
      this.pos = end;
      const value = parseInt(digits, 10);
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new CullError(
          'invalid-value',
          `INFO JSON: integer exceeds safe range at ${this.pos}`,
        );
      }
      return value;
    }
    throw new CullError('invalid-value', `INFO JSON: unexpected value at ${this.pos}`);
  }
}

const LOWER_HEX = /^[0-9a-f]+$/;

function decodeInfo(payload: Uint8Array): Info {
  if (payload.length > MAX_INFO_LEN) {
    throw new CullError('invalid-value', `INFO payload ${payload.length} bytes > ${MAX_INFO_LEN}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new CullError('invalid-utf8', 'INFO payload is not valid UTF-8');
  }
  if (text.trim() !== text) {
    throw new CullError('invalid-value', 'INFO JSON must not contain whitespace');
  }
  const parser = new InfoJson(text);
  const object = parser.parseObject();
  if (parser.position !== text.length) {
    throw new CullError('invalid-value', 'INFO JSON: trailing data');
  }

  const num = (key: string): number => {
    const v = object.get(key);
    if (typeof v !== 'number') {
      throw new CullError(
        'invalid-value',
        `INFO: missing or non-integer key ${JSON.stringify(key)}`,
      );
    }
    return v;
  };
  const str = (key: string): string => {
    const v = object.get(key);
    if (typeof v !== 'string') {
      throw new CullError(
        'invalid-value',
        `INFO: missing or non-string key ${JSON.stringify(key)}`,
      );
    }
    return v;
  };

  const formatVersion = num('format_version');
  if (formatVersion !== VERSION) {
    throw new CullError(
      'unsupported-version',
      `INFO format_version ${formatVersion} != ${VERSION}`,
    );
  }
  const generator = str('generator');
  const generatorVersion = str('generator_version');
  const sourceDigest = str('source_digest');
  const documentId = str('document_id');
  const title = object.get('title');
  const lang = object.get('lang');
  if (title !== undefined && typeof title !== 'string') {
    throw new CullError('invalid-value', 'INFO: title must be a string when present');
  }
  if (lang !== undefined && typeof lang !== 'string') {
    throw new CullError('invalid-value', 'INFO: lang must be a string when present');
  }
  if (sourceDigest.length !== 64 || !LOWER_HEX.test(sourceDigest)) {
    throw new CullError('invalid-value', 'INFO: source_digest must be 64 lowercase hex chars');
  }
  if (documentId.length !== 32 || !LOWER_HEX.test(documentId)) {
    throw new CullError('invalid-value', 'INFO: document_id must be 32 lowercase hex chars');
  }
  const count = (key: string): number => {
    const v = num(key);
    if (v > 0xffffffff) {
      throw new CullError('invalid-value', `INFO: ${key} exceeds u32 range`);
    }
    return v;
  };

  return {
    formatVersion,
    generator,
    generatorVersion,
    sourceDigest,
    documentId,
    ...(title !== undefined ? { title } : {}),
    ...(lang !== undefined ? { lang } : {}),
    chunkCount: count('chunk_count'),
    styleCount: count('style_count'),
    contentCount: count('content_count'),
    atlasCount: count('atlas_count'),
    imageCount: count('image_count'),
  } satisfies Info;
}

/** Chunk kinds that are structural wrappers (SPEC.md §2.2). */
function isStructural(kind: ChunkKind): boolean {
  return (
    kind === ChunkKind.Document ||
    kind === ChunkKind.List ||
    kind === ChunkKind.Table ||
    kind === ChunkKind.TableRow
  );
}

/** All valid chunk flag bits (SPEC.md §2.2). */
const CHUNK_FLAGS_ALL = 0x1f;
/** All valid glyph flag bits (SPEC.md §2.5). */
const GLYPH_FLAGS_ALL = 0x03;

function decodeChnk(payload: Uint8Array): { chunks: ChunkRecord[]; extras: ChunkExtra[] } {
  const c = new Cursor(payload);
  const chunkCount = c.u32('chunk count');
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw new CullError('invalid-value', `chunk count ${chunkCount} > ${MAX_CHUNK_COUNT}`);
  }
  const chunks: ChunkRecord[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const rec = c.bytes(CHUNK_RECORD_LEN, 'chunk record');
    const r = new Cursor(rec);
    const id = r.u32('chunk id');
    if (id !== i + 1) {
      throw new CullError('invalid-value', `chunk ${i}: id ${id} != dense id ${i + 1}`);
    }
    const kindValue = r.u8('chunk kind');
    if (kindValue < MIN_CHUNK_KIND || kindValue > MAX_CHUNK_KIND) {
      throw new CullError('invalid-value', `chunk ${i}: unknown kind ${kindValue}`);
    }
    const kind: ChunkKind = kindValue;
    const flags = r.u8('chunk flags');
    const reserved = r.u16('chunk reserved');
    const styleId = r.u32('chunk style_id');
    const parentId = r.u32('chunk parent_id');
    const prevId = r.u32('chunk prev_id');
    const nextId = r.u32('chunk next_id');
    const firstChildId = r.u32('chunk first_child_id');
    const lastChildId = r.u32('chunk last_child_id');
    const contentIndex = r.u32('chunk content_index');
    const ordinal = r.u32('chunk ordinal');
    const depth = r.u32('chunk depth');
    r.finish('chunk record');
    if (reserved !== 0) {
      throw new CullError('invalid-flags', `chunk ${i}: reserved bits set`);
    }
    if ((flags & ~CHUNK_FLAGS_ALL) !== 0) {
      throw new CullError('invalid-value', `chunk ${i}: unknown flag bits 0x${flags.toString(16)}`);
    }
    if (depth > MAX_CHUNK_DEPTH) {
      throw new CullError('invalid-value', `chunk ${i}: depth ${depth} > ${MAX_CHUNK_DEPTH}`);
    }
    if (isStructural(kind) !== ((flags & CHUNK_FLAG_STRUCTURAL) !== 0)) {
      throw new CullError(
        'invalid-value',
        `chunk ${i}: structural flag does not match kind ${kind}`,
      );
    }
    chunks.push({
      id,
      kind,
      flags,
      styleId,
      parentId,
      prevId,
      nextId,
      firstChildId,
      lastChildId,
      contentIndex,
      ordinal,
      depth,
    });
  }

  const extraCount = c.u32('extra count');
  if (extraCount > MAX_EXTRA_COUNT) {
    throw new CullError('invalid-value', `extra count ${extraCount} > ${MAX_EXTRA_COUNT}`);
  }
  const extras: ChunkExtra[] = [];
  for (let i = 0; i < extraCount; i++) {
    const chunkId = c.u32('extra chunk id');
    if (chunkId === 0 || chunkId > chunkCount) {
      throw new CullError('invalid-value', `extra ${i}: chunk id ${chunkId} out of range`);
    }
    const kindValue = c.u8('extra kind');
    if (kindValue < MIN_EXTRA_KIND || kindValue > MAX_EXTRA_KIND) {
      throw new CullError('invalid-value', `extra ${i}: unknown kind ${kindValue}`);
    }
    const kind: ExtraKind = kindValue;
    const flags = c.u8('extra flags');
    const dataLen = c.u16('extra data len');
    if (flags !== 0) {
      throw new CullError('invalid-flags', `extra ${i}: flags set`);
    }
    const data = c.bytes(dataLen, 'extra data');
    switch (kind) {
      case ExtraKind.LinkTarget: {
        const ec = new Cursor(data);
        const urlLen = ec.u16('link url len');
        const url = ec.utf8(urlLen, 'link url');
        ec.finish('link target extra');
        extras.push({ chunkId, kind, data: { kind, url } });
        break;
      }
      case ExtraKind.CellSpan: {
        const ec = new Cursor(data);
        const colspan = ec.u16('colspan');
        const rowspan = ec.u16('rowspan');
        ec.finish('cell span extra');
        if (colspan === 0 || rowspan === 0) {
          throw new CullError('invalid-value', `extra ${i}: colspan/rowspan must be >= 1`);
        }
        extras.push({ chunkId, kind, data: { kind, colspan, rowspan } });
        break;
      }
      case ExtraKind.ListItemValue: {
        if (data.length !== 4) {
          throw new CullError('invalid-value', `extra ${i}: list item value must be 4 bytes`);
        }
        const ec = new Cursor(data);
        const value = ec.u32('list item value');
        extras.push({ chunkId, kind, data: { kind, value } });
        break;
      }
      case ExtraKind.ImageAlt: {
        let alt: string;
        try {
          alt = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } catch {
          throw new CullError('invalid-utf8', `extra ${i}: image alt is not valid UTF-8`);
        }
        extras.push({ chunkId, kind, data: { kind, alt } });
        break;
      }
    }
  }
  c.finish('CHNK payload');
  return { chunks, extras };
}

/** Property tags whose 4-byte value is an integer, not an f32 (SPEC.md §2.3). */
function decodeStyl(payload: Uint8Array): StyleRecord[] {
  const c = new Cursor(payload);
  const styleCount = c.u32('style count');
  if (styleCount > MAX_STYLE_COUNT) {
    throw new CullError('invalid-value', `style count ${styleCount} > ${MAX_STYLE_COUNT}`);
  }
  const styles: StyleRecord[] = [];
  for (let i = 0; i < styleCount; i++) {
    const id = c.u32('style id');
    if (id !== i) {
      throw new CullError('invalid-value', `style ${i}: id ${id} != dense id ${i}`);
    }
    const propertyCount = c.u16('style property count');
    const blobLen = c.u16('style blob len');
    if (propertyCount > MAX_PROPERTIES_PER_STYLE) {
      throw new CullError(
        'invalid-value',
        `style ${i}: ${propertyCount} properties > ${MAX_PROPERTIES_PER_STYLE}`,
      );
    }
    const blob = new Cursor(c.bytes(blobLen, 'style blob'));
    const properties: StyleProperties = {};
    for (let p = 0; p < propertyCount; p++) {
      const tagValue = blob.u16('property tag');
      if (tagValue < MIN_PROPERTY_TAG || tagValue > MAX_PROPERTY_TAG) {
        throw new CullError('invalid-value', `style ${i}: unknown property tag ${tagValue}`);
      }
      const tag: PropertyTag = tagValue;
      switch (tag) {
        case PropertyTag.FontId:
          properties.fontId = blob.u32('property value');
          break;
        case PropertyTag.FontSizePx:
          properties.fontSizePx = blob.f32('property value');
          break;
        case PropertyTag.LineHeight:
          properties.lineHeight = blob.f32('property value');
          break;
        case PropertyTag.FontWeight:
          properties.fontWeight = blob.u16('property value');
          break;
        case PropertyTag.Italic:
          properties.italic = blob.u8('property value');
          break;
        case PropertyTag.Color:
          properties.color = blob.u32('property value');
          break;
        case PropertyTag.BackgroundColor:
          properties.backgroundColor = blob.u32('property value');
          break;
        case PropertyTag.MarginTop:
          properties.marginTop = blob.f32('property value');
          break;
        case PropertyTag.MarginBottom:
          properties.marginBottom = blob.f32('property value');
          break;
        case PropertyTag.TextAlign:
          properties.textAlign = blob.u8('property value');
          break;
        case PropertyTag.TextIndent:
          properties.textIndent = blob.f32('property value');
          break;
        case PropertyTag.ListStyle:
          properties.listStyle = blob.u8('property value');
          break;
        case PropertyTag.Code:
          properties.code = blob.u8('property value');
          break;
        case PropertyTag.Underline:
          properties.underline = blob.u8('property value');
          break;
        case PropertyTag.LetterSpacing:
          properties.letterSpacing = blob.f32('property value');
          break;
        case PropertyTag.WhiteSpace:
          properties.whiteSpace = blob.u8('property value');
          break;
        default:
          // Unreachable: `tag` is range-checked above.
          throw new CullError('internal', `unhandled property tag ${tagValue}`);
      }
    }
    blob.finish('style blob');
    styles.push({ id, properties });
  }
  c.finish('STYL payload');
  return styles;
}

function decodeCont(payload: Uint8Array): ContentPayload[] {
  const c = new Cursor(payload);
  const payloadCount = c.u32('payload count');
  if (payloadCount > MAX_CONTENT_COUNT) {
    throw new CullError('invalid-value', `payload count ${payloadCount} > ${MAX_CONTENT_COUNT}`);
  }
  const out: ContentPayload[] = [];
  for (let i = 0; i < payloadCount; i++) {
    const id = c.u32('payload id');
    if (id !== i) {
      throw new CullError('invalid-value', `payload ${i}: id ${id} != dense id ${i}`);
    }
    const kindValue = c.u8('payload kind');
    if (kindValue !== KIND_TEXT && kindValue !== KIND_IMAGE_REF) {
      throw new CullError('invalid-value', `payload ${i}: unknown kind ${kindValue}`);
    }
    const kind: PayloadKind = kindValue;
    const flags = c.u8('payload flags');
    const reserved = c.u16('payload reserved');
    const dataLen = c.u32('payload data len');
    if (flags !== 0 || reserved !== 0) {
      throw new CullError('invalid-flags', `payload ${i}: reserved bits set`);
    }
    const data = c.bytes(dataLen, 'payload data');
    if (kind === PayloadKind.TextUtf8) {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw new CullError('invalid-utf8', `payload ${i}: text is not valid UTF-8`);
      }
      out.push({ id, kind, text });
    } else {
      if (data.length !== 4) {
        throw new CullError(
          'invalid-value',
          `payload ${i}: image_ref must be 4 bytes, got ${data.length}`,
        );
      }
      const ec = new Cursor(data);
      out.push({ id, kind, imageId: ec.u32('image id') });
    }
  }
  c.finish('CONT payload');
  return out;
}

function decodeGlyf(payload: Uint8Array): Atlas[] {
  const c = new Cursor(payload);
  const atlasCount = c.u32('atlas count');
  if (atlasCount > MAX_ATLAS_COUNT) {
    throw new CullError('invalid-value', `atlas count ${atlasCount} > ${MAX_ATLAS_COUNT}`);
  }
  const atlases: Atlas[] = [];
  for (let a = 0; a < atlasCount; a++) {
    const fontId = c.u32('atlas font_id');
    const glyphCount = c.u32('atlas glyph count');
    const pageCount = c.u16('atlas page count');
    const format = c.u8('atlas format');
    const flags = c.u8('atlas flags');
    const padding = c.u16('atlas padding');
    const texelsPerEmRaw = c.u32('atlas texels_per_em');
    const ascent = c.f32('atlas ascent');
    const descent = c.f32('atlas descent');
    const lineGap = c.f32('atlas line_gap');
    const capHeight = c.f32('atlas cap_height');
    const xHeight = c.f32('atlas x_height');
    const unitsPerEm = c.f32('atlas units_per_em');
    const familyLen = c.u16('atlas family len');
    if (familyLen > MAX_FAMILY_LEN) {
      throw new CullError(
        'invalid-value',
        `atlas ${a}: family len ${familyLen} > ${MAX_FAMILY_LEN}`,
      );
    }
    const family = c.utf8(familyLen, 'atlas family');
    const weight = c.u16('atlas weight');
    const italicValue = c.u8('atlas italic');
    const reserved = c.u8('atlas reserved');
    const pageWidth = c.u32('atlas page_width');
    const pageHeight = c.u32('atlas page_height');

    if (flags !== 0 || reserved !== 0) {
      throw new CullError('invalid-flags', `atlas ${a}: reserved bits set`);
    }
    if (format !== 0) {
      throw new CullError('invalid-value', `atlas ${a}: format ${format} != 0 (MSDF_RGBA8)`);
    }
    if (texelsPerEmRaw === 0) {
      throw new CullError('invalid-value', `atlas ${a}: texels_per_em must be >= 1`);
    }
    if (weight < 100 || weight > 900) {
      throw new CullError('invalid-value', `atlas ${a}: weight ${weight} outside 100..=900`);
    }
    if (italicValue > 1) {
      throw new CullError('invalid-value', `atlas ${a}: italic ${italicValue} not in {0,1}`);
    }
    if (
      pageWidth === 0 ||
      pageHeight === 0 ||
      pageWidth > MAX_PAGE_DIM ||
      pageHeight > MAX_PAGE_DIM
    ) {
      throw new CullError(
        'invalid-value',
        `atlas ${a}: page ${pageWidth}x${pageHeight} outside 1..=${MAX_PAGE_DIM}`,
      );
    }
    for (const v of [ascent, descent, lineGap, capHeight, xHeight, unitsPerEm]) {
      if (!Number.isFinite(v) || v < 0) {
        throw new CullError('invalid-value', `atlas ${a}: non-finite or negative metric`);
      }
    }
    if (glyphCount > MAX_GLYPH_COUNT) {
      throw new CullError(
        'invalid-value',
        `atlas ${a}: glyph count ${glyphCount} > ${MAX_GLYPH_COUNT}`,
      );
    }

    const glyphs = new Map<number, GlyphRecord>();
    for (let g = 0; g < glyphCount; g++) {
      const rec = new Cursor(c.bytes(GLYPH_RECORD_LEN, 'glyph record'));
      const codepoint = rec.u32('glyph codepoint');
      const advance = rec.f32('glyph advance');
      const bearingX = rec.f32('glyph bearing_x');
      const bearingY = rec.f32('glyph bearing_y');
      const boxX = rec.u16('glyph box_x');
      const boxY = rec.u16('glyph box_y');
      const boxW = rec.u16('glyph box_w');
      const boxH = rec.u16('glyph box_h');
      const pageIndex = rec.u16('glyph page_index');
      const glyphFlags = rec.u8('glyph flags');
      const glyphReserved = rec.u8('glyph reserved');
      const glyphReserved2 = rec.u32('glyph reserved2');
      rec.finish('glyph record');
      if (glyphReserved !== 0 || glyphReserved2 !== 0) {
        throw new CullError('invalid-flags', `atlas ${a}: glyph ${g}: reserved bits set`);
      }
      if ((glyphFlags & ~GLYPH_FLAGS_ALL) !== 0) {
        throw new CullError('invalid-value', `atlas ${a}: glyph ${g}: unknown flag bits`);
      }
      if (codepoint > 0x10ffff) {
        throw new CullError('invalid-value', `atlas ${a}: glyph ${g}: codepoint out of range`);
      }
      if (boxW === 0 || boxH === 0) {
        throw new CullError('invalid-value', `atlas ${a}: glyph ${g}: zero box dimension`);
      }
      for (const v of [advance, bearingX, bearingY]) {
        if (!Number.isFinite(v)) {
          throw new CullError('invalid-value', `atlas ${a}: glyph ${g}: non-finite metric`);
        }
      }
      if (glyphs.has(codepoint)) {
        throw new CullError('invalid-value', `atlas ${a}: duplicate glyph codepoint ${codepoint}`);
      }
      if (pageIndex >= pageCount) {
        throw new CullError(
          'invalid-value',
          `atlas ${a}: glyph ${g}: page ${pageIndex} out of range`,
        );
      }
      if (boxX + boxW > pageWidth || boxY + boxH > pageHeight) {
        throw new CullError('invalid-value', `atlas ${a}: glyph ${g}: box exceeds page bounds`);
      }
      glyphs.set(codepoint, {
        codepoint,
        advance,
        bearingX,
        bearingY,
        boxX,
        boxY,
        boxW,
        boxH,
        pageIndex,
        noOutline: (glyphFlags & 0x01) !== 0,
        combining: (glyphFlags & 0x02) !== 0,
      });
    }

    const kerningCount = c.u32('kerning count');
    if (kerningCount > MAX_KERNING_COUNT) {
      throw new CullError(
        'invalid-value',
        `atlas ${a}: kerning count ${kerningCount} > ${MAX_KERNING_COUNT}`,
      );
    }
    const kerning = new Map<number, Map<number, number>>();
    let prev: [number, number] | undefined;
    for (let k = 0; k < kerningCount; k++) {
      const left = c.u32('kerning left');
      const right = c.u32('kerning right');
      const adjust = c.f32('kerning adjust');
      if (!Number.isFinite(adjust)) {
        throw new CullError('invalid-value', `atlas ${a}: kerning ${k}: non-finite adjust`);
      }
      if (prev !== undefined && (left < prev[0] || (left === prev[0] && right <= prev[1]))) {
        throw new CullError('invalid-value', `atlas ${a}: kerning pairs out of order`);
      }
      prev = [left, right];
      let inner = kerning.get(left);
      if (inner === undefined) {
        inner = new Map<number, number>();
        kerning.set(left, inner);
      }
      inner.set(right, adjust);
    }

    const pageBytes = pageWidth * pageHeight * 4;
    const pages: Uint8Array[] = [];
    for (let p = 0; p < pageCount; p++) {
      pages.push(c.bytes(pageBytes, 'atlas page'));
    }

    atlases.push({
      fontId,
      pageCount,
      padding,
      texelsPerEmRaw,
      ascent,
      descent,
      lineGap,
      capHeight,
      xHeight,
      unitsPerEm,
      family,
      weight,
      italic: italicValue !== 0,
      pageWidth,
      pageHeight,
      glyphs,
      kerning,
      pages,
    });
  }
  c.finish('GLYF payload');
  return atlases;
}

function decodeImgs(payload: Uint8Array): ImageRecord[] {
  const c = new Cursor(payload);
  const imageCount = c.u32('image count');
  if (imageCount > MAX_IMAGE_COUNT) {
    throw new CullError('invalid-value', `image count ${imageCount} > ${MAX_IMAGE_COUNT}`);
  }
  const images: ImageRecord[] = [];
  for (let i = 0; i < imageCount; i++) {
    const id = c.u32('image id');
    if (id !== i) {
      throw new CullError('invalid-value', `image ${i}: id ${id} != dense id ${i}`);
    }
    const width = c.u16('image width');
    const height = c.u16('image height');
    const format = c.u8('image format');
    const flags = c.u8('image flags');
    const byteLen = c.u32('image byte len');
    if (flags !== 0) {
      throw new CullError('invalid-flags', `image ${i}: flags set`);
    }
    if (format !== 0 && format !== 1) {
      throw new CullError('invalid-value', `image ${i}: format ${format} not in {0,1}`);
    }
    if (width === 0 || height === 0 || width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
      throw new CullError('invalid-value', `image ${i}: dimension ${width}x${height} out of range`);
    }
    const bpp = format === 0 ? 4 : 3;
    const expected = width * height * bpp;
    if (byteLen !== expected) {
      throw new CullError(
        'invalid-value',
        `image ${i}: byte_len ${byteLen} != ${expected} (${width}x${height}x${bpp})`,
      );
    }
    images.push({ id, width, height, format, data: c.bytes(expected, 'image data') });
  }
  c.finish('IMGS payload');
  return images;
}

function decodeSeal(payload: Uint8Array): Seal {
  const c = new Cursor(payload);
  const mode = c.u8('SEAL mode');
  const algo = c.u8('SEAL algo');
  const flags = c.u8('SEAL flags');
  const reserved = c.u8('SEAL reserved');
  const count = c.u32('SEAL count');
  if (mode !== SEAL_MODE_HASH_TREE) {
    throw new CullError('invalid-value', `SEAL mode ${mode} != 1 (hash tree)`);
  }
  if (algo !== SEAL_ALGO_SHA256) {
    throw new CullError('unsupported-algorithm', `SEAL algo ${algo} != 0 (SHA-256)`);
  }
  if (flags !== 0 || reserved !== 0) {
    throw new CullError('invalid-flags', 'SEAL flags/reserved bits set');
  }
  if (count > MAX_COVERED_SECTIONS) {
    throw new CullError('invalid-value', `SEAL count ${count} > ${MAX_COVERED_SECTIONS}`);
  }
  const hashes: SectionHash[] = [];
  for (let i = 0; i < count; i++) {
    const kind = c.u32('SEAL section kind');
    hashes.push({ kind, hash: c.bytes(OVERALL_HASH_LEN, 'SEAL digest') });
  }
  const overall = c.bytes(OVERALL_HASH_LEN, 'SEAL overall');
  c.finish('SEAL payload');
  return { mode, algo, hashes, overall: Uint8Array.from(overall) };
}

/** Verify the SEAL over all known non-SEAL sections (SPEC.md §2.7). */
function verifySeal(
  seal: Seal,
  bytes: Uint8Array,
  covered: { kind: number; payload: Uint8Array }[],
): void {
  // Per-section hashes.
  const expected = new Map<number, Uint8Array>();
  for (const { kind, payload } of covered) {
    expected.set(kind, sha256(payload));
  }
  if (seal.hashes.length !== covered.length) {
    throw new CullError(
      'seal-mismatch',
      `SEAL covers ${seal.hashes.length} sections, package has ${covered.length}`,
    );
  }
  for (const entry of seal.hashes) {
    const actual = expected.get(entry.kind);
    if (actual === undefined || !bytesEqual(actual, entry.hash)) {
      throw new CullError('seal-mismatch', `SEAL section hash mismatch for kind ${entry.kind}`);
    }
  }

  // Overall hash: header bytes 0..12, then per covered section in canonical
  // kind order: kind (u32 LE) + decoded_len (u32 LE) + payload.
  const canonical = [...covered].sort((a, b) => a.kind - b.kind);
  const hasher = new Sha256Accum();
  hasher.update(bytes.subarray(0, CRC_COVERED_LEN));
  for (const { kind, payload } of canonical) {
    const kindBytes = new Uint8Array(4);
    new DataView(kindBytes.buffer).setUint32(0, kind, true);
    hasher.update(kindBytes);
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, payload.length, true);
    hasher.update(lenBytes);
    hasher.update(payload);
  }
  const overall = hasher.digest();
  if (!bytesEqual(overall, seal.overall)) {
    throw new CullError('seal-mismatch', 'SEAL overall hash mismatch');
  }
}

class Sha256Accum {
  private chunks: Uint8Array[] = [];
  private length = 0;

  update(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  digest(): Uint8Array {
    const joined = new Uint8Array(this.length);
    let off = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, off);
      off += chunk.length;
    }
    return sha256(joined);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Top-level entry points

/**
 * Parse and fully validate a package (SPEC.md §1.6): container structure,
 * per-section decompression + CRC-32, section payload decoding, and SEAL
 * verification. Every failure is a typed `CullError` inside the result.
 */
export async function readPackage(bytes: Uint8Array): Promise<Result<Package>> {
  try {
    const structure = validateStructure(bytes);
    if (!structure.ok) return structure;
    const { version, flags, entries } = structure.value;

    const sections = new Map<number, Uint8Array>();
    const unknown: { kind: number; payload: Uint8Array }[] = [];
    let totalDecoded = 0;
    // Canonical-order enforcement for the known sections (SPEC.md §1.6): their
    // kinds must be strictly increasing in file order; unknown kinds may appear
    // anywhere.
    let lastKnownKind = 0;
    for (const entry of entries) {
      const payload = await decodePayload(bytes, entry);
      totalDecoded += payload.length;
      if (totalDecoded > MAX_TOTAL_DECODED) {
        throw new CullError('invalid-value', `total decoded size exceeds ${MAX_TOTAL_DECODED}`);
      }
      const actualCrc = crc32(payload);
      if (actualCrc !== entry.crc32) {
        throw new CullError(
          'crc-mismatch',
          `section ${entry.index}: crc32 0x${entry.crc32.toString(16)} != recomputed 0x${actualCrc.toString(16)}`,
          entry.index,
        );
      }
      if (entry.kind >= MIN_SECTION_KIND && entry.kind <= MAX_SECTION_KIND) {
        if (sections.has(entry.kind)) {
          throw new CullError(
            'duplicate-section',
            `duplicate section kind ${entry.kind}`,
            entry.index,
          );
        }
        if (lastKnownKind !== 0 && entry.kind <= lastKnownKind) {
          throw new CullError(
            'invalid-section-order',
            `section ${entry.index}: kind ${entry.kind} appears after ${lastKnownKind} (canonical order violated)`,
            entry.index,
          );
        }
        lastKnownKind = entry.kind;
        sections.set(entry.kind, payload);
      } else {
        // Unknown kind: noncritical sections (flags bit 0 clear) are skipped for
        // forward compatibility; a critical unknown section is rejected
        // (SPEC.md §1.2, §4).
        if ((entry.flags & 0x01) !== 0) {
          throw new CullError(
            'unknown-critical-section',
            `section ${entry.index}: unknown kind ${entry.kind} marked critical`,
            entry.index,
          );
        }
        unknown.push({ kind: entry.kind, payload });
      }
    }

    // INFO is the required section: every conforming v1 package carries it.
    if (!sections.has(SectionKind.Info)) {
      throw new CullError('missing-required-section', 'required INFO section is absent');
    }

    // SEAL verification: covers every known non-SEAL section (canonical order).
    if (sections.has(SectionKind.Seal)) {
      const seal = decodeSeal(sections.get(SectionKind.Seal)!);
      const covered: { kind: number; payload: Uint8Array }[] = [];
      for (const [kind, payload] of sections) {
        if (kind !== SEAL_KIND) covered.push({ kind, payload });
      }
      verifySeal(seal, bytes, covered);
    }

    const pkg = new Package(bytes, version, flags, entries, sections, unknown);
    return { ok: true, value: pkg };
  } catch (e) {
    if (e instanceof CullError) {
      return { ok: false, error: e };
    }
    return { ok: false, error: new CullError('internal', `internal reader failure: ${String(e)}`) };
  }
}
