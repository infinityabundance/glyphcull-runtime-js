//! The GlyphCull JavaScript runtime — a compiled document host.
//!
//! The public surface is exactly six operations (Architecture.md §3.9,
//! DESIGN.md D12): `load() scroll() paint() select() copy() destroy()`.
//! Everything else — the reader, the document model, culling, scheduling,
//! layout, glyph cache, draw list, renderers — is internal and not exported
//! from this entry point. Hosts (browser demos, native wrappers) adapt to
//! the six operations; the runtime never adapts to hosts.
//!
//! ```ts
//! const doc = await load(bytes, { canvas });
//! doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
//! doc.paint();
//! doc.select({ x: 10, y: 40 }, { x: 200, y: 40 });
//! const text = doc.copy();
//! doc.destroy();
//! ```

import { DocumentHost } from './api/runtime.js';
import type { Document, LoadOptions } from './api/runtime.js';
import { RuntimeError } from './api/errors.js';
import type { RuntimeErrorKind } from './api/errors.js';
import { CullError } from './format/errors.js';
import type { ErrorKind } from './format/errors.js';
import { DocumentError } from './document/model.js';
import type { DocumentErrorKind } from './document/model.js';
import type { Clock } from './clock.js';
import type { Point, Selection, SelectionQuad, TextPosition } from './selection/selection.js';
import type { Viewport } from './visibility/visibility.js';
import type { PostEffect } from './render/effects.js';

/**
 * Load a `.cull` package and construct its document handle. Rejects with the
 * reader's `CullError` for malformed packages, the model's `DocumentError`
 * for packages that fail document validation, or `RuntimeError` for invalid
 * options / an unavailable requested renderer.
 */
export async function load(source: Uint8Array, options: LoadOptions): Promise<Document> {
  return DocumentHost.load(source, options);
}

export type {
  Clock,
  Document,
  DocumentErrorKind,
  ErrorKind,
  LoadOptions,
  Point,
  PostEffect,
  RuntimeErrorKind,
  Selection,
  SelectionQuad,
  TextPosition,
  Viewport,
};
export { CullError, DocumentError, RuntimeError };
