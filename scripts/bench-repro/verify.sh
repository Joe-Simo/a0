#!/bin/sh
# Verification and the loss ledger.
# Usage: sh scripts/bench-repro/verify.sh ledger   # the loss ledger check only (about 1 min)
#        sh scripts/bench-repro/verify.sh test     # bun run test: build, then node --test dist/test/*.test.js
#        sh scripts/bench-repro/verify.sh full     # verify, behavior, test, loss-ledger
# verify and behavior regenerate results/verification.json and results/behavior.json. A machine that lacks a toolchain
# records those targets as blocked or skipped, so this script puts the committed files back afterwards
# (set KEEP=1 to keep the new ones) and the new files are in scripts/bench-repro/out/.
. "$(dirname "$0")/lib.sh"
mode=${1:-ledger}

regen() { # script, results file
  bun run "$1" || echo "$1 exited non-zero"
  cp "results/$2" "$OUT/$2"
  [ -n "${KEEP:-}" ] || git checkout -- "results/$2"
}

case "$mode" in
  ledger)
    build >/dev/null
    bun run loss-ledger
    ;;
  test)
    bun run test
    ;;
  full)
    regen verify verification.json
    regen behavior behavior.json
    bun run test
    bun run loss-ledger
    ;;
  *)
    echo "usage: sh scripts/bench-repro/verify.sh ledger|test|full" >&2
    exit 2
    ;;
esac
