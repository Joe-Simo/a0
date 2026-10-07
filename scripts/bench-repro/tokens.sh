#!/bin/sh
# Recomputes the token and edit-cost tables from the raw data committed in results/ (no model, no API, no network):
#   app-edit-summary, app-edit-deps-summary, app-edit-keys-summary  <- results/app-edit*/report.*.json
#   token-bench, dense-tokens                                        <- the programs in this repository
# For each tool the committed results file is saved, the tool runs, the new file is compared with the saved one
# (the generatedAt time stamp is ignored) and the committed file is put back. Prints same or DIFFERENT per file.
# About 1 min. Exit status 1 when any file differs.
# Usage: sh scripts/bench-repro/tokens.sh
. "$(dirname "$0")/lib.sh"
build >/dev/null

bad=0
run() { # tool, results file
  tool=$1 file=$2
  cp "results/$file" "$OUT/committed-$file"
  node "dist/tools/$tool.js" >"$OUT/$tool.log" 2>&1 || { echo "FAILED  $tool (see $OUT/$tool.log)"; bad=1; cp "$OUT/committed-$file" "results/$file"; return; }
  if node scripts/bench-repro/summary.mjs same "$OUT/committed-$file" "results/$file"; then
    echo "same      results/$file   (recomputed by $tool)"
  else
    echo "DIFFERENT results/$file   (recomputed by $tool; kept as $OUT/recomputed-$file)"
    bad=1
    cp "results/$file" "$OUT/recomputed-$file"
  fi
  cp "$OUT/committed-$file" "results/$file"
}

run app-edit-summary app-edit.json
run app-edit-deps-summary app-edit-deps.json
run app-edit-keys-summary app-edit-keys.json
run token-bench tokens.json
run dense-tokens dense-tokens.json
exit $bad
