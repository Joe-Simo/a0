# A0 status

Last updated 2026-10-01, compiler `a0c-0.1.36` (`COMPILER_VERSION` in `src/backends.ts`). This is the current state of the project:
what exists, what is measured and where the numbers live, what is lost or unknown, how to reproduce it, and what comes next.
Every number on this page is in the `results/` file named beside it, or is reproduced by the command shown. The long record of
how the project got here, session by session, is in [docs/history/](docs/history/) (index at the end). Contributing rules are in
[CONTRIBUTING.md](CONTRIBUTING.md); the design and semantics are in [DESIGN.md](DESIGN.md).

## What exists

- **Language.** Types `u32`, `bool`, fixed-size arrays and records, and the linear `io` token; pure, total, exactly specified
  operations (wrapping unsigned arithmetic, logical shifts, total `div`/`rem`); `call`, bounded `fold`, early-exit `loop`, `text`.
  No recursion, no heap, no floating point. Reference: `DESIGN.md`, `MODEL_GUIDE.txt`.
- **Edits.** Revision-checked structured edits through handles (function `e0`, program `g0`): replace, insert, delete, change the
  result, whole-function add and replace, validated as one program and committed atomically. Diagnostics are one table
  (`src/diagnostics.ts`) with stable codes, fixes and `a0 explain`. A dense surface syntax (`src/dense.ts`) is opt-in.
- **Targets.** JavaScript, C (also valid C++), Java, C#/.NET, SystemVerilog, Metal, direct AArch64, x86-64, RISC-V RV64, AVR and
  ARM32 assembly, direct wasm32, and parallel C. One program, one oracle (`tools/corpus.ts`, independent BigInt arithmetic).
- **Self-hosting.** The compiler front end, the C, AArch64 and wasm32 emitters and the optimizer are written in A0
  (`compiler/*.a0`). The C and AArch64 bootstraps reach a byte-identical fixed point; a text-only bootstrap seed is in `seed/`.
- **Tools.** The `a0` CLI, an MCP server (`a0 mcp`), an LSP server (`a0 lsp`), editor grammars, an agent skill and plugin, and the
  development loop in `tools/dev/` (`a0-dev`). The site a0lang.com is two A0 programs (`site/page.a0`, `site/docs.a0`).

## Current results

| Area | Result | Evidence |
|---|---|---|
| Differential execution | 48 generated functions, 5262 input cases: interpreter, optimizer, JS, C (clang and gcc), C++, parallel C, wasm (via C and direct) and JVM pass all of them; direct arm64, x86-64, RISC-V, AVR and ARM32 pass the 4297 io-free cases | `results/verification.json` |
| Optimizer equivalence (Z3, 32-bit) | 48 of 48 corpus functions proved, no counterexample, none unknown | `results/equivalence.json` |
| Behavior table | 8 programs, 46 functions, 718 rows, written once and run on 20 targets: 19 pass, 1 skipped with a recorded reason, 0 fail | `results/behavior.json` |
| SystemVerilog | simulation of 5262 cases passes (Icarus); generic synthesis passes (Yosys). Not run: FPGA place-and-route, ASIC cell library, timing, area, power | `results/hardware.json` |
| .NET and GPU | C# passes 5262 cases; Metal passes 4297 io-free cases on 30 kernels (Apple M3) | `results/dotnet.json`, `results/gpu.json` |
| Application | Conway's Life in A0, 134 cases against an independent TypeScript reference, on seven targets | `results/app.json` |
| Self-hosted emitters | arm64: 50 programs pass, 3 skipped, 6898 cases; C: 6371 of 6371 cases; wasm32: 5 programs, 0 failed | `results/selfhost.json`, `results/selfhost-c.json`, `results/selfhost-wasm.json` |
| Bootstrap | the compiler written by its own output reaches a byte-identical fixed point on the C path, the AArch64 path and the Mach-O path | `results/bootstrap.json`, `results/bootstrap-arm64.json`, `results/bootstrap-macho.json` |
| Native `a0 check` | the self-hosted checker as an arm64 executable agrees with the reference on 124 of 124 sources | `results/native-check.json` |
| Execution speed | geometric mean of baseline time per call over A0's emitted C: hand-written C 0.996 (parity), Rust 0.999, TypeScript 1.52, Java 1.41, Go 1.66, JavaScript 7.95, Python 173.6; recorded load 6.4 to 8.0 on 8 cores, under the gate of 10 but not idle | `results/exec-benchmark.json` |
| Token counts | the ten lang-axes kernels: 559 tokens canonical, 202 in the dense view (o200k_base) | `results/dense-tokens.json`, `results/lang-axes.json` |

