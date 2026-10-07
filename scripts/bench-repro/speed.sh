#!/bin/sh
# Speed against C, Rust, Zig and the other languages (exec-bench) and A0's wasm against clang (wasm-bench).
# Usage: sh scripts/bench-repro/speed.sh quick   # a few kernels, 3 samples: checks the setup, NOT a result (about 1 min)
#        sh scripts/bench-repro/speed.sh wasm    # wasm-bench in full, 15 samples (needs clang with wasm32 and wasm-ld)
#        sh scripts/bench-repro/speed.sh full    # exec-bench in full (every installed language) then wasm-bench
# Output: scripts/bench-repro/out/exec-benchmark.json and out/wasm-benchmark.json, then a summary.
# The tools wait for a quiet machine (load at or below 10) before every sample group; set A0_MAX_LOAD to change it
# (a number recorded above 10 is not a publishable timing). Close other programs first.
. "$(dirname "$0")/lib.sh"
build >/dev/null
mode=${1:-quick}

case "$mode" in
  quick)
    node dist/tools/wasm-bench.js --samples=3 --kernels=noop,dot1k --out="$OUT/wasm-quick.json"
    node dist/tools/exec-bench.js --langs=go --kernels=noop,dot1k --samples=3 --scale=20 --out="$OUT/exec-quick.json"
    node scripts/bench-repro/summary.mjs speed "$OUT/exec-quick.json" "$OUT/wasm-quick.json"
    echo "quick run: a setup check, not a result"
    ;;
  wasm)
    node dist/tools/wasm-bench.js --out="$OUT/wasm-benchmark.json"
    node scripts/bench-repro/summary.mjs speed - "$OUT/wasm-benchmark.json"
    ;;
  full)
    node dist/tools/exec-bench.js --out="$OUT/exec-benchmark.json"
    node dist/tools/wasm-bench.js --out="$OUT/wasm-benchmark.json"
    node scripts/bench-repro/summary.mjs speed "$OUT/exec-benchmark.json" "$OUT/wasm-benchmark.json"
    ;;
  *)
    echo "usage: sh scripts/bench-repro/speed.sh quick|wasm|full" >&2
    exit 2
    ;;
esac
