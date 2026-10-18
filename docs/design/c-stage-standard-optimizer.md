# Standard optimizer experiment for the internal C stage

The original raw-input C-stage proof remains frozen. This experiment prepares a
separate compiler implementation using the existing ordinary optimizer, followed
by direct checking of its IR through the same A0 checker and spec verifier. It
recomputes the entry closure after optimization and freezes that source once.
Contract-only callees remain part of the closure. Source metadata is restored
before checking because the ordinary optimizer returns metadata-free functions.

`tools/c-stage-optimizer-experiment.ts --original=FILE --out=DIR` only prepares
the new input. Its report says `prepared-not-yet-reproduced`. It does not replace
the seed, prune public C wrappers, change compiler defaults or rewrite emitted C.
The existing compiler compiles the frozen new input to stage2; stages3 and4 must
consume those identical bytes with the same generic C shim and emit identical C.
Native execution, status/error ordering, IO, strict traps, resource refusal and
atomic output require independent controls before a compiler substitution.

An explicit `--frontend=DIR` selects a freshly built research frontend artifact;
it must satisfy the existing strict fixture schema and current module/native
input, linked IR and C fingerprints. Its loaded build and Wasm hashes are
recorded without rereading the selected directory. An invalid artifact fails without using
the bundled fixture as a fallback. The helper tests accept that same explicit
artifact through `A0_C_STAGE_FRONTEND_ARTIFACT`; ordinary tests use the verified
bundled frontend.

The strict snapshot compares physical paths on both sides of the module
inventory check, retaining duplicates and cardinality. This accepts a symlink
to the same checkout and still refuses a missing or repeated module. The
existing cached `nativeSourceArtifact()` API remains unchanged.

After building the original and derived stages, run
`node test/fixtures/c-stage-optimizer/controls.mjs BASELINE CANDIDATE OUT` for
status and verbatim-C parity plus independent native behavior. Run
`node test/fixtures/c-stage-optimizer/faults.mjs CANDIDATE_MODULE OUT` for real
LOAD/ALLOC/FINISH/nonbyte transport corruption and atomic refusal. These controls
reuse the existing spec cases, BigInt arithmetic, immutable alias expectations
and independent cell-grid Life model. The original service tests import that
same extracted grid model without changing its implementation. The scalar stage
exposes status/error classes; these controls make no claim about full structured
diagnostic fields. The selected lighter spec suite lists excluded fresh-fuel
controls explicitly in its report.

The comparison uses the same original compiler source for the legacy A0 emitter,
arena A0 emitter and TypeScript C backend. The TypeScript backend's normal
optimization must be recorded explicitly. Old and new resulting native stages
use the same compiler, flags, shim and arena runtime. Correctness builds with
sanitizers are separate from production builds. Preparation and native-build
CPU, peak RSS, executable bytes and the entire prospective seed package are
accounted for, including the frozen source, scripts, runtime and retained fixture
and notices. Measurements require an explicitly coordinated quiet machine.

The recursive `seed/` size limit remains two MiB. No package move, omitted notice,
output minification or limit exception can make this experiment meet that limit.
Windows C-only reproduction and the other bootstrap targets remain separate
requirements before changing the default seed route.

The correctness proof and artifact-byte inventory are recorded in
`results/c-stage-standard-optimizer.json`. The derived C alone exceeds the seed
ceiling, so this experiment does not qualify as a default seed replacement.
Production build CPU/RSS, complete package accounting and quiet comparisons are
separate evidence and remain pending in that report.
