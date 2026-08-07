# glyphcull-runtime-js

The JavaScript GlyphCull runtime. Consumes compiled `.cull` packages and paints them on
Canvas 2D / WebGL. This runtime proves the architecture works in today's browsers.

```
Compiled Document (.cull)
        ↓
Visibility System          (viewport culling + semantic culling)
        ↓
Streaming Runtime          (materialization queue, chunk lifecycle, glyph cache)
        ↓
GPU Draw List
        ↓
Pixels                     (WebGL, Canvas 2D fallback)
```

## The runtime is not a browser

Traditional web:

```
Document → DOM → Layout → Paint
```

GlyphCull:

```
Compiled Document → Visibility → Streaming → Draw List → Pixels
```

The runtime knows nothing about HTML, Markdown, or CSS. The compiler owns translation; the
runtime owns execution.

## Public API — intentionally tiny

```
load()    — load and validate a .cull package into a Document
scroll()  — update the viewport; recompute the visible set
paint()   — build the draw list and paint it
select()  — establish a selection range
copy()    — extract the selection as plain text
destroy() — release every resource
```

Everything else is internal. The format contract is `glyphcull-compiler/docs/format/SPEC.md`.

## Install

```sh
npm install glyphcull-runtime-js
```

ESM with bundled TypeScript declarations:

```ts
import { load, RuntimeError } from 'glyphcull-runtime-js';

const doc = await load(cullBytes, {
  canvas,              // HTMLCanvasElement (WebGL, with Canvas 2D fallback)
  dpr: window.devicePixelRatio,
  width: 800,
  height: 600,
  contentWidth: 800,
  margin: 120,
  glyphBudgetBytes: 16 * 1024 * 1024,
  frameBudgetMs: 8,
  coolingPeriodMs: 1500,
});
doc.scroll({ x: 0, y: 400, w: 800, h: 600 });
doc.paint();
try {
  doc.select({ x: 10, y: 40 }, { x: 200, y: 40 });
  const text = doc.copy();
} catch (error) {
  if (error instanceof RuntimeError) console.error(error.kind);
}
doc.destroy();
```

The package ships only the compiled `dist/` (built from `src/` by `npm run build`); the
repository remains the source of truth for tests and the demo harnesses.

## Package layout

```
src/
  api.ts          — the public API surface (load/scroll/paint/select/copy/destroy)
  format/         — independent .cull reader (validated against compiler golden fixtures)
  document/       — Document model: chunk graph, style table, content, atlas handles
  visibility/     — viewport culling + semantic culling → visible set
  materialize/    — materialization queue, budgets, cooperative scheduling
  lifecycle/      — chunk lifecycle state machine
  layout/         — line breaking, block layout, tables, images
  glyphs/         — glyph cache, glyph generation
  render/         — WebGL renderer (MSDF), Canvas 2D fallback, draw list executor
  selection/      — hit testing, selection model, copy extraction
tests/            — unit, integration, property, stress, memory, perf regression
```

## Principles

- **Culling never materializes; materialization never culls.** Responsibilities never merge.
- **Chunk lifecycle is explicit**: Compressed → Queued → Materializing → Visible → Cooling →
  Evicted. No hidden state.
- **Deterministic architecture**: same package + same viewport → same draw list.
- **Cooperative scheduling**: materialization yields within a frame budget so paint stays
  responsive.
- **Terminology**: the codebase reads like a graphics engine (see
  `glyphcull-compiler/docs/format/GLOSSARY.md`).

## Repository documents

`Architecture.md` · `DESIGN.md` · `ROADMAP.md` · `TESTING.md` · `PERFORMANCE.md` ·
`SECURITY.md` · `CONTRIBUTING.md` · `CHANGELOG.md`

## License

Apache-2.0. See [`LICENSE`](LICENSE).
