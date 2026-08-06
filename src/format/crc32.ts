//! CRC-32 (IEEE 802.3, zlib polynomial 0xEDB88320) — table-driven.
//!
//! Independent implementation of the container integrity primitive
//! (SPEC.md §1). The algorithm processes bytes least-significant-bit
//! first with reflected polynomial `0xEDB88320`, initial value `0xFFFFFFFF`,
//! and final XOR `0xFFFFFFFF` — the standard zlib/PNG CRC-32.

/** The reflected polynomial table, built once. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