Token counts use `js-tiktoken` encodings (`o200k_base`, `cl100k_base`); they are not the tokenizer of any particular model.
Recorded model usage, where a run has it, is stored in the AI-edit result files.

### AI-edit experiments

The experiment (`tools/ai-edit-experiment.ts`) compares A0 and other languages on the same tasks, acceptance tests and protocol
capability, with fresh model subjects, whole-task accounting (primer, view, output, repairs) and one repair round. Results are in
`results/ai-edit-experiment.*.json` (replies in `.replies.json`) and `results/ai-edit-b48*.json` (set b against 48 languages). Task
sets a to f, `c400` and `c4000` are in `tools/ai-edit-tasks-*.ts`; sets d, e and f are sealed by `.sha256` files.

- Set b, 24 trials per cell, tokens per accepted edit for 1 task, 10 tasks and an unbounded session, rank among 49 languages:
  canonical A0 311 (rank 1), 184 (rank 12), 170 (rank 24); dense with callee bodies 274, 117 and 100, rank 1 on all three.
  Acceptance after one repair is 24 of 24 for both. `results/ai-edit-b48-dense.json`.
- Single-function tasks cost A0 more than TypeScript and Rust because the primer is paid on every call; the ledger axes
  `ai-tokens-*` record those losses. A 40-function program reverses it. See the ledger below and `results/ai-edit-experiment.c.*`.

### Loss ledger

`results/loss-ledger.json` (`bun run loss-ledger`, part of `bun run lint`) records every case where a competitor beats A0 beyond
the tie band. It holds 446 recorded losses, 21 of them unverified (recorded above load 10, or with no load recorded). By axis:
emitted JS against hand-written JS 1, wasm ns per trip 9, wasm load time 12, wasm bytes 1, kernel tokens 377, whole-task tokens
for conventional edits 24 and for structured edits 20, structured acceptance 2. The ledger can only shrink: a new or worsened
loss fails lint, and growing it needs `--update --reason`.

## Known limits

- **Timings under load are not claims.** `results/parallel.json` and `results/edit-loop.json` were recorded on a heavily loaded
  host (1-minute load far above the 8 cores) and are not publishable timings. Timing claims need a run at load 10 or below.
- **Language.** No recursion, heap, floating point, strings beyond `text` bytes, FFI, library imports, browser API bindings or
  mobile packaging. Arrays hold up to 65,536 elements (1,024 on hardware and GPU). Compiled targets have no execution budget; the
  reference interpreter has fuel and trip caps.
- **Hardware.** Clocked SystemVerilog is one stage per clock; no pipelining or scheduling, no timing closure, no physical flow.
- **GPU.** Elementwise kernels only: no memory-space or scheduling model, and no GPU speed claim.
- **x86-64.** Verified by execution; timing on Apple silicon runs under translation, so it measures the translator, and no x86-64
  speed claim is made.
- **Self-hosting.** The A0 optimizer runs before the wasm32 emitter only; the A0 C and AArch64 emitters do not use it. The front
  end has fixed table limits (source size, function and node counts); larger programs are checked in chunks.
- **Dense view.** Opt-in. It needs its own 145-token primer and does not lower the cold single-task cost; Haiku's one-shot
  failures on arity remain. Canonical stays the default.
- **Models.** The experiment subjects are fresh model sessions, not a trained model; one subject per cell and 24 trials per cell
  keep a one-trial change in acceptance within noise. Task sets d, e and f were written apart from the subjects and sealed with
  SHA-256; the errata for e and f are in `tools/ai-edit-tasks-e.errata.md` and `tools/ai-edit-tasks-f.errata.md`.
