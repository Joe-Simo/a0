# Source unification: measured candidates and initial refactoring

The source unification is in progress. The public compiler still accepts Canonical and Dense; no candidate has completed the native frontend, migration, tooling and performance requirements needed to replace them. This record separates the implemented infrastructure from the research candidates.

The A0 arena parser now calls a grammar-independent builder for operand, node and function records. The shared builder retains full-width identities and source spans, the existing resource-failure behavior and affine IO. Its native ABI checks run at both optimization levels in `test/arena-program.test.ts`. The linker now composes parsed modules and validates their combined IR directly, avoiding the combined-text parse. Migration readers can return parsed IR directly, while existing native readers returning text retain their API. The shared validator still checks returned IR; an inferred legacy bool aggregate beyond the old signature parser cap is preserved without reparsing. It retains comments from resolved directives, physical source lines and diagnostic ownership; `test/link-ir.test.ts` covers strict graphs, imports, empty modules, Unicode separators, comments and diagnostic locations. Canonical and strict remain **semantic profiles**, independent of source notation.

## Independent Codex edit studies

**Guide erratum.** The frozen Dense primers incorrectly say that unnamed statement results receive consecutive numeric IDs. The implementation generates alphabetic IDs while skipping reserved and explicit names (`src/dense.ts`, `defaultNames`). The primers also omit the `$ID` escape required when a value name matches an operation or function. These are material differences in the guidance supplied to the arms. The original outcomes and token accounting below remain unchanged, but comparative AI-cost conclusions from these studies are withdrawn. In particular, the original second-study Dense failure involves a function/value name collision. A matched replication uses the same frozen tasks, views and evaluator, corrected Dense guidance, and fresh independent subjects in every arm. Reusing the task packet makes this a replication, not new held-out tasks. See `results/unification-codex-guide-erratum.json`.

Each study froze its task packet, controls, syntax guides, dependency closures, evaluator and selection rule before subject trials. Each arm/task used a fresh independent Codex context. A failure received at most one fresh independent repair. The separate packets contain frontend maintenance, Life and website UI/frame tasks. The author and runner knew the references; subjects were instructed to read only their assigned prompt. Filesystem isolation and independent transcript auditing were unavailable.

The first policy retained Dense parsing with explicit IDs and flat statements. Its recorded arithmetic failed the cost selection rule; the guide erratum prevents a fair comparative conclusion. Data: `results/unification-codex-v1.json`.

| Arm | First attempt | Accepted after repair | Visible o200k tokens per accepted edit |
| --- | ---: | ---: | ---: |
| Canonical | 12/12 | 12/12 | 2166.83 |
| Dense | 12/12 | 12/12 | 2044.42 |
| Anchored candidate | 11/12 | 12/12 | 2288.17 |

The second candidate extends the line parser with short parameter operands, compact aggregates and text, shifts, abbreviated types and unambiguous u32 headers. Its recorded arithmetic passed the bounded AI-cost rule, but the guide erratum prevents treating that as a fair syntax comparison. Data: `results/unification-codex-v2.json`.

| Arm | First attempt | Accepted after repair | Visible o200k tokens per accepted edit |
| --- | ---: | ---: | ---: |
| Canonical | 12/12 | 12/12 | 1840.42 |
| Dense | 11/12 | 12/12 | 1826.25 |
| Flat candidate | 12/12 | 12/12 | 1750.17 |

Both tokenizers, every first failure and repair, group totals and Wilson intervals are in the results. Accounting covers actual supplied prompts, replies and repair prompts. It excludes hidden reasoning, system/tool framing and billed usage, which the platform does not expose. The exact provider model identity is also unavailable. These small samples cannot establish universal accuracy or total computational cost. The historical Haiku/Sonnet Dense losses remain evidence; the new trials do not supersede them.

