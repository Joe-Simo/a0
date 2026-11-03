# Execution benchmark measurement integrity

The execution benchmark requires one finite positive timing and a canonical unsigned
32-bit checksum from each measured process. Runtime banners are permitted for language
drivers that need them, but multiple measurement rows are rejected. Invalid or zero
measurements fail; they are not converted into a favorable score.

Each native and JavaScript sample must retain its checksum. A later correct sample
cannot overwrite an earlier mismatch. Startup measurements also require a successful
process exit. `A0_RUSTC` can select an existing Rust compiler explicitly; without it,
the prior default compiler path remains in use.

The reproduced negative/infinite/NaN/ambiguous output cases, corrected outcomes and
bounded real-driver smoke check are recorded in
[`results/benchmark-protocol.json`](../results/benchmark-protocol.json). The smoke run
checks compatibility, not speed. An audit of the recorded execution reports found no
invalid timing fields, so this change does not retract or replace historical scores.
That audit cannot establish historical per-sample checksums from summaries alone.

The separate [counted-source conformance check](SOURCE-TOKEN-CONFORMANCE.md) verifies
individual outputs from the exact sources used for token counts. Neither check is an
AI edit-cost study, universal equivalence proof or full-platform qualification.

Argument validation happens before tool discovery or report writes. Unknown or empty
kernel selections, unknown optional languages, missing option values, non-finite
numbers and non-integer sample counts fail with a nonzero exit. Samples must be
positive safe integers; scale must be finite and at least one. An explicit empty
`--langs=` remains valid because the core C/Rust/JavaScript comparisons still run.
Output filenames retain characters after the first `=`. Existing reports are not
overwritten on argument errors. See
[`results/benchmark-arguments.json`](../results/benchmark-arguments.json) for the
reproduced empty-report defect, executable failure controls and valid smoke check.

The standalone native benchmark also validates its iteration count before reading
source or starting a measurement. Zero, signed, fractional, partial and overflowing
counts cannot produce a successful timing row. Positive decimal counts (including
leading zeros) preserve the random-input sequence and checksum protocol. The
reproduction and native/sanitizer controls are recorded in
[`results/native-bench-count.json`](../results/native-bench-count.json). This does not
change published scores or establish a performance improvement.
