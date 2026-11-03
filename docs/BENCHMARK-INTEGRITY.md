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
