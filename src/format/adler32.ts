//! Adler-32 (RFC 1950 §2.3) — the zlib stream checksum.
//!
//! The reader verifies the trailing Adler-32 of every zlib stream against
//! the decoded output (SPEC.md §1.5): the platform decompressor does not
//! expose it, and truncating the stored stream must never decode silently.

/** Adler-32 over `bytes` (mod 65521), as a 32-bit unsigned integer. */
export function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // Process in chunks to keep `a` and `b` within safe number range.
  const CHUNK = 5552; // largest n with n*(n+1)/2 < 2^31
  for (let base = 0; base < bytes.length; base += CHUNK) {
    const end = Math.min(base + CHUNK, bytes.length);
    for (let i = base; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}
