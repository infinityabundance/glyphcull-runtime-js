//! The WebGL MSDF renderer (Architecture.md §3.7): the median-of-three
//! reconstruction with a fixed 1-device-px edge — the exact GLSL
//! translation of `msdf.ts`, so WebGL, the Canvas fallback, and the
//! reference rasterizer agree within tolerance. Premultiplied alpha,
//! DPR-aware, batched by texture, with context-loss recovery (textures are
//! re-uploaded from the source on restore).
//!
//! Post-processing (`effects.ts`): every frame is rendered into an
//! offscreen framebuffer texture, then a full-screen quad applies the
//! selected post fragment shader to the drawing buffer before presenting.
//! `clean` copies the offscreen texture 1:1 (NEAREST at exact texel
//! centers — byte-identical to rendering directly, so goldens and the
//! reference harness are unchanged); `glitch`, `pixelated`, and `retro`
//! are genuine fragment-shader effects. The mode is fixed per renderer
//! (hosts reload with `load(bytes, { effects: { post } })`); the animation
//! clock arrives per frame as `viewport.time`.

import type { DrawCommand, DrawList } from './drawlist.js';
import type { RendererAdapter, RendererViewport, TextureSource } from './adapter.js';
import { rgbaComponents } from './adapter.js';
import type { PostEffect } from './effects.js';

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
  // Document y grows down; NDC y grows up (the canvas displays GL top at
  // row 0), so the projected y is negated.
  vec2 ndc = (aPos * uScale + uOffset) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
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

/** The full-screen quad (NDC triangle strip); UVs map to the source 1:1. */
const POST_VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// The post fragment shader: one pass, mode-selected by `uEffect`.
//  0 clean      — the identity (exact copy; goldens unchanged)
//  1 glitch     — temporal slice jitter + chromatic separation + block tears
//  2 pixelated  — block-quantized sampling (chunky pixels, real shader math)
//  3 retro      — CRT scanlines + vignette + warm grade + RGB convergence
//
// The source texture holds *premultiplied* colors (the document renders
// with the ONE, ONE_MINUS_SRC_ALPHA blend); the pass preserves that: the
// premultiplied invariant (rgb ≤ a) is re-clamped so the canvas composites
// exactly as the document renderer intends. `uTime` is the runtime's
// animation clock, so a frame at a fixed time is deterministic.
const POST_FRAGMENT_SRC = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uResolution; // device pixel size of the source
uniform float uTime;      // animation clock, seconds
uniform int uEffect;      // 0 clean, 1 glitch, 2 pixelated, 3 retro
varying vec2 vUv;

vec4 sampleTex(vec2 uv) {
  return texture2D(uTex, clamp(uv, 0.0, 1.0));
}

vec4 applyGlitch(vec2 uv) {
  float t = uTime;
  float row = floor(uv.y * 64.0);
  float frame = floor(t * 6.0);
  float rnd = fract(sin(row * 127.1 + frame * 13.7) * 43758.5453);
  float rnd2 = fract(sin(row * 311.7 + frame * 7.3) * 9871.17);
  // Full-slice displacement bursts ~every 0.8s.
  float burst = smoothstep(0.985, 0.998, fract(t / 0.8));
  float shift = burst * (rnd - 0.5) * 0.06;
  // Continuous sub-pixel horizontal jitter.
  float jitter = (fract(sin(row * 47.1 + t * 21.7) * 43758.5453) - 0.5) * 0.002;
  float x = uv.x + jitter + shift;
  // Chromatic separation that grows with the displacement.
  float chroma = 0.004 + shift * 0.6;
  float cr = (rnd2 - 0.5) * chroma;
  float cg = (rnd2 - 0.5) * chroma * 0.5;
  float cb = (rnd2 - 0.5) * chroma;
  vec4 col;
  col.r = sampleTex(vec2(x + cr, uv.y)).r;
  col.g = sampleTex(vec2(x + cg, uv.y)).g;
  col.b = sampleTex(vec2(x + cb, uv.y)).b;
  col.a = sampleTex(vec2(x, uv.y)).a;
  // Rare horizontal block tear.
  float tear = step(0.9965, fract(t * 11.0 + row * 0.13));
  if (tear > 0.5) {
    float rx = fract(sin(row * 199.7 + frame) * 7451.23);
    col = sampleTex(vec2(uv.x + (rx - 0.5) * 0.3, uv.y));
  }
  return col;
}

