# Private JavaScript record fields across iterations

Compiler `a0c-0.1.57` can transfer private flat-array fields through record-state iterations.
Previously, each update of an array projected from a record copied the array. Outer record
ownership alone does not make its children private: two fields or an old record can still
reference the same array. The new analysis proves child ownership before permitting mutation.

The proof applies to records containing u32/bool fields and flat u32/bool arrays. A specialized
iteration body accepts a private state whose array fields are disjoint, and must return a
record that preserves that property. Fresh flat arrays and flat-array iteration results are
ownership candidates; every transfer rechecks prior uses, later uses and the function return.
Repeated fields, unknown aggregate calls, moves, selections and record puts do not establish
deep ownership. An eligible field projection has exactly one literal-field read, and its
parent is observed only through those field reads.

When an initializer cannot transfer, each array field is cloned separately. This protects
caller inputs and separates repeated references, including zero-trip iterations. Nested loops
preserve the invariant through the acyclic call graph. A borrow retained in an earlier record,
array or aggregate-returning call prevents transfer even when its direct last use precedes
the loop. Dedicated negative controls produced wrong values when that escape guard was removed.
The permanent tests retain both observations of the old borrowed values.

The specialized body can reuse its outer record when the old parent has no whole-record uses.
All return-field operands have already been evaluated before stores, preserving parallel field
swaps. Each eligible function keeps the ordinary internal/public entry and one owned variant;
all iterations using a capable body select its specialized variant. Functions without eligible
record types skip the ownership analysis. Analysis caches distinguish ordinary, owned and deep
variants, while emitted-function cache keys retain transitive callee revisions.

The final quiet Linux run compared `.56` at main `ef95f93` with the integrated `.57` compiler
under Node 24.19.0/V8 13.6. Values are medians of nine rotating sample groups after three warmups,
with 512 calls per subject/sample. Every accumulated checksum matched handwritten JavaScript.
The maximum load at a sample start was 0.56, with no concurrent builds or tests. Evidence,
including raw timings and source hashes: `results/js-deep-owned-heap-linux.json`.

| heap256 | Previous compiler | Current compiler | Handwritten JS |
|---|---:|---:|---:|
| Runtime, ns/call | 3,218,934 | 17,128 | 11,950 |
| Module bytes | 10,319 | 10,361 | See reference source |
| Observed typed-array copies for inputs `(7,13)` | 1,651 | 0 | Not instrumented |
| Observed bytes copied through typed-array slice | 3,381,248 | 0 | Not instrumented |

The current compiler is 187.93× faster than the previous compiler in this run, and still
1.43× slower than the handwritten reference. The module grows by 42 bytes. A separate warm
study of the twenty-nine prepared benchmark programs, including optimizer and JS emission
without a FunctionCache, measured medians of 548.6 versus 554.7 microseconds per compile
(about 1.1% higher). Raw samples and load observations:
`results/js-deep-owned-heap-linux.json`.
These are workload-specific observations, not a universal ranking.

Only heap256 changes executable JS emission across that benchmark set after normalizing the
version header. All benchmark programs passed sixty-four per-call comparisons against their
handwritten references in both candidate optimization modes. Permanent regressions exercise
shared fields, old-parent aliases, captured borrows, unknown external arrays, field swaps,
zero trips, strict traps, boolean arrays and I/O effects inside specialized bodies.
Both profile/spec snapshot suites were refreshed after the final emitter changes.

To compare current output with the standard references, use
`bun run exec-bench -- --langs= --kernels=heap256 --samples=9 --scale=16` on a quiet host.
For a revision comparison, preserve emissions from both compilers, use the recorded xorshift
driver and per-row parameters, rotate subjects and check every checksum. Keep raw samples
and emission hashes with the result.
