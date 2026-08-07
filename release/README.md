# Release receipts — glyphcull-runtime-js

Every published npm package must be traceable to its **source commit, version,
package hash, build/test commands, dry-run result, and release timestamp**.
This directory is that evidence: committed receipts, the schema, and the scripts
that generate and validate them. (The canonical conformance suite lives in
`glyphcull-demo`; the receipts reference it as the conformance gate, with the
JS reader's own `test/format` suite as the repo-local check.)

## Layout

```
release/
  README.md                     this document
  templates/
    receipt.template.json       the receipt schema (placeholder values)
  scripts/
    generate-release-receipt.sh   write release/receipts/<package>-<version>.json
    check-release-receipts.sh     validate the committed receipts (--fast CI gate,
                                  --full release procedure)
    release-dry-run.sh            assemble the package in release order
  receipts/                     the committed receipts
```

## The receipt contract

See `glyphcull-compiler/release/README.md` for the field-by-field contract — the
schema is identical (project `glyphcull`, source-tree hash over `git ls-tree -r`,
package hash over the real `npm pack` tarball, toolchain, commands, results, UTC
release timestamp). Everything except `release_timestamp`, `toolchain`,
`git_commit`, and the two hashes is schema-fixed and validated by the check
script. Timestamps never enter `.cull` output.

## Release order (enforced)

```text
glyphcull-runtime-js → (the demo, a separate repository, depends on nothing
                       from the registry for its harness build but is published
                       after the runtime for consumer clarity)
```

`release-dry-run.sh` packs the package (it fails if it does not assemble), and
`check-release-receipts.sh` requires it to have a receipt.

## Usage

```sh
# Assemble the package (the dry run; nothing is published).
release/scripts/release-dry-run.sh

# Generate a receipt (dirty-tree-refusing), with the full gates:
GLYPHCULL_RECEIPT_FULL=1 release/scripts/generate-release-receipt.sh glyphcull-runtime-js

# Validate the committed receipts.
release/scripts/check-release-receipts.sh --fast   # CI gate
release/scripts/check-release-receipts.sh --full   # release procedure (recomputes
                                                   # the package hash from a git
                                                   # worktree of its commit)
```

CI runs `check-release-receipts.sh --fast` on every push/PR: schema, filename,
commit existence, source-tree-hash honesty, clean-tree claim, and completeness.
The `--full` mode is the manual release gate — it re-derives the package archive
hash from a real checkout of the recorded commit, proving reproducibility.

## Workflow

1. Finish the change; commit + push; the tree must be clean.
2. `release/scripts/release-dry-run.sh`.
3. `GLYPHCULL_RECEIPT_FULL=1 release/scripts/generate-release-receipt.sh glyphcull-runtime-js`.
4. `release/scripts/check-release-receipts.sh --full`.
5. Commit the receipts, push, then `npm publish`.
