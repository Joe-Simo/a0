# Native register pressure: retain shorter-lived values

The native allocator previously spilled every new scalar once its register pool was full, even when a register held a value needed much later. It now chooses the active, unpinned interval that ends furthest in the future, and evicts it only when the incoming interval ends sooner. Homes are assigned before emission, so the evicted value uses its stack slot for its whole lifetime; there is no runtime register shuffle. Coalesced values and values carried across loop back edges remain protected. The rule uses liveness, not function names or workload constants.

The initial investigation targeted text-processing losses. Broad eviction, scalar-record promotion and prefix rescheduling did not justify retention. The cumulative size audit then identified the more valuable result: the small allocator change removes substantial spills from the existing matrix workload. The scheduler and record rewrites are not part of the retained source. Their patches, timings and failed setup checks remain in the recovery evidence.

The [paired runtime report](../../results/native-pressure-runtime.json) preserves unchanged stock programs, inputs, iteration counts, drivers and checksums. The Clang reference is emitted C from the same program, compiled with `-O3 -march=native`. The [summary](../../results/native-pressure-summary.json) applies the repository's observed-spread bands:

| Native cell | Before ns | Candidate ns | Clang ns | Against checkpoint |
|---|---:|---:|---:|---|
| Matrix | 152.7651 | 96.0947 | 44.7445 | win |
| UTF-8 | 31872.1202 | 29758.2759 | 21287.4175 | tie |
| Tokenization | 17937.3886 | 17683.1815 | 12694.2092 | tie |
| Heap | 12361.6291 | 10471.2790 | 9911.4279 | tie |

A separate matrix confirmation records 157.8265 to 98.6745 ns, also a win. Matrix remains a loss against Clang; this is not a universal superiority claim. Dot-product, min/max and sieve controls retain identical generated code and are timing ties. Forced SSE2 controls remain included. These scoped cells do not refresh the historical 616-entry ledger.

## Cumulative resource tradeoffs

The [size audit](../../results/native-pressure-size.json) sums executable sections across 29 standalone modules, including repeated helpers. The sum changes from 31454 bytes at recovered checkpoint 9a036e70, through 33173 at preceding checkpoint 5a6ed47e, to 29789 here. JavaScript output remains 170837 bytes, compared with 211928 at the recovered checkpoint. All current JavaScript and C outputs match the preceding checkpoint before the final version-tag update.

Matrix executable sections shrink from 9892 to 6684 bytes and its linked executable from 24496 to 20400 bytes. Its largest explicit stack allocation grows from 224 to 240 bytes; pushes and callers are excluded from that measure. Measured process peak RSS is unchanged within each pair. No general memory or startup benefit is claimed.

The [compilation-cost report](../../results/native-pressure-cost.json) includes the lexer, checker, generated corpus and ten stock kernels. The initial fresh heap-emission result is a loss: 21.110841 to 25.628141 ms. Other initial comparisons are ties. The isolated follow-up on unchanged code records 25.422190 to 24.965079 ms, a tie. Both results are retained; the initial loss is not replaced. No general compilation-speed improvement is claimed.

## Correctness and limits

New regressions exercise record recurrences and old-state aliases, zero and nonzero trip counts, twelve incoming arguments, reversed arguments across a real call, and matrix arithmetic checked by an independent modular-integer oracle. Optimized and unoptimized native code are exercised. Existing ownership, predicate and SIMD tests remain required.

An auxiliary C-driver check exposed a pre-existing harness limitation for strict modules with no trapping sites: its driver references an omitted trap buffer. That failed setup log is preserved. The new allocator tests use direct native execution and interpreter/JavaScript oracles; existing aggregate C checks are unchanged.

The [output controls](../../results/native-pressure-controls.json) verify 87 kernel/target outputs and 13 intended native golden changes; all other golden entries match the independent version-only control. Seed proof, frontend provenance and the available aggregate gate are required before this checkpoint is called validated. Full-platform release validation remains outstanding. Publication and private-upload approvals remain pending; no denied operation was retried.
