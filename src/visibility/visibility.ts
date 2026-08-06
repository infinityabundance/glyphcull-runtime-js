//! The visibility system (Architecture.md §3.3).
//!
//! Culling determines what should exist right now — nothing more. It walks
//! the chunk graph in document order, applies semantic culling (the `hidden`
//! flag excludes a chunk and its whole subtree), then geometric culling
//! (a renderable chunk is visible iff its laid-out geometry intersects the
//! viewport expanded by a margin). Chunks with no geometry yet are *not yet
//! visible* (beyond the materialization frontier), never merely absent.
//! Structural chunks (document, list, table, row) carry no geometry of
//! their own and are visible iff a descendant is visible.
//!
//! **Responsibility boundary**: culling only determines. It never
//! materializes, never generates glyphs, never paints — and it never mutates
//! the geometry source or the document. The visible set is a pure function
//! of (document, geometry, viewport, margin), which is what makes it
//! deterministic and testable.

import { CHUNK_FLAG_HIDDEN } from '../format/sections.js';
import type { ChunkRecord } from '../format/sections.js';
import type { DocumentModel } from '../document/model.js';
import { isStructuralKind } from '../document/model.js';

/** An axis-aligned rectangle in document (CSS pixel) coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The geometry provider visibility consults (implemented by layout). */
export interface GeometrySource {
  /** The laid-out geometry of a chunk, or undefined when not yet materialized. */
  rect(chunkId: number): Rect | undefined;
}

/** The result of one culling pass. */
export interface VisibilityResult {
  /** Visible chunks in document order (renderable + structural context). */
  readonly visible: readonly number[];
  /** Chunks excluded by semantic culling (whole hidden subtrees), document order. */
  readonly hidden: readonly number[];
  /** Chunks beyond the materialization frontier (no geometry yet), document order. */
  readonly notYetVisible: readonly number[];
}

/** A viewport: the visible document window in document coordinates. */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Axis-aligned rectangle intersection (inclusive of edges). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** The viewport expanded by `margin` pixels on every side. */
export function expandedViewport(viewport: Viewport, margin: number): Rect {
  return {
    x: viewport.x - margin,
    y: viewport.y - margin,
    w: viewport.w + margin * 2,
    h: viewport.h + margin * 2,
  };
}

/**
 * Compute the visible set. The walk is in document order (pre-order from the
 * root). Semantic culling prunes hidden subtrees entirely; geometry-less
 * renderable chunks are reported as `notYetVisible`; structural chunks are
 * reported visible when any descendant is visible.
 */
export function computeVisibleSet(
  doc: DocumentModel,
  geometry: GeometrySource,
  viewport: Viewport,
  margin: number,
): VisibilityResult {
  const target = expandedViewport(viewport, margin);
  const hidden: number[] = [];
  const notYetVisible: number[] = [];

  /** Chunks determined visible (any order during the walk). */
  const visibleIds = new Set<number>();

  const walk = (chunk: ChunkRecord): void => {
    if ((chunk.flags & CHUNK_FLAG_HIDDEN) !== 0) {
      // Semantic culling: the whole subtree is excluded.
      hidden.push(chunk.id);
      const stack = [...doc.childIds(chunk.id)];
      while (stack.length > 0) {
        const id = stack.pop()!;
        hidden.push(id);
        stack.push(...doc.childIds(id));
      }
      return;
    }
    const rect = geometry.rect(chunk.id);
    const isStructural = isStructuralKind(chunk.kind);
    let ownVisible = false;
    if (rect !== undefined) {
      ownVisible = intersects(rect, target);
    } else if (!isStructural) {
      // Beyond the materialization frontier: not yet visible, never absent.
      notYetVisible.push(chunk.id);
    }
    let childVisible = false;
    for (const childId of doc.childIds(chunk.id)) {
      const child = doc.chunk(childId);
      if (child === undefined) continue;
      walk(child);
      if (visibleIds.has(childId)) {
        childVisible = true;
      }
    }
    if (ownVisible || (isStructural && childVisible)) {
      visibleIds.add(chunk.id);
    }
  };

  walk(doc.root);
  // Emit in document order (chunk ids are dense in document order).
  const visible: number[] = [];
  for (const id of doc.allIds()) {
    if (visibleIds.has(id)) visible.push(id);
  }
  return { visible, hidden, notYetVisible };
}
