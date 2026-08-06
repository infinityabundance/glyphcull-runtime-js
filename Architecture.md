# Architecture — glyphcull-runtime-js

Status: Phase 3 complete — all ten subsystems landed (format, document,
lifecycle, visibility, materialize, layout, glyphs, render, selection, api)
with the full test pyramid, browser rendering validation, and CI. Living
document; the Rust runtime mirrors this architecture exactly.
The Rust runtime (`glyphcull-runtime-rs`) mirrors this architecture exactly — only
implementation changes.

## 1. Position

The runtime is a **compiled document host**. It consumes `.cull` packages; it never sees
HTML, Markdown, or CSS. Its pipeline is:

```
Compiled Document (.cull)
        ↓
Visibility System
        ↓
Streaming Runtime
        ↓
GPU Draw List
        ↓
Pixels
```

## 2. Runtime pipeline

```
                            ┌──────────────────────────┐
                            │      load()              │  reader → Document model
                            └────────────┬─────────────┘
                                         ▼
                            ┌──────────────────────────┐
                            │   Visibility System      │  viewport culling + semantic
                            │   (visible set)          │  culling. Determines only.
                            └────────────┬─────────────┘
                                         ▼
                            ┌──────────────────────────┐
                            │ Materialization Queue    │  priorities + budgets + yields
                            └────────────┬─────────────┘
                                         ▼
                            ┌──────────────────────────┐
                            │   Materialize chunk      │  stream → layout → glyph instances
                            │   (lifecycle machine)    │  Compressed→…→Visible
                            └────────────┬─────────────┘
                                         ▼
                            ┌──────────────────────────┐
                            │   Draw list builder      │  visible set → ordered commands
                            └────────────┬─────────────┘
                                         ▼
                            ┌──────────────────────────┐
                            │   paint() → GPU          │  WebGL (MSDF) | Canvas 2D
                            └──────────────────────────┘
```

`scroll()` feeds the visibility system; `select()`/`copy()` operate on the laid-out model;
`destroy()` tears down everything. The pipeline is the only architecture: no subsystem
bypasses a stage.

## 3. Subsystems

### 3.1 format/ — the reader

- Independent implementation of SPEC.md. Bounds-checked, typed errors, never panics.
- Validates header, section table, CRC-32, compression, limits; verifies SEAL when present.
- Produces typed section models (chunk graph, style table, content payloads, atlas handles,
  image payloads) without decoding the whole package eagerly where streaming is possible.
- Cross-checked against the compiler's golden fixtures (Phase 3 contract tests) and the
  Rust runtime's reader (Phase 5 cross-implementation validation).

### 3.2 document/ — the Document model

- Chunk graph (tree links, ordinals, kinds, flags), style table (flat resolved styles),
  content payloads, atlas descriptors, image payloads.
- Validated at load (chunk tree invariants, reference resolution) then treated as trusted.
- **No geometry lives here** — geometry is produced by materialization and owned by the
  layout structures.

### 3.3 visibility/ — the Visibility System

- **Viewport culling**: walks the chunk graph in document order, consulting cached layout
  positions; a chunk is in the visible set iff its geometry intersects the viewport
  (expanded by a margin). Chunks beyond the materialized frontier are not laid out at all —
  they are *not yet visible* rather than *not visible*.
- **Semantic culling**: applies semantic visibility rules (e.g., `hidden` chunks) before
  geometry is considered.
- **Responsibility boundary**: culling determines; it never materializes, never generates
  glyphs, never paints. Enforced by module boundaries and tests.

### 3.4 materialize/ — the Streaming Runtime

- **Materialization queue**: chunks enter with a priority derived from viewport distance and
  direction of travel (deterministic); work is executed within a per-frame time budget and
  yields cooperatively.
- **Budgets**: time (ms per frame) and memory (glyph cache budget); enforced, measured.
- **Eviction**: chunks leave the visible set → Cooling (grace period) → Evicted (resources
  returned). LRU-with-age discipline, deterministic.
- Chunk lifecycle state machine (§4) is the only way chunks change state.

### 3.5 layout/ — materialization internals

