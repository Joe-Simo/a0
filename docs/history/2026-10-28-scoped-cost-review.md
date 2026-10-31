# Scoped retained-change and emission-cost review

The historical loss ledger still contains 616 entries. It is not globally refreshed by this review. The [scoped scoreboard](../../results/retained-scoreboard.json) compares nine preselected cells from preserved checkpoint 9a036e70 to 0df5ba4c, measured again on this Linux host with unchanged inputs. Each comparison is paired within its own run; timings from different machines or earlier runs are not substituted. The repository's observed-spread band ranges from 8% to 25%; a tie means inconclusive within that band, not proved parity.

| Cell | Early ns | Current ns | Incumbent ns | Current vs incumbent |
|---|---:|---:|---:|---|
| js min/max | 6129.6 | 3477.3 | 3371.1 | tie |
| js RLE | 26597.4 | 11441.5 | 10040.6 | tie |
| js sorting | 28526.7 | 25926.8 | 14791.2 | loss |
| js heap | 18175.6 | 20602.6 | 15826.7 | loss |
| js UTF-8 | 76988.0 | 75304.4 | 20014.5 | loss |
| native dot | 737.0 | 237.3 | 93.0 | loss |
| native histogram | 4766.9 | 4649.8 | 2082.4 | loss |
| native sieve | 7718.8 | 7867.1 | 3106.9 | loss |
| native prefix | 538.8 | 525.2 | 431.1 | tie |

The JavaScript incumbent is handwritten JavaScript. The native incumbent is Clang O3 native behind the same out-of-line driver. No cell in this scoped refresh is an incumbent win: three are ties and six are losses. Against the early checkpoint, min/max, RLE and native dot retain clear gains; the smaller sorting difference is inconclusive in this refresh. Heap, UTF-8, histogram, sieve and prefix emit identical code after version normalization, so their measured variation is not attributed to a compiler change. Raw data: [JavaScript](../../results/retained-scoreboard-js.json), [native](../../results/retained-scoreboard-native.json).

## Size-focused checkpoint

The candidate removes private JavaScript declarations unreachable from all public exports and runtime roots. Every public body and every retained private body remains byte-identical after version normalization. Function-cache entries remain independent of their callers; reachability is recomputed during assembly. The ordinary body is rendered once and reused for the public scalar entry. The [audit](../../results/js-private-audit.json) covers 47 JavaScript module/profile cases and all 29 stock C/native controls.

| JavaScript input | Early bytes | Before size change | Candidate bytes |
|---|---:|---:|---:|
| compiler | 3742500 | 3754362 | 3615073 |
| gen100 | 87532 | 87532 | 63202 |
| minmax1k | 5124 | 6314 | 5029 |
| rle4k | 6398 | 9088 | 6374 |
| isort256 | 6252 | 7172 | 6253 |
| heap256 | 10361 | 10361 | 9181 |

The size change recovers the added text from min/max and RLE and nearly all of sorting's added text. It also reduces the existing compiler and gen100 outputs. Native dot retains its necessary CPU guard and SSE2 fallback; this change does not touch native code. Exact size and cost data are in [the cost report](../../results/js-private-cost.json).

The same cost run also records the accumulated compiler cost, without treating small changes as established wins:

| Input | Early emit ms / peak KiB | Before emit ms / peak KiB | Candidate emit ms / peak KiB |
|---|---:|---:|---:|
| compiler | 305.024 / 246560 | 321.509 / 257196 | 316.551 / 255704 |
| gen100 | 16.008 / 67692 | 15.698 / 66752 | 14.909 / 67556 |

These are interleaved same-host measurements, not cross-machine comparisons. Peak RSS includes process/module overhead and is not retained program memory. The data do not establish a general compile-speed or memory benefit.

All five [paired runtime controls](../../results/js-private-runtime.json) remain inside the repository tie bands; the largest slower median is heap at about 5.7%. Public executed bodies are unchanged. This does not claim a new runtime win. Compile timings are mixed: compiler and gen100 end-to-end comparisons are ties. The targeted [cold sorting follow-up](../../results/js-private-cold-isort.json) measured 6.632243 ms before and 7.999575 ms after; its broad observed-spread band classifies it as a tie, but the slower median is a real reported tradeoff. No general compile-time, startup, peak-memory or retained-memory improvement is claimed. GC and process measurements are noisy. See [the combined summary](../../results/js-private-summary.json) for all cells, including unfavorable ones.

The available aggregate gate is required for validation. Full Mac/Windows/platform release checks remain outstanding; this local review does not authorize publication.
