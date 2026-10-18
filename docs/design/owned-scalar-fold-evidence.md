# Owned scalar-fold evidence and decision

The detached experiment remains disabled. The same-public-plus-probe package grows on all three
measured emitters. Correctness controls establish a bounded private recurrence transformation;
they do not establish a production performance benefit or complete the compiler's `ap_read` chain.
The frozen results are `results/owned-scalar-fold-proof.json` and
`results/interop-memory-affinity-policy.json`.

| Same public original and projected probe | Before bytes | After bytes | Change |
| --- | ---: | ---: | ---: |
| C source | 9,931 | 11,235 | +1,304 |
| JavaScript source | 6,856 | 7,906 | +1,050 |
| Direct WebAssembly module | 791 | 886 | +95 |

The projected reply root has 15 then 14 nodes, while its complete private callee graph has 33 then
34 nodes. A private-only C closure shrinks, but retaining the original public body and adding the
probe increases the complete artifact. The original word helper already has an existing 16-byte
owned Wasm variant. Removing a logical 128-word update does not establish that the original hot
loop physically copied that page or that LLVM will execute fewer instructions.

## Correctness and failure history

The 73 focused tests pass without skips, including the nine new fold groups and the existing
affinity, host-memory, scalar identity and aggregate-demand controls. C and C++ controls use O0/O2
with address and undefined-behavior sanitizers. They retain independent values, original
interpreter comparisons, callback mutation and exception traces, zero trips, bounded drains,
full original pages, nested bool/aggregate values and explicit refusal cases.

The prior policy at `64ddde9` raises A0310 on the real projected reply graph. The separate
`694bc0b` correction keeps IO-containing projections rather than consuming the same token through
two constructor paths. Its conservative scalar-word case still contains the full page update;
atomic private record packing is a separate proof step. The original sealed 80-case subjects did
not exercise this affine composition failure.

The corrected policy passes all 80 sealed rows twice, with byte-identical reports: 18 JS, 18 direct
Wasm, 36 C and eight C++ rows. Each replay executes 44 native controls. Every raw source emission
hash and ABI-specific expected value matches the frozen baseline. The 32 previously recorded
optimized mismatches are corrected for these subjects. This finite suite does not prove complete
host-memory correctness.

The corrected policy's complete 612-function, 23-module compiler output matches its prior policy
cost: 11,940 nodes and 1,214,815 C bytes. Against the unchanged default, that retains a cost of
378 nodes and 31,149 C bytes across 109 changed functions. The original compiler source and default
1,183,666-byte C output keep their frozen hashes. No default compiler/interpreter substitution
occurs.

## Recoverable boundary

The tested snapshot is `6649cac49de1aa8de686ce50b6df49b79e460c1a`, tree
`ed606f8f432d3825bb9f3a5818fe8037bfe81440`. The source implementation is `8f0482d`; the recipes
were frozen in `59dcd4a` and `6649cac`. Both structural replays and both sealed-policy replays start
from this clean snapshot. Their reports are byte-identical between repetitions, as is the 886-byte
Wasm artifact. `results/owned-scalar-fold-source-bundle.json` describes the binary source bundle,
its prerequisite and isolated import. `results/owned-scalar-fold-verification.json` records the
proof archive's member digests and commands. Importing archived refs does not adopt their code.

The recipes are `experiments/unification/aggregate-return-demand/owned-scalar-fold.mjs.txt` and
`experiments/unification/aggregate-return-demand/interop-memory-affinity-policy.mjs.txt`.
The first requires a clean built checkout of `64ddde9` in `A0_OLD_MEMORY_POLICY_REPO` to reproduce
the old A0310 failure. Both require the recorded Clang toolchain and a built clean tested tree.
They collect structural facts and correctness outcomes, without timing measurements.

Strict profiles refuse. Detached interpreter fuel and resource frame identities differ from the
original. Emission must use `optimize:false` without trap instrumentation; the result's advisory
flag is not enforced by `emitFunction`. Original public roots retain their ABI, semantics, traps,
IO sequence and interpreter metering. The real `ap_read` state remains `unsupported-state`.

Opaque selected-subaggregate packing, formal parameter/effect summaries and a guarded IO-fold
demand fixed point are still absent. Merely accepting a third state field would be insufficient:
the real state contains two arrays, one retained whole, and its call chain carries aggregate
extras. These are future proof obligations, without predicted gains.

Lint, typecheck, prereview, the public-tree check and focused controls pass. Hygiene has three
passing tests and the existing optional denylist skip because no denylist file is configured.
Gate scope remains `everything`; full verification, all targets, bootstrap size, A0 parity/seed
work and coordinated compilation/execution/memory measurements remain prerequisites for adoption.
No full gate, timing or 2 MiB bootstrap-floor claim is made by this archive.