vec4 applyPixelated(vec2 uv) {
  // Block-quantized sampling: ~1/6 of the device resolution per block.
  vec2 blocks = max(uResolution / 6.0, vec2(1.0));
  vec2 p = (floor(uv * blocks) + 0.5) / blocks;
  return sampleTex(p);
}

vec4 applyRetro(vec2 uv) {
  // The document paints edge-to-edge (no bezel), so a geometric barrel
  // would smear the borders; the CRT look comes from scanlines, vignette,
  // a warm grade, and a subtle RGB convergence shift toward the edges
  // (chromatic fringing — alpha is untouched, so nothing bleeds).
  vec2 c = uv - 0.5;
  vec4 col;
  col.r = sampleTex(vec2(uv.x + 0.0015 * c.x, uv.y)).r;
  col.g = sampleTex(uv).g;
  col.b = sampleTex(vec2(uv.x - 0.0015 * c.x, uv.y)).b;
  col.a = sampleTex(uv).a;
  // CRT scanlines: every third line is dimmed.
  float line = mod(floor(uv.y * uResolution.y), 3.0);
  col.rgb *= 0.84 + 0.16 * smoothstep(1.0, 2.0, line);
  // Vignette.
  float vig = 1.0 - smoothstep(0.35, 0.9, length(c) * 1.4);
  col.rgb *= mix(0.5, 1.0, vig);
  // Warm CRT grade (scaling premultiplied channels keeps the blend valid).
  col.r *= 1.06;
  col.g *= 0.98;
  col.b *= 0.9;
  return col;
}

