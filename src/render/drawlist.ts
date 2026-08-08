//! The draw list (Architecture.md §3.7): an ordered sequence of draw
//! commands produced deterministically from the visible set + layout records
//! + glyph stamps. Glyph commands carry their texture (atlas page), UV
//! rect, quad, and color; the renderer batches consecutive commands with
//! the same texture into one draw call.
//!
//! Builders never read the wall clock and never iterate unordered maps in
//! the output path: the draw list is a pure function of (layout, visible
//! set, glyph stamps, selection).

import type { GlyphStamp } from '../glyphs/cache.js';
import { prepareGlyph } from '../glyphs/cache.js';
import type { LayoutEngine, LineLayout, BlockLayout } from '../layout/layout.js';
import type { GlyphInstance } from '../layout/layout.js';
import { ChunkKind } from '../format/sections.js';
import { measureRun } from '../layout/measure.js';
import type { SelectionQuad } from '../selection/selection.js';
import { themedColor } from './theme.js';
import type { Theme } from './theme.js';
import { effectGlyphColor } from './effects.js';
import type { Effects } from './effects.js';

/** A textured glyph quad. */
export interface GlyphCommand {
  readonly type: 'glyph';
  /** The texture handle of the atlas page (assigned by the renderer). */
  readonly texture: number;
  readonly uv: readonly [number, number, number, number];
  /** Quad position and size in document pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: number;
  /** Document pixels per atlas texel at this glyph's size (fontSize/texelsPerEm). */
  readonly pxPerTexel: number;
}

/** A raster image quad. */
export interface ImageCommand {
  readonly type: 'image';
  readonly texture: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A solid fill (backgrounds, selection, list markers as glyphs not here). */
export interface FillCommand {
  readonly type: 'fill';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: number;
}

/** A horizontal rule. */
export interface RulerCommand {
  readonly type: 'ruler';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly color: number;
}

export type DrawCommand = GlyphCommand | ImageCommand | FillCommand | RulerCommand;

/** An ordered sequence of draw commands. */
export interface DrawList {
  readonly commands: readonly DrawCommand[];
}

/** A texture resolver: glyph stamp page / image id → renderer texture handle. */
export interface TextureResolver {
  atlasPage(atlasId: number, pageIndex: number): number;
  image(imageId: number): number;
}

/** Options for the draw list builder. */
export interface DrawListOptions {
  readonly texture: TextureResolver;
  /** Host presentation: re-ink the document's default ink (see `theme.ts`). */
  readonly theme?: Theme;
  /** Host render effects: animated accent (see `effects.ts`). */
  readonly effects?: Effects;
}

/** The draw list builder. */
export class DrawListBuilder {
  private readonly texture: TextureResolver;
  private readonly theme: Theme | undefined;
  private readonly effects: Effects | undefined;

  constructor(options: DrawListOptions) {
    this.texture = options.texture;
    this.theme = options.theme;
    this.effects = options.effects;
  }

  /**
   * The presented color of a glyph: the theme ink, then the effects accent.
   * `time` (seconds) advances the running highlight; `0` is deterministic.
   */
  private glyphColor(color: number, x: number, time: number): number {
    return effectGlyphColor(themedColor(color, this.theme), this.effects, x, time);
  }

  /**
   * Build the draw list for the visible chunk ids. Glyphs are looked up in
   * `stamps` (chunkId → per-glyph stamp); missing stamps are skipped (their
   * chunk is not materialized yet — the scheduler is mid-flight). Markers,
   * backgrounds, rulers, and images are block geometry and render regardless:
   * only text-run glyphs are gated by the cache.
   */
  build(
    layout: LayoutEngine,
    visibleIds: readonly number[],
    stamps: (chunkId: number, glyph: GlyphInstance) => GlyphStamp | undefined,
    selection: readonly SelectionQuad[] = [],
    /** Animation time in seconds (effects accent; 0 = deterministic). */
    time = 0,
  ): DrawList {
    const commands: DrawCommand[] = [];
    for (const quad of selection) {
      commands.push({
        type: 'fill',
        x: quad.x,
        y: quad.y,
        w: quad.w,
        h: quad.h,
        color: 0x3399ff66,
      });
    }
    // The visible set contains every visible chunk (nested included), while
    // a block's emission recurses into its children. Emit each block once:
    // when a parent is emitted its whole subtree is marked, so a nested id
    // appearing later in the list is skipped; a nested id whose ancestors
    // are absent still emits its own subtree.
    const emitted = new Set<number>();
    for (const chunkId of visibleIds) {
      if (emitted.has(chunkId)) continue;
      this.emitBlock(layout, chunkId, commands, stamps, emitted, time);
    }
    return { commands };
  }

