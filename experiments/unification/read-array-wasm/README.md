# Direct Wasm read-array frontend control

The frozen candidate is `31d25e5289a12ce164fdd74aacd3573dcf53f7a1`. It compiles the same
609-function, 19-module A0 frontend as the published C-derived control at
`768375accc9949f00c069a71bf3b9ff7af717704`. The historical parser/emitter checkout is
`764de84ab99a156e41164518f14cc0676b6343dd`.

All 240 emitted C hashes match, but the direct frontend is slower than the C-derived frontend
on all six inputs. This candidate does not meet the no-regression requirement for an official
frontend cutover. The run does not isolate the generic read-array fold optimization against a
pre-optimization direct backend; it supports no causal claim about that change alone.

The benchmark reuses the six frozen flattened applications in
`experiments/unification/frontend-a0/inputs/`. It rotates five arms through one discarded warmup
and seven measured rounds. Every arm uses the same historical C emitter. Artifact validation and
Wasm module compilation occur before the frontend/pipeline phase; instantiation, input upload,
A0 parsing/checking and typed-IR decoding occur inside it. Fresh-process wall time includes module
preparation. The direct subject preloads two Wasm components; the C control preloads one. Common
candidate SDK/artifact preloads for historical/TypeScript controls are disclosed in every raw cell.
The complete build manifests record different code generation, required features and stack settings.
Graph I/O, shipping CLI startup, formatter work, AI/model accuracy and generated-target execution
are outside this experiment.

Reproduce on immutable worktrees at the recorded commits, with a prepared Clang/LLD 19 WASI
toolchain. Replace checkout and toolchain placeholders with local paths. Build the candidate's
TypeScript output, then build its two components:

```sh
bun x tsc -p tsconfig.json --incremental false
node dist/tools/source-direct-build.js --out=.a0-tmp/read-array-frontend \
  --sysroot=<wasi-sysroot> --builtins=<wasi-builtins-archive>
```

Run provenance preparation first. On a quiet machine, repeat without `--prepare-only`:

```sh
node dist/tools/source-cost-bench.js --baseline=<historical-checkout> \
  --artifact=.a0-tmp/read-array-frontend \
  --control-artifact=<published-control-checkout>/seed/source-frontend \
  --control-checkout=<published-control-checkout> --cross-backend \
  --out=.a0-tmp/read-array-cost --prepare-only
```

The harness freshly builds all three checkouts and verifies source closure, function count,
component hashes/sizes, exact frontend re-emission, shared arena runtime/toolchain inputs, the
mechanically recomputed generic arena stack proof and every frozen input/output hash. It rejects
source or artifact changes before and after measurement, and load above its recorded limit.

Correctness controls used the same final candidate artifact: 178 source units in both spellings,
178 original/migrated graph entries, 3,168 independent grammar/error-priority cases, and 18 focused
adapter/provenance/read-fold tests without skips. Separate backend checks passed 28 focused tests,
3,083 behavior cases, lint and typecheck. The generic literal-zero fix also preserves exact module
bytes across 288 prior-emission layouts and rejects genuine stale version65 bodies from memory
and reopened disk caches under version66.

The archived decision links the complete summary, 240 raw cells, preparation, full build manifest,
unit and graph audits and grammar control witnesses:
`results/unified-source-read-array-wasm-decision.json`.
