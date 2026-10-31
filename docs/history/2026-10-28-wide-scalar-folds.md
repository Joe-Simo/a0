# Bounded larger scalar-record folds

The fresh scoped scoreboard identified UTF-8 decoding as a substantial remaining JavaScript loss. Its step has 53 total nodes, 43 computations and five scalar state fields. The old lowering rejected it at the separate 16-computation limit. The new lowering keeps the existing 64-total-node and eight-scalar-field limits, snapshot semantics, and exclusions for strict profiles, calls, nested iterations and effects; it removes the redundant arithmetic limit. It does not recognize benchmark names or substitute an algorithm.

The [paired same-host measurements](../../results/js-wide-fold-runtime.json) compare preserved 5d95b46b with this change using unchanged inputs and handwritten references. The maximum measured machine load was 0.85. Repository verdicts use the observed-spread tie band, not a claim of statistical certainty.

| JavaScript benchmark | Before ns | After ns | Handwritten ns | After vs before |
|---|---:|---:|---:|---|
| utf8dec4k | 66706.668 | 40044.800 | 18317.539 | win |
| tok4k | 51696.401 | 43019.401 | 36628.451 | tie |
| minmax1k | 3702.227 | 3713.518 | 3468.367 | tie; identical emitted code |
| rle4k | 11457.944 | 12089.981 | 10555.013 | tie; identical emitted code |

UTF-8 shows a clear improvement over the current checkpoint but remains slower than the handwritten reference. Token scanning has a lower median, but its change remains within the observed-spread band and is not claimed as a confirmed win. This four-cell result does not refresh the historical 616-entry loss ledger or establish a global win.

## Costs and controls

| Module | Raw bytes before / after | gzip level 6 before / after | Brotli quality 5 before / after |
|---|---:|---:|---:|
| utf8dec4k | 8934 / 10086 | 2129 / 2662 | 2010 / 2533 |
| tok4k | 7550 / 8440 | 1855 / 2253 | 1739 / 2107 |

These size increases are retained tradeoffs, not ignored regressions. The [compile-cost report](../../results/js-wide-fold-cost.json) uses the existing compiler, gen100 and four kernel inputs. Compiler and gen100 output bytes are unchanged. Cold UTF-8 emission medians were 18.083 and 21.029 ms; token emission medians were 15.243 and 15.685 ms. Process memory and other compile timings vary; no general compile-speed, startup or memory improvement is claimed. All figures and classifications, including unfavorable ones, are preserved in the [summary](../../results/js-wide-fold-summary.json).

The [emission audit](../../results/js-wide-fold-audit.json) checks all 29 stock kernels: only UTF-8 and token JavaScript change; C and native output stay unchanged after version normalization. It also verifies measured runtime and compile outputs against the final emitter except for the version banner. Regression tests compare all five decoder state fields across malformed and partial inputs, zero trips, arbitrary initial states and wrapping counters; full-input checks compare both affected kernels with the interpreter and handwritten code. The exact 64/65-node boundary, caller snapshots and strict/effect fallbacks remain covered.

An initial stock baseline run was stopped in its unrelated long native-driver arm and is not used as timing evidence. A full-input reference test initially exhausted its test-only interpreter budget; the corrected test retains the same assertions with sufficient fuel. Both logs are preserved separately in the milestone archive.

The available aggregate gate is required before validation is complete. Full Mac/Windows/platform release checks remain outstanding; no publication is authorized by these measurements.
