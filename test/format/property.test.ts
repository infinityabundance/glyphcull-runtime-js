//! Property tests for the reader: arbitrary bytes must never throw untyped
//! exceptions — every outcome is either a successful parse or a typed
//! `CullError` — and successful parses are deterministic.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CullError } from '../../src/format/errors.js';
import { readPackage, validateStructure } from '../../src/format/reader.js';
import { pipelineGolden } from '../testkit/fixtures.js';

/** Arbitrary byte buffers up to 4 KiB. */
const arbitraryBytes = fc.uint8Array({ minLength: 0, maxLength: 4096 });

describe('reader never throws on arbitrary bytes', () => {
  it('validateStructure returns a typed result for any input', () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        const result = validateStructure(bytes);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CullError);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('readPackage resolves, never rejects, for any input', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryBytes, async (bytes) => {
        const result = await readPackage(bytes);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CullError);
        } else {
          // A successful parse of random bytes is allowed but rare; verify the
          // object shape minimally.
          expect(result.value.version).toBe(1);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('mutations of a valid golden package never throw untyped errors', async () => {
    const golden = pipelineGolden();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: golden.length - 1 }),
        fc.integer({ min: 0, max: 255 }),
        async (position, value) => {
          const mutated = golden.slice();
          mutated[position] = value;
          const result = await readPackage(mutated);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(CullError);
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reading is deterministic: same input yields identical structure', async () => {
    const golden = pipelineGolden();
    const a = await readPackage(golden);
    const b = await readPackage(golden);
    expect(a.ok).toBe(b.ok);
    if (a.ok && b.ok) {
      expect(a.value.entries).toEqual(b.value.entries);
      expect([...a.value.sections.keys()]).toEqual([...b.value.sections.keys()]);
      expect(a.value.info()).toEqual(b.value.info());
      expect(a.value.chunkSection()).toEqual(b.value.chunkSection());
      expect(a.value.styles()).toEqual(b.value.styles());
      expect(a.value.content()).toEqual(b.value.content());
    }
  });
});
