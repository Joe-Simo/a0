# Unified syntax migration: implementation status

The objective is one source syntax and one authoritative frontend, with the existing semantic
program and target backends retained. This refactor is **in progress**. Canonical and Dense are
still supported; neither has been silently reinterpreted. The candidate frontend is internal and
is not exposed as another CLI mode or file extension.

## Implemented foundation

`src/linker.ts` now joins the programs returned by the source readers and calls the shared validator.
It no longer reparses their concatenated printed source. Combined source text remains available
to existing consumers. Removing import and profile directives preserves their line positions,
including directives with trailing comments. Whole-program resource limits, dependency ordering,
duplicate definitions, profiles, types, effects and executable contracts remain validated.

The self-hosted Dense reader's host now splits at function declarations even without intervening
blank lines. Calls across chunks retain their signature stubs, and refusal diagnostics retain
original UTF-8 byte offsets, including CRLF input. `tools/dense-migrate.ts` uses the production
`readOnce` interpreter adapter rather than a separate copy of its byte packing and reader loading.
The A0 reader can now infer scalar array results of one or two dimensions from its existing
type descriptors. The reference reader and standalone source tooling receive imported function
types as well as arities, so imported bool and array results infer consistently across readers.
The fixed tables remain unchanged; aggregate inline-body states, record result inference and
the other unsupported forms still need work. The bootstrap seed was regenerated and verified.

The standalone converter now handles a dependency closure:

```sh
a0 migrate examples/life.a0 new-source-directory
a0 migrate compiler/boot.a0 new-compiler-directory --root=.
a0 migrate legacy-dense/main.a0 new-dense-directory --dense
```

The default source boundary is the entry's directory. `--root` permits a wider boundary; the
existing linker checks imports against it, including symlink resolution. The destination must
not exist, even as an empty directory. The command copies A0 source dependencies only; it does
not copy assets, build configuration, editor settings or third-party dependencies.

The current conversion target is the existing Dense spelling and `.a0d` extension, using
`src/dense.ts` directly. This is a migration building block, **not** a declaration that Dense has
passed the gates to become the sole language. The converter preserves node names, node order,
explicit signatures, contracts, profiles, comments and function/program revisions. It rewrites
imports to the converted filenames. It does not normalize or optimize the program.
The existing `--dense` compatibility flag is needed only for legacy Dense trees stored with
`.a0` filenames; `.a0d` inputs are already recognized by the linker. Migration uses the linker's
original parsed source units and import arities, without maintaining its own source reader.

Every converted file must parse back to the same source program and comments and be a formatter
fixed point. The staged dependency closure must then link to the identical semantic program and
revision. Source contents are rechecked before publication to detect edits during conversion.
Invalid UTF-8 is refused, and the final source check compares bytes rather than decoded text.
`a0-migration.json` records relative source/destination paths, before/after SHA-256 hashes and
the program revision. Original files are never overwritten.

Output is built in a sibling staging directory and published by directory rename, with an empty
destination reserved against accidental overwrites. Ordinary failures clean up staging and the
empty reservation. A process interruption can leave an empty reservation or a sibling staging
directory; retain the originals, inspect the abandoned output, and retry into a fresh directory.
This is not a power-loss durability guarantee or a transactional snapshot against uncooperative
concurrent writers. Directory replacement behavior has been exercised on Linux and in the macOS
integration gate; Windows host execution still needs verification. An unsupported rename fails without modifying the
original sources. Do not delete old source trees based on an unverified migration.

## Candidate frontend and staged cutover

The integration candidate is the flat grammar from the corrected study and the existing A0
frontend experiment, not the older Surface v2 expression prototype. The latter remains in
`tools/surface-v2-frontend.ts` for research; it is not a public mode. The flat candidate retains
explicit node bindings, uses short positional parameter operands, compact array/record/text
literals, abbreviated scalar types and unambiguous inferred scalar signatures. See the corrected
study and retained native performance losses in
[the refactor record](../history/2026-10-16-unified-source-refactor.md).

