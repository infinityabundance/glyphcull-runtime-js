#!/usr/bin/env sh
# Refreshes the committed contract fixtures from the glyphcull-compiler repo.
#
# The fixtures are compiler output, so they live in the compiler repository;
# this runtime repo commits copies for independent reader contract tests.
# Refresh deliberately: review the diff before committing (the reader tests
# pin the exact bytes).
set -eu

COMPILER="${GLYPHCULL_COMPILER:-$(cd "$(dirname "$0")/../../.." && pwd)/glyphcull-compiler}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$COMPILER" ]; then
    echo "error: compiler repo not found at $COMPILER (set GLYPHCULL_COMPILER)" >&2
    exit 1
fi

cp "$COMPILER/tests/fixtures/v1-minimal.cull" "$HERE/test/fixtures/v1-minimal.cull"
cp "$COMPILER/crates/glyphcull-pipeline/tests/fixtures/golden.cull" "$HERE/test/fixtures/pipeline-golden.cull"
cp "$COMPILER/crates/glyphcull-pipeline/tests/fixtures/golden.md" "$HERE/test/fixtures/golden.md"

echo "fixtures refreshed from $COMPILER; review the diff before committing"
sha256sum "$HERE"/test/fixtures/* | sed "s|$HERE/||"
