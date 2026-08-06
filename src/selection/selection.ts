//! Selection (Architecture.md §3.8, DESIGN.md D9): selection is logical,
//! rendering is geometric.
//!
//! A `TextPosition` is a run chunk id plus a character offset into the run's
//! payload text — independent of pixels, so a selection stays stable across
//! re-materialization and scrolling. `Selection` is an ordered pair (start ≤
//! end in document order). Hit testing projects a document point onto the
//! nearest glyph; `rangeQuads` projects a selection back onto laid-out lines;
//! `copyText` extracts plain text from chunk content with the documented
//! boundary policy:
//!
//! ```text
//! between runs of the same block        → ''        (the source text re-joins)
//! between blocks (paragraph boundary)   → '\n'
//! between cells of the same table row   → '\t'
//! between cells of different rows       → '\n'
//! `br` chunks                           → '\n'      (explicit hard break)
//! ```
//!
//! Everything here is a pure function of (document, layout, point/selection):
//! no state, no wall clock, deterministic.

import type { DocumentModel } from '../document/model.js';
import { isBlockKind } from '../document/model.js';
import type { ChunkRecord } from '../format/sections.js';
import { ChunkKind } from '../format/sections.js';
import type { LayoutEngine, LineLayout, RunLayout } from '../layout/layout.js';

/** A point in document coordinates (CSS pixels). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A logical text position: a run chunk + a character offset in its payload. */
export interface TextPosition {
  readonly chunkId: number;
  /** Character offset (UTF-16 code units) into the run's payload text. */
  readonly offset: number;
}

/** A normalized selection: `start` ≤ `end` in document order. */
export interface Selection {
  readonly start: TextPosition;
  readonly end: TextPosition;
}

