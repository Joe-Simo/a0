# A0 history, 2026-10-01: Optimizer, clean-load benchmarks and the A0 wasm path

claim-check: archive. This is a dated record of work on the date above, kept for the evidence trail. Figures are
as measured at the time; some were taken on a loaded benchmark host and are not publishable timings. The current
state and the current numbers are in [STATUS.md](../../STATUS.md) and in results/.

## Session 2026-10-01 (x86-64 steps blocked when x86-64 execution is unavailable)

On the benchmark host the x86-64 translation layer stopped running any x86-64 binary that had not run before (a fresh `clang -arch x86_64` program never exits; already translated binaries still do). `rosettaStuck()` in src/toolchain.ts detects it, so the x86-64 target is reported as blocked instead of hanging the tests. The gate below passed with that target blocked. Re-run once x86-64 execution works again: `verify` (the native x86-64 row of results/verification.json), `test` (the x86-64 tests of test/core.test.ts are skipped) and `behavior` (its x86_64 column); regenerate results/verification.json and results/behavior.json from the gate.

### Same task definition for every A0 cell, and the two tasks every form failed

**1. Comparability.** `b-sumfrom-eight` now names its target, which changes the A0 view only. The task was re-collected fresh (one shot; every cell passed, so no retry was needed) for canonical A0, dense, lean and lean3, Haiku and Sonnet, and the 12-task cells were rescored with that trial replaced (`results/ai-edit-experiment.b.{haiku,sonnet}-a0.json` for canonical; the dense cells in `...-dense*-retry.json`). Every A0 cell of `results/ai-edit-b48-dense.json` now uses the same task definition. Corrected canonical A0 (replaces the 326 / 199 / 185 row of the 49-language table above; its Haiku trial now passes one shot): one shot 22/24, after repair 24/24 (rank 1, 33 ties), 311 / 184 / 170 tokens for 1 task / 10 tasks / unbounded, ranks 1 / 12 / 24.

**2. The two tasks every form failed first (`b-bounds-largest`, `b-checksum-poly`; Haiku only, Sonnet passes both).** Read from the replies and the checker rejection: not model error and not task wording. In `bounds` the bug is in the helper `minmax` (second field wrong) and in `checksum` the seed `0` is shown but the missing `* 31` is in `mixel`; the `deps` view shows a callee as a signature line only, so the helper bodies were invisible. Haiku fixed what it could see (swapped the seed, set seed 7) and the checker rejected the wrong output; Sonnet rewrote the helpers from the instruction. The other 48 languages show the whole source, so this was a missing capability of the A0 views, fixed generally: `scope: 'bodies'` (`src/edit.ts` `scopedViewDense`, MCP `a0_open` `scope: 'bodies'`) prints each direct callee as dense text instead of a signature line (about 8 tokens more for a function with a helper; no cost for one without). Test: `dense edits: scope bodies ...` (test/dense.test.ts) and a case in test/mcp.test.ts. Canonical views have the same limit (`bodies` is dense only; canonical treats it as `deps`); canonical A0 is not changed.

**Result with callee bodies** (lean view plus `bodies`, primer 145; `results/ai-edit-experiment.*-dense-bodies*.json`, harness `A0_EXPERIMENT_DENSE_VIEW=bodies`). Set b: one shot 24/24 (both tasks pass for both models). All sets a, b, d, e, f, fresh Haiku and Sonnet, 124 trials (one retry each; the d-set Haiku trial `d-rename-twice` that the subject left unanswered was re-asked fresh):

| form | one shot | after 1 retry | read/task | cost 1 task / 10 / unbounded |
|---|---|---|---|---|
| canonical | 112 | 120 | 89 | 284 / 157 / 143 |
| dense (program view) | 111 | 114 | 75 | 299 / 143 / 125 |
| dense lean | 114 | 122 | 54 | 272 / 115 / 98 |
| dense lean + bodies | 120 | 123 | 56 | 264 / 107 / 90 |

Set-B 49-language table, the subject against the 48 languages (24 trials per cell; W/T/L on cost uses the 1% band):

| subject | 1 task | 10 tasks | unbounded | one shot | after repair |
|---|---|---|---|---|---|
| canonical A0 | 311, rank 1 | 184, rank 12 | 170, rank 24 | 22/24, rank 21 | 24/24, rank 1 |
| dense (program view) | 314, rank 1 | 157, rank 2 | 140, rank 8 | 23/24, rank 6 | 23/24, rank 34 |
| dense lean | 297, rank 1 | 141, rank 1 (ties Ruby) | 123, rank 2 (Ruby 115 ahead) | 22/24, rank 21 | 24/24, rank 1 |
| dense lean + bodies | 274, rank 1 (48/0/0) | 117, rank 1 (48/0/0) | 100, rank 1 (48/0/0) | 24/24, rank 1 (43/5/0) | 24/24, rank 1 (15/33/0) |

