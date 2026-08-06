//! The Canvas 2D fallback renderer (Architecture.md §3.7): the same draw
//! list executes on Canvas 2D where WebGL is unavailable. Because Canvas 2D
//! cannot run a shader, glyphs are rasterized on the CPU with the shared MSDF
//! reconstruction (`msdf.ts`) into cached, colored bitmaps, then drawn with
//! `drawImage` — the exact same math the WebGL shader and the reference
//! rasterizer use, so outputs agree within tolerance.
//!
//! Compositing matches the WebGL renderer: bitmaps store *straight* color
//! with coverage-scaled alpha; `putImageData` premultiplies into the canvas
//! backing store, so `drawImage` source-over equals the GL blend
//! `ONE, ONE_MINUS_SRC_ALPHA` over premultiplied fragments.

import type { DrawCommand, DrawList } from './drawlist.js';
import type { RendererAdapter, RendererViewport } from './adapter.js';
import { straightComponents } from './adapter.js';
import { reconstruct } from './msdf.js';

/** Options for the Canvas 2D renderer. */
export interface Canvas2dOptions {
  /** The canvas to render into. */
  readonly canvas: HTMLCanvasElement;
  /** Supersampling for the CPU glyph rasterization (1 = fast, 2+ = quality). */
  readonly samplesPerTexel?: number;
  /** The raster cache budget in bytes (default 4 MiB). */
  readonly rasterBudgetBytes?: number;
}

/** The uploaded atlas page source: the raw RGBA8 texels + dimensions. */
interface PageSource {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A cached glyph bitmap with its estimated byte cost. */
interface RasterEntry {
  readonly bitmap: HTMLCanvasElement;
  readonly bytes: number;
}

const DEFAULT_RASTER_BUDGET = 4 * 1024 * 1024;
const BITMAP_OVERHEAD = 256;

/**
 * The Canvas 2D MSDF renderer. Glyph bitmaps are rasterized once per
 * (page, uv, device size, color) and cached under a bounded LRU budget;
 * atlas pages are kept as raw pixel sources for the reconstruction.
 */
export class Canvas2dRenderer implements RendererAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly samplesPerTexel: number;
  private readonly rasterBudgetBytes: number;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** texture handle → atlas page pixels. */
  private readonly pages = new Map<number, PageSource>();
  /** texture handle → uploaded image canvas. */
  private readonly imageCanvases = new Map<number, HTMLCanvasElement>();
  private readonly pageHandles = new Map<string, number>();
  private readonly imageHandles = new Map<number, number>();
  /** Raster key → cached bitmap, in LRU order (Map preserves insertion order). */
  private readonly rasterCache = new Map<string, RasterEntry>();
  private rasterBytes = 0;
  private nextHandle = 1;
  private lost = false;

  constructor(options: Canvas2dOptions) {
    this.canvas = options.canvas;
    this.samplesPerTexel = Math.max(1, options.samplesPerTexel ?? 2);
    this.rasterBudgetBytes = options.rasterBudgetBytes ?? DEFAULT_RASTER_BUDGET;
    if (!Number.isFinite(this.rasterBudgetBytes) || this.rasterBudgetBytes < 0) {
      throw new RangeError(
        `raster cache budget must be non-negative, got ${this.rasterBudgetBytes}`,
      );
    }
    this.ctx = this.canvas.getContext('2d');
    if (this.ctx === null) this.lost = true;
  }

  get contextLost(): boolean {
    return this.lost || this.ctx === null;
  }

  onRestore(callback: () => void): void {
    // Canvas 2D has no context-loss event; the host calls resize() to
    // re-establish the surface. Call the callback immediately once.
    callback();
  }

