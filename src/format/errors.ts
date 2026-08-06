//! Typed reader errors.
//!
//! Every failure of the package reader is a `CullError` with a precise
//! `kind` discriminant and (where useful) expected/actual context. The
//! reader never throws platform exceptions on malformed input: the
//! top-level parse entry point catches everything and wraps unknown
//! failures as `internal` so a host can always depend on typed errors.

/** The discriminant of a reader failure. */
export type ErrorKind =
  | 'too-short'
  | 'bad-magic'
  | 'unsupported-version'
  | 'header-crc-mismatch'
  | 'too-many-sections'
  | 'truncated'
  | 'out-of-bounds'
  | 'duplicate-section'
  | 'unsupported-compression'
  | 'invalid-flags'
  | 'decoded-len-exceeded'
  | 'decompress-mismatch'
  | 'crc-mismatch'
  | 'invalid-utf8'
  | 'invalid-value'
  | 'overflow'
  | 'unknown-section-kind'
  | 'zlib-header-invalid'
  | 'zlib-adler-mismatch'
  | 'seal-mismatch'
  | 'unsupported-algorithm'
  | 'internal';

/** A structured reader failure. */
export class CullError extends Error {
  readonly kind: ErrorKind;
  /** Section table index when the failure is section-scoped. */
  readonly section: number | undefined;

  constructor(kind: ErrorKind, message: string, section?: number) {
    super(message);
    this.name = 'CullError';
    this.kind = kind;
    this.section = section;
  }
}

/** Construct a section-scoped error. */
export function sectionError(kind: ErrorKind, section: number, message: string): CullError {
  return new CullError(kind, `${message} (section ${section})`, section);
}

/** A result: either a value or a typed reader error. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: CullError };

/** Wrap a throwing computation into a `Result`. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof CullError) {
      return { ok: false, error: e };
    }
    // A reader bug must still surface as a typed error, never an untyped
    // throw across the API boundary.
    return {
      ok: false,
      error: new CullError('internal', `internal reader failure: ${String(e)}`),
    };
  }
}
