# Exact-span classification counts

This is a count-only observation and offline cache simulation over the unchanged
612-function, 23-module A0 source frontend and the six frozen application inputs.
No cache executes in the frontend. There are no timers or performance claims.
The complete baseline and traced outputs, including status, M/PS and every arena
allocation word, must be byte-identical and match the earlier committed dump hashes.

A hypothetical cache entry owns 16 words: valid, handle, start, full length; nine
first-page scan accumulators; keyword, opcode and first full-word source cell.
The same source offset with another length is a different key. Site is recorded
but is not part of this context-free key. Empty private contexts start at every
`arena_parse` and `arena_verify_resume` invocation; they never cross a public
return, source-unit snapshot or session. The offline policies are fully associative
LRU with capacities one, two and three, with publication only after complete
classifier success. Raw records preserve every invocation, site, exact key,
status, prefix fold count and all twelve prefix facts.

The design retains the original source-span LOAD, prefix LOAD, tail LOADs, bounded
reply drains, error stage and diagnostics. On a successful prefix cache hit,
cached accumulators would seed the original tail scanner with the current status
and IO token. Prefix failure must use the current reply and original classifier.
Caching final metadata alone would mishandle partial results from long-word tail
failures. This trace contains accepted applications without such failures; it
does not prove that later implementation law. Long-word hits cover the prefix
only. It does not implement once-per-whole-span memoization.

Historical node-word reuse already threads ID/op facts and removes redundant
lookahead and LOADs. This stricter pure-fact simulation retains those LOADs and
adds cache lookup/state work. Hit counts do not establish that implementation is
worthwhile, or that it improves that earlier runtime. Context propagation,
lookup, copies, private stack, compilation, binary and package costs remain open.
Do not change production code or launch a timing comparison from this record.

Reproduce from the exact earlier generated artifact (`module.c`, `driver.c`,
`api.h`, `build.json`) and its baseline native diagnostic probe. The preparer
checks the normalized source and generated C hashes. Use the recorded Clang
19.1.7 and `-std=c11 -O2 -DNDEBUG` for the diagnostic harness:

```sh
python3 experiments/unification/frontend-cost/exact-span-prepare.py.txt \
  "$spanArtifact" tools/native .a0-tmp/exact-span
"$A0_CLANG" -std=c11 -O2 -DNDEBUG -I.a0-tmp/exact-span \
  .a0-tmp/exact-span/harness.c -o .a0-tmp/exact-span/probe
python3 experiments/unification/frontend-cost/exact-span-count.py.txt \
  experiments/unification/frontend-a0/inputs "$spanBaselineProbe" \
  .a0-tmp/exact-span/probe .a0-tmp/exact-span-results
python3 experiments/unification/frontend-cost/exact-span-verify.py.txt \
  .a0-tmp/exact-span-results/source-frontend-exact-span-counts.zip \
  .a0-tmp/exact-span-results/summary.json
node --input-type=module - .a0-tmp/exact-span-results \
  < experiments/unification/frontend-cost/exact-span-report.mjs.txt
```

Commit the exact recipe before writing the final report. The report writer uses
`writeReport`; its provenance identifies that clean recipe commit. Results and
deterministic ZIP archive live under `results/source-frontend-exact-span-counts`.
The ZIP contains fixed-endian gzip-compressed raw traces and a digest manifest;
`exact-span-verify.py.txt` checks CRC, hashes and replays hits/publications with an
independent dictionary-order implementation. No repository gate is repeated here.
