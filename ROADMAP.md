# Roadmap — glyphcull-runtime-js

Execution order is mandatory and matches the root `PLAN.md`. This runtime starts only after
the compiler phase completes (the format contract must be final and golden fixtures must
exist).

## Phase 3 — JavaScript runtime (as sequenced in the master plan)

- [ ] **3.1 format/**: independent `.cull` reader per SPEC.md; validation; SEAL verification;
      malformed corpus + truncation tests; contract tests against compiler golden fixtures.
- [ ] **3.2 document/**: Document model; load-time validation; multi-document coexistence.
- [ ] **3.3 lifecycle/**: chunk lifecycle state machine; guarded transitions; transition log;
      property tests; injected clock.
- [ ] **3.4 visibility/**: viewport culling + semantic culling; visible-set determinism tests.
- [ ] **3.5 materialize/**: priority queue; time/memory budgets; cooperative scheduling;
      eviction with cooling period; starvation tests.
- [ ] **3.6 layout/**: UAX #29 word boundaries; KP line breaking; block layout; tables
      (colspan/rowspan); images; deterministic layout tests + golden layout fixtures.
- [ ] **3.7 glyphs/**: glyph cache; budget enforcement; cache/eviction coupling tests.
- [ ] **3.8 render/**: draw list builder; WebGL MSDF renderer; Canvas 2D fallback; context
      loss recovery; rendering validation vs reference rasterizer.
- [ ] **3.9 selection/**: hit testing; ranges; highlight quads; copy extraction policy tests.
- [ ] **3.10 api/**: exactly `load/scroll/paint/select/copy/destroy`; misuse tests (destroyed
      handle, concurrent loads); TypeScript declarations; API documentation.
- [ ] **Test pyramid complete**: unit, integration, property, stress, memory regression,
      performance regression; CI green.
- [ ] **Documentation complete**: Architecture.md/DESIGN.md updated; state machine and data
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