`src/source.ts` supplies the candidate grammar and one default formatter. It uses the existing
line scanner and instruction parser in `src/core.ts`, with direct IR construction. Source bodies
and executable examples use the same aggregate grammar in `src/aggregate.ts`, recovered from the
frozen experiment. Historical input remains available for migration; no new CLI flag or source
extension exposes the candidate. The formatter preserves IDs, order, signatures, contracts,
profiles, imports and comments. Explicit signatures retain unused parameters. Inferred signatures
include references from executable contracts. Valid large boolean arrays remain representable.
The chosen separator, singleton and repetition rules are specified in
[the flat aggregate grammar](flat-aggregate-grammar.md), including incomplete-input refusals
and the boundary between aggregate items and top-level example arguments.

`src/source-link.ts` connects the candidate to the same dependency resolver, IR composition and
validator as the historical readers. Parser origins map validation errors to physical source
lines. `migrateSourceProject` in `src/migrate.ts` converts historical Canonical or `.a0d` dependency
closures into candidate `.a0` files using the existing guarded staging engine. Its explicit
`legacyDense` migration input argument also handles historical Dense trees stored as `.a0`;
it never guesses between ambiguous spellings. The public
`a0 migrate` command still targets historical Dense until cutover. Candidate migration checks
complete per-file metadata and formatter fixed points, then links and compares the staged program
and revision before publication.

The same staging engine now supports `migrateNativeSourceProject`, whose output is formatted,
parsed and checked by the A0 frontend. Historical readers supply only the explicitly selected
input. Its [migration record](native-source-migration.md) documents native capability refusals,
publication guards and frozen real-application comparisons. Public `a0 migrate` routing still
targets historical Dense; neither candidate converter is an additional source mode.

`test/source.test.ts` checks repository round trips and independent binding/callee, parameter,
contract and aggregate cases. `test/source-link.test.ts` checks linked origins, dependency handling
and migration from both historical spellings against every registered backend's emitted output.
These correctness checks do not establish an AI accuracy, compilation speed or memory advantage.
The native A0 frontend experiment is reusable, but its recorded performance/resource limitations
must be resolved and the compiler, editor and MCP entry points must cut over before the historical
readers and public modes can be removed. This is still an incomplete migration.

The native candidate now has a compiler entry at `compiler/source_frontend.a0`. Grammar-independent
storage, type checking, evaluation and specification verification live in shared compiler modules;
existing bootstrap modules import those same definitions. `tools/source-native-build.ts` builds
that entry through the public C backend and a generic arena transport. It does not load a source
implementation from the archived experiment. The portable `src/source-native.ts` host reads checked
IR directly, preserves callee/type identity, and decodes type rows iteratively. It does not call
the TypeScript source parser or validator. `tools/source-audit.ts --native-artifact=DIR` checks this
host and artifact against the source migration controls. The existing TypeScript compiler remains
the public default until the integration and performance gates pass.

The arena entrypoints now share `compiler/source_grammar.a0` and
`compiler/source_type_grammar.a0` for ordinary source and executable specifications.
`compiler/word_classify_shared.a0` also checks names supplied through structured compiler IR.
`compiler/source_verify_arena_shared.a0` supplies the ordered parse/check/spec driver to both
the source frontend and backend service. Moving that driver preserves the executable artifact
exactly (`results/unified-source-shared-driver.json`). The historical paged bootstrap reader
still needs migration; this consolidation does not complete the public frontend cutover.

`nativeSource.checkProgram` sends existing compiler IR to the same A0 checker without formatting
or reparsing source. Its locations are synthetic. The private diagnostic packet adapter and
remaining renderer coverage are documented in [native diagnostics](native-diagnostic-adapter.md).
Generic host streams for the arena C emitter are documented in
[arena C host IO](arena-c-host-io.md); these support the later bootstrap integration.

The committed native corpus, own-source and specification checks are recorded in
`results/unified-source-module-audit.json`, `results/unified-source-module-build.json` and
`results/unified-source-module-specs.json`. These record correctness, not a timing improvement.