  private emitBlock(
    layout: LayoutEngine,
    chunkId: number,
    commands: DrawCommand[],
    stamps: (chunkId: number, glyph: GlyphInstance) => GlyphStamp | undefined,
    emitted: Set<number>,
    time: number,
  ): void {
    emitted.add(chunkId);
    const record = layout.record(chunkId);
    if (record === undefined) return;
    if (record.kind === ChunkKind.Hr && record.ruler !== undefined) {
      commands.push({
        type: 'ruler',
        x: record.ruler.x,
        y: record.ruler.y,
        w: record.ruler.w,
        color: themedColor(record.style.color, this.theme),
      });
      return;
    }
    if (record.kind === ChunkKind.Image && record.image !== undefined) {
      commands.push({
        type: 'image',
        texture: this.texture.image(record.image.imageId),
        x: record.image.x,
        y: record.image.y,
        w: record.image.w,
        h: record.image.h,
      });
      return;
    }
    // Backgrounds first (beneath the content).
    const bg = record.style.backgroundColor;
    if (bg !== 0 && (record.w > 0 || record.h > 0)) {
      commands.push({
        type: 'fill',
        x: record.x,
        y: record.y,
        w: record.w,
        h: record.h,
        color: bg,
      });
    }
    for (const line of record.lines) {
      this.emitLine(line, commands, stamps, time);
    }
    this.emitMarker(layout, record, commands, time);
    for (const child of record.children) {
      this.emitBlockLayout(layout, child, commands, stamps, emitted, time);
    }
  }

  private emitBlockLayout(
    layout: LayoutEngine,
    block: BlockLayout,
    commands: DrawCommand[],
    stamps: (chunkId: number, glyph: GlyphInstance) => GlyphStamp | undefined,
    emitted: Set<number>,
    time: number,
  ): void {
    emitted.add(block.chunkId);
    const bg = block.style.backgroundColor;
    if (bg !== 0 && (block.w > 0 || block.h > 0)) {
      commands.push({ type: 'fill', x: block.x, y: block.y, w: block.w, h: block.h, color: bg });
    }
    for (const line of block.lines) {
      this.emitLine(line, commands, stamps, time);
    }
    this.emitMarker(layout, block, commands, time);
    for (const child of block.children) {
      this.emitBlockLayout(layout, child, commands, stamps, emitted, time);
    }
  }

  /** Emit a list marker as glyphs at its baseline. */
  private emitMarker(
    layout: LayoutEngine,
    block: BlockLayout,
    commands: DrawCommand[],
    time: number,
  ): void {
    const marker = block.marker;
    if (marker === undefined || marker.text.length === 0) return;
    const atlas = layout.document.atlases[block.style.fontId];
    if (atlas === undefined) return;
    const color = themedColor(block.style.color, this.theme);
    const fontSize = block.style.fontSizePx;
    const measured = measureRun(atlas, marker.text, fontSize, 0);
    let x = marker.x;
    for (const metric of measured.glyphs) {
      const stamp = prepareGlyph(atlas, metric.codepoint, fontSize, color);
      if (stamp !== undefined && !stamp.noOutline) {
        commands.push({
          type: 'glyph',
          texture: this.texture.atlasPage(stamp.key.atlasId, stamp.pageIndex),
          uv: stamp.uv,
          x: x + stamp.offsetX,
          y: marker.y - stamp.offsetY,
          w: stamp.quadW,
          h: stamp.quadH,
          color: this.glyphColor(color, x, time),
          pxPerTexel: stamp.texelsPerEm > 0 ? fontSize / stamp.texelsPerEm : 1,
        });
      }
      x += metric.advancePx;
    }
  }

  private emitLine(
    line: LineLayout,
    commands: DrawCommand[],
    stamps: (chunkId: number, glyph: GlyphInstance) => GlyphStamp | undefined,
    time: number,
  ): void {
    for (const glyph of line.glyphs) {
      if (glyph.markOf !== undefined) continue; // marks ride with the base
      const stamp = stamps(glyph.runChunkId, glyph);
      if (stamp === undefined || stamp.noOutline || stamp.quadW === 0 || stamp.quadH === 0) {
        continue; // spaces and not-yet-cached stamps
      }
      commands.push({
        type: 'glyph',
        texture: this.texture.atlasPage(stamp.key.atlasId, stamp.pageIndex),
        uv: stamp.uv,
        x: glyph.x + stamp.offsetX,
        y: glyph.y - stamp.offsetY,
        w: stamp.quadW,
        h: stamp.quadH,
        color: this.glyphColor(glyph.color, glyph.x, time),
        pxPerTexel: stamp.texelsPerEm > 0 ? glyph.fontSizePx / stamp.texelsPerEm : 1,
      });
    }
  }
}