/** A selection highlight quad (document pixels), consumed by the draw list. */
export interface SelectionQuad {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The pre-order document index of every chunk id (deterministic). */
function orderIndex(doc: DocumentModel): Map<number, number> {
  const index = new Map<number, number>();
  doc.allIds().forEach((id, i) => index.set(id, i));
  return index;
}

/** Compare two positions in document order: -1, 0, or 1. */
export function comparePositions(doc: DocumentModel, a: TextPosition, b: TextPosition): number {
  const index = orderIndex(doc);
  const ia = index.get(a.chunkId) ?? 0;
  const ib = index.get(b.chunkId) ?? 0;
  if (ia !== ib) return ia < ib ? -1 : 1;
  if (a.offset < b.offset) return -1;
  if (a.offset > b.offset) return 1;
  return 0;
}

/** Order two positions into a normalized selection (start ≤ end). */
export function normalizeSelection(
  doc: DocumentModel,
  a: TextPosition,
  b: TextPosition,
): Selection {
  return comparePositions(doc, a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

/** Whether a selection covers no text (start === end). */
export function isCollapsed(selection: Selection): boolean {
  return (
    selection.start.chunkId === selection.end.chunkId &&
    selection.start.offset === selection.end.offset
  );
}

/**
 * Hit test a document point against the laid-out text: the nearest line
 * (smallest vertical distance, document order on ties) and, within it, the
 * nearest glyph center. Returns the run position, or `undefined` when the
 * document has no laid-out text (images and rulers carry no text positions).
 */
export function hitTestPoint(layout: LayoutEngine, point: Point): TextPosition | undefined {
  let best: { line: LineLayout; dy: number } | undefined;
  for (const block of layout.recordsAll().values()) {
    for (const line of block.lines) {
      if (line.runs.length === 0) continue;
      const top = line.y;
      const bottom = line.y + line.heightPx;
      const dy = point.y < top ? top - point.y : point.y > bottom ? point.y - bottom : 0;
      if (best === undefined || dy < best.dy) best = { line, dy };
    }
  }
  if (best === undefined) return undefined;
  return positionInLine(best.line, point.x);
}

/** The run position nearest `x` on a laid-out line. */
function positionInLine(line: LineLayout, x: number): TextPosition {
  // Marks ride with their base glyph (advance 0) and never anchor a position.
  for (const glyph of line.glyphs) {
    if (glyph.markOf !== undefined) continue;
    if (x < glyph.x + glyph.advancePx / 2) {
      return { chunkId: glyph.runChunkId, offset: glyph.offsetInText };
    }
  }
  const last = [...line.glyphs].reverse().find((g) => g.markOf === undefined);
  if (last !== undefined) {
    return { chunkId: last.runChunkId, offset: last.offsetInText + 1 };
  }
  // No glyphs (e.g. missing atlas): anchor at the first run's start.
  const first = line.runs[0]!;
  return { chunkId: first.chunkId, offset: first.start };
}

/**
 * Project a selection onto the laid-out lines as highlight quads, in document
 * order, merged per line where pieces are contiguous. A collapsed selection
 * yields no quads. Runs without glyph geometry fall back to a proportional
 * rect inside the run box.
 */
export function rangeQuads(layout: LayoutEngine, selection: Selection): SelectionQuad[] {
  if (isCollapsed(selection)) return [];
  const doc = layout.document;
  const index = orderIndex(doc);
  const startIndex = index.get(selection.start.chunkId) ?? 0;
  const endIndex = index.get(selection.end.chunkId) ?? 0;
  const quads: SelectionQuad[] = [];
  for (const block of layout.recordsAll().values()) {
    for (const line of block.lines) {
      const pieces: SelectionQuad[] = [];
      for (const run of line.runs) {
        const runIndex = index.get(run.chunkId) ?? 0;
        if (runIndex < startIndex || runIndex > endIndex) continue;
        let from: number;
        let to: number;
        if (runIndex === startIndex && runIndex === endIndex) {
          from = Math.max(run.start, selection.start.offset);
          to = Math.min(run.end, selection.end.offset);
        } else if (runIndex === startIndex) {
          from = Math.max(run.start, selection.start.offset);
          to = run.end;
        } else if (runIndex === endIndex) {
          from = run.start;
          to = Math.min(run.end, selection.end.offset);
        } else {
          from = run.start;
          to = run.end;
        }
        if (from >= to) continue;
        pieces.push(coveredPiece(line, run, from, to));
      }
      // Merge contiguous pieces on the same line (a selection within one run
      // is already a single piece; adjacent full runs merge into one quad).
      let merged: SelectionQuad | undefined;
      for (const piece of pieces) {
        if (merged === undefined) {
          merged = piece;
          continue;
        }
        if (piece.x <= merged.x + merged.w + 0.5) {
          merged = { x: merged.x, y: merged.y, w: piece.x + piece.w - merged.x, h: merged.h };
        } else {
          quads.push(merged);
          merged = piece;
        }
      }
      if (merged !== undefined) quads.push(merged);
    }
  }
  return quads;
}

/** The highlight rect of a covered sub-range [from, to) of a run on a line. */
function coveredPiece(line: LineLayout, run: RunLayout, from: number, to: number): SelectionQuad {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const glyph of line.glyphs) {
    if (glyph.runChunkId !== run.chunkId || glyph.offsetInText < from || glyph.offsetInText >= to)
      continue;
    found = true;
    xMin = Math.min(xMin, glyph.x);
    xMax = Math.max(xMax, glyph.x + glyph.advancePx);
  }
  if (!found) {
    // No glyph geometry (missing atlas): proportional within the run box.
    const f0 = (from - run.start) / run.text.length;
    const f1 = (to - run.start) / run.text.length;
    xMin = run.x + run.width * f0;
    xMax = run.x + run.width * f1;
  }
  return { x: xMin, y: line.y, w: Math.max(0, xMax - xMin), h: line.heightPx };
}

/** The chunk ids between the selection's endpoints, inclusive, document order. */
export function coveredChunkIds(doc: DocumentModel, selection: Selection): number[] {
  if (isCollapsed(selection)) return [];
  const index = orderIndex(doc);
  const startIndex = index.get(selection.start.chunkId) ?? 0;
  const endIndex = index.get(selection.end.chunkId) ?? 0;
  const out: number[] = [];
  for (const id of doc.allIds()) {
    const i = index.get(id) ?? 0;
    if (i >= startIndex && i <= endIndex) out.push(id);
  }
  return out;
}

/**
 * Extract the plain text covered by a selection, preserving document order
 * with the boundary policy in the module doc. A collapsed selection returns
 * the empty string.
 */
export function copyText(doc: DocumentModel, selection: Selection): string {
  if (isCollapsed(selection)) return '';
  const index = orderIndex(doc);
  const startIndex = index.get(selection.start.chunkId) ?? 0;
  const endIndex = index.get(selection.end.chunkId) ?? 0;
  const pieces: string[] = [];
  const parents: number[] = [];
  for (const id of doc.allIds()) {
    const i = index.get(id) ?? 0;
    if (i < startIndex || i > endIndex) continue;
    const chunk = doc.chunk(id);
    if (chunk === undefined) continue;
    if (chunk.kind === ChunkKind.Br) {
      pieces.push('\n');
      parents.push(blockParent(doc, chunk));
      continue;
    }
    const text = doc.directText(id);
    if (text === undefined || text.length === 0) continue;
    let slice = text;
    if (id === selection.start.chunkId) slice = text.slice(selection.start.offset);
    if (id === selection.end.chunkId) {
      slice =
        id === selection.start.chunkId
          ? text.slice(selection.start.offset, selection.end.offset)
          : text.slice(0, selection.end.offset);
    }
    if (slice.length === 0) continue;
    pieces.push(slice);
    parents.push(blockParent(doc, chunk));
  }
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) out += separator(doc, parents[i - 1]!, parents[i]!);
    out += pieces[i]!;
  }
  return out;
}

/** The nearest block ancestor of a chunk (itself included). */
function blockParent(doc: DocumentModel, chunk: ChunkRecord): number {
  let id = chunk.id;
  for (;;) {
    const current = doc.chunk(id);
    if (current === undefined || isBlockKind(current.kind)) return id;
    if (current.parentId === 0) return id;
    id = current.parentId;
  }
}

/** The TableCell ancestor of a block, or undefined. */
function cellOf(doc: DocumentModel, blockId: number): number | undefined {
  let id = blockId;
  for (;;) {
    const current = doc.chunk(id);
    if (current === undefined) return undefined;
    if (current.kind === ChunkKind.TableCell) return id;
    if (current.parentId === 0) return undefined;
    id = current.parentId;
  }
}

/** The separator between two text pieces (see the module doc). */
function separator(doc: DocumentModel, prevBlock: number, nextBlock: number): string {
  if (prevBlock === nextBlock) return '';
  const prevCell = cellOf(doc, prevBlock);
  const nextCell = cellOf(doc, nextBlock);
  if (prevCell !== undefined && nextCell !== undefined) {
    if (prevCell === nextCell) return '\n'; // two paragraphs inside one cell
    const prevRow = doc.chunk(prevCell)?.parentId ?? 0;
    const nextRow = doc.chunk(nextCell)?.parentId ?? 0;
    return prevRow === nextRow ? '\t' : '\n';
  }
  return '\n';
}
