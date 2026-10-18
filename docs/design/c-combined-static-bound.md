# Combined static C package bound

`results/c-combined-static-bound.json` combines the verified standard-optimized
input with the isolated existing-owned-core sharing emitter, explicit variant
consumer roots and an intentionally impossible type-name deletion bound.
It introduces no emitter, alias writer, pruning option or default change.

The exact optimized source remains 414,227 bytes, SHA-256
`6d536d369a0e437fbf286bc5db2fafe0671869c59f5f2606b0aac9abb0d3a29a`.
The frozen candidate compiler emits 1,948,897 bytes of C from that input, SHA-256
`e944c755a1c457bd0e82f396d73153eae826cace577fca1a2133e6bcccd2c17c`.
The existing sharing census proves exactly 263 public wrappers and 1,665
unchanged other definitions. Signatures, variant symbols, other call routes and
all outside-function text remain byte-identical to the verified optimized C.
The emitted candidate C was inspected without compiling or executing it.

| Static known-component bound | Standalone / known consumers | Default library |
| --- | ---: | ---: |
| Source, candidate C, required snapshot files | 2,781,186 | 2,781,186 |
| After free omission of unreachable variants | 2,738,194 | 2,781,186 |
| After also deleting every retained body type token | 2,571,321 | 2,611,956 |
| After also deleting every private header type token | 2,534,903 | 2,574,366 |
| Excess over unchanged 2,097,152-byte ceiling | 437,751 | 477,214 |

The first two contexts have 41 unreachable variants, totaling 42,992 bytes with
their own trailing whitespace. Tokens in those definitions are excluded from the
type-name count, preventing double counting. Every remaining aggregate type-name
token in a function body is then charged zero bytes, including tokens that a real
alias cannot profitably shorten. Private function headers receive the same
additional impossible reduction. Public signatures, canonical type declarations,
exported names and all outside-function text remain intact. Zero-length type
names produce invalid C: this is an optimistic arithmetic bound, not transformed
output or an alias implementation.

The unchanged optimized source does not implement the sharing/root/alias changes;
retaining it for free makes this bound still more optimistic. It is not a
self-reproducing combined package. The required host/runtime/script and retained
frontend fixture/notices use the earlier verified snapshots recorded in
`results/c-emission-static-inventory.json`. Other package metadata, real alias
declarations, compiler implementation costs and output-reference costs are all
omitted. Even this bound fails the ceiling, so these combined ideas do not yet
provide a sufficient size path. Compilation and execution costs remain unmeasured.

The feature/proof commits are recoverable from the existing-owned-sharing archive.
Its original proof runner builds the candidate compiler and regenerates its
stable S1 stage. Use that existing `runCStage` service to emit the unchanged
verified optimized source; no source parser or patch reconstruction is needed.
The optimized input is reproduced by the existing standard-optimizer preparation
tool from the archived original source and verified frontend artifact. Its source
and baseline C hashes must match `results/c-stage-standard-optimizer.json` before
continuing. The archive replay and optimizer preparation documentation describe
those separate prerequisites.

Run the original archived proof's `test/fixtures/c-owned-sharing/census.py` on
the two optimized C artifacts. Then run:

```sh
python3 tools/c-combined-static-bound.py BASELINE_SOPT_C CANDIDATE_SOPT_C SOPT_SOURCE \
  --sharing-census=OWN_CENSUS_JSON \
  --consumed-abi=experiments/unification/compiler-codegen/variant-reachability/consumed-abi-roots.json \
  > OWN_SCRATCH_REPORT_JSON
```

Write archival results through `tools/scrub-results.ts` `writeReport`. The tool
checks the established input hashes and census invariants, reuses the existing
reference-graph reader, and counts only existing byte ranges. Default library
compatibility retains every variant, including dynamic and address-taking
consumers. No generated C is rewritten and no performance improvement is claimed.
