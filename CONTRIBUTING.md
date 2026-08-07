# Contributing — glyphcull-runtime-js

GlyphCull is built as decades-long infrastructure. Contributions must meet the standards in
this file; reviewers enforce them.

## 1. Getting started

- Node 20+ (CI pins a version), npm. Install: `npm ci`. Verify: `npm run check` (fmt +
  lint + typecheck), `npm test`, `npm run bench` (smoke).
- Read in order: `README.md` → `Architecture.md` → `DESIGN.md` →
  `glyphcull-compiler/docs/format/SPEC.md` → `glyphcull-compiler/docs/format/GLOSSARY.md` →
  `TESTING.md` → `PERFORMANCE.md` → `SECURITY.md`.

## 2. Standards

- **Terminology**: graphics-engine vocabulary (GLOSSARY.md). Browser terms are forbidden in
  code, comments, docs, commits, and reviews.
- **Architecture**: the pipeline (visibility → materialization → draw list → paint) is
  absolute. Culling never materializes; materialization never culls. No subsystem bypasses
  a stage.
- **Lifecycle**: chunk state changes only through the state machine; no hidden state.
- **Determinism**: no wall-clock decisions, no `Math.random`, no unordered iteration in
  output paths. The determinism tests must pass for any behavior change.
- **No placeholders**: no `TODO`, `FIXME`, dead code, `any`-abuse, or incomplete features.
- **Small reviews**: one logical unit per change, with tests and docs in the same commit.
- **Dependencies**: zero runtime dependencies is the policy. A new dependency requires a
  DESIGN.md entry (D1) and SECURITY.md update.

## 3. Workflow

1. Branch from `main` (e.g., `phase3/lifecycle-machine`).
2. Tests-first where practical: state machine tables, property tests for invariants,
   golden fixtures for outputs.
3. Local gate: `npm run check && npm test` (and browser rendering harness for renderer
   changes).
4. Update documentation in the same change.
5. Open a PR with change description, evidence (measurements/diffs), and doc delta.

### CI

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs the full gate from a clean
checkout on every push to `main` and every pull request:

- `npm ci` then `npm run build` (the shipped TypeScript build)
- `npm run check` (prettier + eslint + `tsc --noEmit`)
- `npx vitest run test/api` — the committed fixture loads and the public surface is exactly
  `load`/`scroll`/`paint`/`select`/`copy`/`destroy` (+ the typed errors)
- `npm test` (unit, integration, property, stress)
- `npm run test:memory`, `npm run bench:smoke`
- `npm pack --dry-run` (the npm tarball assembles from the allowlisted `dist/`)
- `npx playwright install --with-deps chromium && npm run test:browser` (real pixels)
- `npm run docs:build`

CI is the release gate: a package is published only from a green tree.

## 4. Review requirements

- Behavior changes include before/after evidence.
- Golden fixture regeneration is deliberate: script refuses to run on dirty tree; diff
  reviewed byte-by-byte.
- API surface changes require an explicit DESIGN.md decision (the API is intentionally
  tiny — D12).

## 5. Bug reports

- Include: package or repro, expected vs actual, browser/Node versions, and (if available)
  the runtime's typed error.
- Every accepted bug gets a permanent regression test in the same PR.

## 6. Security

- Do not file public issues for vulnerabilities; follow SECURITY.md.

## 7. License

Apache-2.0 (LICENSE). Contributions are accepted under these terms.
