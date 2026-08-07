# Changelog

All notable changes, reverse chronological. Keep a Changelog format; Semantic Versioning.

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