- **Provenance.** The first verification report is kept as `results/verification-handoff-2026-09-29.json`; it came from an earlier
  corpus generator and is not reproduced evidence.

## How to reproduce

```bash
bun install --frozen-lockfile
bun run lint && bun run typecheck && bun run test     # biome + claim check + loss ledger, tsc, node --test
bun run verify        # results/verification.json
bun run equiv         # results/equivalence.json
bun run hw            # results/hardware.json   (needs iverilog and yosys)
bun run app           # results/app.json
bun run dotnet        # results/dotnet.json     (needs a .NET SDK)
bun run gpu           # results/gpu.json        (needs Metal)
bun run behavior      # results/behavior.json
bun run selfhost && bun run selfhost:c && bun run selfhost:wasm
bun run bootstrap     # C, AArch64 and Mach-O fixed points
bun run exec-bench    # results/exec-benchmark.json (timing: run on a quiet host)
bun run lang-axes     # results/lang-axes.json      (timing: run on a quiet host)
bun run tokens        # results/tokens.json
bun run a0-dev -- gate   # every required step, in order; the one command before a push
```

Toolchains a step needs but the host lacks are reported as blocked or skipped with the reason, never as a pass.
`docs/DEVELOPMENT.md` describes the gate, its step cache and how results files are regenerated and merged.

## Next actions

1. Re-run the results recorded under load (`results/parallel.json`, `results/edit-loop.json`, the 21 unverified ledger entries)
   on a quiet host, then publish or drop each timing.
2. Shrink the primer (measured, `results/primer-ablation.json`, `docs/history/2026-10-02-primer-ablation.md`: 25 variants, clause drops and rewrites,
   selected on set d, confirmed on the different sets e and f, fresh Haiku and Sonnet subagents, 11 to 13 tasks per cell and model, no rate
   separates at that n). The experiment's edit-protocol primer (`experiments/primers/MODEL_GUIDE.rules-merged.txt`, an edit-only text used as the sole system text) is now 101 o200k tokens, was 118; the shipped language guide (`MODEL_GUIDE.min.txt`, MCP tool text, skill copies) is a different, longer text and is NOT changed by this, so no shipped path uses the winning text yet (the shipped-text measurement below tried a trimmed EDIT section of the guide and shorter tool descriptions, and shipped neither): acceptance
   equal on both sizes and a lower cost per accepted edit at all three session lengths on both. No shorter dense primer kept acceptance (88,
   102 and 110 tokens against 145 lose on Haiku and on the 10-task and unbounded cost), so the 145-token dense primer stays; every one of its
   clauses is used on e and f. Open: a whole-function reply without a head result could take the result type from its last statement (the one
   failure every variant shares: bool and record results; teaching it in the primer removed the failures and did not pay for its tokens),
   a callee defined after its caller could be ordered by the edit session, and the dense operand-count text. Earlier edit-cost numbers used the
   118-token text and are not rescored.
   Shipped-text measurement (`results/shipped-accounting.json`, `results/shipped.json`, `docs/history/2026-10-02-shipped-text.md`): an MCP-only client
   reads 1082 o200k tokens of tool list per call and no language text (the server surfaces no guide); the skill path reads 670 (body 275 and the 395-token
   guide); a user with both reads 1752. A trimmed EDIT section (`G1`, 373 tokens) and shorter tool descriptions (`T2`, 983) cleared set d and did not win on
   both model sizes on e and f (`G1` one shot 21 of 24 on Sonnet against 24, `T2` 12 of 24 on Haiku against 16, and cost losses on one size each), so
   `MODEL_GUIDE.min.txt`, the skill copies and `src/mcp.ts` are unchanged. The guide beats the tool list alone on the confirmation sets (one shot 44 of 48 against 33,
   cost per accepted edit lower at all three horizons). The guide surfaced to an MCP-only client (the combined text `B0`, 1477 tokens, against the tool list alone) was then run
   on e and f against fresh same-session controls (`results/shipped.json`, `confirm-s2(e+f)`): one shot 42 of 48 against 31 (Sonnet 24 against 17, Haiku 18 against 14), invented
   operation names 13 to none, cost per accepted edit lower at the 10-task and unbounded horizons on both sizes and higher on the cold one-task horizon on Sonnet (1962.1
   against 1773.7), so the shipping rule (lower cost on both sizes) is not met and `src/mcp.ts` is unchanged. The horizon was then fixed in advance
   (`docs/history/2026-10-02-shipped-text-preregistration.md`: one shot and the 10-task session are primary; ship if on the sealed set g, for both sizes, `B0` one shot is not lower and
   its 10-task cost is lower) and `B0` was run against `T0` on g (`results/shipped.json`, `preRegisteredDecision`): one shot Haiku 15 of 16 against 10, Sonnet 16 against 16;
   10-task tokens per accepted edit Haiku 382.6 against 461.3, Sonnet 372 against 320.3. The Sonnet condition fails (the tool list alone was already 16 of 16), the rule is not met, and
   `src/mcp.ts` still surfaces no guide; a further attempt needs a new sealed set and a new pre-registration. Four of the five refused Sonnet repair rounds were collected on a re-send of the unchanged request; one (`G1`, set e) was refused again and stays missing.
