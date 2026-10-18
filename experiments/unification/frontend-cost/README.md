# Native frontend representation investigation

The next useful proof is a **general typed-IR aggregate-demand analysis**, followed by private
scalar replacement. No implementation or gain is claimed here. The evidence is in
`results/source-frontend-bottleneck-diagnostic.json`; normalized historical V8 profiles are in
`results/source-frontend-bottleneck-profiles.zip`.

## Existing work and current evidence

The investigation reuses C-derived V8 sampling, native gprof/phase counters, direct Wasm
sampling with optional debug names, source-prefix reuse/SIMD exploration, per-site row counters
and the rejected transport, C projection, lazy-error, scalar-read and readonly-call comparisons.
Their identities, limitations and result references are recorded separately in the report.

The C-derived V8 profile covers **604 functions/18 modules**, and the direct profile covers
**609 functions/19 modules**. They are historical diagnostics. In the former, `memcpy`/`memset`
account for 12336 of 36882 self samples, with concrete callers including `arena_reply`, `av_load`,
`av_reserve`, `ap_node` and `ac_function_body`. Those samples cannot establish the current cost
distribution or explain the roughly sevenfold historical boot latency gap on their own.

New counters cover the current **612 functions/23 modules**, normalized source
`0166c16c5b04432f53766f275ed10975693df7a3504f3217cb3fdceaa446fcb0`, generated C
`02e9846c99ecc253974ae46ff786f3ac8d97e3adb519666e829239b55c589998`. Each baseline/instrumented
native execution produces byte-identical status, M/PS and every arena allocation word. There are
no timers in the probe. Concurrent correctness/build activity does not turn these operation
counts into performance measurements.

| Existing input | LOAD replies | Replies requesting at most 5 words | Semantic `arena_zero` calls |
| --- | ---: | ---: | ---: |
| life | 19338 | 18331 | 57017 |
| frame | 31172 | 29528 | 94594 |
| page | 750593 | 725717 | 2379090 |
| docs | 355563 | 348645 | 1219256 |
| boot | 5937336 | 5628101 | 17955224 |
| parser | 663203 | 628498 | 1967863 |

Boot's LOADs carry 21358991 payload words, while the transport executes 35304924 reads and
43576106 writes including upload and framing. These are separate quantities. The 128-word
result capacity and semantic zero counts do **not** establish physical memory traffic or an
estimated speedup; LLVM can remove or combine copies and zero initialization.

The current typed IR has 38 `ap_read` sites. At 31, the returned page is locally consumed only
by literal `get` indices. They cover 3116699 of 4525846 boot `ap_read` calls in the existing
per-site counter map, whose generated C is byte-identical after the sole compiler-version
banner substitution. Seven sites escape through return values or folds. The report retains
every site and use; this is a demand-analysis opportunity, not a measured improvement.

## One proposed general pass

Propagate aggregate field/element demand backward through typed SSA across `call`, `at`, `get`,
`rec`, `put` and iteration continuation state. Demand is a set of literal paths or “all”; an
unknown, dynamic or escaping use conservatively keeps the full value. Join demands through a
deterministic worklist. Do not create a new reader, grammar, source dialect, transport protocol
or user flag.

The first proof should project an internal aggregate result into a scalar record while retaining
the original public function and its value parameters. Extend to continuation state only after
the initial proof. This exposes field liveness before C, JS, Wasm, SV and other backends instead
of depending on one backend's inlining decisions. It could also remove pure computations of
unused classifier fields; that remains a hypothesis until generated instructions confirm it.

This differs from the rejected C projection change, which extended existing owned-record
projections/intermediate reconstruction around `fold`/`loop`. That experiment has real frontend
and RSS losses. It also differs from compiler 69's readonly argument borrowing and the manual
scalar-first row helpers. None of those results demonstrates this new pass is beneficial.

The pass must satisfy these constraints before any adoption:

- Public function names, signatures, aggregate layouts, value snapshots and interoperability
  remain intact. Private projected callees retain value parameters; the real host-mutation
  counterexample remains an independent control. This does not authorize more argument borrowing.
- Preserve every potentially trapping operation and its evaluation order. Preserve IO tokens,
  every read/write word, malformed-reply drain and sequencing before the next effect. A dead
  returned field does not make the operation that produced it dead.
- Preserve the original array modulus. A projection of `u32x128` uses scalar fields and explicit
  original-index semantics; replacing it with `u32xN` would change dynamic `get`/`set` behavior.
- Keep arena allocation order, amounts, budget exhaustion, handles, M/PS schema and native ABI 3
  unchanged. No hidden host parser, cache allocation or target-specific semantic fallback.
- Use deterministic private names and demand joins. Invalidate emission caches when lowering
  changes. Measure analysis time/memory, private-variant growth, emitted C, binary size and the
  **whole** bootstrap package against its existing 2 MiB floor. Wrapper/body duplication can
  defeat the proposal; preserving the floor is a requirement, not an assumed outcome.

The first proof is falsified if a field/trap/IO/budget/ABI control changes, emitted code still
materializes the supposedly removed aggregate, compilation costs grow unacceptably, or source/
binary/package size regresses. Run independent alias, dynamic-index, zero-trip, malformed-reply,
trap-priority, host-callback and cross-translation-unit controls, then all six existing applications
with exact outputs and allocation snapshots. Only afterward run a coordinated quiet comparison
with all old Canonical/Dense/native controls, including compilation cost and execution benchmarks.
Even a successful first slice need not close the full latency gap.

## Reproduce the structural probe

The archived `.txt` files are executable probe sources when explicitly passed to their
interpreter/compiler. Frozen A0/C/probe material stays outside the shipped program inventory.
Use a freshly built ABI 3 artifact containing `module.c`, `driver.c`, `api.h` and `build.json`;
the instrumenter verifies its C hash. The report records every baseline/instrumented input hash.

```sh
costArtifact=/path/to/exact/frontend-artifact
costRoot=$PWD
costReplay=$costRoot/.a0-tmp/frontend-cost-replay
mkdir -p "$costReplay/baseline"
cp "$costArtifact/module.c" "$costArtifact/driver.c" "$costArtifact/api.h" \
  "$costArtifact/build.json" "$costReplay/baseline/"
cp tools/native/arena_runtime.c tools/native/arena_runtime.h "$costReplay/baseline/"
cp experiments/unification/frontend-cost/harness.c.txt "$costReplay/baseline/harness.c"
python3 experiments/unification/frontend-cost/instrument.py.txt \
  "$costArtifact" tools/native "$costReplay/counted"
clang-19 -std=c11 -O2 -DNDEBUG -I"$costReplay/baseline" \
  "$costReplay/baseline/harness.c" -o "$costReplay/baseline/probe"
clang-19 -std=c11 -O2 -DNDEBUG -I"$costReplay/counted" \
  "$costReplay/counted/harness.c" -o "$costReplay/counted/probe"
python3 experiments/unification/frontend-cost/run.py.txt \
  experiments/unification/frontend-a0/inputs \
  "$costReplay/baseline/probe" "$costReplay/counted/probe" "$costReplay/results"
bun run build
node --input-type=module < experiments/unification/frontend-cost/read-demand.mjs.txt \
  > "$costReplay/read-demand.json"
```

This checks counts and exact native results. It does not repeat timing or establish a shipping
native transport. The lexical offset heatmap is also not a valid offset-only cache: boot has
184 repeated-offset events with different span lengths, so a cache would need the full source/
start/length identity and its own budget/lifetime proof. No lexical cache is proposed here.
