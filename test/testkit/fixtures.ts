//! Test fixture loader: reads the committed contract fixtures.
//!
//! The fixtures are compiler output (see `test/fixtures/README.md` for
//! provenance and the refresh script).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

/** The INFO-only minimal package (compiler `v1-minimal.cull`). */
export function v1Minimal(): Uint8Array {
  // Copy into a fresh Uint8Array: `readFileSync` returns a Buffer whose
  // `slice()` shares memory with a possibly non-zero byteOffset, which would
  // break DataView offsets in mutation tests.
  return new Uint8Array(readFileSync(join(fixturesDir, 'v1-minimal.cull')));
}

/** The full pipeline golden package (compiler `golden.cull`). */
export function pipelineGolden(): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, 'pipeline-golden.cull')));
}

/** The golden source markdown. */
export function goldenMarkdown(): string {
  return readFileSync(join(fixturesDir, 'golden.md'), 'utf8');
}

/** The golden user stylesheet used to compile `pipeline-golden.cull`. */
export const goldenCss = 'p { color: #336699; }\n';

/**
 * Expected diagnostics for `pipeline-golden.cull`, pinned from the compiler's
 * `cull inspect` output. Any drift in the fixture or the reader fails here.
 */
export const pipelineGoldenExpected = {
  documentId: '8d6fd4074ac6e80e41255d252504f9d1',
  sourceDigest: '47869ba2d830d7e8599b594a98b1e446f79f85a474f8760f22eb99ba0afc70f9',
  generator: 'glyphcull-compiler',
  chunkCount: 18,
  styleCount: 11,
  contentCount: 9,
  atlasCount: 3,
  imageCount: 0,
  /** Section kinds in file order. */
  sectionKinds: [1, 2, 3, 4, 5, 7],
  /** (font_id, weight, italic, glyphs, kerning, pageWidth) per atlas. */
  atlases: [
    { fontId: 0, weight: 400, italic: false, glyphs: 19, kerning: 10, pageWidth: 256 },
    { fontId: 1, weight: 400, italic: true, glyphs: 6, kerning: 0, pageWidth: 128 },
    { fontId: 2, weight: 700, italic: false, glyphs: 12, kerning: 8, pageWidth: 256 },
  ],
};