3. Decide whether the dense view with callee bodies becomes the recommended form of the MCP server and the docs.
4. Bring the A0 optimizer to the C and AArch64 emitters (it needs a return-kind encoding inside the bootstrap closure).
5. SIMD fills for the arm64 and x86-64 backends (the wasm32 path has them).
6. Per-backend verify, so a change to one backend does not run the whole `verify` step.
7. Libraries and platforms: FFI, browser API bindings, mobile packaging, memory regions beyond fixed arrays.
8. Quiet-machine rerun of the arm64 loop kernels with Zig (`bun run exec-bench -- --langs=zig --kernels=<the fifteen lighter kernels>`),
   then write `results/exec-benchmark-arm64.json`; until then the per-kernel arm64 loop table is not a result.
9. Strict profile follow-ups: the profile runs on every software and native target (Metal and SystemVerilog compile a strict program only when every site is proved safe); still open: teach the model guide and the edit protocol primer about `profile strict` only if a measurement says models need it, measure the strict cost on a quiet machine (loops with array writes are never vectorized in strict), and the `input` trap on arm64 and x86-64 (they refuse io).
10. Spec lines (`ex`, `pre`, `post`) are implemented everywhere (checker, both surfaces, edit protocol, MCP, LSP, grammars, skill, `a0 check --prove`) and stay opt-in and out of the model guide: the first fresh-subject measurement (`results/spec-lines.json`, `docs/history/2026-10-02-spec-lines-experiment.md`) found no acceptance gain and a loss on tokens per accepted edit in every measured cell. Open: general fixes for the protocol ambiguities it found (spec lines placed after the body, limits not taught, dense nesting), whether `post` without `ex` should be checked by the solver at edit time, and a task set where provided examples actually refuse wrong edits. Also open: an application-scale benchmark (A0 front end against the TypeScript reference, equal views).
11. Finish verifying return literals of 2^28 or more (kind-5 operand, fixed in all consumers): `selfhost:wasm` was not run to completion on the `bigret` list, and `efnstep`, `qfn`, `evalrun.a0` and `shape.a0` were read but not run with a big literal.
12. Port the assembler and linker (`src/arm64enc.ts`, `src/macho.ts`) to A0.
13. Free directory submissions (Smithery, Cursor, Cline, Goose, Kilo, opencode, Hugging Face); the MCP Registry entry is published.

## History

Dated records of the work, kept for the evidence trail (figures are as measured then; the current ones are above):

