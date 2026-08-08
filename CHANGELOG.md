# Changelog

All notable changes, reverse chronological. Keep a Changelog format; Semantic Versioning.

## [Unreleased]

### Fixed (WebGL `glitch` post effect was imperceptible)

- The `glitch` post mode's bursts fired for ~1% of each cycle with sub-pixel
  displacement, so the effect was technically present but invisible. The
  shader now produces a clearly visible glitch: held-slice displacement
  bursts (~40% duty cycle per 0.85 s), stronger chromatic separation that
  scales with the burst, occasional horizontal block tears, and a rolling
  cyan band — while never adding alpha over empty space (no bleed) and
  staying deterministic per fixed clock time. Verified by the browser
  harness: the mode alters the framebuffer, animates with the clock, and
  stays under the bleed bound.

### Added (WebGL post-processing — the `effects.post` pass)

- `load()` accepts an optional `effects.post` (`'clean' | 'glitch' |
  'pixelated' | 'retro'`): a genuine **fragment-shader post-processing pass**
  on the WebGL renderer (`render/gl.ts`). Every frame renders into an
  offscreen framebuffer texture; a full-screen quad then runs the selected
  mode before presenting — `clean` (the identity; byte-identical to before,
  goldens unchanged), `glitch` (temporal slice jitter + chromatic separation
  + block tears), `pixelated` (block-quantized sampling), `retro` (CRT
  scanlines + vignette + warm grade + RGB convergence). The pass animates
  with the runtime's animation clock (`viewport.time`, the same clock the
  accent uses), so a frame at a fixed time is deterministic; the Canvas 2D
  fallback cannot run a shader and renders clean. `effects.accent` is now
  optional (a `post`-only configuration is valid). Tests: `api` (option
  validation + post loads + accent/post combined) and the browser harness
  (`scripts/browser-harness/post-harness.html` +
  `test/browser/post-effects.spec.ts`) — the identity stays within reference
  tolerance, each mode alters the framebuffer, glitch animates with the
  clock, pixelated produces hard block structure, and no mode fills the
  frame.

### Added (render effects — the animated accent)

- `load()` accepts an optional `effects: { accent: '#rrggbb' }`: glyphs the
  document paints in that exact color render with a **running highlight** —
  a light band whose position is a pure function of the glyph's x and an
  animation time (seconds) the host advances by repainting on a rAF loop
  (`render/effects.ts`, applied in `drawlist.ts`; `paint()` passes the
  clock when effects are configured). The runtime never self-animates; a
  paint at a fixed time is byte-deterministic; no effects → identity
  (goldens unchanged). Used by the demo to animate the top-performer bar of
  every chart. Tests: `drawlist` (accent animates with time, geometry
  identical, deterministic per frame, default ink untouched) and `api`
  (option validation + themed/accent loads).

### Fixed (table columns size to their text — no more 32px collapse)

- `cellNaturalWidth` measured only each cell's **direct** text payload; but
  cell content is laid out in paragraph → run chunks, so every normal table
  cell measured as empty and every column collapsed to the two-em floor
  (32px at 16px text). Tables with wide content (device names, `#`/`█`
  chart bars) wrapped into narrow strips. The natural width is now measured
  per run with the run's own style (a `code` run uses the mono atlas;
  mixed styles sum correctly; hard breaks end a line) — `blockNaturalWidth`
  — so columns size to their content and glyph-drawn chart bars stay on one
  line. Mirrors the Rust core fix. Tests: `layout.test.ts`
  `sizes table columns from the natural width of the cell text (per-run)`;
  the Rust `table_honors_rowspan_and_grows_the_last_spanned_row` now drives
  wrapping with a narrow table instead of the 32px collapse.

### Added (host theming — the `theme` load option)

