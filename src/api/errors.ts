//! The runtime API's typed errors (Architecture.md §3.9, DESIGN.md D12):
//! destroyed handles reject every call with a `RuntimeError` of kind
//! `destroyed`; `load()` rejects invalid options with `invalid-options` and
//! unavailable renderers with `renderer-unavailable`. Reader/document
//! validation failures keep their own typed errors (`CullError`,
//! `DocumentError`), which `load()` propagates.

/** The kinds of runtime API errors. */
export type RuntimeErrorKind = 'destroyed' | 'invalid-options' | 'renderer-unavailable';

/** A typed runtime API error. */
export class RuntimeError extends Error {
  readonly kind: RuntimeErrorKind;

  constructor(kind: RuntimeErrorKind, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.kind = kind;
  }
}

/** Throw `RuntimeError('destroyed')` when the handle is destroyed. */
export function assertAlive(handle: { readonly destroyed: boolean }): void {
  if (handle.destroyed) {
    throw new RuntimeError('destroyed', 'the document handle has been destroyed');
  }
}