From results/ai-edit-b48-dense.json: the earlier statement that the unbounded row is a loss to Ruby by a few tokens holds for the lean view without callee bodies (123 against 115) and is gone with `bodies` (100 against 115), where the gain is fewer retries (calls per task 1.00) rather than fewer tokens; with 24 trials per cell, a one-trial change in acceptance moves a cost by about 8 tokens, so the row is won by a margin of that order and should be read with that noise. Recommendation from the numbers: the lean view with callee bodies is the best dense form on every measured row, and canonical remains the default (its 49-language ranks are 1 / 12 / 24). Whether to make it the recommended dense form of the MCP and docs is left to the maintainers: the evidence supports it for the dense view (non-inferior or better on acceptance in all five sets, 20 to 40% fewer tokens per task), but dense still needs a 145-token primer, and Haiku's one-shot failures on arity (`f-divrem-pair`, `d-isdiv-bool`) remain.

## Session 2026-10-01 (clean-load lang-axes and exec-bench on the merged branch)

Branch merged with origin/main e21a599. Timing tools now wait for a quiet machine: tools/quiet.ts (`waitQuiet`, limit 10 on the 1-minute load, `A0_MAX_LOAD` to change it) runs before every lang-axes round and before every exec-bench sample group, and both result files record what the gate saw (`loadGate`).

lang-axes (results/lang-axes.json): 5 rounds, interleaved. The 1-minute load at the start of each round was 6.3 / 5.4 / 7.7 / 6.6 / 9.8, then 6.6 after the last round; the gate waited once, at 13.5 (30 s in all), so no round started above 10. Hence this is a clean run in the repo's sense; the machine was shared with other jobs, so the spread between rounds is still real.
- Check + run per edit (median over rounds, then over the 3 kernels): A0 2.5 ms, Lua 2.8, Forth 3.9, Smalltalk 9.8, Tcl 11.3, Perl 12.7, Prolog 18.0, Common Lisp 24.0, Guile 29.6, Python 59.5, JS 65.3, Racket 92.3. A0 and Lua are a tie: per round A0 took 1.9-3.6 ms and Lua 2.0-6.9 ms on the same kernels, so the ranges overlap on every kernel. A0 is ahead of every other language by 1.5x (Forth) or more.
- Static check per edit: A0 2.8 ms, Perl 6.1, JS 30.3, Python 38.0, Ruby 55.6. A0 is first of the 33 languages with a static step, 2.2x ahead of Perl.
- Coverage: 48 languages beside A0 on every axis that applies; none missing or failed.

exec-bench (results/exec-benchmark-full.json): the full run of the current tool, all 45 table languages plus A0, C, Rust and JavaScript, on the 19 kernels now in tools/exec-bench-kernels.ts, 7 samples per side, interleaved. 665 sample groups, 41 waits (123 s) for the load to fall, highest 1-minute load at the start of any sample group 9.78 (results record loadGate and loadAverage 3.6 at the end). A0 here is the emitted-C path (`c.emitted`); a language counts as beaten when A0's slowest sample is below its fastest, lost when A0's fastest is above its slowest, tie otherwise (overlapping sample ranges).

| kernel | A0 ns/call | languages | A0 faster | tie | A0 slower |
|---|---|---|---|---|---|
| affine | 7.8 | 45 | 23 | 11 | 11 |
| rotl | 3.3 | 45 | 44 | 1 | 0 |
| clamp | 6.6 | 45 | 32 | 1 | 12 |
| mix | 3.3 | 45 | 31 | 14 | 0 |
| ident | 1.6 | 45 | 32 | 13 | 0 |
| noop | 1.6 | 45 | 32 | 13 | 0 |
| chain3 | 3.2 | 45 | 32 | 13 | 0 |
| branchy | 3.5 | 45 | 34 | 1 | 10 |
| arrfill | 3.2 | 45 | 36 | 9 | 0 |
| loop64 | 80.2 | 45 | 32 | 13 | 0 |
| arrfill4k, dot1k, prefix1k, hist256, xs4k | | 1 each (Zig) | 5 | 0 | 0 |
| fnv4k | 20731 | 1 (Zig) | 0 | 1 | 0 |
| mat4 | 136.1 | 1 (Zig) | 0 | 0 | 1 |
| minmax1k | 44818 | 1 (Zig) | 0 | 0 | 1 |
| filter2 | 90062 | 1 (Zig) | 0 | 0 | 1 |

