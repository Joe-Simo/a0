# Source unification: measured candidates and initial refactoring

The source unification is in progress. The public compiler still accepts Canonical and Dense; no candidate has completed the native frontend, migration, tooling and performance requirements needed to replace them. This record separates the implemented infrastructure from the research candidates.

The A0 arena parser now calls a grammar-independent builder for operand, node and function records. The shared builder retains full-width identities and source spans, the existing resource-failure behavior and affine IO. Its native ABI checks run at both optimization levels in `test/arena-program.test.ts`. The linker now composes parsed modules and validates their combined IR directly, avoiding the combined-text parse. It retains comments from resolved directives, physical source lines and diagnostic ownership; `test/link-ir.test.ts` covers strict graphs, imports, empty modules, Unicode separators, comments and diagnostic locations. Canonical and strict remain **semantic profiles**, independent of source notation.

## Independent Codex edit studies

Each study froze its task packet, controls, syntax guides, dependency closures, evaluator and selection rule before subject trials. Each arm/task used a fresh independent Codex context. A failure received at most one fresh independent repair. The separate packets contain frontend maintenance, Life and website UI/frame tasks. The author and runner knew the references; subjects were instructed to read only their assigned prompt. Filesystem isolation and independent transcript auditing were unavailable.

The first policy retained Dense parsing with explicit IDs and flat statements. It failed its cost selection rule. Data: `results/unification-codex-v1.json`.

| Arm | First attempt | Accepted after repair | Visible o200k tokens per accepted edit |
| --- | ---: | ---: | ---: |
| Canonical | 12/12 | 12/12 | 2166.83 |
| Dense | 12/12 | 12/12 | 2044.42 |
| Anchored candidate | 11/12 | 12/12 | 2288.17 |

The second candidate extends the line parser with short parameter operands, compact aggregates and text, shifts, abbreviated types and unambiguous u32 headers. It passed the bounded AI-cost rule, with lower measured visible payload cost than both controls. Data: `results/unification-codex-v2.json`.

| Arm | First attempt | Accepted after repair | Visible o200k tokens per accepted edit |
| --- | ---: | ---: | ---: |
| Canonical | 12/12 | 12/12 | 1840.42 |
| Dense | 11/12 | 12/12 | 1826.25 |
| Flat candidate | 12/12 | 12/12 | 1750.17 |

Both tokenizers, every first failure and repair, group totals and Wilson intervals are in the results. Accounting covers actual supplied prompts, replies and repair prompts. It excludes hidden reasoning, system/tool framing and billed usage, which the platform does not expose. The exact provider model identity is also unavailable. These small samples cannot establish universal accuracy or total computational cost. The historical Haiku/Sonnet Dense losses remain evidence; the new trials do not supersede them.

`node experiments/unification/replay.mjs` reproduces all recorded adjudications and independent base/reference/wrong controls without provider calls. The frozen historical runtimes are research fixtures, never imported by the compiler. Archived prompt paths are relocated; original measured prompt hashes/counts and separate published-file hashes are retained. Replies are unchanged. See `experiments/unification/README.md`.

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

## Conversion evidence and remaining work

The static token comparison uses the same frozen source units for each representation, preserves names/order/profiles/specs and never normalizes the program. `results/unification-token-baseline.json` records both tokenizers, exact AST checks and formatting fixed points. Module source units and whole applications are distinguished from kernels; expanded literal arrays account for much of the kernel savings.

The revised research migrator requires an explicit source version per file and validates the complete original graph, including typing, contracts, profile agreement, roots and cycles, before printing the flat candidate. It then verifies per-file IR, comments/imports, a formatting fixed point, linked IR and identical C output. Mixed legacy graphs rewrite imports deterministically when `.a0d` files acquire `.a0` extensions. Invalid original programs and absent version declarations are refused. Strict first-failure/fold identity and affine IO have separate controls. Data: `results/unification-graph-migration.json`.

This is not production migration proof. Canonicalized symlinks, all resource limits, complete literal/spec coverage, provenance, every backend and native frontend behavior still need verification. The candidate also needs performance work. Only after those checks can the official grammar/formatter change, repository programs migrate, and redundant source modes and Dense edit translation be removed from the CLI, MCP, editor, authoring tools and documentation. Internal semantic serialization may remain versioned without being another public source language.