- `load()` accepts an optional `theme: { ink }` (hex `#rrggbb` / `#rrggbbaa`): a
  host presentation hint that re-inks the document's **default ink** (`#000000` —
  text, headings, list markers, and rules the source did not color) with the given
  color, e.g. `{ ink: '#ffffff' }` for a dark reader. Every other color, image, and
  background is preserved; the rule is exact-match and deterministic; no `theme`
  means the document renders exactly as compiled (goldens unchanged). Applied at
  stamp preparation, stamp lookup, and draw-list emission (glyphs, markers,
  rulers) — `render/theme.ts`, `api/runtime.ts`, `render/drawlist.ts`. Tests:
  `test/render/drawlist.test.ts` (ink-only substitution, geometry unchanged,
  ruler re-ink) and `test/api/api.test.ts` (option validation + themed load).

### Fixed (table captions lay out above the rows)

- `layoutTable` now recognizes a `caption` chunk child (SPEC.md §2.2) and lays it
  out as a text block **above** the rows, advancing the table origin by the
  caption's height — mirroring the Rust core layout. Previously the caption chunk
  was treated as a row with no cells, so its text was dropped from the layout.
  The Linux-wikipedia demo page (4 tables, 1 caption) renders the caption.

### Added (release receipts, hardening pass H7)

- `release/` — the receipt system: schema template, `generate-release-receipt.sh`
  (records commit, deterministic source-tree hash, the real `npm pack` tarball hash,
  toolchain, commands, results, UTC timestamp), `check-release-receipts.sh`
  (`--fast` CI gate; `--full` recomputes the tarball hash from a git worktree of the
  recorded commit — the worktree runs `npm ci` so `prepack` builds the same `dist/`),
  and `release-dry-run.sh`.
- `release/receipts/` — the committed receipt for `glyphcull-runtime-js@0.1.0` with
  build/test/conformance/package gates recorded as pass (full gates re-run at
  generation).
- CI: the `gate` job runs `release/scripts/check-release-receipts.sh --fast`.

## [0.1.0] — 2026-08-07

### Added (first npm release)

- Published to npm as `glyphcull-runtime-js@0.1.0`: ESM (`dist/`, built by `npm run
  build`/`prepack`) with bundled TypeScript declarations, `sideEffects: false` for
  bundlers, the six-operation public surface (`load`/`scroll`/`paint`/`select`/`copy`/
  `destroy`) plus the typed errors, and the documented `LoadOptions`. The package ships
  only `dist/`; the repository remains the source of truth. Verified from the registry:
  fresh install, six-op smoke against a real `.cull` package, typed errors, and a
  strict-mode `tsc` consumer check.

## [Unreleased]

### Changed (README status correction, hardening pass H4)

- The README now leads with the tagline **"A compiled GPU document runtime."** and a
  status block: v0.1 experimental infrastructure prototype; Latin-script per-codepoint
  rendering only (complex shaping, bidi, vertical text, Indic/Arabic scripts, and full
  international publishing are documented exclusions); not DRM; does not make scraping
  impossible. Added the CI badge and the conformance-suite link.

### Changed (fixture refresh + CI hardening)

- Contract fixtures refreshed from the compiler: `pipeline-golden.cull` follows the
  glyph-packer correctness fix (face 0 packs onto one page instead of two; the pinned
  `documentId` and atlas pages in `test/testkit/fixtures.ts` updated accordingly).
- CI now also runs the explicit build, the fixture-load + public-API-surface step
  (`vitest run test/api`), and `npm pack --dry-run`; the README carries the CI badge.

### Added (Phase 0 — Foundations)

- Repository scaffolding: README, Architecture.md, DESIGN.md, ROADMAP.md, TESTING.md,
  PERFORMANCE.md, SECURITY.md, CONTRIBUTING.md, LICENSE (Apache-2.0), CHANGELOG,
  .gitignore, .editorconfig.

### Planned (Phase 3 — per master plan)

- `.cull` reader; Document model; chunk lifecycle state machine; visibility system;
  materialization queue; layout (word boundaries, Knuth–Plass, blocks, tables, images);
  glyph cache; WebGL + Canvas 2D renderers; draw list; selection/copy; the tiny public API.
