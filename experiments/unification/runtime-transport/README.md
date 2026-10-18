# Native frontend transport controls

These rejected experiments preserve the A0 grammar and arena wire protocol. Their source patches
are archived here so future work can reproduce the results. The production runtime and native
fixture retain the unchanged implementation.

- `reply-view.patch` borrows a successful LOAD payload until its reply drains. It passes the
  independent wire oracle and all 178 source-unit and original/migrated graph entries, but all six
  frontend latency and live RSS medians worsen. The default artifact grows from 356280 to 407914
  bytes. The 240 matched cells, maximum load 3.04, exact output controls and method are recorded in
  `results/unified-source-reply-view.json` and `results/unified-source-reply-view-samples.json`.
- `reply-factored.patch`, applied after `reply-view.patch`, shares the read failure path. Its
  artifact is still larger at 402760 bytes. This variant has no latency or memory measurement.
- `bulk-write.patch` adds generic ordered word transport and recognizes an exact array-writing
  fold body in the C backend. It passes the recorded C behavior and sanitizer controls, but its
  artifact grows to 384748 bytes. This variant has no native frontend corpus audit or latency and
  memory measurements.

The latter two build records, patch checksums, correctness scope and rejection reasons are in
`results/unified-source-transport-size-controls.json`. The original LOAD decision and graph/unit
audits are in `results/unified-source-reply-view-*.json`. None of these results clears the existing
native frontend cost loss against old Canonical.

To replay a patch, create a separate worktree from this evidence revision, install dependencies,
and apply it with `git apply`, then commit the applied change. Audits and measurements require a
clean committed tree. Apply the factored patch only after the original LOAD patch; replay
bulk writes in a separate worktree. Build an artifact with `tools/source-native-build.ts` and a
WASI sysroot and builtins archive as described in `docs/design/unified-syntax.md`. The checked-in
fixture intentionally remains bound to the unchanged production inputs; use the new artifact
explicitly for audits and measurements.

The independent wire oracle is `test/fixtures/arena/reply-view-test.c`, exercised at O0 and O2 with
address and undefined-behavior sanitizers by `test/arena-runtime.test.ts`. It also passes the
unchanged runtime. The bulk patch includes its additional transport and fold tests.

Use `tools/source-unit-audit.ts --artifact=DIR` and
`tools/source-audit.ts --native-artifact=DIR --native-graph` before measuring a frontend variant.
For matched cost trials, `tools/source-cost-bench.ts` accepts `--baseline=DIR --artifact=DIR
--control-artifact=DIR --control-checkout=DIR --out=DIR`. It verifies both committed native input
closures and generated C, holds A0 source and build options equal, uses one historical C text
emitter for all arms, and checks every emitted output hash. Omitting `--control-checkout` retains
the stricter build-option-only control. `--prepare-only` validates provenance and frozen inputs
without taking timing samples. These trials exclude shipping CLI startup, graph I/O, target
execution and AI editing; those remain separate cutover requirements.
