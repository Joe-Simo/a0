# WebAssembly ownership after completed reads

Compiler `a0c-0.1.53` permits in-place updates after earlier calls and fold/loop extra-argument
reads. These uses cannot retain an alias: call results have separate storage, and iteration extras
are read-only. Initial state operands, live borrows and reads delayed into lazy select arms still
prevent reuse. The same rule is implemented in the TypeScript and A0 wasm emitters.

On Linux x86-64 with Node 24.19.0/V8 13.6 and clang 19.1.7, hash-table lookup improved from
48,479 to 8,733 ns per trip, **5.55× faster than the previous compiler**. Clang took 7,402 ns;
A0 remains slower on this kernel. Module size fell from 653 to 598 bytes. These are medians of nine
interleaved samples, with checksums checked on every timed call and load below 1:
`results/wasm-readonly-hash-linux.json`. The baseline is main at `3a3409a` (compiler `.52`).

The cause was two full 4 KiB table copies per insertion. Removing the false sharing dependency
also permits the insertion body to inline. There is no kernel-name check or benchmark-specific
rule in the compiler.

The broader run covers all 29 exec-bench kernels, using saved baseline and candidate modules in
one process. Maximum load at a sample start was 0.90. Hash lookup improved 5.44× in that run;
the other kernels' executable code is unchanged after normalizing compiler-version metadata.
Raw samples, checksums and module digests are in `results/wasm-readonly-ab-linux.json`.
These results do not establish superiority over every language or workload.

`bun run wasm-ab -- --unroll=1 --save-modules=DIR` now saves modules for later comparisons.
With those baseline modules available, reproduce an interleaved comparison with
`bun run wasm-ab -- --unroll=1 --samples=9 --baseline=DIR --baseline-label=REV --kernels=hash1k`.
Use separate output directories for each revision; the JSON records raw samples and module digests.

Regression coverage checks completed scalar and aggregate calls, fold and loop extras, borrowed
record fields, delayed reads, and state passed again as an extra against the interpreter with and
without optimization. The self-hosted wasm parity suite includes those cases and the hash kernel.

The gate cache now includes every test file and fixture in its input hash. Previously a changed
test outside the fixed entry list could reuse a cached pass. A regression test first caches a
passing run, then adds a failing test, edits a test to fail, or changes its fixture, and requires
the gate to rerun and report the failure.