The default native fixture omits linker debug metadata; `--symbols=keep` retains it for debugging.
The executable-section and ABI comparison is recorded in
`results/unified-native-release-sections.json`. This packaging change does not establish a frontend
latency improvement or a completed syntax cutover.

The current native graph audit and source-unit controls are recorded in
`results/unified-native-graph-source-audit.json` and `results/unified-native-graph-unit-audit.json`.
The own-source comparison and exact build provenance are in
`results/unified-native-graph-self-source.json` and `results/unified-native-graph-build.json`.
These are correctness records; measured frontend performance remains a separate cutover gate.

The same native grammar also exposes `nativeSource(module).parseUnit(source)`. This returns
source IR, imports, comments and specifications without checking external callees or executing
specifications; `parse(source)` performs the whole-program check. The distinction is a compiler
stage, not a source dialect. `tools/source-unit-audit.ts --artifact=DIR` compares both existing
and flat-formatted source units and verifies that invalid whole programs can parse before the
validation stage rejects them. The earlier source-unit and full-frontend audit records are
`results/unified-source-unit-audit.json`, `results/unified-source-unit-frontend-audit.json` and
`results/unified-source-unit-build.json`.

The candidate now composes parsed dependency IR through `checkUnits` and `src/source-native-link.ts`.
The same graph loader retains path, symlink, cycle, duplicate-definition, profile and resource
policy. A source reader supplies one check stage: the native reader calls the A0 checker once,
without full-source reparsing or TypeScript validation. Symbol/type identity comes from the shared
A0 interners. Source spans, spec directories and comments are rebased; physical lines and filtered
line-table indexes remain separate. Comment folding is shared with the reference linker.

`NativeSourceError` exposes authoritative numeric failure facts and physical file/line origins.
With the optional A0 diagnostic companion it also retains supported catalog wording, suggestions,
structured edits and spec faults. Coverage, refusals and remaining grammar differences are
documented in [native diagnostics](native-diagnostic-adapter.md) and
[spec diagnostics](native-spec-diagnostics.md). This API remains an internal candidate; measured
compatibility cases do not establish complete diagnostic parity or a public cutover.

The optional [A0 formatter and revision companion](arena-format.md) consumes authenticated current
native input or explicitly activated formatting IR. It preserves source metadata without granting
typed acceptance to unchecked input. [Retained project sessions](native-source-project.md) can
activate original files for formatting and recheck their dependency graph through the same checker.
Ordinary one-shot linking retains no project session. These APIs support the later tool migration;
the public edit, MCP and LSP routes have not switched.

The existing `EditSession` can now receive the native parser, checker, formatter, revisions and
repair origins as one service set. Node, function, program, numbered and specification edits use
the same session and mutation kernels; response publication rolls back session state if formatting
or an output guard refuses the response. The implementation and its cross-backend controls are in
[native edit sessions](../native-edit-sessions.md) and
`results/native-edit-session-controls.json`. This remains an internal integration path.

The source-service package contains the frontend and its A0 formatting and diagnostic companions.
Its runtime loader verifies a caller-pinned manifest and every component, without a checkout or
build toolchain. The standalone and browser-target controls in
`results/native-source-package.json` establish that packaging boundary; they do not establish a
browser deployment, lower total package cost or a faster frontend. The explicit
[native bootstrap bridge](bootstrap-source-authority.md) hands authentic checked IR to the existing
C backend and retains the measured stage-one source-size increase in
`results/native-bootstrap-source.json`.

Production routing still determines whether the historical readers can be retired:

| Consumer | Current default | Native integration still required before removal |
| --- | --- | --- |
| CLI and source migration command | Historical readers and migration target | Route loading, edits and conversion through the verified package |
| MCP | Historical service set | Adopt the complete native service set after the combined gate |
| LSP | Historical frontend | Adopt its supplied native frontend and preserve document diagnostics |
| C bootstrap | Checked-in bootstrap seed | Adopt the checked-IR bridge and verify release self-hosting |
| Website build and Wasm bootstrap | Historical bootstrap setup | Migrate build-time loading and backend setup; the website has no live source parser |

