//! The document host (Architecture.md §3.9): the tiny runtime API surface
//! `load() scroll() paint() select() copy() destroy()` wired over the
//! subsystems. `load()` reads the package, builds the trusted model, and
//! constructs the pipeline (visibility → scheduler → layout → glyph cache →
//! draw list → renderer). Nothing else is exported from the package entry:
//! hosts adapt to the six operations, never to internals (DESIGN.md D12).
//!
//! Multi-document: every handle is self-contained (own model, layout, cache,
//! renderer, scheduler); documents coexist without shared state. Destroyed
//! handles reject every call with a typed `RuntimeError('destroyed')`;
//! `destroy()` itself is idempotent.

import { realClock } from '../clock.js';
import type { Clock } from '../clock.js';
import { buildDocument } from '../document/model.js';
import type { DocumentModel } from '../document/model.js';
import { CHUNK_FLAG_HIDDEN } from '../format/sections.js';
import { readPackage } from '../format/reader.js';
import { GlyphCache, prepareGlyph } from '../glyphs/cache.js';
import type { GlyphStamp } from '../glyphs/cache.js';
import { LayoutEngine } from '../layout/layout.js';
import type { BlockLayout, GlyphInstance } from '../layout/layout.js';
import { LifecycleManager } from '../lifecycle/lifecycle.js';
import { MaterializationScheduler } from '../materialize/scheduler.js';
import type { MaterializeWorker } from '../materialize/scheduler.js';
import { Canvas2dRenderer } from '../render/canvas2d.js';
import { DrawListBuilder } from '../render/drawlist.js';
import type { TextureResolver } from '../render/drawlist.js';
import type { RendererAdapter, TextureSource } from '../render/adapter.js';
import { WebGlRenderer } from '../render/gl.js';
import {
  copyText,
  coveredChunkIds,
  hitTestPoint,
  normalizeSelection,
  rangeQuads,
} from '../selection/selection.js';
import type { Point, Selection } from '../selection/selection.js';
import { computeVisibleSet } from '../visibility/visibility.js';
import type { Viewport } from '../visibility/visibility.js';
import { RuntimeError, assertAlive } from './errors.js';

/** The document handle: exactly the six runtime operations. */
export interface Document {
  /** Whether the handle has been destroyed. */
  readonly destroyed: boolean;
  /**
   * Move the viewport (document CSS pixels) and run one materialization
   * cycle. `direction` is the travel direction for scheduling priorities.
   */
  scroll(viewport: Viewport, direction?: 1 | -1): void;
  /** Render the current viewport + selection into the canvas. */
  paint(): void;
  /** Select the text at a point (collapsed) or between two points (drag). */
  select(anchor: Point, focus?: Point): void;
  /** Select a logical range directly (normalized to document order). */
  select(range: Selection): void;
  /** The plain text of the current selection ('' when none/collapsed). */
  copy(): string;
  /** Release every resource; idempotent. All other calls then reject. */
  destroy(): void;
}

/** Options for `load()` (all budgets configurable, per DESIGN.md D11). */
export interface LoadOptions {
  /** The canvas to render into (its CSS size is the viewport size). */
  readonly canvas: HTMLCanvasElement;
  /** Device pixel ratio (default 1). */
  readonly dpr?: number;
  /** The page content width in CSS pixels (default: the canvas client width). */
  readonly contentWidth?: number;
  /** The initial viewport width in CSS pixels (default: the canvas client width). */
  readonly width?: number;
  /** The initial viewport height in CSS pixels (default: the canvas client height). */
  readonly height?: number;
  /** The visibility margin in CSS pixels (default 120). */
  readonly margin?: number;
  /** The glyph cache budget in bytes (default 8 MiB). */
  readonly glyphBudgetBytes?: number;
  /** The materialization frame budget in ms (default 8). */
  readonly frameBudgetMs?: number;
  /** The cooling period before eviction in ms (default 1500). */
  readonly coolingPeriodMs?: number;
  /** Renderer preference: 'auto' (default), 'webgl', or 'canvas2d'. */
  readonly renderer?: 'auto' | 'webgl' | 'canvas2d';
  /** The time source (determinism seam; production uses the wall clock). */
  readonly clock?: Clock;
}

const DEFAULT_DPR = 1;
const DEFAULT_MARGIN = 120;
const DEFAULT_GLYPH_BUDGET = 8 * 1024 * 1024;
const DEFAULT_FRAME_BUDGET_MS = 8;
const DEFAULT_COOLING_MS = 1500;

