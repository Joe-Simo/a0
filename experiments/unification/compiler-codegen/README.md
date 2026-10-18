# Same-source native compiler code-generation control

`tools/source-cost-bench.ts --compiler-codegen` compares two C-derived frontend artifacts
produced by different compiler implementations. It requires explicit artifact and immutable
checkout paths for the control, plus `--sysroot` and `--builtins` for exact native rebuilds.
It is mutually exclusive with `--cross-backend` and `--source-algorithm`. Existing build-option,
native-transport and compiled-backend controls keep their prior requirements.

Build both artifacts in ignored directories of separate clean, owned checkouts, after applying
the same provenance metadata code to each. Use freshly built TypeScript output and the existing
`tools/source-native-build.ts` builder. Legacy manifests and external provenance supplements do
not qualify for this mode.

The A0 entry, normalized source, raw module closure, function count, frontend ABI, runtime,
source emission options, compiler/dependency configuration, Node/TypeScript versions, native
libraries, Clang/LLD versions, complete compile/link flags, actual include dependency hashes and
effective Clang command must match. Generated C and its derived API header may differ. The
harness records every changed, added or removed compiler input, re-emits each artifact's exact C
through its own freshly built compiler, and reuses its existing native builder to reproduce its
complete Wasm bytes and full build record before measurements. Compiler source/configuration
inventories are complete and checked against their own clean committed snapshots.

Strict native comparisons currently require `--symbols=strip`. `keep` is refused because debug
paths are not reproducible across the different rebuild output directories. Existing symbol
retention support and existing comparison modes are unchanged.

Run provenance preparation first; no timing samples are taken by this command:

```sh
node dist/tools/source-cost-bench.js --compiler-codegen \
  --baseline=<historical-emitter-checkout> --artifact=<candidate-artifact> \
  --control-artifact=<control-artifact> --control-checkout=<control-checkout> \
  --sysroot=<wasi-sysroot> --builtins=<wasi-builtins-archive> \
  --out=.a0-tmp/compiler-codegen-cost --prepare-only
```

A coordinated quiet run omits `--prepare-only`. It retains the existing representative frozen
inputs, historical Canonical/Dense and TypeScript arms, one fixed historical C emitter, exact
output hashes, fresh-process phase definitions, per-sample load checks and initial/final immutable
source/artifact/worker checks. Reports include both full build manifests, native rebuild proofs,
all compiler input differences and the symbol restriction. This mode makes no result, shipping
CLI, model-accuracy, universal-source cutover or generated-target execution claim by itself.

The same-compiler preparation control is archived in
`results/source-cost-compiler-codegen-selfcontrol.json`. Its separate clean checkouts reproduced
the exact native artifacts and build records and prepared every frozen input. It contains no
timing samples or performance conclusion.

For a comparison that holds the compiler fixed while changing the A0 implementation, use the
separate [source-algorithm control](source-algorithm.md).
