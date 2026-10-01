# A0 history, 2026-09-30: AI-edit experiments: task sets, primers and languages

claim-check: archive. This is a dated record of work on the date above, kept for the evidence trail. Figures are
as measured at the time; some were taken on a loaded benchmark host and are not publishable timings. The current
state and the current numbers are in [STATUS.md](../../STATUS.md) and in results/.

## Session 2026-09-30 (tiny primer)

- `MODEL_GUIDE.tiny.txt`: 234 o200k tokens (min 388, short 304). Fresh subjects, one shot, sets A and B (TS/Rust cells reused). Results `results/ai-edit-experiment.{,b.}{haiku,sonnet}-tiny.json`.
  - Sonnet: 13/13 and 12/12 on both A0 cells. Haiku: A 12/13 both cells (cube = sq(sq x), a repeated model error), B structured 10/12 (fold callee arity wrong; p3 on a three-parameter function). All four classified as model errors: the primer states the fold signature and parameter rule; no general fix applies.
  - Cost, Sonnet structured, cache-adjusted tokens per task (one task / session of ten / no cache): min 147 / 127 / 545, short 139 / 123 / 461, tiny 133 / 119 / 391; TypeScript 109 / 103 / 224. The primer is the entire gap: context (77 vs 69) and output (28 vs 28) are level. On single-function tasks A0 cannot beat TypeScript while any primer travels; the default primer stays MODEL_GUIDE.min.txt (Haiku holds 100% only there) and all three are published.
  - Next measurement (set C): the same tasks embedded in realistic-size programs, where the conventional cell must read the whole file and the scoped A0 view stays small (7.3x on the 17-function Life program).
## Session 2026-09-30 (task set C, project scale)

