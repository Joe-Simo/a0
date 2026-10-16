# Owned iteration results, record fields and predicate branches

Compiler `a0c-0.1.56` removes redundant iteration copies and fixes x86 bit-test liveness.
The comparison fix matters independently of the performance changes: a comparison that absorbs
an AND must keep the AND's input live. Tracking only the omitted node allowed the register
allocator to reuse that input too early. In a new regression, `(x & 8) == 0` combined with an
intervening addition produced the wrong selection for `x = 7, y = 13`: zero instead of fourteen.
Both materialized comparisons and direct predicate branches now track their actual operands.

JavaScript iteration bodies may return a fold/loop result without another `.slice()`. That
result already owns its outer container: initialization either transfers private storage or
copies it, and each owned body preserves that invariant. This includes zero trips. References
inside nested records still require their existing copy-on-write protections; outer ownership
does not imply exclusive ownership of fields. Tests preserve essential extra-argument snapshots,
shared record fields and caller inputs updated through zero-trip and nonzero-trip results.

Direct x86 iterations can update an aggregate field of a private record in place when the
parent has only unique literal-field reads and returns a rebuilt record of the same type.
Existing later-use and borrowed-field checks still apply. Rebuilt records store their fields
directly into the owned state, skipping unchanged fields. A field whose source overlaps another
destination keeps the temporary copy, preserving simultaneous field swaps. Records containing
an io token retain the existing storage path.

Eligible inlined predicates branch on scalar comparisons and conjunctions after all other nodes
have run. Shared DAG nodes and outside uses remain materialized, keeping code size linear.
Other boolean operations retain their ordinary evaluation. Strict traps and I/O effects keep
their original order; dedicated regressions check a false conjunction with a later trap and
one whose predicate reads the input stream.

The quiet Linux run used Node 24.19.0/V8 13.6 and clang 19.1.7 at `-O2`. All values below are
medians of nine interleaved samples after three warmups, with raw samples, checked checksums,
source/binary digests and per-row call counts in `results/owned-iterations-linux.json`.

| Target and kernel | Previous compiler, ns/call | Current, ns/call | Speedup | Handwritten reference, ns/call |
|---|---:|---:|---:|---:|
| JS sieve4k | 248,917 | 12,440 | 20.01× | 8,597 |
| JS isort256 | 378,102 | 26,688 | 14.17× | 13,783 |
| JS heap256 | 2,819,331 | 2,432,072 | 1.16× | 15,641 |
| x86 isort256 | 25,522 | 22,817 | 1.12× | 9,286 |
| x86 bsearch1k | 11,555 | 9,218 | 1.25× | 19,725 |
| x86 hash1k | 8,789 | 7,700 | 1.14× | 7,059 |
| x86 heap256 | 222,982 | 34,237 | 6.51× | 7,669 |

The baseline is main at `7187b58`, compiler `.55`. Subjects rotate their starting order in each
sample group. Native changed kernels also passed per-call comparisons against handwritten C
on sixty-four inputs with UBSan enabled in the reference. Maximum load at a sample start was
0.32; no tests or builds ran concurrently. JavaScript uses the external xorshift/checksum loop
in one Node process. Native x86 links against the standard C driver in a separate translation
unit; handwritten C compiles with its driver at the same flags. Evidence:
`results/owned-iterations-linux.json`.

Only the listed target/kernel combinations change emission across the exec-bench kernel set
after normalizing the compiler-version header. The report includes all emission digests.
The candidates still lose on several comparisons: JavaScript heap operations remain about
155 times slower than their handwritten reference. These results establish no universal ranking.
Evidence: `results/owned-iterations-linux.json`.

To measure current outputs against the standard references, run
`bun run exec-bench -- --langs= --kernels=sieve4k,isort256,bsearch1k,hash1k,heap256 --samples=9 --scale=16`
on a quiet host. For the interleaved revision comparison, save the `.55` and `.56` emissions,
use the drivers and per-row parameters recorded in the report, rotate subjects and check every
sample's accumulated checksum. Keep raw samples and artifact digests with the result.
