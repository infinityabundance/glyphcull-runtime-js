# Security — glyphcull-runtime-js

Status: Phase 3 in progress — threat model defined (Phase 0); the concrete audit lands with the remaining Phase 3 work.

## 1. Position

GlyphCull is not marketed as impossible to scrape — that claim is not supportable on an open
client. The compiled representation raises the engineering cost of high-quality,
large-scale automated extraction. This document makes technically accurate claims only.

## 2. Trust model

- **Packages are untrusted**: a runtime may be asked to load arbitrary `.cull` bytes from
  the network, storage, or archives. The reader and all downstream subsystems must handle
  hostile packages without memory unsafety, unbounded resource use, or crashes.
- **The host page is trusted**: this runtime executes in the page that embeds it; it is not
  a sandbox for the page.
- **The document is content**: packages carry text and images; they carry no code. The
  runtime contains no HTML/CSS/JS execution surface. This is the architectural security
  property of GlyphCull: **there is nothing in a package to execute**.

## 3. Threat model

| # | Threat | Vector | Control |
|---|---|---|---|
| T1 | Reader crash/DoS | Malformed package bytes | SPEC.md §1.6 reader rules; bounds-checked reader; truncation/flip corpora; property "never throws" test |
| T2 | Unbounded resource use | Package with huge counts/limits | SPEC.md §1.3 limits enforced at load; budgets (glyph cache, materialization time) enforced at runtime; memory regression tests |
| T3 | Renderer DoS | Extreme glyph density, huge images, many atlases | Texture/dimension caps at load; draw list command caps; budget eviction |
| T4 | Data exfiltration | Malicious package content | Packages are inert data; the runtime never executes package content, never fetches URLs from packages, never emits network traffic. Links are data only (opened by the host, not the runtime). |
| T5 | Selection/copy confusion | Manipulated geometry vs content | Selection is logical (chunk id + offsets) and verified against content length; copy extracts from chunk content, never from rendered geometry |
| T6 | Nondeterminism / fingerprinting | Timing or layout side channels | Determinism policy (D10); not a primary control — documented as inherent to client rendering |
| T7 | WebGL context compromise | Driver bugs | No `unsafe`-equivalent surface in JS; context loss handled; GL resources bounded and released on destroy; no extension required beyond WebGL1 core + derivatives (fallback path without derivatives) |
| T8 | Long-term availability (archival) | Format rot | Versioned format, committed golden fixtures, two independent readers; reader rejects unknown versions loudly (no silent misinterpretation) |

## 4. Hardening rules

1. The reader never throws on malformed input paths; typed errors only. No `any` casts
   around untrusted lengths; arithmetic on untrusted sizes is checked.
2. Resource caps are enforced *before* allocation (SPEC.md limits at load; budgets at
   runtime).
3. No `eval`, no dynamic code generation, no `Function` construction anywhere in the
   runtime. (Enforced by review + a lint rule.)
4. No network access from the runtime: `load()` consumes bytes the host provides.
5. All public API misuse returns typed errors; destroyed handles reject calls.
6. Packages claiming the SEAL section are verified; failure is a load error.

## 5. Reporting

Security issues: see CONTRIBUTING.md (coordinated disclosure). No secrets in this
repository.