/** The public document handle implementation. */
export class DocumentHost implements Document {
  private readonly doc: DocumentModel;
  private readonly layout: LayoutEngine;
  private readonly glyphCache: GlyphCache;
  private readonly lifecycle: LifecycleManager;
  private readonly scheduler: MaterializationScheduler;
  private readonly renderer: RendererAdapter;
  private readonly builder: DrawListBuilder;
  private readonly clock: Clock;
  private readonly margin: number;
  private readonly dpr: number;
  private readonly coolingPeriodMs: number;
  private readonly topLevelIds: ReadonlySet<number>;
  private readonly pageHandles = new Map<string, number>();
  private readonly imageHandles = new Map<number, number>();
  private viewport: Viewport;
  private selection: Selection | undefined;
  private selectedChunks = new Set<number>();
  private surfaceSize: { w: number; h: number } | undefined;
  private destroyedFlag = false;

  private constructor(
    doc: DocumentModel,
    options: LoadOptions & {
      dpr: number;
      margin: number;
      glyphBudgetBytes: number;
      frameBudgetMs: number;
      coolingPeriodMs: number;
      contentWidth: number;
    },
  ) {
    this.doc = doc;
    this.clock = options.clock ?? realClock;
    this.dpr = options.dpr;
    this.margin = options.margin;
    this.coolingPeriodMs = options.coolingPeriodMs;
    this.layout = new LayoutEngine(doc, { dpr: options.dpr, contentWidth: options.contentWidth });
    this.glyphCache = new GlyphCache(options.glyphBudgetBytes);
    this.lifecycle = new LifecycleManager({
      clock: this.clock,
      defaultCoolingPeriodMs: options.coolingPeriodMs,
    });
    this.scheduler = new MaterializationScheduler(this.lifecycle, {
      clock: this.clock,
      frameBudgetMs: options.frameBudgetMs,
      yieldPenalty: 1,
    });
    this.builder = new DrawListBuilder({ texture: this.textureResolver });
    this.renderer = createRenderer(options.renderer, options.canvas, this.textureSource);
    this.topLevelIds = new Set(doc.childIds(doc.root.id));
    const width = options.width ?? (options.canvas.clientWidth || options.contentWidth);
    const height = options.height ?? (options.canvas.clientHeight || 600);
    this.viewport = { x: 0, y: 0, w: width, h: height };
    this.registerChunks();
    this.uploadTextures();
    this.scroll(this.viewport, 1);
  }