  uploadAtlasPage(
    atlasId: number,
    pageIndex: number,
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number {
    const key = `${atlasId}:${pageIndex}`;
    let handle = this.pageHandles.get(key);
    if (handle === undefined) {
      handle = this.nextHandle++;
      this.pageHandles.set(key, handle);
    }
    this.pages.set(handle, { pixels, width, height });
    return handle;
  }

  uploadImage(imageId: number, pixels: Uint8Array, width: number, height: number): number {
    let handle = this.imageHandles.get(imageId);
    if (handle === undefined) {
      handle = this.nextHandle++;
      this.imageHandles.set(imageId, handle);
    }
    this.imageCanvases.set(handle, pixelsToCanvas(pixels, width, height));
    return handle;
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  draw(list: DrawList, viewport: RendererViewport): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const dpr = viewport.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Clear the whole surface (device size = viewport × dpr), then scroll the
    // document into view.
    ctx.clearRect(0, 0, viewport.w, viewport.h);
    ctx.translate(-viewport.x, -viewport.y);
    for (const command of list.commands) {
      switch (command.type) {
        case 'fill': {
          ctx.fillStyle = rgbaCss(command.color);
          ctx.fillRect(command.x, command.y, command.w, command.h);
          break;
        }
        case 'ruler': {
          ctx.fillStyle = rgbaCss(command.color);
          // Exactly one device pixel tall (ruler line).
          ctx.fillRect(command.x, command.y, command.w, Math.max(1, dpr) / dpr);
          break;
        }
        case 'image': {
          const canvas = this.imageCanvases.get(command.texture);
          if (canvas !== undefined) {
            ctx.drawImage(canvas, command.x, command.y, command.w, command.h);
          }
          break;
        }
        case 'glyph': {
          this.drawGlyph(ctx, command, dpr);
          break;
        }
      }
    }
  }

  private drawGlyph(
    ctx: CanvasRenderingContext2D,
    command: Extract<DrawCommand, { type: 'glyph' }>,
    dpr: number,
  ): void {
    const page = this.pages.get(command.texture);
    if (page === undefined) return;
    // Rasterize at device resolution so the bitmap maps 1:1 under the DPR
    // transform (sharp at every scale; the AA edge is in device px).
    const bw = Math.max(1, Math.round(command.w * dpr));
    const bh = Math.max(1, Math.round(command.h * dpr));
    const key = `${command.texture}|${command.uv.join(',')}|${bw}x${bh}|${command.color.toString(16)}`;
    let entry = this.rasterCache.get(key);
    if (entry === undefined) {
      entry = {
        bitmap: this.rasterize(page, command, bw, bh, dpr),
        bytes: bw * bh * 4 + BITMAP_OVERHEAD,
      };
      this.rasterCache.set(key, entry);
      this.rasterBytes += entry.bytes;
      this.evictRaster();
    } else {
      // LRU touch: re-insert to the most-recent position.
      this.rasterCache.delete(key);
      this.rasterCache.set(key, entry);
    }
    ctx.drawImage(entry.bitmap, command.x, command.y, command.w, command.h);
  }

  /** Rasterize the glyph quad from the MSDF page via the shared math. */
  private rasterize(
    page: PageSource,
    command: Extract<DrawCommand, { type: 'glyph' }>,
    bw: number,
    bh: number,
    dpr: number,
  ): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = bw;
    out.height = bh;
    const outCtx = out.getContext('2d');
    if (outCtx === null) return out;
    const [u0, v0, u1, v1] = command.uv;
    const boxX = u0 * page.width;
    const boxY = v0 * page.height;
    const boxW = (u1 - u0) * page.width;
    const boxH = (v1 - v0) * page.height;
    const coverage = reconstruct(
      page.pixels,
      page.width,
      boxX,
      boxY,
      boxW,
      boxH,
      bw,
      bh,
      command.pxPerTexel * dpr,
      this.samplesPerTexel,
    );
    const imageData = outCtx.createImageData(bw, bh);
    const [r, g, b, a] = straightComponents(command.color);
    const src = imageData.data;
    for (let i = 0; i < coverage.length; i++) {
      const c = coverage[i]! / 255;
      const j = i * 4;
      // Straight color + coverage-scaled alpha: putImageData premultiplies
      // into the backing store, matching the GL blend (see module doc).
      src[j] = Math.round(r * 255);
      src[j + 1] = Math.round(g * 255);
      src[j + 2] = Math.round(b * 255);
      src[j + 3] = Math.round(a * c * 255);
    }
    outCtx.putImageData(imageData, 0, 0);
    return out;
  }

  /** Evict least-recently-used bitmaps until the budget is satisfied. */
  private evictRaster(): void {
    for (const [key, entry] of this.rasterCache) {
      if (this.rasterBytes <= this.rasterBudgetBytes) break;
      this.rasterCache.delete(key);
      this.rasterBytes -= entry.bytes;
    }
  }

  /** The current raster cache usage in bytes. */
  get rasterBytesUsed(): number {
    return this.rasterBytes;
  }

  destroy(): void {
    this.rasterCache.clear();
    this.rasterBytes = 0;
    this.pages.clear();
    this.imageCanvases.clear();
  }
}

/** Build a canvas holding the (possibly RGB8) image pixels. */
function pixelsToCanvas(pixels: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const imageData = ctx.createImageData(width, height);
    if (pixels.length === width * height * 3) {
      const out = imageData.data;
      for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
        out[i] = pixels[j]!;
        out[i + 1] = pixels[j + 1]!;
        out[i + 2] = pixels[j + 2]!;
        out[i + 3] = 255;
      }
    } else {
      imageData.data.set(pixels);
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas;
}

/** RGBA u32 → CSS color string. */
export function rgbaCss(color: number): string {
  const r = (color >>> 24) & 0xff;
  const g = (color >>> 16) & 0xff;
  const b = (color >>> 8) & 0xff;
  const a = (color & 0xff) / 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
