#!/usr/bin/env bash
# Snapshot -> a verified distribution in dist/, failing loudly at the first inconsistency.
#
#   yarn distribution <snapshot.json|csv> [--min-eth 0.0001] [--expect-count N] [--expect-total WEI]
#
# The snapshot is the complete holder record. Any dust floor is a PROCESSING decision
# applied here with --min-eth, not something baked into the data.
#
# Writes dist/merkle-input.json, dist/merkle-result.json and dist/SUMMARY.txt.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: yarn distribution <snapshot.json|csv> [--min-eth 0.0001] [--expect-count N] [--expect-total WEI]" >&2
  exit 1
fi

SNAPSHOT="$1"; shift
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

# The proxy is both the address being upgraded and the address that pays out, so it is
# the funding address too. Defaulting saves the operator setting a second variable.
FUNDING="${DISTRIBUTION_ADDRESS:-${PROXY:-}}"

echo "==> 1/4 normalising and validating the snapshot"
node scripts/build-merkle-input.mjs "$SNAPSHOT" "$@" 2> "$OUT_DIR/.input.log" > "$OUT_DIR/merkle-input.json"
cat "$OUT_DIR/.input.log"

echo "==> 2/4 building the merkle tree"
npx ts-node scripts/generate-merkle-root.ts -i "$OUT_DIR/merkle-input.json" -o "$OUT_DIR/merkle-result.json" 2> "$OUT_DIR/.root.log"
cat "$OUT_DIR/.root.log"

echo "==> 3/4 re-verifying every proof and reconstructing the root independently"
npx ts-node scripts/verify-merkle-root.ts -i "$OUT_DIR/merkle-result.json" | tail -3

echo "==> 4/4 cross-checking the result against the input"
npx ts-node scripts/check-distribution.ts \
  -i "$OUT_DIR/merkle-input.json" \
  -r "$OUT_DIR/merkle-result.json" \
  ${FUNDING:+--address "$FUNDING"}

ROOT=$(node -e "console.log(require('./$OUT_DIR/merkle-result.json').merkleRoot)")
TOTAL=$(node -e "console.log(require('./$OUT_DIR/merkle-result.json').tokenTotal)")
COUNT=$(node -e "console.log(Object.keys(require('./$OUT_DIR/merkle-result.json').claims).length)")

{
  echo "distribution built $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo
  echo "source      : $SNAPSHOT"
  echo "filters     : ${*:-none}"
  echo
  grep -E 'recipients|total' "$OUT_DIR/.input.log" || true
  echo
  echo "merkleRoot  : $ROOT"
  echo "recipients  : $COUNT"
  echo "tokenTotal  : $TOTAL wei"
  echo
  echo "Fund the distributor with at least tokenTotal before the claim window opens."
} > "$OUT_DIR/SUMMARY.txt"

rm -f "$OUT_DIR/.input.log" "$OUT_DIR/.root.log"

echo
cat "$OUT_DIR/SUMMARY.txt"

if [ -z "$FUNDING" ]; then
  echo
  echo "WARNING: neither PROXY nor DISTRIBUTION_ADDRESS was set, so the funding balance"
  echo "         was NOT checked. Nothing has verified the paying address holds enough."
fi

echo
echo "next:  cp $OUT_DIR/merkle-result.json ../eth-claim-portal/data/"
echo "       yarn deploy:mainnet"
