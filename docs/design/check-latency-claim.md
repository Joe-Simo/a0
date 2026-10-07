# Edit-check latency: what we measured and what the site may say

Tool: `tools/check-latency.ts` (`bun run check-latency`). Report: `results/check-latency-win32-x64.json`
(Linux x64 and macOS arm64 partial reports, with tsc-rs, come from `.github/workflows/check-latency.yml`).
Same code on both sides: A0 `compiler/lex.a0` + `compiler/parse.a0` linked (4103 lines, 79164 bytes as formatted,
106 functions: `size.a0`), TypeScript `tools/ref-parse.ts` front end (637 lines, 22033 bytes: `size.ts`).
Edits: the reference solutions of the 14 sealed tasks of `tools/app-edit-tasks.ts`.

## Read this before quoting any number

1. The committed Windows run was recorded on a machine that was saturated by other work (cpu-utilisation load 8 on
   8 CPUs for the whole session; `load.max` = 8, under the repository's limit of 10 but not quiet). tsgo is
   multi-threaded and suffers most: its median was 857 ms in an earlier trial run, 7600 ms in another and 25652 ms in the
   committed one (max 63861 ms). tsc moved 2.0 s to 3.9 s. A0's in-process numbers moved 12 ms to 14 ms (edit median).
   So: the A0 vs tsgo ratio in the committed file is inflated by contention. Do not quote tsc or tsgo ratios until the
   report is regenerated on a quiet machine (the CI workflow's runners, or this box idle).
2. `EditSession.apply` validates incrementally since the commit that added `results/edit-incremental.json`.
   The committed reports below (`check-latency-*.json`) were recorded BEFORE that change: their A0 edit rows are the whole-program
   re-validation (median 13.8 ms vs 22.7 ms cold open in the quiet-ish run). Until they are regenerated, quote the A0 edit time only
   from `results/edit-incremental.json` (same program, same 14 edits, before and after in one interleaved run, load max
   4.09 on 8 CPUs, win32-x64): median over the 14 edits 7.24 ms before, 1.82 ms after, 3.98x (`summary.speedupMedian`;
   per-edit minimum 3.33x, `summary.speedupMin`). An edit retypes only the edited functions and their transitive callers
   (3 to 9 of 106 functions, `edits[].retyped`).
3. A0 numbers are in process (no process start); tsc, tsgo, tsc-rs are fresh processes (as hyperfine times them). The
   report therefore also has `a0.coldOpenProcess`: the whole front end validated in a fresh node process.
4. Not run here: tsc-rs (npm ships Linux x64 and macOS arm64 binaries only; the workflow runs it), `bun check` (bun
   1.4.2: `bun check` is not a command, `error: Script not found "check"`; recorded in `tools["bun check"]`). TypeScript 6 is not
   installed; the TypeScript compared is 5.9.3 (`tools.tsc.version`).

## Results (committed run, contended machine; ms, medians)

| subject | ms | field |
|---|---|---|
| A0 apply, median over the 14 tasks | 22.7 (slowest 103) | `a0.editMedianMs`, `a0.editSlowestMs` |
| A0 whole front end, in process | 28.4 | `a0.coldOpenInProcess.median` |
| A0 whole front end, fresh process | 847 | `a0.coldOpenProcess.median` |
| tsc 5.9.3, whole project | 3918 | `wholeProject.tsc.median` |
| tsgo 7.0.0-dev.20260707.2, whole project | 25652 (contended) | `wholeProject.tsgo.median` |

Verdicts (`comparisons[]`, tie band 8 % to 25 % as in `tools/loss-ledger.ts`): A0 wins every row against tsc and tsgo,
for every one of the 14 edits and for the whole front end both in process and in a fresh process. No loss, so nothing
is added to the loss ledger. The closest row on the quiet-ish trial was a fresh-process whole-front-end check against
tsgo (413 ms vs 857 ms, 2x); on an idle machine tsgo's minimum was about 320-390 ms, so that row may become a tie.
That is why it must be regenerated before it is quoted.

## Recommended claim text (use only after a quiet regeneration; fill from the fields named)

> On the same 4,100-line front end, an A0 edit is validated in about N ms in a warm session (`a0.editMedianMs`),
> against M ms for a whole-project `tsc --noEmit` (`wholeProject.tsc.median`) and K ms for TypeScript 7's native
> `tsgo` (`wholeProject.tsgo.median`), each in a fresh process. A0 checks the whole program on every edit today, so
> this is a constant-factor win from a warm session, not an incremental check; validating the whole front end from
> scratch takes P ms in process (`a0.coldOpenInProcess.median`) and Q ms in a fresh process (`a0.coldOpenProcess.median`).
> tsc-rs: R ms (`results/check-latency-linux-x64.json`, `wholeProject["tsc-rs"].median`).

Every number needs the load next to it (`load.max`, `load.source`) and the platform. Do not claim "O(function)" and do not
drop the whole-front-end row.

## Incremental validation (done) and where the time goes now

`validate` (src/core.ts) reuses a function's typed result by identity when the function is a typed result of an earlier
`validate` (a WeakMap of results `validate` itself produced: a spread copy is never trusted), under the same profile, and every
function it resolved by name (callees, loop predicates, the callees of `pre` and `post`) is the same object in the new program.
Edited functions are typed again; so are their transitive callers, because a caller holds its callee's typed object (its
`calls`, iteration bounds and spec runs depend on it). An added, deleted or renamed function, and a reorder that moves a callee
below its caller, change what a name resolves to, so the callers are typed again and fail exactly as before. No early cutoff on
an unchanged signature: that is a possible further saving, not made. The result equals a full validation:
`test/incremental-validate.test.ts` compares the typed program (canonical text, order, revisions, types, calls, iteration
bounds, profile) and, on failure, every field of the diagnostic, against a validation of the same functions with all typings
removed, for about 2,400 random edits of corpus and example programs (rename, rename with callers, body, op, signature, result,
delete, add, reorder, move, broken and later callee, drop a spec, profile switch, rebuilt copy), 600 more over linked compiler
programs and a spec program, and the 14 reference (and 14 wrong) replies on the real front end; it was checked to fail when the
callee check is removed.

Where the remaining ~1.8 ms goes (CPU profile of 400 applies, whole loop including session setup): hashing the whole program text
for the program-handle revision check (SHA-256 of 79 KB, about 20 %; the revision is the hash of the canonical text, so it cannot
be made incremental without changing every revision), re-typing the dependency cone (11 %), the garbage collector, and the token
counter used by the benchmark harness (not part of apply). Formatting every function and hashing every function revision was
the first hotspot (about 35 % of the profile once validation was incremental); canonical text, function revision and program
revision are now remembered per immutable object (`formatFunction`, `revision`, `programRevision`).
Speedups before that second change were 2.0x to 4.4x (median 2.4x, load max 8); with it 3.3x to 7.4x. Emission is untouched
(no COMPILER_VERSION change).

No verdict is a loss. The gap that matters is the design claim: apply re-validates the whole program. The general fix is
incremental validation in `validate()`: keep each function's typed result, and on an edit re-validate only the edited
function and the functions that call it transitively (functions are ordered callee first, so everything above the edit is
untouched and a function below it only changes when a callee's typed signature changed). Then apply would be O(function plus
dependents) and the "lines checked" count per edit would drop from 4103 to the edited function's dependency cone
(`a0.edits[].viewLines` is the size of the view the model sees). That change is not made here.

## Fresh-process `a0 check`: what the shipped binary is, and the start-up fix

What ships: `tools/release.sh` runs `bun build --compile --target=bun-<os>-<arch> --minify dist/src/cli.js`. The release
binary (`a0`, `a0-windows-x64.exe`) is the TypeScript CLI bundled with the Bun runtime, not a native A0 program. The
self-hosted native checker (`tools/native-check.ts`, `compiler/check.a0` through the C backend) is not shipped and cannot
validate this input: its host driver stops at a 16384-byte linked program (exit 65), the front end is 79164 bytes
(`size.a0.formattedBytes`). So no native-check row exists here, and none is claimed.

The loss: in `results/check-latency-linux-x64.json` (CI, load 1.4) the row "a0 whole front end, fresh process" is a node
process that imports `src/core.js` and validates the front end. It loses to tsc-rs (91.4 ms against 55.7 ms) and ties
tsgo, while the same validation in process is 13.2 ms (`a0.coldOpenInProcess`). The cost is the process, not the checker.
That row is also not what a user runs: `a0 check FILE` went through `src/cli.ts`, which imported every backend, the MCP
and language servers, the Z3 prover encoder, the wasm toolchain wrapper and the agent files at start-up.

The general fix (no benchmark special case): `src/cli.ts` now imports only what `check` needs (core, link, dense, edit,
fix, diagnostics) and loads a backend, cache, toolchain, server, prover, explain or agents module with `import()` when its
command runs. The compiler version and target names moved to `src/targets.ts` (re-exported by `src/backends.ts`) so
`--version` and the usage text need no backend. `test/cli-startup.test.ts` fails if the CLI's static import closure
reaches any of those modules again, and checks that `check`, `emit` and `explain` still work through the dynamic path.

The harness now has two shipped-command subjects, `a0 cli check (node, fresh process)` and `a0 binary check (fresh
process)` (the binary is built with the release flags in the scratch directory when `bun` is present), as the optional
report fields `a0.cliCheckProcess` and `a0.binaryCheckProcess` plus extra `comparisons[]` rows; reports without them stay
valid.

Indicative before/after, NOT publishable: Windows x64, a machine saturated by other agents (cpu-utilisation load 8 on
8 CPUs throughout, so above the "quiet" bar this document sets even though under the repository limit of 10), 15
interleaved runs after 3 warmups, `a0 check compiler/parse.a0` (links lex.a0). "Before" is the same bundle with every
heavy module imported first (`import` of each, then the CLI), which is what the old static imports loaded:

| fresh process | before (eager) median | after (lazy) median |
|---|---|---|
| node dist/src/cli.js check | 2067 ms | 636 ms |
| bun --compile binary check | 625 ms | 507 ms |

Only the ratio between rows measured in the same interleaved run means anything; the absolute numbers are contention.
`results/check-latency-win32-x64.json` was NOT regenerated (the machine never went quiet), and the Linux and macOS
reports predate the change, so no committed report shows the fixed number yet. The three losses those reports record
(Linux x64 against tsc-rs; macOS arm64 against tsgo and tsc-rs, fresh-process whole front end) are in
`results/loss-ledger.json` (axis `check-latency-ms`, added with `--update --reason`) and classified
`needs-ci-remeasure` in `results/loss-blockers.json`.

What closes it: run `.github/workflows/check-latency.yml` (or `bun run check-latency -- --tools DIR` on an idle machine)
so the reports carry `a0.cliCheckProcess` and `a0.binaryCheckProcess`; the ledger entries leave when those rows are
not a loss. If the binary still trails tsc-rs there, the remaining cost is the Bun runtime's start-up and parse of the
bundle; the way past it is shipping a native `check` (the self-hosted checker) with its 16384-byte program limit lifted,
which is a larger change than this one.