The native paths must pass capability, migration, target and total-cost checks before becoming
defaults. The recorded frontend latency and memory losses remain blockers. Internal stage APIs,
MCP tool layouts and compilation targets do not create additional source syntaxes.

The source-bound executable fixture under `seed/source-frontend/` lets integration tests run with
ordinary Node, without a local WASI build toolchain. Its freshness check covers the full A0 closure,
generated C, native transport and builder inputs. Tests execute that artifact, including actual
compiler graphs, specifications, ownership/lifetime boundaries and independent backend controls.
The artifact's build provenance and third-party notices are retained alongside it. The existing
C bootstrap remains independent. Regeneration instructions are in its README.

The artifact builder defaults to the WebAssembly MVP instruction set. The explicit research build
option `--wasm-features=bulk-memory` enables standard bulk-memory code generation on compatible
compiler hosts. This is a backend feature setting, not a source dialect. The matched six-workload
comparison did not establish a consistent time/memory improvement, so it is not the default
(`results/unified-source-bulk-memory.json`). The build report records the Clang flags and required
features. Application target semantics are unchanged.

Build the internal candidate with an installed Clang/WASI toolchain (no downloads are performed):

```sh
bun run build
node dist/tools/source-native-build.js --out=.a0-tmp/source-frontend \
  --sysroot=/path/to/wasi/usr --builtins=/path/to/libclang_rt.builtins-wasm32.a
```

## Measurements

`tools/frontend-baseline.ts` compares built checkouts on identical input snapshots:

```sh
bun run build
node dist/tools/frontend-baseline.js --baseline=/path/to/built/baseline-checkout
```

`--include-candidate-source` adds an internal candidate-frontend cell on the candidate checkout
and candidate token counts. The baseline has no such frontend; it is compared on the two
historical spellings only. Every cell must match the same semantic program and emitted artifacts.
The report retains the explicit incomplete-cutover status. It is not evidence of model accuracy.

It uses Life, the linked self-hosted compiler and the website application. It records Canonical
and Dense token counts with both repository tokenizers, warm frontend samples and observed load,
frontend-worker peak RSS, and hashes/sizes of optimized JS, C and direct Wasm output. A disagreement
in semantic programs, inputs or generated output fails the comparison. Timing cells run in
separate processes sequentially and are exploratory; they do not establish a speedup. Peak RSS
includes input snapshots and frontend warmups and must not be described as parser-only memory.
RSS is sampled before importing the measured checkout's backends or emitting artifacts. Each
worker loads only the measured checkout's frontend; tokenization and source conversion happen
in the parent process. The report is `results/frontend-baseline.json`.
New runs require clean committed baseline and candidate checkouts, record both complete Git
tree IDs, and force a fresh TypeScript build in a separate process before each worker imports
the implementation. Build time and compiler memory are excluded from the frontend samples.
The earlier checked-in frontend report predates these provenance checks: its candidate was
uncommitted and only the linker diff was recorded. Treat it as a historical exploratory
snapshot, not a fully reproducible candidate-tree measurement.
Its input hash identifies the shared Canonical fixture even in Dense cells. New runs hash the
actual bytes of each surface and compare those hashes between implementations on that surface;
semantic program and output artifact hashes are compared across both surfaces.
Both source inputs are printer-normalized without comments so comment retention does not bias
the comparison between source surfaces.
It also reruns the existing Dense chunk planner across the accepted-source tree and records
capacity refusals. Passing this static capacity check is not a self-hosted reader execution pass.

