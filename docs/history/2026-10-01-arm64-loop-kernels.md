# Session 2026-10-01: arm64 loop kernels

claim-check: archive. A dated record moved from STATUS.md. Figures marked as console output are not recorded results; the current numbers are in results/.

## Session 2026-10-01 (direct arm64 backend: loop kernels, A0-driver row, mat4, branchy)

COMPILER_VERSION a0c-0.1.36 (a0c-0.1.35 is the merged optimizer branch). Every change is in src/arm64.ts (plus tools/exec-bench.ts and tools/exec-bench-kernels.ts for the new row, tests in test/arm64-loops.test.ts and one assertion changed in test/core.test.ts); the shared optimizer is untouched.

What changed in the direct arm64 backend
- Vector loops: unrolled by 4 or 2 with one accumulator per copy, loads and stores paired as `ldp`/`stp`, `mul index c (+ y)` strength-reduced to a register stepped by an add, `acc += a * b` as `mla`, a constant factor inside a sum moved out of the loop (c * (x + y) = c*x + c*y in wrapping u32).
- New vector shapes: an inclusive prefix scan (`ext`/add per vector plus a running carry), an indexed read-modify-write (histogram: the index and weight four at a time, the updates sequential per lane), and min/max/xor/or/and/mul/add reductions on records or scalars as before.
- Arrays that are only read by a few `get`s are never stored. A fill or any element-wise pipeline (`set p0 p1 f(i, extras, gets of other such arrays)`) is evaluated at the indices read; a prefix scan or an add/xor histogram from zeros is answered as one masked reduction per `get` inside a single vector loop. Exact under value semantics; guarded by a cost bound.
- A previous element guarded at trip 0 by a seed (`select (eq p1 0) seed (get p0 (p1 - 1))`) starts the carried register at the seed (no compare, no select) and is computed straight into its register (no copy on the recurrence); an index bounded by a shift or mask is not masked again; scalar ops over literal operands fold at compile time.
- Fold state records of scalars live in registers across the loop and are stored back once. Inlined callees get their own loops fused (before, only the function itself did).
- 4x4 products of scalar grids (the straight-line form the optimizer's matrix power produces) run in NEON registers: row r of the result is the sum over k of row k of Y scaled by element by x[r][k]; a grid that is itself a product stays in its registers; rows are emitted as soon as their inputs exist.
- Peepholes: absolute difference as `subs` + `cneg`, `(x & m) == 0` and single-bit tests as `tst`.
- exec-bench has a second arm64 row: the whole program in A0 (a fold that generates the xorshift inputs, calls the kernel and xors the results), compiled by the direct arm64 backend, so the kernel is inlined into the loop as in the other languages' own drivers. Rows in the report: `arm64VsBestFlags` is the kernel alone called out of line from a C driver; `arm64A0DriverVsBestFlags` (and `c.arm64A0Driver`) is the A0 driver. Both are compared with the fastest of C -O3, Rust and Zig; losses stay losses.

Measurements (not results). The per-kernel table below is the console output of an interrupted exec-bench run (load gate at 10). No results file was written for it: `results/exec-benchmark-arm64.json` does not exist, so none of these figures is a recorded result and none may be quoted as one. They wait for a rerun on a quiet machine. Only fnv4k, xs4k, minmax1k and filter2 have recorded values, in `results/exec-benchmark-arm64-heavy.json` (without Zig) with the Zig column from `results/exec-benchmark-full.json`. Speedup over the best of clang -O3 -march=native, Rust and Zig ReleaseFast, above 1 is faster; before = the clean-load run in `results/exec-benchmark-full.json`.

| kernel | before | C driver row | A0 driver row |
|---|---|---|---|
| affine, rotl, clamp, mix, ident, noop, chain3, branchy, arrfill, loop64 | 0.63 to 1.00 (affine 0.63, clamp 0.69, branchy 0.90) | 0.93 to 1.01 tie | 0.96 to 1.00 tie |
| arrfill4k | 1.32 | 71.6 | 72.2 |
| dot1k | 1.03 | 2.36 | 2.36 |
| prefix1k | 0.40 | 3.03 | 3.04 |
| hist256 | 0.67 | 2.18 | 2.17 |
| mat4 | 0.23 | 2.03 | 2.02 |
| minmax1k | 0.75 | 1.18 tie | 1.15 tie |
| xs4k | 0.74 | 1.00 tie | 1.00 tie |
| fnv4k | 1.04 | 1.02 tie | 1.02 tie |
| filter2 | 2.02 | 64 | 64 |

Where the numbers come from: the rows for fnv4k, xs4k, minmax1k and filter2 are in `results/exec-benchmark-arm64-heavy.json`, run without Zig (a table run is 20 million iterations of a 7 to 20 microsecond kernel, minutes per sample), so for those four the Zig column is the clean-load run in `results/exec-benchmark-full.json`. The other fifteen kernels (with Zig, 7 samples) come from the interrupted run's console output only: the Zig step of fnv4k was killed under load and no report was written; the rerun could not get below load 10. It has to be repeated with `bun run exec-bench -- --langs=zig --kernels=<those fifteen>` and only then become a result. Until then these fifteen figures are neither results nor claims, and nothing outside this history file uses them.

Ties that are chains, not code quality
- xs4k (xorshift32 stream, xor-reduced) and fnv4k (FNV-1a) are serial dependency chains (about 6 and 16 cycles per element); A0 emits the same chain as clang, so they tie at 1.00 and 1.02. A0 no longer adds a compare, select and register copy to the chain (that was the xs4k loss).
- minmax1k is bound by the NEON op count (umax, umin, the hash multiply and shift and the index step, about 2.5 vector ops per cycle here): 1.15 to 1.18, a tie by the 1.2 rule.

Verification
- 4297-case arm64 verify passes; interpreter, optimizer, native arm64, selfhost and the stage 1 to 3 fixed point (C, arm64, Mach-O) pass; test/arm64-loops.test.ts covers each new shape against the interpreter, optimized and unoptimized. About 900 random programs (fills, reductions, scans, histograms, pipelines, carried recurrences) were compared with the interpreter in a differential fuzz; it found one bug (a scaled product operand read twice), fixed with a regression test. The gate ran with A0_SKIP_X86=1 because the x86-64 steps are blocked while Rosetta 2 is stuck. Two tree-sitter tests fail only because the tree-sitter binary is not installed in this checkout.

Ideas not done
- Closed form for GF(2)-linear streams: xorshift state is a 32x32 bit matrix M, the xor of the stream is (M + M^2 + ... + M^N) x, computable at compile time and applied with four table lookups; this would take xs4k from a tie to far ahead.
- A general superword vectorizer (isomorphic scalar groups with lane-varying literals) would also vectorize the input grids of mat4, which are still scalar code.
- Prefix-sum point queries could split the loop at the queried index instead of masking every vector; the histogram query could compare bytes instead of words.
