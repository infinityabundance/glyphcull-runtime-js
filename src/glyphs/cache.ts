//! The glyph cache (Architecture.md §3.6).
//!
//! Glyph instances are cached per (atlas, codepoint, size, color) quad as
//! prepared stamps: the pixel-space quad + UV rect + metrics needed to emit
//! a draw command, derived from the atlas glyph record and the placement
//! convention (SPEC.md §2.5):
//!
//! ```text
//! scale        = fontSizePx / texelsPerEm
//! inkLeftPx    = penX + bearingX * fontSizePx
//! inkTopPx     = baselineY - bearingY * fontSizePx
//! boxLeftPx    = inkLeftPx - padding * scale      (box = ink + padding)
//! boxTopPx     = inkTopPx - padding * scale
//! quad size    = boxW * scale, boxH * scale
//! uv           = box rect / page size (page texels)
//! ```
//!
//! The cache is budgeted in bytes; when the budget is exceeded the least
//! recently used entries are evicted (deterministic Map order). Chunks own
//! their stamps: `releaseChunk` drops every stamp of an evicted chunk
//! (lifecycle coupling — Evicted ⇒ cache entries released).

import type { Atlas } from '../format/sections.js';
import { texelsPerEm } from '../format/sections.js';

/** The cache key of a prepared glyph. */
export interface GlyphKey {
  readonly atlasId: number;
  readonly codepoint: number;
  /** The font size the stamp was prepared for (document px). */
  readonly fontSizePx: number;
  /** The color the stamp was prepared for (RGBA). */
  readonly color: number;
}

/** A prepared, size-specific glyph stamp. */
export interface GlyphStamp {
  readonly key: GlyphKey;
  readonly pageIndex: number;
  /** UV rect in texture space: [u0, v0, u1, v1]. */
  readonly uv: readonly [number, number, number, number];
  /** The quad's top-left relative to the pen (penX + offsetX, baseline - offsetY). */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Quad size in pixels. */
  readonly quadW: number;
  readonly quadH: number;
  /** Advance in pixels. */
  readonly advancePx: number;
  readonly noOutline: boolean;
  readonly combining: boolean;
  /** The atlas page texture dimensions (for shader normalization). */
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** Estimated bytes (quad + key + fixed overhead). */
  readonly sizeBytes: number;
}

const STAMP_OVERHEAD = 128;

/**
 * Prepare a glyph stamp for a codepoint at a size and color. Returns
 * `undefined` when the atlas has no record for the codepoint (the layout
 * renders a tofu box instead).
 */
export function prepareGlyph(
  atlas: Atlas,
  codepoint: number,
  fontSizePx: number,
  color: number,
): GlyphStamp | undefined {
  const glyph = atlas.glyphs.get(codepoint);
  if (glyph === undefined) return undefined;
  const tpe = texelsPerEm(atlas);
  const scale = tpe > 0 ? fontSizePx / tpe : fontSizePx;
  const padding = atlas.padding * scale;
  const inkLeftPx = glyph.bearingX * fontSizePx;
  const inkTopPx = glyph.bearingY * fontSizePx;
  const offsetX = inkLeftPx - padding;
  const offsetY = inkTopPx + padding; // page y grows down; box top is above baseline
  const quadW = glyph.boxW * scale;
  const quadH = glyph.boxH * scale;
  const u0 = glyph.boxX / atlas.pageWidth;
  const v0 = glyph.boxY / atlas.pageHeight;
  const u1 = (glyph.boxX + glyph.boxW) / atlas.pageWidth;
  const v1 = (glyph.boxY + glyph.boxH) / atlas.pageHeight;
  return {
    key: { atlasId: atlas.fontId, codepoint, fontSizePx, color },
    pageIndex: glyph.pageIndex,
    uv: [u0, v0, u1, v1],
    offsetX,
    offsetY,
    quadW,
    quadH,
    advancePx: glyph.advance * fontSizePx,
    noOutline: glyph.noOutline,
    combining: glyph.combining,
    pageWidth: atlas.pageWidth,
    pageHeight: atlas.pageHeight,
    sizeBytes: STAMP_OVERHEAD + 64,
  };
}