- [2026-09-29 baseline, design decisions and first measurements](docs/history/2026-09-29-baseline.md)
- [2026-09-30 self-hosting](docs/history/2026-09-30-self-hosting.md)
- [2026-09-30 backends](docs/history/2026-09-30-backends.md)
- [2026-09-30 AI-edit experiments](docs/history/2026-09-30-ai-edit-experiments.md)
- [2026-09-30 tooling, security, MCP server and the site](docs/history/2026-09-30-tooling-and-site.md)
- [2026-09-30 related work, blockers and plans](docs/history/2026-09-30-reference-and-plans.md)
- [2026-10-01 AI-edit experiments, errors for agents and the dense view](docs/history/2026-10-01-ai-edit-and-dense-view.md)
- [2026-10-01 trust layer, gate speed and the site](docs/history/2026-10-01-trust-layer-and-gate.md)
- [2026-10-01 optimizer, clean-load benchmarks and the A0 wasm path](docs/history/2026-10-01-optimizer-and-benchmarks.md)
- [2026-10-01 equal context (scoped views for every language) and the site charts](docs/history/2026-10-01-equal-context-and-site-charts.md)
- [2026-10-01 the hung stage executable: Node's stdin pipe on macOS 27 beta](docs/history/2026-10-01-hung-stage-executable.md)
- [2026-10-01 direct arm64 backend: loop kernels, A0-driver row, mat4, branchy](docs/history/2026-10-01-arm64-loop-kernels.md)

## Windows, protocol fixes and the latest comparisons (2026-10-06)

Short version; the dated record, with every number and its `results/` file, is [docs/history/2026-10-06-windows-port-and-measurements.md](docs/history/2026-10-06-windows-port-and-measurements.md).

- **Windows x64** builds and runs the compiler, the tests, the MCP and language servers. Needs Bun and Node 22+; the checks that use a C compiler use `clang` or `gcc` on PATH
  (`A0_CLANG`, `A0_GCC`). Not available there: timing benchmarks (Windows has no load average, so `tools/quiet.ts` refuses), the seed bootstrap (POSIX driver; use WSL or MSYS2),
  tree-sitter and sanitizer checks without the tools installed. `.gitattributes` pins LF.
- **Protocol changes** (general, with tests, none re-measured with fresh subjects): an `ex` line after a node is hoisted; an unwritten dense result takes the type of the last statement;
  `at`/`put` on an array carries an exact edit to `get`/`set`; a dense callee signature copied without its `#` is skipped.
- **Dense against canonical** (pre-registered, new sealed sets H, I, J): dense met the rule once in six model-by-set comparisons; it stays out of the shipped form (`results/set-h.json`, `results/set-i.json`, `results/set-j.json`).
- **Shipped guide against the 101-token edit primer** (set K, then sets L, M, N pooled): `results/set-k.json` and `results/set-lmn.json` and `results/set-opq.json`: the primers cost 36 to 64 per cent less at the cold task and the pre-registered rule (both models) is not met in any of three replications (one-shot acceptance); the shipped text is unchanged. A recurring Haiku delete-syntax misreading is a protocol ambiguity still to fix.
- **Loss ledger by cause**: `results/loss-blockers.json` gives a reason for each of the recorded losses; `results/canon-syntax-tokens.json` prices three canonical syntax cuts against the token losses.
- **Sets R to W** (selected primer `KR3b` against the shipped guide, under the fixed delete protocol): `results/set-rst.json` and `results/set-uvw.json`: the rule is not met on both models in either confirmation (sets U, V, W: Haiku one shot 28 against 41, Sonnet 47 against 48); cold cost is lower, the shipped text is unchanged.
- **Windows test run** (MSYS2 installed in its default folder, no other setup: `src/toolchain.ts` finds MSYS2 clang and gcc and LLVM in their usual folders and puts a compiler found there on PATH for its DLLs; the tree-sitter CLI from `bun install`): 349 pass, 22 are skipped with reasons and 1 fails: `results/behavior.json` is stale for the new `biglit` behavior program (the table hash changed) and has to be regenerated by a full `bun run behavior` on a machine where every target runs (a Windows run would record several targets as blocked). The full `a0-dev gate` has not been run to a pass: its later steps (verify, equiv, hw, dotnet, bootstrap, selfhost) need Z3, iverilog, yosys, a .NET SDK and a POSIX shell. Nothing is pushed.
- **Return literals of 2^28 and above, end to end** (item 5 of the brief, checked on this machine): a function returning `2147483648`, one adding `268435456`, one adding `4294967295` to zero give the same values in the interpreter, the emitted JavaScript, the emitted C (clang) and the direct wasm run in Node (`268435461`, `4294967295`, `2147483648`); the parser round trip for 2^28 - 1, 2^28, 2^31 and 2^32 - 1 is the existing test in `test/core.test.ts`. The direct arm64, x86-64 and RISC-V outputs were emitted but not executed here (no such machine); the behavior table runs them on the maintainer's arm64 machine. The A0 ports of the arm64 encoder and the Mach-O writer are done (see below); an x86-64 encoder in A0 (`compiler/asm_x86_64.a0`) matches clang and its TypeScript reference (`src/x86_64enc.ts`), and `src/pe.ts` and `src/elf.ts` write Windows and Linux executables (the PE program runs here); the A0 ports of those two writers are not built (blocked by a safeguard stop).
- **Assembler and linker in A0** (item 5 of the brief): `compiler/asm_arm64.a0` encodes every mnemonic of `src/arm64enc.ts` (50 of 50, 6 directives) and `compiler/macho.a0` writes the Mach-O file of `src/macho.ts`; `test/asm-arm64.test.ts` and `test/macho-a0.test.ts` compare them with the TypeScript originals on the texts the repository can produce (12 of 13 arm64 texts equal, the 13th refused identically; 34 of 34 linked modules byte for byte). Not yet wired into the bootstrap or the seed; the A0 encoder keeps no line numbers and has fixed capacities stated in its header.
- **Application-scale edit benchmark** (item 1 of the brief, pre-registered in `docs/history/2026-10-06-app-edit-preregistration.md`, result in `results/app-edit.json`; 14 sealed tasks editing the A0 lexer and parser against the TypeScript reference, fresh Haiku and Sonnet subjects, one shot plus one repair): repaired acceptance A0 against TypeScript is 7 against 13 of 14 on Haiku and 12 against 14 of 14 on Sonnet; per accepted edit A0 costs more on Haiku (10130.1 against 7960) and 19 per cent less on Sonnet (5893.3 against 7277.3). Losses for A0 on acceptance on both models; two tasks fail on a view gap (the keyword hash of a new keyword is not shown). Next: show the keyword table in the view, and a separately pre-registered arm that lets subjects use the MCP validate-and-fix loop.
- **Tool-loop arm of the application-scale benchmark** (pre-registered in `docs/history/2026-10-06-app-edit-loop-preregistration.md`, result in `results/app-edit-loop.json`; subjects use the shipped-style tools in a loop with a budget of 12 tool runs): accepted A0 against TypeScript is 7 against 12 of 14 on Haiku and 13 against 14 on Sonnet, and A0 costs more per accepted edit on both. The tool loop did not lift Haiku on A0. The MCP server no longer returns the whole program for an edit without a handle line. Open: the keyword table of the lexer is not shown in the view, which cost two A0 tasks; `compiler/*.a0` changes need `bun run seed` on a POSIX machine.
- **State at the end of this session (2026-10-06)**: `main` is at the merge of the x86-64 encoder; CI on the two earlier pushes failed in `bun run test` (a stale digest of the regenerated `site/page.a0`, fixed in the next push, and `results/behavior.json`, which is stale for the new `biglit` row and has to be regenerated by `bun run behavior` on a machine where every target runs: a Windows run records 9 targets as blocked and was not committed). The site source is updated and built (`site/dist`) but not deployed: deploy with `bun run site` and `vercel deploy --prod` from `site/dist` on a machine with the Vercel CLI logged in. Open work, in order: regenerate `results/behavior.json`; show the lexer's keyword table in the A0 view (a `compiler/*.a0` change, needs `bun run seed` on a POSIX machine); A0 ports of `src/pe.ts` and `src/elf.ts`; wire the encoders and writers into `a0 build`; quiet-machine arm64 timing; the loss ledger is at 583 (the application-scale arms added six losses, each with its own blocker entry).
- **Dependency-scoped program view** (pre-registered in `docs/history/2026-10-06-app-edit-deps-preregistration.md`, result in `results/app-edit-deps.json`; the A0 request of the application-scale benchmark lists only the functions the target reaches instead of every signature: 1245 tokens against 4827, `results/app-edit-deps/view-tokens.json`): rule met on both models. Accepted after repair 9 against 7 (Haiku) and 13 against 12 (Sonnet) compared with the full listing; tokens per accepted edit 2348.3 against 10130.1 and 1576.5 against 5893.3. Against TypeScript (7960 and 7277.3) A0 now costs less per accepted edit on both models; TypeScript still has more accepted (13 against 9 on Haiku, 14 against 13 on Sonnet): one loss recorded (the ledger is at 584). The shipped MCP tool `a0_program` already returns this view when given a target; the benchmark harness keeps the full listing as its default (the sealed arm) and takes the scoped one with `A0_PROGRAM_VIEW=deps`.


## Wording arm of the application-scale edit benchmark (2026-10-06)

The revised view-choice wording did not meet the pre-registered rule: Haiku 8 of 14 accepted both ways (cost per accepted edit 20304.9 against 20521.7), Sonnet 12 against 11 accepted and cost 5343.7 against 4690.4 (see `results/app-edit-wording.json`). No change to the shipped skill or MCP text. Pre-registration: `docs/history/2026-10-06-app-edit-wording-preregistration.md`.


## Word-key legend in the A0 view (2026-10-06)

The view of a function now ends with a one-line key legend when an `eq`/`ne` literal is the parser word key of a known word (`src/wordkey.ts`). Measured on the five tasks whose request changes (`results/app-edit-keys.json`): Haiku 10 of 14 accepted (9 without), Sonnet 14 of 14 (13 without), both at lower cost per accepted edit; Sonnet now ties TypeScript on acceptance. Haiku still trails TypeScript (13); the remaining misses are model errors. Also this round: seed bootstrap runs on Windows, benchmark load is read from CPU utilisation on Windows (`tools/system-load.ts`; `os.loadavg()` is always 0 there). The full gate still fails on this machine (see its debugging agent); the site is not deployed (needs a logged-in Vercel CLI).


Quiet rerun of the noop JS kernel on Windows x64 (`results/exec-benchmark-noop-win32.json`, load 2.4 of 8 CPUs): a tie (A0 20.4 ns against hand-written JS 18.7 ns). The recorded loss (8.5% gap against an 8.2% noise band at load 6.4) is from another platform and stays in the ledger. The exec-bench harness now runs on Windows (`where.exe` lookup, `-pthread`, `.exe` names).


Quiet Windows x64 rerun of the wasm benchmark against clang (`results/wasm-benchmark-win32.json`, two runs agree, load 2.2 of 8 CPUs by CPU utilisation, interleaved samples): geomean 1.059 (above 1 is A0 faster); losses on chain3 (0.89x), arrfill (0.69x) and prefix1k (0.85x), ties on ident, noop, branchy, hist256, xs4k, filter2, wins on arrfill4k, loop64, dot1k, mat4, fnv4k, minmax1k. wasm-bench now records platform and load (it recorded neither).


The A0014 diagnostic (wrong operand count) now shows the chain when an associative binary op (`add`, `mul`, `and`, `or`, `xor`) is written with more than two operands (`src/core.ts`, `test/operand-chain-hint.test.ts`); no measurement of its effect on model acceptance has been made, so no claim is attached. It targets the `number-leading-zero` miss on Haiku in `results/app-edit-keys.json`.


The wasm benchmark file `results/wasm-benchmark.json` was regenerated on a quiet Windows x64 machine with platform and load recorded (before, it recorded no load and 21 ledger rows were unverified). The ledger now has 586 entries, none unverified: 8 ns-per-trip losses against clang, 14 wasm-load-ms (noisy: the A0 to clang ratio moved by up to 0.27 between two runs), 1 wasm-bytes; 7 earlier entries are gone or tied. Geomean 1.055 (above 1 is A0 faster).