- Line breaking: Unicode word boundaries (UAX #29) + Knuth–Plass-quality breaking with a
  deterministic fallback; `nowrap`/`pre` modes; justified/start/center/end alignment.
- Block layout: margins, indents, list markers, rules (hr), captions, tables (colspan/
  rowspan), images with intrinsic aspect ratio.
- Output: per-chunk layout records with glyph instances (or image quads), absolute
  geometry, and text-run positions for selection.
- Scope boundary (documented in DESIGN.md): per-codepoint shaping with combining-mark
  attachment; complex-script shaping and bidi are explicit v1 exclusions.

### 3.6 glyphs/ — glyph cache

- Glyph instances are cached per (atlas, codepoint, size, color) quad; the cache is budgeted
  and evicted with its owning chunk's lifecycle (Evicted ⇒ cache entries released).
- The atlas texture is uploaded once per atlas; glyph quads sample it with MSDF
  reconstruction in the shader.

### 3.7 render/ — draw list and GPU execution

- **Draw list**: an ordered sequence of draw commands (glyph runs, image quads, selection
  quads, backgrounds), batched by texture/material, produced deterministically from the
  visible set + selection.
- **WebGL renderer**: MSDF shader (median-of-three, screen-space derivative antialiasing),
  premultiplied alpha, device-pixel-ratio aware; context-loss recovery.
- **Canvas 2D fallback**: same draw list, sampled atlas via `ImageData`/`drawImage`; exact
  same output within coverage tolerance (validated by rendering tests).
- Renderer selection: WebGL when available; Canvas 2D otherwise; explicit opt-out.

### 3.8 selection/ — selection and copy

- Hit testing against glyph-instance boxes and image quads → logical ranges
  (chunk id + text offsets).
- Selection renders as quads in the draw list (independent of glyph rasterization).
- `copy()` extracts the selection as plain text from chunk content, preserving document
  order, with explicit line/paragraph boundaries; table cells separated by tabs, rows by
  newlines (documented policy).

### 3.9 api.ts — the public API

Exactly six functions; everything else internal and not exported. `load()` returns a
`Document` handle; the rest are methods on it (or free functions taking it). Destroyed
handles reject subsequent calls with a typed error.

## 4. Chunk lifecycle state machine

```
Compressed ──(enqueue)──▶ Queued ──(budget granted)──▶ Materializing ──(complete)──▶ Visible
    ▲                        │                              │                           │
    │                        │                              │ (budget exhausted)       │
    │                        └──────────────────────────────┘                           │
    │                                          ▲                                        │
    │                                          │ (culled)                               ▼
    └─────────────────────(queued again)──── Cooling ◀───────────────(left visible set)──┘
                                            │
                                            │ (cooling period elapsed)
                                            ▼
                                        Evicted ──(resources released)──▶ (re-enter at Compressed)
```

- Every transition is explicit, guarded, and recorded (transition log for diagnostics/tests).
- Guards: `Queued→Materializing` requires budget; `Visible→Cooling` requires culling;
  `Cooling→Evicted` requires cooling period elapsed and no selection referencing the chunk.
- A chunk whose content is needed again re-enters at `Compressed → Queued`.
- Hidden (semantically culled) chunks never enter the queue.

## 5. Determinism

- Same package + same viewport + same device scale ⇒ same visible set, same draw list.
- Priorities are pure functions of (viewport, document); no wall-clock except for budget
  *measurement* (never affecting decisions).
- The transition log is deterministic in tests (injected clock).

## 6. Memory ownership

- The Document owns content (from the package); layout records own glyph instances; the
  glyph cache owns cached quads; the GPU owns textures.
- `destroy()`: releases event listeners, GPU resources, cache, layout, model — in order.
- No global state; multiple Documents coexist; each is self-contained.

## 7. Related documents

[`DESIGN.md`](DESIGN.md) (rationale) · [`TESTING.md`](TESTING.md) · [`PERFORMANCE.md`](PERFORMANCE.md) ·
[`SECURITY.md`](SECURITY.md) · format contract: `glyphcull-compiler/docs/format/SPEC.md` ·
terminology: `glyphcull-compiler/docs/format/GLOSSARY.md`.