/**
 * The glyph cache: budgeted, deterministic (Map insertion order is the LRU
 * order), and chunk-owning (releaseChunk frees a chunk's stamps).
 */
export class GlyphCache {
  private readonly budgetBytes: number;
  /** key → stamp, in LRU order (Map preserves insertion order; get re-inserts). */
  private readonly stamps = new Map<string, GlyphStamp>();
  /** stampKey → owning chunk ids (a stamp may be shared by several runs). */
  private readonly owners = new Map<string, Set<number>>();
  private bytes = 0;

  constructor(budgetBytes: number) {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) {
      throw new RangeError(`glyph cache budget must be a non-negative number, got ${budgetBytes}`);
    }
    this.budgetBytes = budgetBytes;
  }

  private keyOf(key: GlyphKey): string {
    return `${key.atlasId}:${key.codepoint}:${key.fontSizePx}:${key.color}`;
  }

  /** The current byte usage. */
  get usedBytes(): number {
    return this.bytes;
  }

  /** The configured budget. */
  get budget(): number {
    return this.budgetBytes;
  }

  /** The number of cached stamps. */
  get size(): number {
    return this.stamps.size;
  }

  /** Fetch a stamp (touching its LRU position), or undefined. */
  get(key: GlyphKey): GlyphStamp | undefined {
    const id = this.keyOf(key);
    const stamp = this.stamps.get(id);
    if (stamp === undefined) return undefined;
    // Touch: re-insert to move it to the most-recent position.
    this.stamps.delete(id);
    this.stamps.set(id, stamp);
    return stamp;
  }

  /** Whether a stamp is cached. */
  has(key: GlyphKey): boolean {
    return this.stamps.has(this.keyOf(key));
  }

  /**
   * Store a stamp owned by `ownerChunkId`. When the budget is exceeded, the
   * least recently used stamps are evicted (deterministically).
   */
  put(key: GlyphKey, stamp: GlyphStamp, ownerChunkId: number): void {
    const id = this.keyOf(key);
    if (this.stamps.has(id)) {
      // Refresh ownership and LRU position.
      this.stamps.delete(id);
      this.stamps.set(id, stamp);
      const set = this.owners.get(id);
      if (set !== undefined) set.add(ownerChunkId);
      return;
    }
    this.stamps.set(id, stamp);
    this.bytes += stamp.sizeBytes;
    let set = this.owners.get(id);
    if (set === undefined) {
      set = new Set<number>();
      this.owners.set(id, set);
    }
    set.add(ownerChunkId);
    this.evictLru();
  }

  /** Evict least-recently-used stamps until the budget is satisfied. */
  private evictLru(): void {
    for (const [id, stamp] of this.stamps) {
      if (this.bytes <= this.budgetBytes) break;
      this.stamps.delete(id);
      this.owners.delete(id);
      this.bytes -= stamp.sizeBytes;
    }
  }

  /**
   * Release every stamp owned by a chunk (called when the chunk is Evicted
   * by the lifecycle). Stamps shared with live chunks survive.
   */
  releaseChunk(chunkId: number): number {
    let freed = 0;
    for (const [id, owners] of this.owners) {
      if (!owners.has(chunkId)) continue;
      owners.delete(chunkId);
      if (owners.size === 0) {
        const stamp = this.stamps.get(id);
        if (stamp !== undefined) {
          this.stamps.delete(id);
          this.owners.delete(id);
          this.bytes -= stamp.sizeBytes;
          freed += stamp.sizeBytes;
        }
      }
    }
    return freed;
  }

  /** The chunk ids owning a given key (for lifecycle coupling tests). */
  ownersOf(key: GlyphKey): number[] {
    return [...(this.owners.get(this.keyOf(key)) ?? [])];
  }

  /** Drop everything (destroy). */
  clear(): void {
    this.stamps.clear();
    this.owners.clear();
    this.bytes = 0;
  }
}
