# Bounded native predicate counting and cumulative cost review

The remaining sieve gap came partly from a scalar pass that counts an array predicate. The native backend now recognizes a small pure fold that adds the 0/1 result of an equality or inequality against a literal, optionally restricted by an unsigned lower bound on the index. It counts four elements at once with SSE2, preserving modulo indexing, initial state and wrapping addition. The ordinary scalar path handles tails and counts below sixteen. Strict profiles and unmatched shapes keep their original lowering. This is a structural rule; no benchmark names or algorithms are selected by the compiler.

A separate general instruction rule emits boolean-to-word selections directly, including inverted and fused comparisons. It saves instructions in the remaining scalar paths and offsets generated code growth. Its isolated timing probe was inconclusive, so it is retained for its measured size reduction rather than advertised as a standalone speed win.

The [paired stock runtime report](../../results/native-count-runtime.json) uses unchanged inputs, checksums and iteration counts on one host. The [summary](../../results/native-count-summary.json) applies the repository's observed-spread rule:

| Native cell | Before ns | Candidate ns | Clang ns | Candidate vs checkpoint |
|---|---:|---:|---:|---|
| Sieve | 7611.2604 | 4305.7369 | 3093.4650 | win |
| Heap | 15387.2133 | 15605.6252 | 10742.4428 | tie; identical code |
| UTF-8 | 35468.3976 | 32672.7325 | 20660.6167 | tie |
| Tokenization | 21117.4193 | 17295.3693 | 11818.2073 | tie |

All four cells remain losses against Clang in these samples. Only the sieve has a confirmed runtime improvement over the checkpoint. Maximum recorded one-minute load across the retained runtime, cost and final short-loop controls was 1.13. The earlier nine-cell scoreboard and historical 616-entry ledger are not globally refreshed by this scoped report.

Short-loop controls caught an actual problem before retention: vector setup made four- and seven-trip loops slower. The measured cutoff leaves loops below sixteen scalar. In the [final matched controls](../../results/native-count-short-controls.json), every tested count below sixteen is a tie and every tested count at or above sixteen is a win. These synthetic sensitivity checks are not the stock performance claim. Both the failing and corrected measurements are preserved.

## Cumulative generated sizes

The [size audit](../../results/native-count-size.json) compiles identical inputs at recovered checkpoint 9a036e70, preceding checkpoint 92008c34 and this candidate. Object totals sum the executable sections of 29 standalone kernel modules, including repeated helpers; they are not the size of a single application.

| Exact generated-size measure | Recovered | Previous | Candidate |
|---|---:|---:|---:|
| Native object executable bytes, 29 modules | 31454 | 33701 | 33653 |
| JavaScript module bytes, 29 modules | 211928 | 170837 | 170837 |
| Native lexer assembly bytes | 67583 | 76457 | 76265 |
| Native checker assembly bytes | 831498 | 892082 | 881536 |

This recovers some accumulated native growth but does not erase it. Sieve executable sections grow from 993 to 1185 bytes, UTF-8 shrinks from 3345 to 3233, and tokenization shrinks from 1953 to 1825. Beyond the final version-tag update, all other stock native outputs and all stock JavaScript/C outputs are unchanged. The linked sieve executable remains 16376 bytes. Its measured stack allocation remains 4096 bytes and peak RSS is 8624 KiB on both sides. No general memory or startup win is claimed.

The [compilation-cost report](../../results/native-count-cost.json) contains the lexer, checker, generated corpus and eight stock kernels. Every retained warm and fresh-process comparison is within its observed tie band. Unfavorable medians remain visible: sieve fresh emission changes from 20.257876 to 23.106626 ms and its process peak from 50560 to 51968 KiB. Checker fresh emission changes from 315.539674 to 305.762538 ms, while peak RSS rises from 122280 to 123160 KiB. This does not establish a general compile-speed or memory benefit.

## Validation and remaining work

Regression coverage includes unsigned equality/inequality, reversed comparisons, high unsigned index bounds, inverted predicates, modulo reads, initial-state overflow, dynamic and fixed cutoff boundaries, tails, strict trap identity, unsupported shapes, and live register and stack arguments. The unchanged sieve is checked against its handwritten reference and interpreter. The implementation needs only SSE2; Darwin emission checks do not substitute for platform execution.

Isolated boolean, vector-prefix, combined and pre-cutoff experiments remain in the recovery evidence. An initial UTF-8 control overlapped the start of compilation measurements; those logs are preserved but excluded from the retained report. UTF-8 and the complete cost audit were repeated sequentially with no competing work.

The [output control](../../results/native-count-controls.json) verifies 87 stock kernel/target outputs and the ten intended native golden changes for Life and four compiler modules. All remaining canonical golden entries and the spec-free golden match the version-only control.

The code was measured with compiler tag 0.1.78. The retained version advances to 0.1.79 and requires a separate version-only output/golden control, seed proof and fresh available aggregate gate. Full-platform release validation remains outstanding. Publication and private upload approvals remain pending, and no denied operation was retried.

The cumulative objective remains runtime, correctness, output size and compilation cost across A0's supported targets. Remaining measured losses include the residual sieve and dot-product gaps, sorting and heap behavior, and UTF-8/tokenization costs. Current Linux measurements are not evidence of universal superiority or of the unavailable platform checks.