The behavior-table run is recorded separately in `results/unified-foundation-behavior.json`.
Environment-blocked targets remain explicitly blocked; they are not counted as passing.
The historical reader behavior report's .NET detail is labeled as the first profile group;
its aggregate case count is unchanged. This is a metadata correction, not a new measurement.
`results/unified-source-migration.json` records the source-tree conversion audit: each accepted
entry is linked by the rebuilt baseline frontend, converted into an isolated directory, then
linked again and compared by semantic-program hash. These are TypeScript reader checks, not
proof that the self-hosted Dense reader accepts the migrated source.
Its `legacyDense` section repeats the audit on complete Dense `.a0` trees generated by the
existing `denseForms` helper and linked with the baseline's `dense: true` path.

`results/unified-selfhost-reader-baseline.json` and `results/unified-selfhost-reader.json` execute
the existing reader migration audit before and after the reader compatibility increment. Both
read back 79 of 86 source programs exactly; seven are refused by the capacity precheck. The new
inferred-array tests exercise source forms that the default printer keeps explicit, so these
corpus totals do not claim increased coverage. The candidate report records the reader source
hash. Sources are checked in memory; the baseline report explicitly corrects the older tool's
on-disk wording. Competitor token results in these reports remain historical controls.

Repository gate outcomes and fresh per-step reports are in
`results/unified-foundation-gate/summary.json` and its directory. That foundation run encountered
the Apple-silicon bootstrap and AArch64 self-hosted macOS requirements, unavailable Metal tools,
and an absent .NET SDK. Its hardware command reported blocked simulation/synthesis rather than
a hardware execution pass. The C bootstrap reached its
fixed point. Original historical reports remain available under their existing filenames.
The later reader increment has separate evidence under `results/unified-reader-gate/` and
`results/unified-reader-behavior.json`: local Java and .NET toolchains now execute their cases,
and Icarus Verilog and Yosys execute RTL simulation and generic synthesis. These later runs
supersede the corresponding tool-availability blockers, while the foundation reports preserve
their original outcomes. Generic synthesis is not FPGA/ASIC implementation or silicon testing.
The overall gate still has Apple-specific blockers. The reader increment's full unit run had
752 passes, 15 skips and three outdated fixture expectations. After correcting the inferred
array/text refusal expectations and only the deliberately changed compiler source's digest row,
all three affected checks passed focused reruns. `results/unified-reader-gate/summary.json`
preserves the failed full-run outcome and the successful reruns; it does not claim a second
all-green full-suite invocation. No implementation changed after that full run.