- `tools/ai-edit-tasks-c.ts`: set C = the twelve set-B tasks (same instructions, tests, reference edits; ids `c-*`) with every target embedded in one deterministic 40-function program, identical for all twelve tasks and across the three representations (same names, same order, callees before callers): the set-A and set-B task functions, six from `examples/life.a0` (nb, count, bitstep, popcount, rowpop, population), `is_even` from `examples/kernels.a0`, and hand translations to TypeScript and Rust of every A0 fold helper the set-B sources had inlined (addi, addel, minmax, mixel, dstep, pstep, inc, below). Filler precedence B > A > hand translations; the file is assembled from per-function texts (`splitFunctions`, `assemble`), so a reference edit replaces its functions in place and new functions (norm2, pctof, hamming) append. `A0_EXPERIMENT_TASKSET=c`; `taskSetSha256` covers the assembled sources: `8c125465573d3387dbd88f6c8e7e4dc3d54c3a126823255c7ff04a77c7ef0a80`.
- Protocols for C (recorded in the report's `method` field and in the module comment): `conventional` sends the whole file in every representation; `structured` sends for A0 the dependency-scoped view of the target (`open(name, {scope: 'deps'})`: body plus one signature line per callee) and the program handle (one signature line per function), and for TypeScript and Rust the whole numbered file with the line-edit protocol. Locating the function in the file is part of the job for TS/Rust, as it is for an agent editing a real file; the asymmetry is what set C measures.
- Harness: self-check ok for all 12 tasks x 3 representations (originals compile and fail, references pass) in scripted mode with an empty replies file; scripted replies, repair loop, dump, and token buckets exercised on two tasks across all six cells. The report now carries `contextTokensByCell` (mean view and mean first-attempt tool context per cell) and prints it.
- Context cost per cell before any model runs (o200k, mean over 12 tasks; toolContext = task text + view): a0/conventional 1411, a0/structured 590, ts/conventional 1786, ts/structured 1966, rust/conventional 1888, rust/structured 2075. The scoped A0 view is 2.4x smaller than the A0 file and 3.0-3.5x smaller than the TS/Rust files; of the 590, about 480 is the 40-line program handle, the scoped function itself is 50-120 tokens. Against that, the A0 language primer (min, 405 tokens per call) is now smaller than the context saving (about 1200 tokens versus TypeScript), so at this program size A0 structured should cost less per task than any other cell even with the primer travelling; the measurement is the next step.
- Not done: no model has been run on set C. Prompts: `A0_EXPERIMENT_TASKSET=c A0_EXPERIMENT_REPLIES=<empty {} file> A0_EXPERIMENT_DUMP=<path>.json node dist/tools/ai-edit-experiment.js` (the harness rewrites `results/ai-edit-experiment.json`; run from a scratch copy or restore it). The Rust file needs rustc; the TypeScript acceptance needs `node_modules/.bin/tsc` under the working directory (a fresh worktree needs `bun install`).

## Session 2026-09-30 (set C collected: project scale)

- Fresh subjects (Haiku and Sonnet), all six cells, one shot, min primer. Results `results/ai-edit-experiment.c.{haiku,sonnet}-min.json`.
- Sonnet, cache-adjusted tokens per task (one task): A0 structured 670 at 12/12 vs TypeScript 2007 at 12/12 vs Rust 2115 at 12/12: **A0 3.0x cheaper** (a win). Conventional: A0 2834 vs TS 3549 vs Rust 3754 (1.25x). Haiku: A0 structured 672 at 11/12 vs TS 2041 at 9/12 vs Rust 2135 at 11/12.
- Haiku's two A0 misses: `select (lt a b) ...` (nested expression, third sighting, all from Haiku on the bounds task; Sonnet never; the diagnostic names the fix) and a callee defined after its caller in the whole-file cell (a model error against the stated rule). Item B decision: refusal documented, not added; 3 occurrences in ~150 Haiku structured replies, 0 in Sonnet.
- Site: the Edits card and the Cost section now lead with set C and keep the single-function loss (0.68x/0.71x vs TypeScript) in the same chart.

## Session 2026-09-30 (repair round, Haiku)

- One repair round after the one-shot pass (rule 1), Haiku, min primer, all sets, fresh subject contexts seeing the original prompt, their first reply, and the rejection. Results `results/ai-edit-experiment.{,b.,c.}haiku-min-repair.json`.
- After one repair: set A all six cells 13/13; set B all six 12/12; set C A0 conventional 12/12, A0 structured 11/12, TypeScript structured 10/12, Rust structured 11/12, the rest 12/12. The one A0 miss is the bounds task: first a nested `select (lt ...)`, then the body of the callee written under the caller's handle (model error). Sonnet had no first-attempt failures to repair.

## Session 2026-09-30 (more baselines)

- `bun run exec-bench` now runs 45 hand-written baseline languages next to C, Rust, the direct arm64 backend, and JavaScript, from one data table (`tools/exec-bench-languages.ts`, `tools/exec-bench-languages-more.ts`: per-kernel source, driver template, toolchain finder, build and run commands). Every kernel in every language is checksum-verified against the A0 result for the same iteration count before it is timed (mismatch = `skipped-checksum-mismatch`, never a number); runs are interleaved across languages sample by sample; medians of 7; process-launch latency per language. `results/exec-benchmark.json` keeps its old keys and adds per-language rows (`family`, `toolchain`, `status`, timing, `startupMs`), `startupCompiledMs`, a top-level `languages` block, `skipped`, and `geomeans` (baseline ns / A0 emitted-C ns, geometric mean over the 10 kernels; 1.0 = parity). Options: `--langs`, `--kernels`, `--samples`, `--scale`, `--out`, `--help`.
- Run of 2026-09-30 05:34 UTC, 45/45 languages ran on 10/10 kernels, nothing skipped. Load average at start 11.6 (8 cores; the 10-minute quiet wait expired, so the run went ahead under load as instructed), 6.4 at the end. C-path A0 tied hand-written C and Rust on all 10 kernels; arm64 1.80x geomean (chain3 1.34x, arrfill 29.5x, loop64 8.3x losses unchanged).
- Geomean ratios vs native A0 (higher = A0 faster per call): Zig 1.00, C 1.00, Rust 1.00, Odin 1.00, C++ 1.01, D 1.01, Crystal 1.02, V 1.03, Nim 1.04, Objective-C 1.12, Fortran 1.12, Julia 1.14, Vala 1.18, Swift 1.34, Java 1.41, Kotlin 1.45, Scala 1.45, F# 1.47, TypeScript 1.52, Go 1.66, C# 1.71, Visual Basic 1.75, Pascal 1.77, Dart 1.97, Groovy 2.55, Clojure 2.61, Common Lisp 2.92, OCaml 3.07, Haskell 3.46, Racket 4.62, Gleam 5.24, Erlang 7.04, JavaScript 7.95 (emitted JS 7.69), Elixir 8.48, Forth 16.7, PHP 20.8, Lua 20.9, CHICKEN 29.0, Haxe (eval) 75.5, Ruby 78.1, COBOL 95.6, Perl 145, Python 174, Guile 278, Smalltalk 304, Tcl 475, Prolog 869, R 3524.
- Read the numbers with their tiers: the JVM/.NET rows are in-process warm JIT (20M or 5M iterations after a warm-up pass), interpreters run 100k (R and Smalltalk 10k) iterations; Lua, CHICKEN, Pascal, COBOL, and Smalltalk report CPU-time or millisecond clocks (`timer` field). R emulates u32 on doubles with 16-bit bitwise halves, PHP splits products into 16-bit halves (signed 64-bit ints overflow to float), Haxe eval uses 32-bit signed ints with a sign-flip unsigned compare; all verified by checksum.
- Startup (one process, one iteration, median ms; native A0 2.3): Odin 1.6, Nim 1.7, Swift 1.8, C++ 1.9, Zig 2.0, Lua 2.5, Go 2.7, OCaml 2.7, Crystal 3.1, D 3.4, Perl 5.3, Tcl 7.2, Dart 11.1, SBCL 16.3, Haskell 18.6, Python 20.7, C# 22.0, Node/TypeScript 23.0, Kotlin 31.3, Java 36.5, Ruby 48.1, PHP 49.7, Racket 62.8, Scala 75.2, R 113, Julia 131, Erlang 156, Elixir 238, Clojure 342, Groovy 734.
- Bugs found while verifying: GnuCOBOL 3.2 evaluates `B-XOR`/`B-SHIFT-R` wrongly for values above 2^31 when nested inside a `FUNCTION MOD` argument (kernels keep boolean and arithmetic steps in separate `COMPUTE`s); gforth 0.7.3 has no `umin`/`umax`; Homebrew gfortran needs the macOS SDK library path passed to `ld`; Zig 0.16 moved argv to `std.process.Init.Minimal`.

## Session 2026-09-30 (merged: 45 languages, checker, playground, arm64 re-measured)

- Merged this session: arm64 register allocation and inlining (a0c-0.1.7), 65536-element arrays with in-place C updates, both under COMPILER_VERSION a0c-0.1.8 with results regenerated; A0 lexer, parser, and type checker written in A0 (`compiler/`), each differentially verified against an independent TypeScript reference and run on every target by `bun run app`; the /play/ page (a third A0 program running the self-hosted front end in the browser); task set C; the tiny primer; the Haiku repair round; 45 language baselines in exec-bench (table-driven, every kernel checksum-verified, 0 skipped).
- exec-bench ledger: the 45-language run was taken under load (1-minute load 11.6 at start, recorded in the JSON); A0 via C still ties C and Rust on all ten kernels. The arm64 rows were re-measured afterwards with the new backend (load ~7): ties clang on 6 of 10 (within 10%), behind on loop64 1.36x, arrfill 1.30x, mix 1.12x, rotl 1.11x; geomean 1.10x (was 1.80x with the old backend, 30x and 8.4x on the two loop kernels). A quiet-machine rerun of the whole ledger is still owed.
- Site: 48-language chart (log scale) on the home page; native paragraph and limits computed from the ledger; README table from the ledger.
- Open: quiet-machine exec-bench; stage 4 of self-hosting (optimizer and AArch64 emitter in A0); bootstrap fixed point; x86-64 and other targets; release note when the ledger reads parity or better on every axis except the single-function primer cost.

## Session 2026-09-30 (set D: independent author, primer only)

- `tools/ai-edit-tasks-d.ts`: 13 tasks written by an agent that saw only MODEL_GUIDE.min.txt and the task-file shape, sealed in `tools/ai-edit-tasks-d.sha256` (a0bafeeb…3651); the harness self-check verified every original and reference in all three representations. Harness set `d`.
- Fresh subjects, one shot, min primer. Results `results/ai-edit-experiment.d.{haiku,sonnet}-min.json`.
  - Acceptance: A0 13/13 on both protocols for both models. TypeScript: Haiku 13/13 conventional, 12/13 structured; Sonnet 13/13 both. Rust: 13/13 conventional, 12/13 structured for both models.
  - Cost (cache-adjusted, one task): Sonnet A0 structured 154 vs TypeScript 118 vs Rust 136; single-function tasks, so the primer is the gap again (loss, published).
## Session 2026-09-30 (token scaling: 400 and 4000 functions)

- Task sets `c400` and `c1000` (`A0_EXPERIMENT_TASKSET`): the twelve set-C tasks in one deterministic program of 400 / 1000 functions, identical names, semantics and order in A0, TypeScript and Rust. Filler: `generateFiller` in `tools/ai-edit-tasks-c.ts`, six fixed templates (affine, xor-shift, cap, pair, sum of two earlier unary helpers, mix of one), constants from a fixed LCG, names with a four-digit index; interleaved in 40 runs before the 40 project functions (`scaledOrder`), callees before callers; the tests never call filler. Test: all 960 generated helpers agree between the A0 interpreter and the TypeScript text (8 inputs each) and form a valid program. Self-check ok for c400 and c1000 (all originals fail, all references pass, tsc and rustc). Set C is unchanged (`taskSetSha256` still `8c1254…`); c400 `ad0f14cd…`, c1000 `88aadc11…`.
- **4000 is not a legal A0 program**: `LIMITS.maxFunctions` is 1024 (also for linked programs, the documented static cap, and the size of the self-hosted checker's `fns` table). The cap was not raised (a language decision; site/ and compiler/ depend on it); c1000 is the largest scaled set. At 4000 the generated filler alone is 118,762 o200k tokens in TypeScript and 118,256 in Rust (124,702 in A0), so the TS/Rust whole-file cells would be about 120k (conventional) and 141k (numbered) tokens per task.
- `src/edit.ts`: `openProgram({ scope: 'deps', target })` — a program handle whose view is a comment line (`# N functions; shown: T, its callees, its callers`) and the signatures of the target, its transitive callees (calls, folds, loops), and its direct callers (`programNeighbourhood`, `scopedProgramView`); it still edits the whole program, `view()` follows edits, and a removed target falls back to the full listing. The full handle remains the default. Tested. Harness: `A0_EXPERIMENT_PROGRAM_VIEW=deps|all` (recorded as `programView` and in `method`); TS/Rust structured and conventional cells get the whole file (in `method`).
- Context tokens per cell (`contextTokensByCell`, mean toolContext o200k, task text + view; A0 structured shown with full / scoped handle):

| cell | 40 fns (c) | 400 fns | 1000 fns |
|---|---|---|---|
| A0 conventional | 1411 | 12749 | 31644 |
| A0 structured, full g0 | 590 | 4850 | 11950 |
| A0 structured, scoped g0 | 122 | 122 | 123 |
| TS conventional | 1786 | 12584 | 30579 |
| TS structured | 1966 | 14102 | 35697 |
| Rust conventional | 1888 | 12637 | 30551 |
| Rust structured | 2075 | 14169 | 35683 |

  TS structured / A0 structured: full handle 3.3x / 2.9x / 3.0x (the handle grows linearly with the program); scoped handle 16x / 116x / 290x (constant A0 context). Conventional A0 / TS: 0.79 / 1.01 / 1.03 (the generated A0 filler is slightly more token-dense than its TS translation).
- Collected on c400, structured cells only, fresh subjects, min primer, one shot (group files per representation x protocol, 12 tasks each; the TS and Rust group files print the whole numbered file once as a shared view, since it is identical for all 12 tasks and 12 copies would be 170k tokens). Results `results/ai-edit-experiment.c400.{haiku,sonnet}-min.json` (scoped handle, with TS and Rust) and `…c400.{haiku,sonnet}-min-fullhandle.json` (A0 full handle). Cost per task cache-adjusted as before (primer once at 1.25x over the 12 tasks, context and output 1x):

| subject | cell | accepted | cost/task |
|---|---|---|---|
| Sonnet | A0 structured, scoped g0 | 12/12 | 202 |
| Sonnet | A0 structured, full g0 | 12/12 | 4930 |
| Sonnet | TS structured | 12/12 | 14143 |
| Sonnet | Rust structured | 12/12 | 14210 |
| Haiku | A0 structured, scoped g0 | 10/12 (1 protocol, 1 wrong output) | 217 |
| Haiku | A0 structured, full g0 | 8/12 (1 protocol, 1 wrong output, 2 tasks skipped by the subject) | 5347 |
| Haiku | TS structured | 8/12 (4 compile) | 14202 |
| Haiku | Rust structured | 7/12 (5 compile) | 14294 |

  Decision by measurement: the scoped handle loses no acceptance against the full one (Sonnet 12/12 both; Haiku 10/12 vs 8/12) at 1/40 of the context, so it is the handle to use for large programs. At 400 functions A0 structured costs 70x less per task than TypeScript (Sonnet, 202 vs 14143) with the scoped handle, 2.9x with the full one.
- Not collected: the conventional cells at 400 (each reply is the whole 12.6k-token file; 12 per subject). Caveat: the scoped A0 view is protocol-supplied, while TS/Rust get no comparable per-function tool; that asymmetry is what this measures.

## Session 2026-09-30 (4000-function programs)

- **Function cap raised (a0c-0.1.14)**: `LIMITS.maxFunctions` 1024 -> 65536 in `src/core.ts`, enforced by the parser and by `validate` (so also for linked programs, `src/link.ts` validates the merged program). Every other bound is unchanged (1 MiB source, 4096 nodes and 64 params per function, 65536-element arrays, 2^21-bit aggregates, 1024-element vectors on hardware/GPU); the 1 MiB source bound is the binding one for tiny functions (about 45k one-line functions). Hardware and GPU needed no per-module function limit. COMPILER_VERSION a0c-0.1.13 -> a0c-0.1.14 (semantics-visible: programs of 1025..65536 functions were rejected before). DESIGN.md security bounds sentence updated. Test: a 4000-function call chain validates and emits JS; 65537 functions are rejected by `validate` with `too many functions`.
- **Not updated: `compiler/check.a0` still enforces 1024 functions** (its `fns` table is u32x1024) until the self-hosted checker is updated; the TypeScript front end and the self-hosted checker therefore disagree for 1025..65536 functions. The site docs generator (site/) is not touched; the new cap for the docs is 65,536 functions per program.
- Task set `c4000` (`A0_EXPERIMENT_TASKSET=c4000`, same `generateFiller`/`scaledOrder`, 3960 filler functions): 12 tasks, harness self-check ok (all originals fail, all references pass, tsc and rustc); `taskSetSha256` `fc835b07…`.
- Context tokens per cell at 4000 functions (mean toolContext o200k, task text + view, scoped A0 handle): A0 conventional 126,113; A0 structured (scoped g0) 123-125; TS conventional 120,548; TS structured 143,666-143,671; Rust conventional 120,144; Rust structured 143,276-143,307 (ranges: the two scored runs differ only in reply-dependent repairs). TS structured / A0 structured context 1168x, Rust 1165x (290x at 1000 functions, 116x at 400).
- Collected on c4000, structured cells only, fresh Haiku and Sonnet subagents, min primer, one shot, scoped A0 handle. One group file per representation, 12 tasks each; the TS and Rust group files print the whole numbered file once as a shared view (identical for all 12 tasks, as in the c400 collection), and since that view is about 143k tokens (420 KB for TS) it is split across two files (`group-{ts,rust}-structured.txt` with the tasks and the first half of the view, `…-part2.txt` with the rest, no line omitted); subjects read both in chunks. Results `results/ai-edit-experiment.c4000.{haiku,sonnet}-min.json`. Cost per task cache-adjusted as before (primer once at 1.25x over the 12 tasks, context and output 1x):

| subject | cell | accepted | cost/task |
|---|---|---|---|
| Sonnet | A0 structured, scoped g0 | 12/12 | 202 |
| Sonnet | TS structured | 12/12 | 143708 |
| Sonnet | Rust structured | 12/12 | 143317 |
| Haiku | A0 structured, scoped g0 | 11/12 (1 protocol: select with 5 operands) | 205 |
| Haiku | TS structured | 11/12 (1 wrong output, avgfloor signed) | 143715 |
| Haiku | Rust structured | 10/12 (2 compile) | 143348 |

  Cost ratio TS / A0: 711x (Sonnet), 701x (Haiku); Rust / A0: 709x (Sonnet), 699x (Haiku). A0 cost per task is flat from 400 to 4000 functions (Sonnet 202 both) while TS/Rust grow linearly with the file. Caveat as at c400: the scoped A0 view is protocol-supplied; TS/Rust get the whole numbered file.
- Gate (this branch, all exit 0): lint, typecheck, test 56/56, verify, app (JVM emitter row still blocked as before), equiv 48/48 proved, hw, dotnet, gpu.

## Session 2026-09-30 (AI edits: seven languages)

- Five more representations in the AI-edit harness: Python, Go, Java, C#, C++ (`tools/ai-edit-langs.ts`). Hand translations of every function in set B (originals and references) and in the set-C / c400 program (set-A originals, the fold-helper and examples/ extras, and the six generated filler templates, emitted from a `spec` now recorded on each `generateFiller` entry), same names and u32 semantics: Python `& 0xFFFFFFFF`, Go `uint32`, Java `int` with `Integer.compareUnsigned` / `divideUnsigned` / `remainderUnsigned`, C# `uint`, C++ `uint32_t`; shift counts masked to 5 bits; `pctof` divides with the A0 rule (b = 0 gives 4294967295). Records: tuples (Python, C# value tuples), `U32U32` / `U32Bool` (Go structs, Java records), `std::pair` (C++).
- Acceptance follows acceptTs/acceptRust: write the file, build (`python3 -m py_compile`, `go build`, `javac`, `dotnet build -c Release`, `clang++ -std=c++20`), run a generated driver that prints each result in one canonical form, compare. Protocols: conventional (whole file) and structured (numbered whole file + line edits, the TS/Rust protocol) for each language. Harness: `A0_EXPERIMENT_REPS=python,go,java,csharp,cpp` (default `a0,ts,rust`), `A0_EXPERIMENT_PROTOCOLS`; reports carry `representations`, `protocols`, and `langTaskSetSha256` (b `bc76a963…`, c400 `58a27fdf…`); `taskSetSha256` unchanged (b `21de5a34…`, c400 `ad0f14cd…`).
- Self-check ok on b and c400 in all five languages: every reference passes, every original fails.
- Collected with fresh subjects (one Haiku and one Sonnet subagent per group file, one shot): set b, 10 group files (5 languages x 2 protocols, 12 tasks each); c400, 5 group files (structured only), each printing the shared numbered 400-function file once, as the earlier c400 collection did. c400 conventional not collected (each reply is the whole ~11.5k-token file, 12 per subject; same reason as before). Results `results/ai-edit-experiment.{b,c400}.{haiku,sonnet}-langs.json`. A0 rows are the earlier collections on the same prompts (`b.*-min`, `c400.*-min`, scoped g0); A0 was not re-collected. Cost per task cache-adjusted as before (primer 1.25x per call, context and output 1x); ratio = language cost / A0 cost, same protocol.

Set b (single-function files):

| subject | cell | Python | Go | Java | C# | C++ | A0 |
|---|---|---|---|---|---|---|---|
| Sonnet | conventional accepted | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet | conventional cost/task | 140 (0.71x) | 152 (0.77x) | 171 (0.86x) | 166 (0.84x) | 185 (0.93x) | 198 |
| Sonnet | structured accepted | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet | structured cost/task | 126 (0.68x) | 142 (0.77x) | 148 (0.80x) | 144 (0.78x) | 159 (0.86x) | 184 |
| Haiku | conventional accepted | 11/12 | 11/12 | 10/12 | 12/12 | 12/12 | 12/12 |
| Haiku | conventional cost/task | 144 (0.73x) | 160 (0.81x) | 175 (0.88x) | 165 (0.83x) | 186 (0.94x) | 198 |
| Haiku | structured accepted | 3/12 | 12/12 | 8/12 | 9/12 | 11/12 | 12/12 |
| Haiku | structured cost/task | 150 (0.77x) | 143 (0.73x) | 202 (1.03x) | 199 (1.02x) | 163 (0.83x) | 196 |

  On single functions A0 is the most expensive representation (its primer dominates), as it was against TS and Rust (TS/Rust 139–162). Every language ties or beats A0's acceptance with Sonnet; with Haiku, A0 structured (12/12) beats Python (3/12: 9 replies dropped the indentation of the replaced line, so the line-edit protocol breaks significant whitespace), Java (8/12: 3 compile, 1 wrong output) and C# (9/12: 3 compile, two of them edits placed outside the class).

Set c400 (one 400-function program, structured):

| subject | Python | Go | Java | C# | C++ | A0 (scoped g0) |
|---|---|---|---|---|---|---|
| Sonnet accepted | 12/12 | 11/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet cost/task | 12502 (62x) | 13203 (65x) | 13114 (65x) | 13761 (68x) | 13011 (64x) | 202 |
| Haiku accepted | 1/12 | 5/12 | 8/12 | 7/12 | 9/12 | 10/12 |
| Haiku cost/task | 12534 (58x) | 13266 (61x) | 13151 (61x) | 13788 (64x) | 13042 (60x) | 217 |

  With TS (14143 / 14202) and Rust (14210 / 14294) from the earlier collection, A0 structured is 58x–70x cheaper per task than every one of the seven languages at 400 functions; the whole numbered file is 12.4k–13.7k tokens in each of them (Python smallest, C# largest). Haiku's misses: Python indentation again (11), Go (6 compile, e.g. a line number taken from the file position rather than the view number; 1 divide-by-zero panic in `pctof`), C# replies without the handle line (3). Sonnet's one miss: a Go insert inside `popcnt`.
- Caveat as before: the scoped A0 view is protocol-supplied; the other languages get no per-function tool.

## Session 2026-09-30 (grammar item B: nested expressions)

- Prototype (not kept): `ParseOptions.nested` in `src/core.ts` `parse`/`parseAndValidate` and `SessionOptions.nested` in `src/edit.ts` (edit lines, `ret OP …`, and `fn` blocks), desugaring one level of `ID OP (OP ARGS) ARGS` into fresh nodes `ID_1, ID_2…` left to right just before the line (ids renamed if taken in the function or the edit), typing unchanged; off by default; 1 test with 8 cases (equivalence to the explicit program, collisions, `ret` form, `@` placement, depth/unmatched/empty errors, the option off rejects). Harness switch `A0_EXPERIMENT_NESTED=1`.
- Collection (no rescore of old replies): fresh Agent-tool subjects (Haiku, Sonnet), each reading only its group file, sets B and D, A0 conventional and structured, current `MODEL_GUIDE.min.txt` (control) versus the same primer plus one line, "Nested: one level of parentheses is accepted, e.g. `r select (lt a b) a b` (each group becomes a fresh line)." (option on for scoring). 16 groups. Results `results/ai-edit-experiment.{b,d}.{haiku,sonnet}-min-itemb-{control,nested}.json`.
- One shot, control vs option: Haiku B conv 12/12 vs 12/12, B struct 10/12 vs 11/12, D conv 13/13 vs 12/13, D struct 12/13 vs 12/13 (47/50 both); Sonnet 50/50 both. Nested replies: Haiku 1/50 control (bounds task, the parse diagnostic) and 2/50 with the line (bounds, which then failed with a type error; isdiv, accepted); Sonnet 0/100. Primer 405/440 -> 436/471 tokens per call; one-task cache-adjusted tokens up in all 8 cells (Haiku 198->201, 195->196, 152->159, 168->176; Sonnet 198->201, 184->192, 152->155, 154->157).
- Decision: refused (no acceptance gain on either model, cost up). Prototype removed; DESIGN.md records the numbers. COMPILER_VERSION unchanged.

## Session 2026-09-30 (single-function cost)

- Question: can the 6–32% single-function loss against TypeScript/Rust be closed without special-casing any model? Two general levers, measured on sets A, B and D (38 tasks) with all three primers: (1) the scoped program handle (`A0_EXPERIMENT_PROGRAM_VIEW=deps`) on the structured cell; (2) a new harness option `A0_EXPERIMENT_SYSTEM=merged` (`mergedA0System` in `tools/ai-edit-experiment.ts`): one system text, no protocol paragraph. The primer's single `EDIT:` line carries the protocol: for structured cells it gets the code-block rule appended; for conventional cells it is swapped for the whole-file rule, since those cells never use edit syntax. Works for any primer with exactly one `EDIT:` line, otherwise it refuses. Both variants also use the scoped handle. Also new: `A0_EXPERIMENT_OUT` (report path). Default behaviour is unchanged (`separate`, `all`).
- Collection: 12 group files (primer x {separate, merged} x {structured, conventional}, the 38 A0 tasks each). One fresh Haiku and one fresh Sonnet subagent per file, each reading only its group file. One shot. **A0 cells only**: the TS and Rust cells are the earlier replies (g9 set A, gb set B, g14 set D), rescored unchanged. Their prompts are identical because they depend on neither primer, program view nor system layout. Results `results/ai-edit-experiment.{a,b,d}.{haiku,sonnet}-{min,short,tiny}-variant-{deps,merged}.json` (`-variant-deps` = separate text + scoped handle; `-variant-merged` = merged text + scoped handle); self-check ok in all 36.
- Cost per task, cache-adjusted (o200k): system text S written once at 1.25x and read at 0.05x on every further call, context and output at 1x. For a session of N tasks: cost(N) = 1.2·S/N + 0.05·S·k + x, where k = calls per task and x = context + output per task. Figures are N = 1 / 10 / unbounded, over the 38 tasks.

| cell (Sonnet) | S | accepted | A0 | TS | Rust |
|---|---|---|---|---|---|
| structured, min, deps | 440 | 38/38 | 684 / 209 / 156 | 268 / 131 / 115 | 292 / 139 / 122 |
| structured, min, merged | 397 | 38/38 | 629 / 200 / 153 | same | same |
| structured, short, deps | 356 | 38/38 | 580 / 196 / 153 | same | same |
| structured, short, merged | 313 | 38/38 | 528 / 190 / 152 | same | same |
| structured, tiny, deps | 286 | 38/38 | 491 / 183 / 148 | same | same |
| structured, tiny, merged | 243 | 38/38 | 438 / 176 / 146 | same | same |
| conventional, min, separate | 405 | 38/38 | 632 / 195 / 146 | 185 / 133 / 128 | 205 / 137 / 130 |
| conventional, min, merged | 343 | 38/38 | 555 / 185 / 143 | same | same |
| conventional, short, merged | 257 | 38/38 | 447 / 170 / 139 | same | same |
| conventional, tiny, separate | 251 | 38/38 | 440 / 169 / 139 | same | same |
| conventional, tiny, merged | 199 | 38/38 | 375 / 160 / 136 | same | same |

  Haiku costs match within a few tokens where acceptance matches. Haiku acceptance (A0; per set a/b/d):

| Haiku | structured | conventional |
|---|---|---|
| min, deps / separate | 31/38 (9, 10, 12) | 37/38 |
| min, merged | 36/38 (12, 12, 12) | **38/38** |
| short, deps / separate | 31/38 | 38/38 |
| short, merged | 0/38 (the subject left out the opening fence in all 38 replies) | 37/38 |
| tiny, deps / separate | 35/38 | 36/38 |
| tiny, merged | 32/38 | **38/38** |

  TS/Rust (reused): Haiku TS 36/38 structured, 38/38 conventional; Rust 36/38, 37/38. Sonnet TS 38/38 both; Rust 37/38, 38/38.
- **Break-even session length: none, in every variant, for both models, against both TS and Rust.** Even with an unbounded session the A0 cell costs more per task. The cached primer read (0.05·S = 10–22 tokens per call) is larger than any saving in context or output. Context + output is level with TS (conventional 126 vs about 126; structured 134 vs about 110, where the two-handle A0 view is the larger one). Best case, tiny primer + merged text, conventional: 375 / 160 / 136 vs TypeScript 185 / 133 / 128, which is +103% / +20% / +6%. The earlier loss narrows but is not closed: the primer is all of the gap, and the gap cannot fall below 0.05·S per call.
- Decisions, keeping a variant only if acceptance holds on both models:
  - **Kept (as the `A0_EXPERIMENT_SYSTEM=merged` option): merged system text for conventional cells** with the min and tiny primers: 38/38 on both models, S down 62 and 52 tokens.
  - Not kept: the scoped handle on structured single-function tasks. Sonnet holds (38/38), but Haiku fell to 31/38 (min) and 35/38 (tiny), against 38/38 for min with the full handle in the earlier collections. The misses are protocol shapes: the `g0` signature lines echoed as blocks, or new helpers placed after their caller. The earlier c400 result (scoped handle better for Haiku on large programs) is unchanged. This set measures small programs only.
  - Not kept: merged text for structured cells. Sonnet holds everywhere; Haiku gets 36/38 (min), 32/38 (tiny) and 0/38 (short, all missing the opening fence).
  - Single subjects per cell, so a difference of 1–3 tasks on Haiku is within subject variance. The recorded defaults (MODEL_GUIDE.min.txt, separate text, full handle) are unchanged.



## Session 2026-09-30 (output tokens per edit)

Loss addressed: A0 structured replies cost ~34 o200k output tokens per edit vs ~28 TypeScript and ~26 Rust (sets b, c400 scoped, d; Haiku and Sonnet subagents, min primer).

Attribution of the accepted A0 replies (72 replies, o200k, token assigned by its first non-space character): operands 8.3 (25%), whole-function headers in `fn` blocks 7.3 (22%), newlines 5.8 (17%), code fence 3.0 (9%), ids 2.4, ops 2.1, handle line 2.0 (6%, plus its newline), `ret` lines 1.8, `end` 0.7. TS/Rust replies spend the same 3 fence + 2 handle tokens; the rest is the replaced line text.

Protocol changes (src/edit.ts, test/edit.test.ts; protocol only, COMPILER_VERSION unchanged, noted in DESIGN section 5):
- handle line optional when implied: exactly one function handle open (or, with none, exactly one program handle); an explicit handle, several handles, or an unknown handle behave as before;
- a function handle also takes `-fn name` lines (it already took whole `fn` blocks);
- `end` of a `fn` block is optional: the block closes at the next `fn`/`-fn` line or the end of the reply (`fn`/`end` are reserved, so no instruction line is mistaken for a boundary);
- no code fence required (the harness already accepted bare lines; the protocol text now asks for bare lines). MODEL_GUIDE.min.txt EDIT line and PROTOCOL_STRUCTURED_A0 updated; the view is unchanged.
Old fenced, handle-first replies (sets b and d, both models) re-score identically.

Fresh subjects (Agent tool subagents, model haiku / sonnet, each reading only its group file; results/ai-edit-experiment.{b,c400,d}.{haiku,sonnet}-bare.json, A0 structured cell only; TS/Rust from the existing -min files):

| set / model | A0 accepted before -> after | A0 output/edit before -> after | TS output | Rust output | A0 whole-task total before -> after |
|---|---|---|---|---|---|
| b haiku | 12/12 -> 12/12 | 45.3 -> 31.6 | 30.2 | 26.4 | 590 -> 579 |
| b sonnet | 12/12 -> 12/12 | 34.2 -> 27.5 | 27.9 | 25.3 | 579 -> 575 |
| c400 haiku | 10/12 -> 11/12 | 30.7 -> 29.8 | 30.7 | 26.5 | 611 -> 597 |
| c400 sonnet | 12/12 -> 12/12 | 34.0 -> 25.6 | 28.0 | 26.0 | 596 -> 590 |
| d haiku | 13/13 -> 13/13 | 35.0 -> 24.5 | 25.3 | 25.8 | 560 -> 553 |
| d sonnet | 13/13 -> 13/13 | 26.2 -> 19.2 | 25.2 | 25.8 | 551 -> 547 |
| mean | | 34.2 -> 26.4 | 27.9 | 26.0 | |

Against the old fenced TS/Rust protocol A0 output per edit is below TypeScript and level with Rust; on equal (relaxed) protocols it is not, see the next subsection. Whole-task totals barely move because the primer dominates (TS/Rust totals: ~230-265 on b/d, ~14.3k on c400). Remaining A0 output: operands 33%, `fn` headers 27% (models resend whole functions under a function handle for small edits), newlines 13%. The one failure (c400-bounds-largest, Haiku) is a language error (nested `select (lt ...)`), as before.

### All three on the relaxed protocol

TS and Rust structured cells got the same relaxations where they apply (tools/ai-edit-apply.ts, PROTOCOL_STRUCTURED_TS/RUST): no code fence, handle line optional (edit lines start with a digit, `+`, or `-`, so a handle-shaped first line is unambiguous; a wrong handle is still rejected). tools/ai-edit-langs.ts is not in this base, so the five other languages were not changed. Fresh TS and Rust subjects (Agent tool subagents, haiku / sonnet, one group file each) on sets b, c400 (scoped A0 view; whole numbered file for TS/Rust), d; the A0 replies are the ones above. results/ai-edit-experiment.{b,c400,d}.{haiku,sonnet}-bare.json now hold all three structured cells.

| set / model | A0 acc, out/edit | TS acc, out/edit (old -> relaxed) | Rust acc, out/edit (old -> relaxed) |
|---|---|---|---|
| b haiku | 12/12, 31.6 | 11/12 30.2 -> 11/12 23.5 | 12/12 26.4 -> 8/12 19.3 |
| b sonnet | 12/12, 27.5 | 12/12 27.9 -> 9/12 22.8 | 12/12 25.3 -> 12/12 19.6 |
| c400 haiku | 11/12, 29.8 | 8/12 30.7 -> 8/12 24.5 | 7/12 26.5 -> 12/12 20.8 |
| c400 sonnet | 12/12, 25.6 | 12/12 28.0 -> 12/12 22.2 | 12/12 26.0 -> 12/12 19.5 |
| d haiku | 13/13, 24.5 | 12/13 25.3 -> 12/13 19.4 | 12/13 25.8 -> 12/13 20.6 |
| d sonnet | 13/13, 19.2 | 13/13 25.2 -> 13/13 19.6 | 12/13 25.8 -> 13/13 19.0 |
| all | 73/74, 26.2 | 68/74 27.8 -> 65/74 21.9 | 67/74 26.0 -> 69/74 19.8 |

On equal protocols A0 structured output per edit is higher than TS (+4.3) and Rust (+6.4): the relaxations saved TS/Rust about 6 tokens, as much as A0. A0 keeps the acceptance lead (73/74 vs 65/74 and 69/74) and, on c400, the whole-task lead (~590 vs ~14.3k, the view). TS/Rust failures: Sonnet TS b (3, protocol: multi-line replacement text without line numbers), Haiku Rust b (4: unbalanced braces from line edits, one wrong output), Haiku TS c400 (4: compile errors, one wrong output); one-shot subjects swing between runs (Haiku Rust c400 went 7/12 -> 12/12). The remaining A0 gap is the `fn` headers of whole-function resends (27% of A0 output) and one newline per instruction.


### Line-addressed edits (measured: a regression, not adopted as the default)

Implemented (src/edit.ts, test/edit.test.ts): `open(name, { numbered: true })` numbers the view's body lines (`1 a add p0 p1` ... `N ret a`; header and `end` unnumbered). Under a function handle `N line` replaces line N, `N-` deletes it, `N+ line` inserts after it (`0+` at the top), `f:N ...` addresses function f (required under a program handle). Numbers refer to the view before the reply; each edited function becomes a whole `fn` block that goes through the existing whole-function path, so the program is parsed and validated before anything is committed (atomic with the rest of the reply; id-addressed lines apply afterwards). Whole-function `fn` blocks stay. Inside a `fn` block a leading view number is dropped (round-2 rule, below). Harness: `A0_EXPERIMENT_A0_VIEW=numbered` with `A0_EXPERIMENT_GUIDE=MODEL_GUIDE.lines.txt` (MODEL_GUIDE.min.txt plus the line-edit clause in the EDIT line). Primer 395 -> 433 o200k (+38; cl100k 389 -> 427); A0 view +2 to +3 tokens per task.

Fresh subjects, same method as the -bare runs (Agent subagents, haiku / sonnet, one shot, each reading only its group file; sets b, c400 with the scoped view, d). TS/Rust are the relaxed-protocol replies of the -bare run (their prompts are unchanged). Round 1: results/ai-edit-experiment.{b,c400,d}.{haiku,sonnet}-lines1.json, scored with a build that rejected view numbers inside `fn` blocks. Round 2: new fresh subjects on the same prompts, scored with the final rule; results/…-lines.json.

| set / model | A0 before (-bare) | A0 round 1 | A0 round 2 | TS relaxed | Rust relaxed |
|---|---|---|---|---|---|
| b haiku | 12/12, 31.6 | 11/12, 31.8 | 4/12, 32.2 | 11/12, 23.5 | 8/12, 19.2 |
| b sonnet | 12/12, 27.5 | 12/12, 28.3 | 12/12, 28.0 | 9/12, 22.8 | 12/12, 19.6 |
| c400 haiku | 11/12, 29.8 | 3/12, 29.2 | 12/12, 30.6 | 8/12, 24.5 | 12/12, 20.8 |
| c400 sonnet | 12/12, 25.6 | 12/12, 26.0 | 12/12, 31.8 | 12/12, 22.2 | 12/12, 19.5 |
| d haiku | 13/13, 24.5 | 7/13, 25.5 | 13/13, 21.8 | 12/13, 19.4 | 12/13, 20.6 |
| d sonnet | 13/13, 19.2 | 6/13, 23.1 | 11/13, 23.7 | 13/13, 19.6 | 13/13, 19.0 |
| all | 73/74, 26.2 | 51/74, 27.2 | 64/74, 27.9 | 65/74, 21.9 | 69/74, 19.8 |

(accepted one shot, mean o200k output tokens per edit over all replies.) Output per edit went up, not down (26.2 -> 27.2 / 27.9), acceptance dropped (73/74 -> 51/74 / 64/74), and the primer grew by 38 tokens per call; A0 is further from TS (21.9) and Rust (19.8) than before. Why, from the replies: the models did switch small edits to line form (0 -> 29-30 of 74 replies are line edits only), but those replaced id-addressed lines of the same size; replies with `fn` blocks did not drop (44 -> 42 / 43 of 74), because most of them add a function, change a signature, or rewrite a callee whose body the view does not show, none of which a line number can address; and the numbers leaked into the blocks (models number the lines of new functions, `0+` inside blocks, lines numbered past the end), so number prefixes are 8% (round 1) and 14% (round 2) of A0 output. Failures: round 1 d (Haiku 6, Sonnet 7), 12 of them numbered `fn` blocks rejected by the strict build (re-scored with the round-2 rule round 1 is 63/74), Haiku c400 9 replies written on one line with ` / ` separators (as in the primer's example; not a line-edit effect), Haiku b 1; round 2 Haiku b 8 (`0+` inside new `fn` blocks, numbers past the end of a function), Sonnet d 2 (`-fn f` plus a new `fn f` block in one reply, rejected as before). The round-2 rule was chosen after seeing round 1, and round 2 then showed new failure shapes; tightening further would be fitting the protocol to these replies. Decision: the default harness view and MODEL_GUIDE.min.txt are unchanged (the -bare protocol stays the measured best: 73/74, 26.2); line-addressed edits stay in EditSession as an opt-in (numbered views only) and in the harness behind the flag. The remaining gap is not addressable by line numbers under these views: it is new-function and signature headers, and callee rewrites without a visible body.

## Session 2026-09-30 (held-out sets E and F: full protocol)

Seals: `tools/ai-edit-tasks-e.ts` hashes to `a71fdb69…5708` and `tools/ai-edit-tasks-f.ts` to `0e648bc5…be30`, matching `tools/ai-edit-tasks-{e,f}.sha256`. Both seals were redone after delivery (see `tools/ai-edit-tasks-{e,f}.errata.md`: E lost two tasks that could not be measured, F probably had a formatter-only change), so they attest the current files, not the files as first delivered. Set E has 11 tasks and set F has 13, 24 in total. Harness self-check ok on both. Run `taskSetSha256`: e `7b387c6f…`, f `2c02b500…`.

Method: the prompts were dumped with empty replies (`A0_EXPERIMENT_DUMP`). There were 8 group files, one per cell and primer: A0 {min, full} x {structured, conventional}, and TS and Rust x {structured, conventional}. Each group file holds the e+f tasks (24) with the system text printed once. TS/Rust prompts do not depend on the primer, so one TS/Rust collection serves both primers. Each group file got one fresh Haiku and one fresh Sonnet Agent-tool subagent that read only that file and wrote its replies as JSON. That makes 16 first-round subjects. Every first-attempt failure then went into repair group files: system, request, first reply, and the harness's exact rejection message. Each repair group file got a fresh subagent of the same model (9 subjects). There is exactly one repair round: the full primer allows 2 repairs, but no third reply was supplied. There are no author-written replies. The reply texts are committed as `results/ai-edit-experiment.{e,f}.{haiku,sonnet}-{min,full}.replies.json` and the scored reports as `results/ai-edit-experiment.{e,f}.{haiku,sonnet}-{min,full}.json`.

Cost is mean o200k tokens per task. The primer is the system text, charged 1.25x on the first call and 0.05x on a repair call. Code read is the task text plus the view, re-sent on repair along with the first reply and the rejection. Write is every reply. The cache-adjusted total is primer + read + write. TS/Rust rows are identical under both primers.

| model / primer | cell | one-shot | after 1 repair | primer | code read | write | cache-adj total |
|---|---|---|---|---|---|---|---|
| Haiku / min | A0 structured | 19/24 | 24/24 | 558 | 125 | 35 | 719 |
| | A0 conventional | 23/24 | 24/24 | 516 | 82 | 45 | 643 |
| Haiku / full | A0 structured | 17/24 | 18/24 | 895 | 149 | 32 | 1076 |
| | A0 conventional | 24/24 | 24/24 | 846 | 76 | 42 | 965 |
| Haiku | TS structured | 17/24 | 20/24 | 159 | 167 | 33 | 359 |
| | TS conventional | 21/24 | 24/24 | 60 | 98 | 58 | 216 |
| | Rust structured | 20/24 | 23/24 | 177 | 144 | 25 | 347 |
| | Rust conventional | 23/24 | 24/24 | 79 | 84 | 50 | 212 |
| Sonnet / min | A0 structured | 21/24 | 21/24 | 557 | 116 | 25 | 698 |
| | A0 conventional | 24/24 | 24/24 | 515 | 76 | 46 | 637 |
| Sonnet / full | A0 structured | 21/24 | 24/24 | 889 | 112 | 30 | 1031 |
| | A0 conventional | 24/24 | 24/24 | 846 | 76 | 46 | 969 |
| Sonnet | TS structured | 24/24 | 24/24 | 158 | 86 | 21 | 264 |
| | TS conventional | 24/24 | 24/24 | 60 | 78 | 48 | 186 |
| | Rust structured | 24/24 | 24/24 | 176 | 85 | 19 | 280 |
| | Rust conventional | 24/24 | 24/24 | 79 | 77 | 47 | 203 |

Per-task A0 against TS/Rust, same protocol, recorded separately. Acceptance is after the repair and is shown as W/T/L. Cost W/T/L covers only tasks both sides accepted, and a tie means within 5%:
- Acceptance, structured: Haiku min, A0 wins 4 / ties 20 / loses 0 vs TS, and 1/23/0 vs Rust. Sonnet min, 0/21/3 vs both. Haiku full, 0/22/2 vs TS and 0/19/5 vs Rust. Sonnet full, 0/24/0 vs both.
- Acceptance, conventional: all ties (24/24 everywhere).
- **Cost: A0 loses every task on which both sides were accepted, in every model, primer and protocol (0 wins, 0 ties).** The primer alone (516–895 cache-adjusted) exceeds the whole TS/Rust task (186–359). A0 reads the least code (76–82 conventional vs 77–98) and writes the least in the conventional cell, and that does not offset the primer on a single cold task. A0 structured replies are not smaller than TS/Rust structured ones (25–35 vs 19–33).

Failure taxonomy: 48 failed attempts, first and repair attempts together (A0 28, TS 14, Rust 6).
- Protocol ambiguity (23):
  - A0 structured, 19. First, instruction lines for the shown function mixed with a new `fn` block in one reply (`expected 'fn', got 'x'`): 10. The guide does not say whether the two can be combined or in what order. Second, on repair, the callee `fn` block placed after the instruction lines that call it (`unknown callee 'sq' (callees must be defined earlier)`): 6. The guide does not say where an added function lands or in what order a reply's lines apply. Third, `-fn f` followed by `fn f` in one reply (`function is both removed and defined`): 3 (Sonnet, full primer). The guide says a `fn` block replaces, but does not say the pair is rejected. All three come from the add-a-helper tasks (sq-twice, sumsq-helper, popcount-fold, thread-param, avg4).
  - TS/Rust `f-divrem-pair`, 4: the expected `divrem(7,0)` remainder is 7 (the A0 rule), but the TS/Rust semantics notes only fix the quotient by zero (visible in the source) and never state the remainder by zero.
- Genuine model errors (25):
  - A0, 9: a bool left where u32 is declared (countabove x2, addover x2 with a bad `-fn` signature form), a pair returned without changing the signature (divrem x2), a malformed function body (popcount, thread-param repair), and fold step arity (popcount, conventional).
  - TS, 12: line-edit syntax that broke the file (TS1128/TS1005, 4), an edit line with no number (2), the return type not updated (2), a return lost (TS2355, 2), and `sq` added without `export` (2, conventional).
  - Rust, 4: line edits that broke the syntax (3) and a type mismatch (1).
- Still unaccepted after the repair: Haiku TS structured 4, Haiku Rust structured 1, Sonnet-min A0 structured 3 (all definition-order repairs), Haiku-full A0 structured 6.

Findings:
- On held-out sets written without the harness author, A0's conventional cell matches TS/Rust acceptance (24/24 with both models and both primers). It loses on cost on every task, by about 3x (min primer) and 4.5x (full primer), because the primer dominates a cold single task.
- The A0 structured cell's weak spot is protocol, not language. 19 of its 28 failures are ambiguities in how function-handle lines, `fn` blocks and `-fn` combine in one reply, and on how definition order interacts with them. Two fixes would remove these failures: stating the rule in the guide, or accepting the combination (apply `fn` blocks first, then the function-handle lines). This session did neither.
- The full primer did not help. Haiku full did worse than min on A0 structured (18/24 vs 24/24 after repair). Sonnet full did better (24 vs 21).
- The TS/Rust semantics notes should state the division and remainder rule for a zero divisor (the `f-divrem-pair` ambiguity). Not changed here, since the sealed task file and the notes' bytes stay fixed for this run.

## Session 2026-09-30 (every chart on the full language set: deterministic axes)

New tool `bun run lang-axes` (tools/lang-axes.ts) writes `results/lang-axes.json`. It runs on the same programs as exec-bench: the kernel sources and drivers now live in tools/exec-bench-kernels.ts, which exec-bench.ts and lang-axes.ts both import. It covers A0 plus 48 languages: C, Rust and JavaScript (exec-bench's core baselines) and the 45 table languages.

- **Tokens:** o200k tokens of each kernel source and of each full runnable program, over the 10 exec-benchmark kernels.
- **Validation per edit:** a warm project directory. Each sample adds one real comment line to the file, so content-hash caches (Go, Zig) rebuild.
  - `checkMs` is the language's own static step: its exec-bench build, or its toolchain checker (py_compile, ruby -c, php -l, perl -c). It is null when the toolchain has no static check.
  - `checkRunMs` adds everything needed to run once, plus one run whose checksum must match A0.
  - Kernels affine, branchy and arrfill; 5 rounds interleaved across every (language, kernel) pair, with the order rotated each round. The load average is recorded each round.
- **Startup:** not re-measured, because exec-bench already has it for all table languages.

The machine was loaded. The 1-minute load averages per round were 24.9, 28.9, 17.8, 50.4, 165.7, then 60.4 after the last round, on 8 CPUs. Absolute milliseconds are comparable only within this run.

Every toolchain is installed on the benchmark host, so no "not installed" rows. Tcl first failed its checksum: its driver printed the checksum with `format %d`, which prints values over 2^31 as negative numbers. It was fixed to `%ld` and Tcl re-measured alone with an A0 control. The file marks this as `validation.tcl.separateRun`. lua has no static check here because only `lua` is located, not `luac`.

The A0 static check is a cold CLI process (node startup included): median 353 ms. That is slower than C (182), Python (116) or JS `--check` (70), and faster than TypeScript (778), Java (1395) or Kotlin (10700). The in-process figure is in results/edit-loop.json.

Coverage by axis (languages beside A0, M = 48):

| axis | before | after |
|---|---|---|
| execution speed (exec-benchmark.json) | 48/48 | 48/48 (unchanged) |
| startup (exec-benchmark.json) | 46/48 (C and Rust startup measured but not charted) | 46/48 (unchanged) |
| source tokens read/write per kernel (tokens.json: TS, C, Python) | 3/48 | 48/48 (lang-axes.json) |
| validation, static check per edit (edit-loop.json: TS, Rust, Go) | 3/48 | 33/48 have a static step; the other 15 have none in their toolchain |
| validation, check + run per edit | 0/48 | 48/48 |
| AI-edit acceptance and cost (model subjects) | set b and c400: 7/48 (TS, Rust, Python, Go, Java, C#, C++); sets c and c4000: 2/48 (TS, Rust) | unchanged; not fanned out (see plan) |
| parallel folds (parallel.json) | 7/48 (C, Rust, Zig, Go, Java, JS, Python) | unchanged |

Plan for the model-subject axes, not run: each language needs a hand translation of task set B plus the project filler, with an acceptance harness (tools/ai-edit-langs.ts took about 290 lines per language for 5 languages).
1. Add 8 languages that span the families (Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir, Zig) to ai-edit-langs.ts.
2. Collect set b with Haiku only: 24 trials per language, 192 subject calls.
3. Then Sonnet on the same set, and c400 for the 3 cheapest to accept.
4. Show the deterministic token and validation axes for all 48 languages next to it, labelled as proxies and not acceptance.