  /** Load a package and construct its document handle. */
  static async load(source: Uint8Array, options: LoadOptions): Promise<DocumentHost> {
    validateOptions(options);
    const parsed = await readPackage(source);
    if (!parsed.ok) throw parsed.error;
    const model = buildDocument(parsed.value);
    if (!model.ok) throw model.error;
    return new DocumentHost(model.value, {
      ...options,
      dpr: options.dpr ?? DEFAULT_DPR,
      margin: options.margin ?? DEFAULT_MARGIN,
      glyphBudgetBytes: options.glyphBudgetBytes ?? DEFAULT_GLYPH_BUDGET,
      frameBudgetMs: options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS,
      coolingPeriodMs: options.coolingPeriodMs ?? DEFAULT_COOLING_MS,
      contentWidth: options.contentWidth ?? options.width ?? (options.canvas.clientWidth || 800),
    });
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  scroll(viewport: Viewport, direction: 1 | -1 = 1): void {
    assertAlive(this);
    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)) {
      throw new RuntimeError(
        'invalid-options',
        `viewport origin must be finite, got ${viewport.x},${viewport.y}`,
      );
    }
    if (!(viewport.w > 0) || !(viewport.h > 0)) {
      throw new RuntimeError(
        'invalid-options',
        `viewport size must be positive, got ${viewport.w}×${viewport.h}`,
      );
    }
    this.viewport = viewport;
    // Lay out the geometry the viewport needs (the sequential frontier),
    // then reconcile the visible set with the scheduler and run one cycle.
    this.layout.extendTo(viewport.y + viewport.h + this.margin);
    const result = computeVisibleSet(this.doc, this.layout, viewport, this.margin);
    this.scheduler.reconcile(result.visible, viewport, direction, (id) => this.layout.rect(id));
    this.scheduler.runFrame(this.worker);
    this.scheduler.tick(this.worker);
    if (this.surfaceSize?.w !== viewport.w || this.surfaceSize.h !== viewport.h) {
      this.surfaceSize = { w: viewport.w, h: viewport.h };
      this.renderer.resize(viewport.w, viewport.h, this.dpr);
    }
  }

  paint(): void {
    assertAlive(this);
    const result = computeVisibleSet(this.doc, this.layout, this.viewport, this.margin);
    const selection = this.selection === undefined ? [] : rangeQuads(this.layout, this.selection);
    const list = this.builder.build(this.layout, result.visible, this.stampLookup, selection);
    this.renderer.draw(list, {
      x: this.viewport.x,
      y: this.viewport.y,
      w: this.viewport.w,
      h: this.viewport.h,
      dpr: this.dpr,
    });
  }

  select(anchor: Point, focus?: Point): void;
  select(range: Selection): void;
  select(first: Point | Selection, second?: Point): void {
    assertAlive(this);
    if (second !== undefined) {
      const anchor = hitTestPoint(this.layout, first as Point);
      const focus = hitTestPoint(this.layout, second);
      this.setSelection(
        anchor !== undefined && focus !== undefined
          ? normalizeSelection(this.doc, anchor, focus)
          : undefined,
      );
      return;
    }
    if (isPoint(first)) {
      const hit = hitTestPoint(this.layout, first);
      this.setSelection(hit === undefined ? undefined : { start: hit, end: hit });
      return;
    }
    this.setSelection(normalizeSelection(this.doc, first.start, first.end));
  }

  copy(): string {
    assertAlive(this);
    return this.selection === undefined ? '' : copyText(this.doc, this.selection);
  }

  destroy(): void {
    if (this.destroyedFlag) return; // idempotent
    this.destroyedFlag = true;
    for (const id of this.selectedChunks) this.lifecycle.unselect(id);
    this.selectedChunks.clear();
    this.selection = undefined;
    this.renderer.destroy();
  }

  // -------------------------------------------------------------------------
  // Wiring

  /** The lifecycle registration: every chunk, hidden per its flag. */
  private registerChunks(): void {
    for (const id of this.doc.allIds()) {
      const chunk = this.doc.chunk(id);
      if (chunk === undefined) continue;
      this.lifecycle.register(id, {
        hidden: (chunk.flags & CHUNK_FLAG_HIDDEN) !== 0,
        coolingPeriodMs: this.coolingPeriodMs,
      });
    }
  }

  /** Upload the atlas pages and images to the renderer (once per page). */
  private uploadTextures(): void {
    for (const atlas of this.doc.atlases) {
      atlas.pages.forEach((page, pageIndex) => {
        const handle = this.renderer.uploadAtlasPage(
          atlas.fontId,
          pageIndex,
          page,
          atlas.pageWidth,
          atlas.pageHeight,
        );
        this.pageHandles.set(`${atlas.fontId}:${pageIndex}`, handle);
      });
    }
    for (const image of this.doc.images) {
      const handle = this.renderer.uploadImage(image.id, image.data, image.width, image.height);
      this.imageHandles.set(image.id, handle);
    }
  }

  /** The texture source for context-loss re-uploads (WebGL restore). */
  private readonly textureSource: TextureSource = {
    atlasPage: (atlasId, pageIndex) => {
      const atlas = this.doc.atlases[atlasId];
      if (atlas === undefined) return undefined;
      const page = atlas.pages[pageIndex];
      if (page === undefined) return undefined;
      return { pixels: page, width: atlas.pageWidth, height: atlas.pageHeight };
    },
    image: (imageId) => {
      const image = this.doc.images[imageId];
      if (image === undefined) return undefined;
      return {
        pixels: image.data,
        width: image.width,
        height: image.height,
        format: image.format === 1 ? 1 : 0,
      };
    },
  };

  /** The draw list's texture resolver: page/image → renderer handle. */
  private readonly textureResolver: TextureResolver = {
    atlasPage: (atlasId, pageIndex) => this.pageHandles.get(`${atlasId}:${pageIndex}`) ?? -1,
    image: (imageId) => this.imageHandles.get(imageId) ?? -1,
  };

  /** The scheduler's worker: lay out a block and prepare its cached stamps. */
  private readonly worker: MaterializeWorker = {
    work: (chunkId) => {
      // Nested blocks exist only once their top-level ancestor is laid out;
      // materializing the ancestor is idempotent, so this also covers runs
      // and nested chunks whose parent is already materialized.
      const top = this.topLevelOf(chunkId);
      if (top === undefined) return 'complete';
      this.layout.materialize(top);
      const record = this.layout.record(chunkId);
      if (record === undefined) return 'complete';
      this.prepareStamps(record);
      return 'complete';
    },
    release: (chunkId) => {
      this.glyphCache.releaseChunk(chunkId);
    },
  };

  /** The draw list's stamp lookup: the glyph cache. */
  private readonly stampLookup = (
    chunkId: number,
    glyph: GlyphInstance,
  ): GlyphStamp | undefined => {
    void chunkId;
    return this.glyphCache.get({
      atlasId: glyph.atlasId,
      codepoint: glyph.codepoint,
      fontSizePx: glyph.fontSizePx,
      color: glyph.color,
    });
  };

  /** Prepare and cache the stamps of a block's laid-out glyphs. */
  private prepareStamps(record: BlockLayout): void {
    for (const line of record.lines) {
      for (const glyph of line.glyphs) {
        if (glyph.markOf !== undefined || !glyph.hasOutline) continue;
        const atlas = this.doc.atlases[glyph.atlasId];
        if (atlas === undefined) continue;
        const stamp = prepareGlyph(atlas, glyph.codepoint, glyph.fontSizePx, glyph.color);
        if (stamp === undefined) continue;
        // Stamps are owned by the run chunk carrying the glyph: eviction is
        // per chunk, so a culled run releases exactly its own stamps.
        this.glyphCache.put(stamp.key, stamp, glyph.runChunkId);
      }
    }
  }

  /** The top-level block ancestor of a chunk (itself included), or undefined. */
  private topLevelOf(chunkId: number): number | undefined {
    let id = chunkId;
    for (;;) {
      if (this.topLevelIds.has(id)) return id;
      const chunk = this.doc.chunk(id);
      if (chunk === undefined || chunk.parentId === 0) return undefined;
      id = chunk.parentId;
    }
  }

  /** Replace the selection and repin the lifecycle selection refs. */
  private setSelection(selection: Selection | undefined): void {
    const next =
      selection === undefined ? new Set<number>() : new Set(coveredChunkIds(this.doc, selection));
    for (const id of this.selectedChunks) {
      if (!next.has(id)) this.lifecycle.unselect(id);
    }
    for (const id of next) {
      if (!this.selectedChunks.has(id)) this.lifecycle.select(id);
    }
    this.selectedChunks = next;
    this.selection = selection;
  }
}

