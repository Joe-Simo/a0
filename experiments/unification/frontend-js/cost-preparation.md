# Generated JS target: strict cost preparation

This extends the existing `--cross-backend` experiment. It changes no A0 source, backend lowering,
public routing or default. The first cohort retains fresh workers, five rotated arms, all six
frozen inputs, one discarded warmup round and seven measured rounds. Historical Canonical and
Dense readers and the common output emitter remain at `764de84ab99a156e41164518f14cc0676b6343dd`.
The C control is a separately built clean checkout of
`3ef2db0f9160dada89e1c513fd8170d78649d7ef`, with the same 612-function, 23-module A0 closure.

Parent preparation freshly compiles each checkout, re-emits JS through the strict cold compiler
boundary, reproduces the generic arena through its original builder, and reproduces the C control's
complete C/Wasm/build record through its own strict builder. The comparison requires equal raw
modules, normalized A0 source, function count, eight consumed structural API signatures, common
compiler sources/configuration/build versions, optimization, generic runtime bytes, libc/builtins
and native toolchain. The different JS/Wasm representation, target options, stack and feature
contracts remain explicit in the full records. Legacy C manifests remain ineligible.

The parent freezes a hashed worker proof containing each exact raw manifest/component snapshot,
the complete common worker/SDK compiled-output inventory, and the historical SDK output inventory.
The worker inventory includes the load-sampling helper, so altered load observations cannot evade
the exact-code checks while leaving application output checksums unchanged.
Every fresh worker verifies that proof, its clean source identities and actual SDK/component bytes
before and after module preparation and after execution. `postCheckMs` labels the final proof checks
outside the frontend/pipeline phases; their cost stays inside child wall.
The existing JS artifact inspection and typed adapter load those detached components. The public
`prepareJsSource` loader still always performs cold re-emission; no validation-skip option is added.
The workers do not rebuild TypeScript or re-emit the A0 frontend per sample.

Use the normal build commands in the README after freezing the harness commit, then:

```sh
node dist/tools/source-cost-bench.js --cross-backend --prepare-only \
  --baseline="$HISTORICAL_CHECKOUT" --artifact="$JS_ARTIFACT" \
  --control-checkout="$C_CONTROL_CHECKOUT" --control-artifact="$C_ARTIFACT" \
  --sysroot="$WASI_SYSROOT" --builtins="$WASI_BUILTINS" --out="$PREPARATION_OUTPUT"
```

Run the exact C artifact builder in its control checkout with the recorded default O3/MVP/stripped
options and explicit `--diagnostic-ports=disabled`. Both subjects must use the same Clang/WASI inputs.
Preparation validates all six input hashes and frozen historical C outputs without taking samples.
Formal comparison requires a separate quiet-window clearance and a new output directory.

`frontendMs` retains instantiation/upload/first parsing/checking/typed-IR decoding. First-call lazy
JS JIT work therefore remains inside that phase. `emitCMs` and `pipelineMs` retain the fixed historical
C emitter. `modulePreparationMs` separately records component/SDK verification, ESM import and Wasm
module compilation; it is outside `frontendMs` and remains inside total fresh-child `wallMs`.
Offline artifact code generation and strict parent reproduction are preparation, outside worker
phases. Process and shared SDK startup are included in child wall. No same-process warmed cohort
is added to this first comparison.

The record counts JS text bytes and Wasm bytes separately. Live/peak RSS, JS heap used/total,
external and array-buffer counters accompany the before/after phase values. `wasmLinearMemoryBytes`
is arena-only for JS and excludes its JS heap, generated code, JIT and GC. These counters do not
isolate JIT/code/GC costs or establish total-memory equivalence. No forced GC is introduced.
Existing per-word page/record copying and JS/Wasm calls remain unchanged for the baseline.

No comparative performance or no-regression conclusion follows from preparation or correctness
smokes. Every latency, memory or size loss must be retained in the subsequent comparison.

The [final preparation record](../../../results/source-frontend-js-cost-validation.json) freezes
the clean harness at `acb686bea705e23097b7433d03b4c231dc361a66`. It records all six strict parent
input checks, 30 fresh-worker output checks, 16 source-cost proof controls and two actual JS loader
corruption/stale-output controls. The original source history is retained in a
[raw Git bundle](../../../results/source-frontend-js-cost-source-bundle.json), with its prerequisite,
byte hash and a verified recovery from a repository holding only that prerequisite.

Published manifest and worker-proof snapshots replace local checkout paths with named placeholders.
They are inspection copies, with the original raw byte hashes recorded separately; they are not
executable manifests or worker proofs. Replay rebuilds exact artifacts and proof files in its own
clean checkouts. The smoke runner and replay commands are included in the preparation record.
The subsequent [quiet fresh-process comparison](../../../results/source-frontend-js-cost-quiet.json)
completed all 240 cells on the frozen harness: 30 discarded warmups and 210 measured cells, with
maximum recorded one-minute load 1.94. Generated JS had higher median frontend, pipeline and
fresh-child wall time and higher frontend RSS on every input against each control. The raw samples,
full proof/build snapshots, all six prepared source inputs and every comparison are retained in the
[artifact archive](../../../results/source-frontend-js-cost-quiet-artifacts.zip). The current JS arm
therefore remains an experiment; its cold cost does not meet the adoption requirement. The same-process
warm cohort remains unrun.
