//! The WebGL MSDF renderer (Architecture.md §3.7): the median-of-three
//! reconstruction with a fixed 1-device-px edge — the exact GLSL
//! translation of `msdf.ts`, so WebGL, the Canvas fallback, and the
//! reference rasterizer agree within tolerance. Premultiplied alpha,
//! DPR-aware, batched by texture, with context-loss recovery (textures are
//! re-uploaded from the source on restore).

import type { DrawCommand, DrawList } from './drawlist.js';
import type { RendererAdapter, RendererViewport, TextureSource } from './adapter.js';
import { rgbaComponents } from './adapter.js';

const VERTEX_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aColor;
attribute float aPxRange;
uniform vec2 uScale;
uniform vec2 uOffset;
varying vec2 vUv;
varying vec4 vColor;
varying float vPxRange;
void main() {
  vUv = aUv;
  vColor = aColor;
  vPxRange = aPxRange;
  gl_Position = vec4((aPos * uScale + uOffset) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
varying vec4 vColor;
varying float vPxRange;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 msd = texture2D(uTex, vUv).rgb;
  float distPx = (median(msd.r, msd.g, msd.b) - 0.5) * vPxRange;
  float t = clamp(distPx + 0.5, 0.0, 1.0);
  float coverage = t * t * (3.0 - 2.0 * t);
  gl_FragColor = vec4(vColor.rgb * coverage, vColor.a * coverage);
}
`;

/** Options for the WebGL renderer. */
export interface GlOptions {
  /** The canvas to render into. */
  readonly canvas: HTMLCanvasElement;
  /** Pixel sources for (re-)upload after context loss. */
  readonly source: TextureSource;
  /** Invoked after a context restore. */
  onRestored?: () => void;
}

/** The WebGL MSDF renderer. */
export class WebGlRenderer implements RendererAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly source: TextureSource;
  private readonly restored: (() => void)[] = [];
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private whiteTexture: WebGLTexture | null = null;
  private readonly textures = new Map<number, WebGLTexture>();
  private readonly pageHandles = new Map<string, number>();
  private readonly imageHandles = new Map<number, number>();
  private nextHandle = 2;
  private lost = false;

  private aPos = -1;
  private aUv = -1;
  private aColor = -1;
  private aPxRange = -1;
  private uScale: WebGLUniformLocation | null = null;
  private uOffset: WebGLUniformLocation | null = null;
  private uTex: WebGLUniformLocation | null = null;

  constructor(options: GlOptions) {
    this.canvas = options.canvas;
    this.source = options.source;
    if (options.onRestored !== undefined) this.restored.push(options.onRestored);
    const gl = this.canvas.getContext('webgl', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
    });
    if (gl === null) {
      this.lost = true;
      return;
    }
    this.init(gl);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      const restored = this.canvas.getContext('webgl');
      if (restored !== null) {
        this.textures.clear();
        this.whiteTexture = null;
        this.init(restored);
        this.reuploadAll();
        for (const cb of this.restored) cb();
      }
    });
  }

  get contextLost(): boolean {
    return this.lost || this.gl === null;
  }

  onRestore(callback: () => void): void {
    this.restored.push(callback);
  }

  private init(gl: WebGLRenderingContext): void {
    this.gl = gl;
    this.lost = false;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    // The DOM lib types createProgram as non-null, but real drivers can fail
    // allocation; widen to the WebGL spec's nullable contract so the guard
    // below is genuine (and TS's const-narrowing cannot make it dead).
    const program = gl.createProgram() as WebGLProgram | null;
    if (program === null || vs === null || fs === null) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.aPos = gl.getAttribLocation(program, 'aPos');
    this.aUv = gl.getAttribLocation(program, 'aUv');
    this.aColor = gl.getAttribLocation(program, 'aColor');
    this.aPxRange = gl.getAttribLocation(program, 'aPxRange');
    this.uScale = gl.getUniformLocation(program, 'uScale');
    this.uOffset = gl.getUniformLocation(program, 'uOffset');
    this.uTex = gl.getUniformLocation(program, 'uTex');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  private handleForPage(atlasId: number, pageIndex: number): number {
    const key = `${atlasId}:${pageIndex}`;
    let handle = this.pageHandles.get(key);
    if (handle === undefined) {
      handle = this.nextHandle++;
      this.pageHandles.set(key, handle);
    }
    return handle;
  }

  uploadAtlasPage(
    atlasId: number,
    pageIndex: number,
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number {
    const handle = this.handleForPage(atlasId, pageIndex);
    this.uploadTexture(handle, pixels, width, height);
    return handle;
  }

  uploadImage(imageId: number, pixels: Uint8Array, width: number, height: number): number {
    let handle = this.imageHandles.get(imageId);
    if (handle === undefined) {
      handle = this.nextHandle++;
      this.imageHandles.set(imageId, handle);
    }
    this.uploadTexture(handle, pixels, width, height);
    return handle;
  }

  private uploadTexture(handle: number, pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    if (gl === null) return;
    let texture = this.textures.get(handle);
    if (texture === undefined) {
      // Same nullable widening as init(): the DOM lib types createTexture as
      // non-null, but drivers can fail.
      const created = gl.createTexture() as WebGLTexture | null;
      if (created === null) throw new Error('WebGL texture allocation failed');
      texture = created;
      this.textures.set(handle, texture);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private white(): WebGLTexture {
    const gl = this.gl!;
    if (this.whiteTexture !== null) return this.whiteTexture;
    const texture = gl.createTexture() as WebGLTexture | null;
    if (texture === null) throw new Error('WebGL texture allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.whiteTexture = texture;
    return texture;
  }

  resize(width: number, height: number, dpr: number): void {
    const gl = this.gl;
    if (gl === null) return;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(list: DrawList, viewport: RendererViewport): void {
    const gl = this.gl;
    if (gl === null || this.program === null) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    const scaleX = viewport.dpr / this.canvas.width;
    const scaleY = viewport.dpr / this.canvas.height;
    gl.uniform2f(this.uScale, scaleX, scaleY);
    gl.uniform2f(this.uOffset, -viewport.x * scaleX, -viewport.y * scaleY);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    let batch: Extract<DrawCommand, { type: 'glyph' }>[] = [];
    let batchTexture = -1;
    const flush = (): void => {
      if (batch.length > 0) {
        this.drawBatch(batch, batchTexture, viewport);
        batch = [];
      }
    };
    for (const command of list.commands) {
      if (command.type === 'glyph') {
        if (batchTexture !== -1 && command.texture !== batchTexture) flush();
        batchTexture = command.texture;
        batch.push(command);
      } else {
        flush();
        batchTexture = -1;
        if (command.type === 'image') {
          this.drawImageQuad(command);
        } else {
          this.drawFill(command);
        }
      }
    }
    flush();
  }

  private drawFill(command: Extract<DrawCommand, { type: 'fill' | 'ruler' }>): void {
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.white());
    const [r, g, b, a] = rgbaComponents(command.color);
    const height = command.type === 'ruler' ? 1 : command.h;
    // pxRange = 1 forces coverage 1 through the white texture.
    this.drawOneQuad(command.x, command.y, command.w, height, 0, 0, 1, 1, r, g, b, a, 1);
  }

  private drawImageQuad(command: Extract<DrawCommand, { type: 'image' }>): void {
    const texture = this.textures.get(command.texture);
    if (texture === undefined) return;
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.drawOneQuad(command.x, command.y, command.w, command.h, 0, 0, 1, 1, 1, 1, 1, 1, 1);
    // Images are opaque; the white-tint with coverage 1 renders them 1:1.
  }

  private drawBatch(
    commands: Extract<DrawCommand, { type: 'glyph' }>[],
    textureHandle: number,
    viewport: RendererViewport,
  ): void {
    const gl = this.gl!;
    const texture = this.textures.get(textureHandle);
    if (texture === undefined) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const data = new Float32Array(commands.length * 6 * 9);
    let o = 0;
    for (const command of commands) {
      const [r, g, b, a] = rgbaComponents(command.color);
      const pxRange = command.pxPerTexel * viewport.dpr;
      pushQuad(
        data,
        o,
        command.x,
        command.y,
        command.w,
        command.h,
        command.uv,
        r,
        g,
        b,
        a,
        pxRange,
      );
      o += 54;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(this.aPxRange);
    gl.vertexAttribPointer(this.aPxRange, 1, gl.FLOAT, false, stride, 32);
    gl.drawArrays(gl.TRIANGLES, 0, commands.length * 6);
  }

  private drawOneQuad(
    x: number,
    y: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
    pxRange: number,
  ): void {
    const gl = this.gl!;
    const data = new Float32Array(54);
    pushQuad(data, 0, x, y, w, h, [u0, v0, u1, v1], r, g, b, a, pxRange);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(this.aPxRange);
    gl.vertexAttribPointer(this.aPxRange, 1, gl.FLOAT, false, stride, 32);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private reuploadAll(): void {
    for (const key of this.pageHandles.keys()) {
      const [atlasId, pageIndex] = key.split(':').map(Number);
      const page = this.source.atlasPage(atlasId!, pageIndex!);
      if (page !== undefined) {
        this.uploadAtlasPage(atlasId!, pageIndex!, page.pixels, page.width, page.height);
      }
    }
    for (const imageId of this.imageHandles.keys()) {
      const image = this.source.image(imageId);
      if (image !== undefined) {
        this.uploadImage(imageId, image.pixels, image.width, image.height);
      }
    }
  }

  destroy(): void {
    const gl = this.gl;
    if (gl !== null) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
  }
}

/** Push one textured quad (6 vertices × 9 floats) into `data` at `offset`. */
function pushQuad(
  data: Float32Array,
  offset: number,
  x: number,
  y: number,
  w: number,
  h: number,
  uv: readonly [number, number, number, number],
  r: number,
  g: number,
  b: number,
  a: number,
  pxRange: number,
): void {
  const [u0, v0, u1, v1] = uv;
  const quad = [
    [x, y, u0, v0, r, g, b, a, pxRange],
    [x + w, y, u1, v0, r, g, b, a, pxRange],
    [x, y + h, u0, v1, r, g, b, a, pxRange],
    [x, y + h, u0, v1, r, g, b, a, pxRange],
    [x + w, y, u1, v0, r, g, b, a, pxRange],
    [x + w, y + h, u1, v1, r, g, b, a, pxRange],
  ] as const;
  let o = offset;
  for (const vertex of quad) {
    for (const component of vertex) {
      data[o++] = component;
    }
  }
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`WebGL shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}
