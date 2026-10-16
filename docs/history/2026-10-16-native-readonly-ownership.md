# Native ownership after completed scalar reads

Compiler `a0c-0.1.55` removes two unnecessary sources of aggregate copying in the TypeScript
compiler's native paths. The public calling conventions and A0 value semantics are unchanged.

The C emitter already generated internal variants that read aggregate extra arguments through
const pointers. Scalar-state folds used them, while scalar-state loop bodies and predicates
called the by-value functions. Both loop roles now use the existing view convention. Updates
inside a view still copy the extra before writing, so the caller's original value remains intact.
This also handles boolean state, large arrays and nested records.

The direct x86 emitter now permits reuse of private storage after a completed scalar-result
call, fold or loop that reads the storage as an extra argument. Such a result cannot retain
an aggregate reference. Aggregate-returning calls, later reads, live field borrows and initial
state also passed as an extra retain the existing guards. No kernel name or size threshold
selects either optimization. The A0 self-hosted emitters retain their existing implementations;
these measurements concern the TypeScript compiler's emitted C and direct x86 output.

On Linux x86-64 with clang 19.1.7 at `-O2`, hash lookup improved from 75,063 to 7,505 ns per
call through emitted C (**10.00×**) and from 89,487 to 9,007 ns through direct x86 (**9.93×**).
Handwritten C took 7,005 ns. The candidates still take about 7% and 29% longer respectively.
Evidence, raw samples, checksums and source/binary digests: `results/native-readonly-hash-linux.json`.
These results apply to this kernel, toolchain and machine; they establish no universal ranking.

Baseline compiler `.54` is main at `d7d7597`. Each subject used the common xorshift/checksum
driver from `tools/exec-bench-kernels.ts`. Emitted C and handwritten C compile in the same
translation unit as their driver; direct assembly links against that driver separately. The
run used three warmups and nine sample groups, rotating the starting subject each group, with
1,220 calls per sample. Every timed sample's accumulated checksum was checked. No builds or
tests ran concurrently; maximum load at a sample start was 0.09. All recorded values are in
`results/native-readonly-hash-linux.json`.

Only the hash kernel changes C or x86 emission across the exec-bench kernel set after normalizing
the compiler-version header. The report includes per-kernel digests. New regressions first failed
on the unnecessary C call convention and x86 table-copy instructions. Functional tests compare
optimized and unoptimized execution with the interpreter, including local updates to borrowed
extras, independently observable aliases, later reads and state passed again as an extra. The
C tests use the undefined-behavior sanitizer.

To measure the current outputs against the standard references, run
`bun run exec-bench -- --langs= --kernels=hash1k --samples=9 --scale=16` on a quiet Linux x86-64
machine. For the interleaved revision comparison, save the hash kernel's C and x86 emissions from
`.54` and `.55`, build them with the driver and flags above, then apply the warmup, sample order
and call count recorded in the report. Retain checksums, raw samples and artifact digests.
