# Performance — glyphcull-runtime-js

Status: Phase 3 in progress — 3.1–3.8 landed; the benchmark suite and memory harness land with the remaining Phase 3 work. GlyphCull
never prematurely optimizes: deterministic architecture first, then profile, measure,
optimize on evidence.

## 1. Objectives

The runtime must remain interactive on documents of arbitrary size. Streaming is not
optional: a 50 MB package must paint the viewport in bounded time and bounded memory, with
the viewport populated progressively.

## 2. Budgets (v1, to be confirmed by measurement)

| Metric | Budget (reference: 2020-era laptop, Chromium) |
|---|---|
| `load()` for 10 MB package | < 150 ms validation + model build |
| First `paint()` after load | < 100 ms to first pixels (progressive) |
| Sustained scroll frame time | < 16 ms p95 (paint only); materialization scheduled around it |
| Materialization throughput | ≥ 5 MB text materialized per second sustained |
| Glyph cache budget | default 64 MB, configurable; eviction, never failure |
| Materialization budget/frame | default 8 ms, configurable |
| Memory overhead beyond package bytes | < 8 × package size at steady state (layouts + caches) |
| Resize invalidation | re-materialization of affected chunks ≤ 100 ms for a viewport |

## 3. Methodology

- All benchmarks committed; baselines recorded as machine-relative ratios and absolute
  numbers with the measurement environment recorded.
- Memory measured with `--expose-gc` retained-heap harness; regression threshold = ratio
  to committed baseline with documented tolerance (GC noise).
- Frame-time measurement uses the browser harness with warmup, documented percentiles
  (p50/p95), and pinned page state.
- Every optimization must be (a) profile-motivated, (b) behavior-preserving (draw list and
  visible set unchanged — verified by determinism tests), (c) regression-covered.

## 4. Known hot paths (to profile, not optimize blind)

- Reader: CRC-32 and zlib decode (Worker-eligible; initial load only).
- Layout: KP line breaking per paragraph (cached per (chunk, width, size, dpr)).
- Glyph generation: quad emission; batching by atlas page.
- Draw list: command compaction; upload budget (textures).

## 5. Streaming invariants (performance-critical, tested)

- Visible set size is bounded by viewport size, not document size.
- Materialization queue is bounded by budget; priority ordering is O(visible frontier).
- Eviction releases glyph cache and layout records of cooled chunks; steady-state memory is
  independent of total document size.

## 6. Evidence log

To be appended as Phase 3 lands: environment, commands, measurements, decisions.