The later integration published as `e67d33a` passed both [full CI](https://github.com/Joe-Simo/a0/actions/runs/39067658205)
and the [macOS full gate](https://github.com/Joe-Simo/a0/actions/runs/39067655493) on the identical
`7b34126` tree. Those results supersede the Apple-host availability blocker for that release.
They do not establish a completed single-syntax frontend or fresh AI acceptance results.

The later compiler foundation is published on the exact tree recorded in
`results/unified-core-68-platform-publication.json`, with a full macOS gate, Windows C bootstrap
verification and checked production deployment. Platform verification is available through CI;
a local Mac is not required to continue this refactor.

The next authoring integration has actual compiled C/direct-Wasm/generated-JS controls, recorded
in `results/native-authoring-combined-initial.json`. Full signature fragments, per-file formatting,
native migration and the injected LSP path have been exercised. That initial attempt also retains
the failed whole-function editing controls: source-less callee diagnostics return a renderer
transport refusal instead of the required catalog error. The shared A0 renderer fix passes its
frozen follow-up controls in `results/native-ir-reference-diagnostics.json`. The fresh combined
rerun passes all targeted groups in `results/native-authoring-combined.json`; its archive retains
the executable bytes, provenance, logs and initial failed renderer. This includes the shared
CLI/encrypted-storage graph-loading seams. Full platform verification for that increment is still
required. Public CLI/MCP defaults continue using the historical readers and editing paths.

The source-bound package loader prepares the existing frontend, formatter and diagnostic assets
for loading outside a compiler checkout. The assembler reuses strict source/compiler guards and
the shared formatter provenance helper. Standalone and isolated VM controls are recorded in
`results/native-source-package.json`. Public defaults and release integration remain pending;
the VM check does not establish real-browser behavior or performance.

The opt-in Wasm/site build bridge now accepts native checked IR through the shared
bootstrap closure, then runs the existing A0 table optimizer and emitter. Native setup,
independent arithmetic/Life checks, and page/docs/cache/prerender parity pass in
`results/native-wasm-bootstrap.json`. The actual compiler emitted as Wasm fails its
child-module check: its linker writes an invalid code-section length. The report retains
the failing bytes and an independent trace showing a wrong loop bound; the faulty
emission pass and old-bootstrap comparison are not yet established by this snapshot.
Historical source mode 1 remains in the artifact, strict-profile table emission remains
unsupported, and public defaults are unchanged. This is not a completed Wasm selfhost or
source cutover, and no performance improvement is claimed.

The formal generated-JS frontend cohort is retained in
`results/source-frontend-js-cost-quiet.json`. Its measured frontend, pipeline, child-wall and
process-memory losses keep that backend experimental. Correctness across compilation targets
does not establish a compilation-cost improvement.

## Fresh controls before selecting the standard syntax

`tools/app-edit-bench.ts --surface=canonical|dense` now uses the same sealed application task set,
validators and hidden tests for both existing source views. Dense harness references are derived
through the production edit engine and formatter; no reference answer is submitted as a model
reply. Canonical remains the default. Prompt dumps carry source-tree, starter, guide, task-set and
prompt hashes. Measurements require a clean committed tree and direct Bun source execution to
avoid recording source hashes alongside stale compiled tooling. The [registered protocol](../history/2026-10-17-unified-controls-preregistration.md)
defines the paired pilot, repair budget, usage accounting and limits on any conclusion.

`bun tools/dense-loader.ts --source-spelling-only` audits accepted source files as written through
both existing parsers, including source comments and imported arities. This is a grammar audit,
not a runtime benchmark or a new reader. An independent strict-profile regression test demonstrates
that a binding whose name is also a callee can be accepted by both grammars with different runtime
behavior. A source conversion must therefore be explicit and verified; content-based parser
guessing cannot safely merge the source entry points.

Existing evidence must remain distinguishable from fresh measurements:

- `results/dense-tokens.json` and `results/dense-migration-tokens.json`: token experiments and
  self-hosted reader migration coverage. The latter records refused sources; a TypeScript
  conversion passing does not imply the self-hosted Dense reader accepts it.
- `results/surface-v2.json`, `results/surface-v2-failures.json` and
  [the Surface v2 study](surface-v2.md): research converter, token accounting and historical
  failure analysis. Its prediction of AI edit cost is not a fresh acceptance measurement.
- `results/set-h.json`, `results/dense-default.json`, `results/dense-lenient.json` and the
  sealed AI-edit experiments: historical acceptance and repair costs, with their original
  protocols and primers. They are not results for a newly unified frontend.

## Remaining acceptance gates

1. Select the syntax using whole-task token accounting, fresh independent edit tasks, success
   rates, repair costs and tokens per accepted edit. Keep old Canonical and Dense control cells.
   Neither character counts nor renamed historical cells prove a new syntax improves AI cost.
2. Resolve self-hosted reader capacity and coverage gaps before replacing the bootstrap parser.
   A source-to-source shim in front of the old parser is not the final frontend architecture.
3. Migrate compiler sources, bootstrap seed, examples, site sources and independent fixtures;
   establish self-hosted fixed points and behavior parity on the supported targets.
4. Make CLI, MCP, LSP, structured edits, diagnostics, formatter, editor grammars, skills and
   documentation consume the same syntax. Preserve revision and edit compatibility explicitly.
5. Only after equivalence and performance gates pass, retire alternate readers, source flags,
   modes and extensions. Keep legacy conversion isolated from the standard compiler frontend.

Fresh model acceptance, tokens per accepted edit, target runtime measurements for a unified
syntax and a single self-hosted authoritative parser are **not implemented or established** by
this foundation. It must not be advertised as completed language unification.