/** Whether a value is a document point ({x, y} numbers). */
function isPoint(value: Point | Selection): value is Point {
  return typeof (value as Point).x === 'number' && typeof (value as Point).y === 'number';
}

/** Validate load options; reject nonsense with a typed error. */
function validateOptions(options: LoadOptions): void {
  const reject = (message: string): never => {
    throw new RuntimeError('invalid-options', message);
  };
  if (options.dpr !== undefined && !(options.dpr > 0))
    reject(`dpr must be positive, got ${options.dpr}`);
  if (options.contentWidth !== undefined && !(options.contentWidth > 0)) {
    reject(`contentWidth must be positive, got ${options.contentWidth}`);
  }
  if (options.width !== undefined && !(options.width > 0))
    reject(`width must be positive, got ${options.width}`);
  if (options.height !== undefined && !(options.height > 0))
    reject(`height must be positive, got ${options.height}`);
  if (options.margin !== undefined && options.margin < 0)
    reject(`margin must be non-negative, got ${options.margin}`);
  if (options.glyphBudgetBytes !== undefined && !(options.glyphBudgetBytes >= 0)) {
    reject(`glyphBudgetBytes must be non-negative, got ${options.glyphBudgetBytes}`);
  }
  if (options.frameBudgetMs !== undefined && !(options.frameBudgetMs > 0)) {
    reject(`frameBudgetMs must be positive, got ${options.frameBudgetMs}`);
  }
  if (options.coolingPeriodMs !== undefined && !(options.coolingPeriodMs >= 0)) {
    reject(`coolingPeriodMs must be non-negative, got ${options.coolingPeriodMs}`);
  }
}

/** Create the renderer per preference (WebGL → Canvas 2D fallback). */
function createRenderer(
  preference: 'auto' | 'webgl' | 'canvas2d' | undefined,
  canvas: HTMLCanvasElement,
  source: TextureSource,
): RendererAdapter {
  if (preference !== 'canvas2d') {
    try {
      const renderer = new WebGlRenderer({ canvas, source });
      if (!renderer.contextLost) return renderer;
    } catch {
      // Fall through to the Canvas 2D fallback.
    }
    if (preference === 'webgl') {
      throw new RuntimeError('renderer-unavailable', 'WebGL was requested but is unavailable');
    }
  }
  return new Canvas2dRenderer({ canvas, samplesPerTexel: 2 });
}
