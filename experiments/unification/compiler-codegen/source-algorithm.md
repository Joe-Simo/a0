# A0 source-algorithm control

`tools/source-cost-bench.ts --source-algorithm` compares two C-derived frontend artifacts whose
A0 implementations differ. It is mutually exclusive with `--compiler-codegen` and
`--cross-backend`; existing modes retain their requirements.

This mode requires explicit control artifact/checkout paths, `--sysroot` and `--builtins`, and
fresh manifests produced by the same provenance code in clean owned checkouts. Stripped symbols
are required. Legacy manifests, missing consumed API signatures and external provenance
supplements are refused.

The compiler/host input inventory and version, compiler/dependency configuration and build
versions, runtime, entry, consumed A0 structural API signatures, frontend ABI, source emission
options, native libraries, toolchain, actual include closure, effective Clang command and complete
compile/link flags must match. Diagnostic port capabilities must match too. Only the A0 source
closure, normalized source hash and function count may differ; reports include each source hash,
count and every module addition, removal or content change.

Each artifact is bound to its own clean immutable checkout. The harness independently verifies
its complete source closure/count, exact consumed signatures, exact C re-emission through its
fresh compiler, and exact native Wasm/build-record reproduction through its existing builder.
The builder records the signatures of every A0 function consumed by the adapter and generated API
macros; a full native rebuild also checks that this inventory is complete.

```sh
node dist/tools/source-cost-bench.js --source-algorithm \
  --baseline=<historical-emitter-checkout> --artifact=<candidate-artifact> \
  --control-artifact=<control-artifact> --control-checkout=<control-checkout> \
  --sysroot=<wasi-sysroot> --builtins=<wasi-builtins-archive> \
  --out=.a0-tmp/source-algorithm-cost --prepare-only
```

Preparation takes no timing samples. A coordinated quiet run omits `--prepare-only` and reuses
the existing worker, representative frozen inputs, one fixed historical C emitter, exact output
checks, rotated fresh-process rounds, load checks and before/after immutable checks. Correctness
controls remain outside timing. This mode makes no shipping CLI, model-accuracy, source cutover,
generated-target execution or performance claim by itself.

`results/source-cost-source-algorithm-selfcontrol.json` records an end-to-end preparation control
with the same compiler and A0 source in separate clean checkouts. Both artifacts reproduce their
complete native bytes and build records, all consumed signatures match, and every frozen input
passes. It contains no source-algorithm comparison or timing samples.
