# Roadmap — glyphcull-runtime-js

Execution order is mandatory and matches the root `PLAN.md`. This runtime starts only after
the compiler phase completes (the format contract must be final and golden fixtures must
exist).

## Phase 3 — JavaScript runtime (as sequenced in the master plan)

**Status: complete.** All ten subsystems shipped; the test pyramid, browser
rendering validation, and CI are green. Rendering validation established the
shared pixel-center sampling convention (WebGL shifts glyph UVs half a texel;
Canvas 2D rasterizes phase-exact bitmaps) and the premultiplied comparison
space — see Architecture.md §3.7 and TESTING.md §2.

- [x] **3.1 format/**: independent `.cull` reader per SPEC.md; validation; SEAL verification;
      malformed corpus + truncation tests; contract tests against compiler golden fixtures.
- [x] **3.2 document/**: Document model; load-time validation; multi-document coexistence.
- [x] **3.3 lifecycle/**: chunk lifecycle state machine; guarded transitions; transition log;
      property tests; injected clock.
- [x] **3.4 visibility/**: viewport culling + semantic culling; visible-set determinism tests.
- [x] **3.5 materialize/**: priority queue; time/memory budgets; cooperative scheduling;
      eviction with cooling period; starvation tests.
- [x] **3.6 layout/**: UAX #29 word boundaries; KP line breaking; block layout; tables
      (colspan/rowspan); images; deterministic layout tests + golden layout fixtures.
- [x] **3.7 glyphs/**: glyph cache; budget enforcement; cache/eviction coupling tests.
- [x] **3.8 render/**: draw list builder; WebGL MSDF renderer; Canvas 2D fallback; context
      loss recovery; rendering validation vs reference rasterizer.
- [x] **3.9 selection/**: hit testing; ranges; highlight quads; copy extraction policy tests.
- [x] **3.10 api/**: exactly `load/scroll/paint/select/copy/destroy`; misuse tests (destroyed
      handle, concurrent loads); TypeScript declarations; API documentation.
- [x] **Test pyramid complete**: unit, integration, property, stress, memory regression,
      performance regression; CI green.
- [x] **Documentation complete**: Architecture.md/DESIGN.md updated; state machine and data
      flow diagrams; public API docs.

## Definition of done (every phase)

- All tests green; TypeScript strict; lint clean; no `TODO`/`FIXME`/placeholder code.
- Docs updated in lockstep; terminology standard enforced.
- Memory + performance regression baselines recorded.
- Every bug fixed during the phase has a permanent regression test.

## Future phase candidates (recorded, not scheduled)

- Worker-thread materialization (needs scheduler contract extension).
- Complex-script shaping and bidi (depends on compiler-side text scope extension).
- Search index consumption (IDXM section, compiler-side).

## Release status

- **npm artifact prepared** (2026-08-07): the package metadata (`repository`, `keywords`,
  `sideEffects: false`, `prepack` build) and consumption docs are in place; the tarball
  is verified (`npm pack` + install + import smoke). Publishing to npm requires an
  authenticated npm token (`npm login` / `NPM_TOKEN`) — one command: `npm publish`. The
  demo and harnesses continue to consume the repository checkout via
  `build-siblings.sh`; the npm artifact is for external hosts.
