#!/usr/bin/env bash
# The release dry-run (release/scripts/release-dry-run.sh): assembles the npm
# package and verifies it packs cleanly — this IS the dry run, nothing is
# published.
#
# Usage: release/scripts/release-dry-run.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

# Canonical release order (release/README.md).
ORDER="glyphcull-runtime-js"

for pkg in $ORDER; do
  echo "== ($pkg)"
  npm pack --dry-run
done

echo "release dry-run OK: all $(echo "$ORDER" | wc -w) packages assemble in release order"
