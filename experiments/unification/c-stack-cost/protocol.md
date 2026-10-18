# Fixed-object C stack cost protocol

This is a private comparison of the already verified C frontend binaries in
`results/source-frontend-c-stack-relink-artifacts.zip`, SHA256
`200d40ab0eab525278d2abe7e9e75fb0b51da705d34647591241ea7a274a9b50`.
The 359944-byte baseline reserves 16777216 bytes of linear C stack. The
359942-byte candidate reserves 131072 bytes. Both final binaries have the same
109-function proof and 127888-byte conservative bound. The prior exact-object
link record and eleven correctness groups remain the provenance and semantic
controls; this experiment changes no library, builder, release or default.

Run preparation and collection from one clean committed checkout:

```
bun run build
node test/fixtures/c-stack-cost/cost.mjs prepare .a0-tmp/c-stack-cost
node test/fixtures/c-stack-cost/cost.mjs collect .a0-tmp/c-stack-cost
```

Preparation verifies the archive and every member digest, reanalyzes both final
Wasm modules, copies the six frozen input files without rewriting them, checks
the two frontends' C output bytes and the independent frozen output hashes, and
records every SDK/worker output used by the existing source-cost worker. The
candidate descriptor is explicitly research-only and binds the prior relink
record and original build record. It does not claim production build-time
freshness-guard acceptance. Production guards remain unchanged.

The only execution arms are the original and smaller-stack C frontends, named
`flat-a0-control` and `flat-a0` by the existing shared worker. Every sample runs
that worker in a fresh Node process with the same SDK, C emitter, frozen input
bytes and immutable proof. No alternate parser or emitter runs in a timed arm.
The common SDK includes unused historical readers as the existing worker's
shared preload; this is not a shipping CLI measurement.

The sequence is fixed before collection: one warmup round followed by eleven
measured rounds, six applications and two arms per round, for 144 children.
The application order rotates by the round index plus one modulo six. Within
each application, arm order alternates by that rotation plus the frozen unit
ID modulo two. Only the explicitly labelled twelve warmup children are excluded
from summary medians. Every measured sample, failure and outlier is retained;
there is no trimming, adaptive stopping, replacement or selective retry.

The parent records fresh-child wall time and system-load triples immediately
before and after each child. The shared worker records preparation time/CPU,
frontend time/CPU, C-emission time, pipeline time/CPU, process CPU through report
construction, live and
peak RSS, JavaScript heap/external/array-buffer counters, retained Wasm linear
buffer capacity, component byte counts and hashes, output hash, and load around
the measured pipeline. CPU user/system values are microseconds; RSS values are
bytes. Process CPU includes imports, preparation and proof checks, and is
sampled while constructing the report; it excludes report encoding, stdout,
frontend close and process exit. Pipeline CPU
includes frontend instantiation, parsing/checking and C emission. Whole-child
wall includes startup, imports, artifact preparation and final proof checks.

Collection starts only after coordination with the other local agents. Load
above ten before collection defers it. The gate uses the one-minute load value
(index zero); the complete parent load triples are retained. Load above ten
during a child, or any
failure/provenance/output mismatch, stops and invalidates the cohort while
retaining all attempted samples. There is no automatic rerun. Remote platform
CI does not share this machine. Record the host CPU, available parallelism,
Node version and load source alongside the samples.

Report all six applications separately, with each arm's medians and candidate
minus baseline absolute and percentage differences. Report frontend, pipeline
and whole-child wall time; user-plus-system CPU for frontend, pipeline and
process; peak and live RSS; logical Wasm memory; and component bytes. Also
retain minima, maxima and every paired observation so medians cannot conceal
variation. An independent replay recomputes every summary from raw child JSON,
checks the complete sequence, source/proof/input/component/output identities and
finite values, and binds the archive to the committed protocol and controller.

Smaller logical memory does not imply smaller physical RSS because pages can be
lazy. This protocol has no preset winning threshold, combined score or adoption
decision. Results describe these fixed artifacts on this host only; they do not
establish general compiler superiority, public cutover readiness, or passing
platform gates. No default or shipping artifact changes follow from collection.
