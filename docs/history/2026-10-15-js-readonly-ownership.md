# JavaScript ownership after scalar reads

Compiler `a0c-0.1.54` reuses private array and record storage after a completed call with a
`u32` or `bool` result, or a completed scalar-result fold/loop that reads the storage as an extra
argument. A scalar result cannot retain an input reference. This removes an unnecessary table
snapshot on each hash insertion without changing the public API or adding a kernel-specific rule.

Aggregate-returning calls still prevent reuse: JavaScript can return an input reference directly.
Later reads of the original container and state passed again as an iteration extra also preserve
their snapshots. Dedicated tests make each retained value observable independently, compare
optimized and unoptimized output with the interpreter, and observe actual copies during a call.

On Linux x86-64 with Node 24.19.0/V8 13.6, hash lookup improved from 1,025,476 to 10,939 ns per
call, **93.75× faster than compiler `.53`**. The handwritten JavaScript reference took 9,468 ns;
the new output still takes about 16% longer. Evidence: `results/js-readonly-hash-linux.json`.
This is a result for this kernel and machine, not a claim about every language or workload.

The report records nine samples per subject, three warmups, raw timings, module SHA-256 digests
and checked checksums. Baseline, candidate and handwritten modules ran in one Node process with
the starting subject rotated each sample. It uses the external xorshift argument/checksum driver
from `tools/exec-bench.ts`, with 1,220 calls per sample. No builds or tests ran concurrently;
maximum load at a sample start was 0.69. Baseline source was saved from main at `9c49c4e`
before the change. Source and argument definitions come from `tools/exec-bench-kernels.ts`.
All values and comparison counts are recorded in `results/js-readonly-hash-linux.json`.

Across the exec-bench kernel set, baseline and candidate return equal results on boundary inputs.
Only hash lookup changes emitted JavaScript after normalizing the compiler-version header. The
shared ownership fixture also agrees with the interpreter. The report records the comparison
counts; the separate direct alias tests guard values that subsequent operations could overwrite.

To measure the current compiler and handwritten reference with the standard driver, run
`bun run exec-bench -- --langs= --kernels=hash1k --samples=9 --scale=16` on a quiet machine.
To repeat the interleaved revision comparison, save JavaScript emitted by `.53` and `.54` for
the same hash kernel, import those and its handwritten `js` source into one Node process, and
apply the warmups, rotating sample order and driver parameters recorded in the report. Check
every checksum and retain the raw samples and module digests. The unchanged native C and direct
assembly paths retain separate performance losses.
