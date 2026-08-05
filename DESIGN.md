# Design — glyphcull-runtime-js

Status: Phase 0 (foundations). Decisions recorded with rationale, alternatives, tradeoffs.
The Rust runtime mirrors these decisions; cross-references are noted where they differ.

## D1. TypeScript, zero runtime dependencies

- **Rationale**: types make the chunk lifecycle and format reader auditable; zero runtime
  dependencies means the shipped runtime is fully ours — no supply-chain surface in the
  artifact, deterministic behavior, trivial audit. The format is binary and self-contained,
  so no utility library is needed.
- **Alternatives**: plain JS (loses static verification of a state machine), framework
  (rejected: the runtime is infrastructure, not an app).
- **Tradeoffs**: we write our own binary reader, UTF-8 handling, and atlas sampling — that
  is the point of the project.

## D2. WebGL primary, Canvas 2D fallback

- **Rationale**: MSDF rendering requires per-pixel shader evaluation — WebGL is the right
  host. Canvas 2D keeps the runtime usable where WebGL is unavailable (software rendering,
  restricted environments) — the same draw list executes on both.
- **Alternatives**: Canvas 2D only (weak MSDF quality control), WebGL only (breaks the
  fallback guarantee).
- **Tradeoffs**: two renderer backends to test — mitigated by shared draw list + rendering
  validation against the reference rasterizer.

## D3. Cooperative materialization with budgets

- **Rationale**: materialization is the long pole; a document must be interactive before it
  is fully materialized. Time-budgeted, yield-based scheduling keeps paint latency bounded
  while streaming large documents. Deterministic priorities keep behavior reproducible.
- **Alternatives**: worker-thread materialization (real parallelism, but complicates the
  lifecycle and is not available in all hosts), synchronous full materialization (blocks
  paint; defeats streaming).
- **Tradeoffs**: complexity of a scheduler — contained in one module with property tests
  (invariants: no starvation of visible chunks, budgets respected, determinism).

## D4. Explicit chunk lifecycle (Compressed → Queued → Materializing → Visible → Cooling → Evicted)

- **Rationale**: streaming systems live or die by their eviction discipline. An explicit
  state machine with guarded transitions and a transition log makes behavior testable,
  debuggable, and deterministic.
- **Alternatives**: ad-hoc caching flags (hidden state — forbidden by the charter).
- **Tradeoffs**: slight ceremony; justified by the charter's "no hidden state" rule.

## D5. Layout at materialization time, driven by a sequential frontier

- **Rationale**: chunk bounds are only known after layout; a full pre-layout pass would
  defeat streaming. The visibility system walks the chunk graph in document order, laying
  out incrementally as needed, and caches layout records. Chunks past the frontier are not
  laid out — they simply have no geometry yet (streaming, not absence).
- **Alternatives**: precompute layout in the compiler (breaks viewport-adaptive layout;
  couples compiler to runtime geometry).
- **Tradeoffs**: layout cache invalidation on resize — handled by invalidation keys
  (font size, width, device scale) and re-materialization through the lifecycle.

## D6. Knuth–Plass-quality line breaking (deterministic)

- **Rationale**: justification quality is a first-order document-quality property for
  archival/scientific material. KP breaks are deterministic and high-quality; the reference
  implementation is well documented.
- **Alternatives**: greedy wrapping (fast, visibly worse for justified text).
- **Tradeoffs**: KP cost is higher per paragraph — bounded by paragraph size, budgeted, and
  cached; performance targets in PERFORMANCE.md.

## D7. Simple shaping scope (explicit boundary)

- Per-codepoint glyph selection with combining-mark attachment (marks advance 0, positioned
  by the base glyph) covers Latin, Cyrillic, Greek, and mark-heavy scripts adequately.
  Complex shaping (Arabic, Indic), bidi, hyphenation, and vertical text are **documented
  exclusions** for v1 — tracked in ROADMAP.md — and are not silently partial: the runtime
  checks and reports unsupported script ranges when asked (diagnostics API internal).
- **Rationale**: correctness for the supported scope beats broken rendering for the
  unsupported scope. The compiler's GLOSSARY/SPEC make the scope explicit.

## D8. MSDF reconstruction in the shader

- The atlas stores three signed-distance channels (texel units); the shader takes the
  median, converts texel distance → screen pixels via (font size × device scale) /
  texels-per-em, and antialiases with screen-space derivatives. This is the standard,
  validated approach (SPEC.md §2.5); rendering validation compares output against the
  reference rasterizer.

## D9. Selection is logical, rendering is geometric

- Selection is stored as logical ranges (chunk id + offsets) — independent of pixels.
  Rendering projects ranges to quads via layout records. Copy extracts plain text from
  chunk content. This keeps selection stable across re-materialization.

## D10. Determinism policy

- No wall-clock in decisions (budget measurement only), no `Math.random`, no iteration over
  `Map`/`Set` in any output path, all ordering explicit. Same inputs ⇒ same draw list.
  Enforced by tests (double-paint byte comparison of draw lists).

## D11. Resource budgets are enforced, measured, and tested

- Glyph cache budget (bytes), materialization budget (ms/frame), layout cache budget
  (records), texture budget (bytes). Exceeding a budget triggers eviction (never failure);
  budgets are configurable at `load()` and measured by memory regression tests.

## D12. Public API surface is exactly six functions

- Anything not in `load/scroll/paint/select/copy/destroy` is not public. Rationale: a tiny
  contract is a durable contract; hosts (demo, future native wrappers) adapt, not the
  runtime. Destroyed handles reject calls with typed errors (tests cover all misuse paths).
