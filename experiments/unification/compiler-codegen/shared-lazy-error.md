# Shared checker line-read preparation

`results/source-cost-shared-lazy-error-preparation.json` records strict preparation for the
shared lazy-error A0 algorithm from `0f9b4d34` against the unchanged `1b1fc66` frontend closure.
Both owned checkouts use the reviewed common builder/host from `b9c35ca`, the same C emitter,
compiler version, runtime, build options and toolchain. No C projection change is included.

The baseline's complete consumed raw A0 closure matches `1b1fc66`. The candidate changes only
`arena_shared.a0`, `check_arena_shared.a0`, `verify_arena_shared.a0` and the legacy entry hook in
`check_arena.a0`; the last file is outside the measured frontend closure. The report records
the normalized source hashes, counts and every changed consumed module. The consumed structural
API signatures match exactly.

Preparation re-emits each exact C artifact through its own freshly built compiler and reproduces
its complete Wasm and build record through its own native builder. Every representative frozen
input produces the expected historical C output, and both source/artifact inventories stay
unchanged. Independent correctness/request evidence is `2dace596`; this preparation does not
replace those controls. It contains no timing samples or performance/promotion conclusion.
