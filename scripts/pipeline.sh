#!/usr/bin/env bash
# Snapshot -> validated merkle result, failing loudly at the first inconsistency.
#
#   ./scripts/pipeline.sh <snapshot.csv|snapshot.json> [extra build-merkle-input flags…]
#
# Writes build/merkle-input.json and build/merkle-result.json.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <snapshot.csv|snapshot.json> [--min-eth 0.0001] [--expect-count N] [--expect-total WEI]" >&2
  exit 1
fi

SNAPSHOT="$1"; shift
OUT_DIR="${OUT_DIR:-build}"
mkdir -p "$OUT_DIR"

echo "==> 1/4 building merkle input"
node scripts/build-merkle-input.mjs "$SNAPSHOT" "$@" > "$OUT_DIR/merkle-input.json"

echo "==> 2/4 generating merkle root"
npx ts-node scripts/generate-merkle-root.ts -i "$OUT_DIR/merkle-input.json" -o "$OUT_DIR/merkle-result.json"

echo "==> 3/4 verifying every proof and reconstructing the root"
npx ts-node scripts/verify-merkle-root.ts -i "$OUT_DIR/merkle-result.json"

echo "==> 4/4 cross-checking the result against the input"
npx ts-node scripts/check-distribution.ts \
  -i "$OUT_DIR/merkle-input.json" \
  -r "$OUT_DIR/merkle-result.json" \
  ${DISTRIBUTION_ADDRESS:+--address "$DISTRIBUTION_ADDRESS"}

if [ -z "${DISTRIBUTION_ADDRESS:-}" ]; then
  echo
  echo "WARNING: DISTRIBUTION_ADDRESS was not set, so the funding balance was NOT checked."
  echo "         Nothing has verified that the paying address holds at least tokenTotal."
  echo "         Set DISTRIBUTION_ADDRESS=0x... and re-run before trusting this result."
fi

echo
echo "pipeline complete: $OUT_DIR/merkle-result.json"
