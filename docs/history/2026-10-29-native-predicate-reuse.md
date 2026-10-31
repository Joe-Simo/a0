# Native loop predicate reuse and countdown bounds

The native backend now shares materialized scalar computations from a pure loop predicate with the identical immutable prefix of its body. A bounded structural interner matches operations and types; writes, calls and nested iterations end eligibility. Values skipped or fused into branch instructions are excluded. Existing carried array values may feed the predicate when the same read is proved. Strict profiles retain their original lowering and trap identity. Weak maps reuse immutable analysis without retaining dead programs.

A companion range rule tracks the active loop counter and its exact limit. Inside the guarded iteration, the matching unsigned limit minus counter is positive and bounded by the limit; subtracting one preserves a tighter bound. This removes redundant modulo masks without assuming that unrelated limits or wrapping arithmetic are bounded. No benchmark names or algorithm-specific constants select either rule.

The [paired runtime measurements](../../results/native-reuse-runtime.json) use unchanged stock workloads, inputs, drivers and checksums. The [summary](../../results/native-reuse-summary.json) applies the observed-spread rule, with a maximum recorded load of 1.25:

| Native cell | Previous ns | Candidate ns | Clang ns | Against previous |
|---|---:|---:|---:|---|
| Insertion sort | 24246.9489 | 14098.3196 | 13264.6977 | win |
| Heap sort | 14038.0413 | 12053.4089 | 9897.6744 | tie |
| Binary search | 10385.3499 | 10046.7793 | 27022.8800 | tie |
| Sieve | 4198.5549 | 4153.5802 | 2973.9855 | tie; identical code |

Insertion sort improves by 41.9% against the preceding checkpoint. Its comparison with Clang is a tie within the observed uncertainty, with A0's median still slower. Heap is also a tie against Clang; sieve remains a loss. Binary search was already faster than Clang and remains so; its small change against the checkpoint is inconclusive. These four measurements do not refresh the historical 616-entry ledger or establish universal superiority.

## Size and compilation tradeoffs

The [size audit](../../results/native-reuse-size.json) uses identical inputs for all three checkpoints. The native executable-section total across 29 standalone modules changes from 31454 bytes at recovered checkpoint 9a036e70, through 33653 at preceding checkpoint 7e20f8fe, to 33173 for this candidate. Shared helpers are repeated in that sum; it is not a single application. JavaScript output remains 170837 bytes, compared with 211928 at the recovered checkpoint. All current stock JS and C outputs are unchanged except the final compiler-version tag.

Insertion-sort native text changes from 1169 to 1057 bytes, heap from 2641 to 2289 and binary search from 1105 to 1089. Linked executable sizes and measured peak RSS are unchanged for these cases. Lexer assembly remains 76265 bytes; checker assembly changes from 881536 to 881541. This recovers some cumulative native growth, not all of it, and is not a general compiler-output size win.

The [compilation audit](../../results/native-reuse-cost.json) covers the lexer, checker, generated corpus and nine stock kernels. All warm emit and fresh-process comparisons are within uncertainty. The initial UTF-8 parse-and-emit sample was a 32.9% loss; an isolated repeat on the unchanged candidate measured 14.1%, inside the uncertainty band. Both are retained. No compilation-speed or memory improvement is claimed, and the unfavorable initial result remains a limitation. The earlier uncached analysis and rejected probes are preserved in local recovery evidence.

## Correctness and remaining work

Tests exercise mutation barriers, old array aliases, different expressions and indices, early exits, zero trips, overflow, strict traps, shared expression DAGs, exact and unrelated countdown limits, and the unchanged heap, insertion-sort and binary-search workloads against independent references. The final version-only control, seed proof and available aggregate gate are recorded separately; a light gate is not the full platform release gate.

A test fixture exposed a separate pre-existing issue: a strict native function named `dec` collides with a runtime helper symbol. The failure was reproduced on unchanged 7e20f8fe, then the fixture was renamed to isolate this work. Its reproducer and failure log are preserved. That issue is not fixed here.

Remaining work includes the strict-name collision, residual sieve, dot-product, heap and text-processing losses, and full platform validation. Publication and private upload approvals remain pending; no denied operation was retried. Current evidence is saved locally for recovery.
