# Detached multi-field recurrence evidence

This proof extends the dormant private IO-fold operation to a finite set of selected scalar
elements. It does not specialize the real `ap_read` call chain or select a compiler default.
The source is recoverable from `results/multi-field-recurrence-source.bundle`; its metadata names
the exact prerequisite and frozen ref. Importing that ref does not adopt the implementation.

The actual `arena_reply` subject retains status, count, payload words zero through three, and IO.
The original array length remains 128. The complete projected graph no longer constructs or
updates that payload array, while it retains every original header and bounded payload read.
Independent controls compare complete original pages with the selected values, callbacks and
drains on the interpreter, standalone JS/direct Wasm, and C/C++ at O0/O2 with sanitizers.
The focused suite passed 83 tests without skips. Logs and member hashes are retained in
`results/multi-field-recurrence-proof.zip`; verification is recorded separately. Test log durations
come from a busy host and are not performance measurements.

The structural result remains negative for the original public root plus detached probe:

| Artifact | Original only | Original plus projected probe | Original plus owned probe |
| --- | ---: | ---: | ---: |
| C bytes | 9,018 | 11,412 | 15,437 |
| JS bytes | 5,651 | 7,136 | 9,566 |
| Direct Wasm bytes | 547 | 840 | 1,124 |

The probe's reachable node count grows from 36 to 49. These are artifact facts from
`results/multi-field-recurrence-proof.json`, not a production package, a runtime improvement or
a physical-copy estimate. Earlier measured whole-package losses remain binding.

Two review counterexamples required corrections before freezing: shared synthetic return paths
previously crossed the node ceiling before validation, and packing every selected element into
every local consumer accumulated unnecessary temporary nodes. Shared path prefixes, local
consumer demands and explicit node-limit refusals now protect those cases. The temporary bound
includes original nodes, initializer captures and one local consumer's captures; no hard two-times
node ceiling is asserted.

The default 612-function, 23-module source and C artifact retain their frozen hashes. The actual
`ap_read` three-field state still refuses with `unsupported-state`. Known-call parameter/effect
summaries, private returned-field provenance and guarded zero-or-one fold closure remain open.
Strict profiles refuse; detached interpreter metering and resource frame identities differ.
Emission requires the corrected memory policy, `optimize:false`, and no trap instrumentation.

Lint, typecheck, prereview, the focused suite, public-tree check and the available hygiene checks
passed. The optional denylist check was skipped because no denylist was configured. Scope remains
`everything`: the complete repository gates, all targets, quiet combined costs and the whole
bootstrap size floor are still pending. This proof is not approved for production adoption.