Totals over all kernels: 333 wins, 90 ties, 36 losses. The losses: on affine, clamp and branchy A0 is 25-60% slower than the natively compiled languages (C++, Objective-C, Swift, Zig, Fortran, Julia, Nim, Crystal, D, V, Odin, Vala; also TypeScript on affine); this run is quieter than the earlier one where they tied. The six kernels added to the tool most recently have a hand-written baseline only in Zig, and A0 is slower there on mat4, minmax1k and filter2, by 3.6x, 50x and 100x. These are real losses and stay listed.

Limits found while doing this:
- site/gen can hold 16 kernels (its tables are strided by 16 in site/gen/sgjson.a0 and sgcalc.a0); the tool now produces 19, and the generator overruns its output ("output capacity reached") at 17. results/exec-benchmark.json is therefore left at the committed 10-kernel file the site was built from, and the full run is stored beside it as results/exec-benchmark-full.json. Raising the generator's kernel capacity (re-striding about 30 tables) is the next step before the full file can become the page's source.
- results/loss-ledger.json is unchanged: it reads exec-benchmark.json, so the 56 new losses in the full run are not in it yet.
- The first exec-bench run of this session was not interrupted; a second copy started by mistake was stopped before it wrote anything.

## IR optimizer: matrix power, select at equality, cost model (a0c-0.1.35)

What changed in src/optimize.ts (shared by every backend):
- A `fold` whose step is one n x n u32 matrix product (state times an invariant matrix from an extra
  parameter, on either side, recognized from the body dataflow) becomes S x M^trips: squaring plus one
  product per set bit, log2+popcount products instead of `trips`, exact in wrapping u32 arithmetic.
  mat4 (8 trips) goes from 8 products to 4 (arm64 text: 607 to 333 mul/madd). 1320 randomized
  comparisons against the interpreter (n 2..4, both sides, 3..1000 trips) found no difference.
- `select (x == y) K v` (and the `ne` mirror) is `v` when `v` evaluates to the literal K at x == y
  (abstract evaluation through sub/xor/compare/select, depth 6). branchy loses one eq and one select
  on every backend (arm64 8 to 7 instructions).
- Inline and unroll gates are expressed in Rust's cost units (instruction 5, call or loop 25), at the
  same thresholds as before for call-free bodies. No one-call bonus: every backend emits every
  function, so inlining a single call site removes no code.
- Tests: two new in test/core.test.ts. Gate run with A0_SKIP_X86=1 (x86-64 execution unavailable, x86-64 steps not
  run): lint, typecheck, test, verify, equiv, hw, app, selfhost, selfhost-c, bootstrap, dotnet, gpu,
  tokens, site all pass.

Development measurements while other jobs were running, not a timing claim (the recorded timings
are in results/exec-benchmark.json, taken at clean load; ns, A0 arm64 vs best of C -O3, Rust, Zig):
- mat4: 138.7 before; 72.7 vs 34.8 (0.48x, was 0.23x) in the quietest run; a later run, with other
  jobs busy, gave 139 vs 53 ns (0.38x). Still a loss: the best C/Rust/Zig vectorize the matrix product with
  NEON; the remaining gap is SIMD (SLP) and register allocation in src/arm64.ts (about 800
  instructions, ~100 spill ld/st), not the IR.
- affine, clamp: not an optimizer matter. A0 emits the same instructions as clang -O3 (madd;
  cmp/csel x2) and ties clang -O3 out of line (6.75 vs 6.75, 7.20 vs 7.18). The recorded 0.63 and
  0.69 come from Zig's inlined driver loop running faster than every other row.
- branchy: 4.60 vs 4.46 to 4.39 (0.91x); clang emits 6 instructions (fused subs, tst), A0 now 7.
  The rest needs arm64.ts peepholes (fused subs, tst, cneg for abs-diff).
- Other kernels unchanged within noise (rotl, mix, ident, noop, chain3, arrfill, loop64 tie). Only
  15 of 19 kernels finished in the timed run; results/exec-benchmark*.json were not rewritten, so the
  loss ledger is unchanged.
- Open item for src/arm64.ts: NEON SLP for straight-line 4x4 products (mla by element),
  tst/subs/cneg fusion, spill reduction.

## Session 2026-10-01 (A0 optimizer, shape analyses and wasm emitter ported to main's new src/optimize.ts and src/wasm.ts; a0c-0.1.35)

