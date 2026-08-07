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
 *
 * NOTE: the fixture tracks the compiler's golden, which changed in the
 * compiler commit "Fix chunk partition dropping list-item, code-block, and
 * cell text" (22 chunks / 12 content: tight-list items and code blocks now
 * carry their text) and again in the hardening pass (the glyph-packer
 * correctness fix: face 0 packs onto one page instead of two; document_id
 * follows the atlas bytes).
 */
export const pipelineGoldenExpected = {
  documentId: '19aa2542367bb9a3bba587bc3038805b',
  sourceDigest: '47869ba2d830d7e8599b594a98b1e446f79f85a474f8760f22eb99ba0afc70f9',
  generator: 'glyphcull-compiler',
  chunkCount: 22,
  styleCount: 11,
  contentCount: 12,
  atlasCount: 3,
  imageCount: 0,
  /** Section kinds in file order. */
  sectionKinds: [1, 2, 3, 4, 5, 7],
  /** (font_id, weight, italic, glyphs, kerning, pageWidth, pages) per atlas. */
  atlases: [
    { fontId: 0, weight: 400, italic: false, glyphs: 22, kerning: 12, pageWidth: 256, pages: 1 },
    { fontId: 1, weight: 400, italic: true, glyphs: 6, kerning: 0, pageWidth: 128, pages: 1 },
    { fontId: 2, weight: 700, italic: false, glyphs: 12, kerning: 8, pageWidth: 256, pages: 1 },
  ],
};