`node experiments/unification/replay.mjs` reproduces all recorded adjudications and independent base/reference/wrong controls without provider calls. The frozen historical runtimes are research fixtures, never imported by the compiler. Archived prompt paths are relocated; original measured prompt hashes/counts and separate published-file hashes are retained. Replies are unchanged. See `experiments/unification/README.md`.

## Corrected-guidance matched replication

The replication retained the same frozen second-study tasks, views, references, evaluator and selection rule. Only the Dense guide changed; every arm used fresh independent subjects. The preregistration and grading-file hashes were frozen before subjects began. This is a replication on reused tasks, not a new held-out set. Data, first failures, the sole repair, both tokenizers and Wilson intervals: `results/unification-codex-v2-replication.json`.

| Arm | First attempt | Accepted after repair | Visible o200k tokens per accepted edit |
| --- | ---: | ---: | ---: |
| Canonical | 12/12 | 12/12 | 1855.00 |
| Dense | 11/12 | 12/12 | 1884.08 |
| Flat candidate | 12/12 | 12/12 | 1763.92 |

The flat candidate passes the frozen bounded AI-cost criterion in the corrected replication (`results/unification-codex-v2-replication.json`). Dense again first failed on the function/value collision, then passed its single fresh repair. The original flawed studies remain archived and their comparative conclusions remain withdrawn. Visible payload accounting still excludes hidden reasoning, provider framing and billing. These results do not resolve compiler/memory losses, incomplete native syntax support or migration/tooling readiness.

## Compiler and memory measurements

Measurements use rotating arm order, fresh processes, a warmup followed by measured rounds, recorded load and a common checker/optimizer/backend. Inputs include Life, frame helpers, the site page and docs, the compiler bootstrap and the arena parser. The standalone parser comparison also includes a seeded generated program. Inputs, output hashes and raw samples are retained in these records:

- `results/unification-compiler-baseline.json`: historical Canonical, Dense and the rejected anchored policy.
- `results/unification-flat-matched.json`: the initial flat candidate with the same public checker and backend for all arms.
- `results/unification-flat-parameter-use.json`: the same grammar after accumulating inferred parameter use while parsing, eliminating a second operand scan.
- `results/unification-link-initial.json`: complete dependency loading, validation and optimized C emission before restricting directive removal to the module header.
- `results/unification-link-header-scan.json`: the committed linker after that optimization, including unchanged-function reuse.

The initial flat run with separate checker/cache instances was provisional and is excluded from conclusions. The corrected measurements above retain parser and pipeline losses. They measure no model inference or native C compilation; process peak RSS includes preloaded research modules and accounting overhead.

The latest linked-build medians remain mixed. Pipeline milliseconds include linking, validation and optimized C emission. Data: `results/unification-link-header-scan.json`.

| Whole program | Old Canonical | New linker, Canonical | New linker, flat candidate |
| --- | ---: | ---: | ---: |
| Life | 18.33 | 18.04 | 20.10 |
| Frame helpers | 26.22 | 26.12 | 25.67 |
| Site page | 128.60 | 108.63 | 109.05 |
| Site docs | 65.91 | 62.03 | 60.42 |
| Compiler bootstrap | 1422.91 | 1447.52 | 1377.06 |
| Arena parser | 229.58 | 206.00 | 208.53 |

In particular, the candidate's Life pipeline and the new linker's Canonical bootstrap pipeline have slower medians (`results/unification-link-header-scan.json`). Memory measurements and earlier runs remain in the records. No all-workload speed improvement or absence of regressions is established. Exact IR and identical emitted artifacts are correctness evidence; they are not a newly measured runtime speedup.

The C emitter now indexes operand uses and memoizes projection facts within each function emission. Exact ownership observations and emitted C remain unchanged for the recorded corpus, including strict-profile controls. `results/unification-c-analysis.json` contains both the initial persistent-cache experiment and the final function-scoped version, their raw samples and source/input hashes, the local behavior report, and a separate controlled retained-memory probe. The scoped version releases those analysis maps even on exceptional exits. Bootstrap and arena-parser pipelines improve in these runs, but the final Canonical frame-helper median is slower and some memory cells increase. These data do not establish absence of regressions, target runtime improvements, or readiness to cut over the source grammar.