void main() {
  vec4 col;
  if (uEffect == 1) col = applyGlitch(vUv);
  else if (uEffect == 2) col = applyPixelated(vUv);
  else if (uEffect == 3) col = applyRetro(vUv);
  else col = sampleTex(vUv);
  // The premultiplied invariant: never let a channel exceed the alpha
  // (shifts and grades can disturb it; the canvas compositor needs it).
  col.rgb = min(col.rgb, vec3(col.a));
  gl_FragColor = col;
}
`;

/** The post-mode → shader selector. */
const POST_IDS: Record<PostEffect, number> = {
  clean: 0,
  glitch: 1,
  pixelated: 2,
  retro: 3,
};

/** Options for the WebGL renderer. */
export interface GlOptions {
  /** The canvas to render into. */
  readonly canvas: HTMLCanvasElement;
  /** Pixel sources for (re-)upload after context loss. */
  readonly source: TextureSource;
  /** Invoked after a context restore. */
  onRestored?: () => void;
  /** The post-processing pass (default 'clean'). */
  readonly post?: PostEffect;
}

/** The WebGL MSDF renderer. */
export class WebGlRenderer implements RendererAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly source: TextureSource;
  private readonly post: PostEffect;
  private readonly restored: (() => void)[] = [];
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private whiteTexture: WebGLTexture | null = null;
  private readonly textures = new Map<
    number,
    { texture: WebGLTexture; width: number; height: number }
  >();
  private readonly pageHandles = new Map<string, number>();
  private readonly imageHandles = new Map<number, number>();
  private nextHandle = 2;
  private lost = false;

  // The post-processing pass (offscreen framebuffer + full-screen quad).
  private postProgram: WebGLProgram | null = null;
  private postA = -1;
  private postVbo: WebGLBuffer | null = null;
  private fb: WebGLFramebuffer | null = null;
  private fbTexture: WebGLTexture | null = null;
  private fbSize = { w: 0, h: 0 };
  private uPostTex: WebGLUniformLocation | null = null;
  private uPostRes: WebGLUniformLocation | null = null;
  private uPostTime: WebGLUniformLocation | null = null;
  private uPostEffect: WebGLUniformLocation | null = null;

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
    this.post = options.post ?? 'clean';
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
    this.initPost(gl);
    // The offscreen target exists from the start (the canvas's attribute
    // size is the initial surface; resize() replaces it as needed).
    this.ensureFramebuffer(gl, this.canvas.width, this.canvas.height);
  }

  /** Compile the post program and the full-screen quad. */
  private initPost(gl: WebGLRenderingContext): void {
    const vs = compileShader(gl, gl.VERTEX_SHADER, POST_VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, POST_FRAGMENT_SRC);
    const program = gl.createProgram() as WebGLProgram | null;
    if (program === null || vs === null || fs === null) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL post program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.postProgram = program;
    this.postA = gl.getAttribLocation(program, 'aPos');
    this.uPostTex = gl.getUniformLocation(program, 'uTex');
    this.uPostRes = gl.getUniformLocation(program, 'uResolution');
    this.uPostTime = gl.getUniformLocation(program, 'uTime');
    this.uPostEffect = gl.getUniformLocation(program, 'uEffect');
    const vbo = gl.createBuffer() as WebGLBuffer | null;
    if (vbo !== null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
    }
    this.postVbo = vbo;
  }

  /** (Re)create the offscreen target at the given device size. */
  private ensureFramebuffer(gl: WebGLRenderingContext, w: number, h: number): void {
    if (this.fb !== null && this.fbTexture !== null && this.fbSize.w === w && this.fbSize.h === h) {
      return;
    }
    this.fbSize = { w, h };
    const texture = gl.createTexture() as WebGLTexture | null;
    const fb = gl.createFramebuffer() as WebGLFramebuffer | null;
    if (texture === null || fb === null) {
      this.fb = null;
      this.fbTexture = null;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // NEAREST: the post pass maps each drawing-buffer pixel to exactly one
    // source texel (clean is a 1:1 copy; block modes quantize in shader UV).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // An incomplete offscreen target (e.g. a driver with a 0-sized
      // surface): fall back to rendering directly to the drawing buffer and
      // skip the post pass — the document still renders, unprocessed.
      this.fb = null;
      this.fbTexture = null;
    } else {
      this.fb = fb;
      this.fbTexture = texture;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    let entry = this.textures.get(handle);
    if (entry === undefined) {
      const created = gl.createTexture() as WebGLTexture | null;
      if (created === null) throw new Error('WebGL texture allocation failed');
      entry = { texture: created, width, height };
      this.textures.set(handle, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
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
    this.ensureFramebuffer(gl, this.canvas.width, this.canvas.height);
  }

  draw(list: DrawList, viewport: RendererViewport): void {
    const gl = this.gl;
    if (gl === null || this.program === null) return;
    // The document renders into the offscreen target; the post pass then
    // presents it (or, if the offscreen target is unavailable, directly).
    if (this.fb !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.viewport(0, 0, this.fbSize.w, this.fbSize.h);
    }
    gl.enable(gl.BLEND);
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
    this.drawPost(gl, viewport.time ?? 0);
  }

  /** The full-screen post pass: offscreen texture → drawing buffer. */
  private drawPost(gl: WebGLRenderingContext, time: number): void {
    if (
      this.fb === null ||
      this.fbTexture === null ||
      this.postProgram === null ||
      this.postVbo === null
    ) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // The source is already premultiplied; write it through unblended so
    // the canvas compositor sees exactly the document's composited color.
    gl.disable(gl.BLEND);
    gl.useProgram(this.postProgram);
    gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uPostTex, 0);
    gl.uniform2f(this.uPostRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uPostTime, time);
    gl.uniform1i(this.uPostEffect, POST_IDS[this.post]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.postVbo);
    gl.enableVertexAttribArray(this.postA);
    gl.vertexAttribPointer(this.postA, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
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
    const entry = this.textures.get(command.texture);
    if (entry === undefined) return;
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    this.drawOneQuad(command.x, command.y, command.w, command.h, 0, 0, 1, 1, 1, 1, 1, 1, 1);
    // Images are opaque; the white-tint with coverage 1 renders them 1:1.
  }

  private drawBatch(
    commands: Extract<DrawCommand, { type: 'glyph' }>[],
    textureHandle: number,
    viewport: RendererViewport,
  ): void {
    const gl = this.gl!;
    const entry = this.textures.get(textureHandle);
    if (entry === undefined) return;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    // GLSL texture2D LINEAR samples at uv·size − 0.5 (texel centers at
    // integers); the reference and the Canvas 2D fallback sample at pixel
    // centers (uv·size). Shift the glyph UVs half a texel so all three agree
    // exactly (the MSDF ink placement matches the CPU rasterizer).
    const halfTexelU = 0.5 / entry.width;
    const halfTexelV = 0.5 / entry.height;
    const data = new Float32Array(commands.length * 6 * 9);
    let o = 0;
    for (const command of commands) {
      const [r, g, b, a] = rgbaComponents(command.color);
      const pxRange = command.pxPerTexel * viewport.dpr;
      const [u0, v0, u1, v1] = command.uv;
      pushQuad(
        data,
        o,
        command.x,
        command.y,
        command.w,
        command.h,
        [u0 + halfTexelU, v0 + halfTexelV, u1 + halfTexelU, v1 + halfTexelV],
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
