//! zlib (RFC 1950) decompression with explicit stream verification.
//!
//! The platform's `DecompressionStream('deflate')` performs the inflate
//! (deterministic, available in every modern browser and Node ≥ 18); this
//! module owns the SPEC-mandated verification (SPEC.md §1.5) so it does
//! not depend on the platform's error behavior:
//!
//! 1. The two-byte zlib header is validated before decompression:
//!    `CMF & 0x0F == 8` and `(CMF << 8 | FLG) % 31 == 0`.
//! 2. The trailing four bytes of the stored stream are the Adler-32 of the
//!    decoded output; it is recomputed and compared explicitly.
//! 3. The decoded length must equal the container's authoritative
//!    `decoded_len`.
//!
//! Truncated or corrupted stored streams therefore always surface as typed
//! `CullError`s, never as silent or platform-shaped failures.

import { adler32 } from './adler32.js';
import { CullError, sectionError } from './errors.js';

/** Validate the RFC 1950 two-byte zlib header. */
export function checkZlibHeader(stream: Uint8Array, section: number): void {
  if (stream.length < 2) {
    throw sectionError(
      'zlib-header-invalid',
      section,
      'stored stream shorter than the 2-byte header',
    );
  }
  const cmf = stream[0]!;
  const flg = stream[1]!;
  const cm = cmf & 0x0f;
  if (cm !== 8) {
    throw sectionError('zlib-header-invalid', section, `compression method ${cm} != 8 (deflate)`);
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw sectionError('zlib-header-invalid', section, 'header check bits (CMF<<8|FLG) % 31 != 0');
  }
}

/**
 * Inflate a zlib stream and verify header, decoded length, and Adler-32.
 *
 * @param stream  the stored payload bytes (must be a full zlib stream)
 * @param decodedLen  the container's authoritative decoded length
 * @param section  section table index, for error scoping
 */
export async function inflateVerified(
  stream: Uint8Array,
  decodedLen: number,
  section: number,
): Promise<Uint8Array> {
  checkZlibHeader(stream, section);
  if (stream.length < 6) {
    throw sectionError('truncated', section, 'stored stream shorter than the 4-byte Adler trailer');
  }
  const storedAdler = new DataView(stream.buffer, stream.byteOffset + stream.length - 4, 4);

  let decoded: Uint8Array;
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    // The stream may be backed by any ArrayBufferLike; the platform accepts all.
    const writeDone = writer.write(stream as unknown as BufferSource);
    const closeDone = writer.close();
    // Attach handlers immediately so platform-side failures (bad data,
    // truncation, Adler mismatch) can never surface as unhandled rejections.
    let platformError: unknown;
    writeDone.catch((e: unknown) => {
      platformError ??= e;
    });
    closeDone.catch((e: unknown) => {
      platformError ??= e;
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (e) {
        platformError ??= e;
        break;
      }
      if (result.done) break;
      const chunk = result.value;
      total += chunk.length;
      if (total > decodedLen + 1) {
        // Bounded accumulation: we know the authoritative length already.
        void reader.cancel();
        throw sectionError(
          'decompress-mismatch',
          section,
          `decoded stream exceeds authoritative decoded_len ${decodedLen}`,
        );
      }
      chunks.push(chunk);
    }
    await writeDone;
    await closeDone;
    if (platformError !== undefined) {
      const message =
        platformError instanceof Error
          ? platformError.message
          : typeof platformError === 'string'
            ? platformError
            : JSON.stringify(platformError);
      throw sectionError('decompress-mismatch', section, `inflate failed: ${message}`);
    }
    decoded = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      decoded.set(chunk, off);
      off += chunk.length;
    }
  } catch (e) {
    if (e instanceof CullError) throw e;
    throw sectionError('decompress-mismatch', section, `inflate failed: ${String(e)}`);
  }

  if (decoded.length !== decodedLen) {
    throw sectionError(
      'decompress-mismatch',
      section,
      `decoded ${decoded.length} bytes, authoritative decoded_len ${decodedLen}`,
    );
  }

  const expectedAdler = storedAdler.getUint32(0, false);
  const actualAdler = adler32(decoded);
  if (actualAdler !== expectedAdler) {
    throw sectionError(
      'zlib-adler-mismatch',
      section,
      `adler32 0x${expectedAdler.toString(16)} != recomputed 0x${actualAdler.toString(16)}`,
    );
  }

  return decoded;
}