The first local feature gate is retained as a failure in `results/unification-initial-gate.json`. Native linking still used the obsolete directive-removal regexes after the TypeScript linker began preserving header comments and physical lines. The native fix reads immutable per-file parser snapshots, strips only parsed header directives, and keeps original-byte origins. Focused native link/spec verification, additional CRLF/hash-path/quoted-separator/no-final-LF cases, bootstrap reproduction and the source-metadata checks pass. `results/unification-native-link-header.json` records the scope. The Dense chunk checks also completed the enlarged corpus before failing their stale source-count expectations; updating that inventory does not remove any conversion assertion. A passing updated whole-suite/full promotion gate remains outstanding.

## Conversion evidence and remaining work

The static token comparison uses the same frozen source units for each representation, preserves names/order/profiles/specs and never normalizes the program. `results/unification-token-baseline.json` records both tokenizers, exact AST checks and formatting fixed points. Module source units and whole applications are distinguished from kernels; expanded literal arrays account for much of the kernel savings.

The revised research migrator requires an explicit source version per file and validates the complete original graph, including typing, contracts, profile agreement, roots and cycles, before printing the flat candidate. It then verifies per-file IR, comments/imports, a formatting fixed point, linked IR and identical C output. Mixed legacy graphs rewrite imports deterministically when `.a0d` files acquire `.a0` extensions. Invalid original programs and absent version declarations are refused. Strict first-failure/fold identity and affine IO have separate controls. Data: `results/unification-graph-migration.json`.

This is not production migration proof. Canonicalized symlinks, all resource limits, complete literal/spec coverage, provenance, every backend and native frontend behavior still need verification. The candidate also needs performance work. Only after those checks can the official grammar/formatter change, repository programs migrate, and redundant source modes and Dense edit translation be removed from the CLI, MCP, editor, authoring tools and documentation. Internal semantic serialization may remain versioned without being another public source language.

## Integrated A0 frontend prototype

The candidate source and executable-Spec aggregate grammar now share A0 scanning and
construction helpers. A frozen integrated A0 parser/checker/resumable verifier can be
rebuilt into a portable artifact through the existing C backend. The host reconstructs
typed IR and Specs without reparsing source or running another checker. A generic,
opt-in C host-I/O interface supplies storage transport; the default C ABI and emitted
output remain unchanged. The interface has native reference-interpreter checks for
unsigned words, stream length, token identity, UTF-8 text and strict input traps.

Whole-program IR/fact/output comparisons and independent Spec success/failure controls
pass for the prototype. These component proofs do not complete source migration,
resource limits, formatting, graph loading or tool integration. The public frontend
remains unchanged. The current cost matrices retain substantial compilation-time and
memory losses. A private aggregate-storage threshold experiment also retains its
tradeoffs and is not promoted. No official cutover is justified by these results.

Rebuild instructions, frozen source/reference controls and the matched benchmark are
in `experiments/unification/frontend-a0/README.md`. Raw samples, source/artifact hashes,
dependency provenance, exploratory phase profiles, scope corrections and the decision
are recorded in `results/unification-portable-frontend.json`.

## Linked Java oracle correction

The subsequent feature light gate passed lint, typecheck, build and site generation,
but failed three Java tests that share stale linked-graph expectations. Import comments
now survive physical-line stripping, and a Unicode-spaced strict directive respects the
canonical profile override. Independent public linking, Spec verification and evaluation
establish success for both unchanged graphs. The isolated native/Java tests, JVM execution
and generated-output mutation controls pass with the corrected oracle. Production code,
graph inputs, the driver and test assertions are unchanged. Historical rows and the failed
gate counts remain in `results/unification-java-oracle-correction.json`; this correction
does not establish a passing whole-suite gate.