- **Why.** Main's src/optimize.ts (393 -> 1343 lines) and src/wasm.ts (~950 -> 1998 lines) gained scalar-call inlining, literal reassociation, short-fold unrolling, aggregate forwarding, borrowed reads (`borrowLive`), fill/select analyses, producer-consumer loop fusion, and in wasm simd128 fills, induction variables, scalar-replaced fold state, carried reads, lazy selects, rotated loops, inlining, `Code.finish` (stackification, local.tee, dead stores, live-range local sharing), the unroll option and export pruning. The A0 versions were stale (selfhost:wasm 0/5, `bun run site` failing). All of it is ported; the A0 pipeline (optimizer -> shape/fusion -> emitter) is byte-identical to `wasmModuleBytes(compile(program,'wasm',layout).text)`.
- **Pieces.** compiler/optimize.a0 (generated from compiler/optimize.a0s by tools/a0s.ts, `--check`; evaluator in compiler/evalrun.a0): `optimizeFunction` with its callee-first closure; one function per a0w run (mode 7; no A0 value can exceed 65536 words), body requests by code 7 and reruns with the optimized bodies; mode 8 `ozopt1` is the same optimizer as a pure function. compiler/shape.a0 (generated from shape.a0m by tools/a0m.ts, `--check`, test/a0m.test.ts): `fillRun`, `lazyArms`, `overwritesState`, `borrowLive` into a shape table (`sh`, u32x128x200) and `fuseLoops` (check, fuse, args, shape of the fused view). compiler/emit_wasm.a0 (+ compiler/wasm_code.a0, the `Code.finish` passes) is the emitter; compiler/boot.a0 orchestrates (`wxorch`, `wxfunf`, `wxbad` = the `emitFused` fallback by a dry run that scans for out-of-line calls of synthetic bodies; modes 1/2/3 as before, mode 1 computes the shape table from the front end's tables). Export pruning is in the A0 linker. emit_wasm.a0 and wasm_code.a0 are the source (hand-edited after a first mechanical generation).
- **Tables.** One node capacity everywhere: u32x128x132 (2816 nodes); operands u32x128x512; pool u32x128x400. Protocol of tools/selfhost-wasm.ts: opaque external rows carry their node count and request their bodies by code 7; the driver unions the requests of optimizer, shape and emitter and reruns the chunk; code 4 cuts the chunk in two. A u32 ret literal of 2^28 or more is ret kind 5 in the IR; the A0 front end's 28-bit ret packing cannot hold one (source mode binds such a ret to a `mov` first, `frontEndForm`).
- **Checks** (`bun run selfhost:wasm`, results/selfhost-wasm.json): module bytes identical to src/wasm.ts at default options and at `{optimize:false}`, table and source mode, on the corpus, kernels, life, site/docs.a0 and site/page.a0 (5/5), optimized IR identical to `optimizeFunction` on every function (corpus 48, kernels 5, life 14, docs 28, page 61), corpus seeds 1-14 at both levels (seeds 3 and 11 at O0 excluded: the TS emitter itself throws "unbound node"), SHAPE's fusion/lazy/borrow scratch programs and fusion fuzz at both levels, export-pruning cases, unroll 2/4 and simd off on the small programs. Timings (loaded machine): page.a0 optimizer ~12 s, emission O1 67 s from tables / 44 s from source; docs.a0 17 s / 4 s.
- **Limits** (diagnostic 4 or a thrown error): 4096 optimizer arena nodes, 32768 operand slots, 256 stacked nodes, evaluator 1024 frames / 16368 env words / 40832 heap words (an evaluator exhaustion keeps the fold as a loop, as TS), fusion builder 7936 operand pairs, over 60000 call markers with an export list. Fusion triggers in none of the five target programs; it is exercised by scratch programs.
- **Capacities found on the way.** The linker's pool was one 53,632-word table; main's newer page needs 54,860 distinct pool words, so the linker has two pool banks now (about 120,800 words). main's page had a chart function (`chart_ec`) of 3273 nodes, above the 2816-node function table: the template splits it over `chart_ec` and `chart_ec2`, and tools/site-budget.ts now checks nodes (limit 2776) as well as operands, naming the function. Source mode at O0 skips `site/page.a0` chunks that do not fit the front end (chart_tk).
- Known flake: bootstrap-arm64's stage-2/3 `a0c` executable hung (killed by the 600 s timeout) on one chunk in three of five full runs, never on replay of the same input (300 replays fine) and not on the runs that passed; a clean rerun gives the fixed point. Not understood; the benchmark host had a stuck x86-64 process from another job's test run.
- Gate: see the gate note of the commit (a0-dev gate).
