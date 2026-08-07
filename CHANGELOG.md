# Changelog

All notable changes, reverse chronological. Keep a Changelog format; Semantic Versioning.

## [Unreleased]

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
