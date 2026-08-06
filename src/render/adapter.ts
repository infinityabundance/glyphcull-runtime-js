//! The renderer adapter seam (Architecture.md §3.7, TESTING.md §1):
//! browser-only rendering (WebGL, Canvas 2D) is behind a thin interface so
//! logic tests run in Node and rendering validation runs in the browser
//! harness. Both renderers consume the same draw list and the same texture
//! sources.

import type { DrawList } from './drawlist.js';

/** The device viewport a frame is drawn into. */
export interface RendererViewport {
  /** The document-space viewport origin (scroll position). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The device pixel ratio. */
  readonly dpr: number;
}

/** A pixel source for texture upload (implemented from the document model). */
export interface TextureSource {
  /** The RGBA8 pixels of an atlas page, or undefined when unavailable. */
  atlasPage(
    atlasId: number,
    pageIndex: number,
  ): { pixels: Uint8Array; width: number; height: number } | undefined;
  /** The raw pixels of an image (RGBA8 or RGB8), or undefined. */
  image(
    imageId: number,
  ): { pixels: Uint8Array; width: number; height: number; format: 0 | 1 } | undefined;
}

/** The renderer adapter contract. */
export interface RendererAdapter {
  /**
   * Upload (or refresh) an atlas page texture. Returns a handle the draw
   * list's texture resolver maps back to.
   */
  uploadAtlasPage(
    atlasId: number,
    pageIndex: number,
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number;
  /** Upload (or refresh) an image texture. */
  uploadImage(imageId: number, pixels: Uint8Array, width: number, height: number): number;
  /** Draw a prepared draw list into the current frame. */
  draw(list: DrawList, viewport: RendererViewport): void;
  /** Resize the drawing surface (CSS pixels × dpr). */
  resize(width: number, height: number, dpr: number): void;
  /** Release GPU resources. */
  destroy(): void;
  /** Whether the adapter lost its context and is awaiting restore. */
  readonly contextLost: boolean;
  /** Register a callback fired after context restore (textures re-uploaded). */
  onRestore?(callback: () => void): void;
}

/** Convert an RGBA u32 to premultiplied float components. */
export function rgbaComponents(color: number): [number, number, number, number] {
  const r = ((color >>> 24) & 0xff) / 255;
  const g = ((color >>> 16) & 0xff) / 255;
  const b = ((color >>> 8) & 0xff) / 255;
  const a = (color & 0xff) / 255;
  // Premultiply (matches the WebGL renderer's compositing).
  return [r * a, g * a, b * a, a];
}

/** Convert an RGBA u32 to straight (non-premultiplied) float components. */
export function straightComponents(color: number): [number, number, number, number] {
  return [
    ((color >>> 24) & 0xff) / 255,
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ];
}
