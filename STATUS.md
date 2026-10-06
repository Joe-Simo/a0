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

## Windows (x64) support, 2026-10-06

First full test run on Windows 11 x64 with Node 22 and bun, no C compiler, Java, Icarus or tree-sitter installed: the build and
`a0 check` work; of 357 tests, 322 pass, 22 skip and 14 fail only because a required toolchain is absent (clang for the C, parallel,
trap and seed tests; tree-sitter). Fixed in this pass: LF pinned in `.gitattributes` (a `core.autocrlf=true` checkout turned every
source, seed and golden file into CRLF); tool discovery no longer calls `/usr/bin/which` (`src/toolchain.ts`); the LSP linked-path
parser accepts drive-letter paths; the git merge driver command is quoted with forward slashes; tests no longer assume POSIX
virtual paths, `/bin/cat`, or the right to create symlinks (they skip with a reason). Not done: the 14 toolchain-bound tests have
not run on Windows, so C, parallel C, trap and seed behavior there is unverified. The application-scale benchmark harness
(`tools/app-edit-*.ts`) is not in the public repository and is therefore still blocked.

Protocol fix (2026-10-06, item 3, first of three): an `ex` line written after the first node of a function is hoisted under the
header instead of refused (A0714), so the canonical text is the same wherever the writer put it (`test/spec.test.ts`). `pre` and
`post` after a node stay ordinary node ids (they are ambiguous there). Not yet re-measured with fresh subjects, so no acceptance
claim is made. Still open: the spec-line limits are not taught, and dense nesting of a repeated value.

Windows toolchain note (2026-10-06): with Zig 0.17.0 unpacked outside the repo and a small `clang.exe` shim that runs `zig cc`
(`A0_CLANG`, `A0_GCC` set), 320 of 358 tests pass here. The remaining C-dependent failures are not compiler bugs: the tests and tools
build executables with `-o name` and run `name`, but a Windows compiler writes `name.exe`, so the run step finds nothing (about 100
call sites in `test/` and `tools/`). Needs one shared `exe()` helper and a mechanical pass; not done. Unverified on Windows: the C,
parallel C, trap and seed tests, and every benchmark (speed claims need a quiet arm64 machine in any case).

Windows C backend (2026-10-06, compiler `a0c-0.1.38`): the parallel C runtime compiles on Windows (`windows.h` and `GetSystemInfo` replace
`sys/resource.h` and `sysconf` under `_WIN32`; POSIX text unchanged), so `COMPILER_VERSION` is bumped and the golden hashes
regenerated. With a Zig-based `clang`/`gcc` shim, the C every-op-at-the-boundaries tests (strict and canonical, clang, gcc, C++,
optimized and not) and the parallel and strict-target tests pass on Windows x64, and the site generator reproduces `site/page.a0`
and `site/docs.a0` byte for byte (the driver sets binary stdio). Still failing here, all environmental: tree-sitter (not
installed), AddressSanitizer (Zig ships none), the seed rebuild (not yet diagnosed), a direct-spawn CRLF check in
`strict-targets`, and an ELF x86-64 assembly check. Results files were not regenerated (that is the full gate's job, which needs the
arm64 machine); do not push this branch before `a0-dev gate` passes there.
The seed bootstrap (`seed/driver.c`) is POSIX-only (fork, pipes, `sys/wait.h`): on Windows build the seed under WSL or MSYS2. Its two tests skip on Windows with that reason; a native port of the driver is open work.

## Loss ledger by axis: what blocks each group (2026-10-06, `results/loss-ledger.json`, 577 entries)

None of these is closed by this session; each group has its own blocker and next action.

| Axis (entries) | What it is | Blocker | Next action |
|---|---|---|---|
| tokens-kernel (377) | Canonical A0 text of the ten lang-axes kernels costs more tokens than most competitors' idiomatic kernels; the opt-in dense view is far smaller (`results/dense-tokens.json`). Canonical losses are never replaced by dense rows. | Closing it needs a smaller canonical syntax (a grammar change touching the parser, the self-hosted front end and the seed, plus a fresh-subject re-measurement) or making dense the default; neither is measured yet. | Pre-register and measure dense as the shipped default on sealed set g with fresh Haiku and Sonnet. |
| primer-* (91) | Primer-ablation variants that lost to a control on one-shot acceptance, repaired acceptance or tokens per accepted edit (`results/primer-ablation.json`). | Needs new fresh-subject runs; the three protocol ambiguities behind most failures are only partly fixed (`ex` after a node is now hoisted). | Fix result-type-in-head, spec limits and dense nesting generally, then re-run d, e, f. |
| ai-tokens-* and ai-accepted-* (46) | Whole-task token cost against TypeScript and Rust on single-function tasks: the primer is paid every call. | Same as above; reversed only for large programs (`results/ai-edit-experiment.c.*`). | The application-scale benchmark, blocked: its harness and seal are on a branch that was never pushed. |
| spec-* (40) | Spec lines (opt-in) cost tokens and did not raise acceptance (`results/spec-lines.json`). | Measured and recorded; they stay out of the guide. | A task set where provided examples actually refuse wrong edits. |
| wasm-load-ms, wasm-bytes, ns-per-trip, ns-per-call-js (23) | Speed and size against hand-written clang, JS and wasm. | Timing needs a quiet machine (load at most 10); this session ran on a Windows x64 laptop with no arm64 and no quiet run. | `bun run exec-bench` on the arm64 machine, overnight. |

Dense as the default, from data already measured (`results/loss-blockers.json`, `denseAsDefault`; source `results/primer-ablation.json`, sets e and f,
24 tasks per model, fresh Haiku and Sonnet): the 145-token dense primer beats the best canonical primer (101 tokens) on tokens per accepted edit
in a 10-task session and unbounded on both models (Haiku 168.9 against 184.3, Sonnet 130 against 142.4 at 10 tasks) and loses the cold
single-task cost on both (Haiku 339.7 against 298.1, Sonnet 293.4 against 256.2); acceptance is within noise. This supports making dense the
recommended form for sessions of several edits (open decision 3 above) and does not close the single-call losses. No new run was made.

Set H (2026-10-06, `results/set-h.json`, `docs/history/2026-10-06-dense-default-preregistration.md`): the pre-registered confirmation of dense against canonical on a new sealed set
of 16 tasks, fresh Haiku and Sonnet subagents, did NOT hold. Dense one shot 12 and 14 of 16 against 13 and 16 for canonical, and a higher cost per accepted
edit at the 10-task horizon on both models (Haiku 187.0 against 162.9, Sonnet 120.5 against 114.9). The e and f advantage above is therefore not a reason to make dense the
default; the 325 dense-view token entries stay open. Dense failures were the known ambiguities (positional parameters in fold helpers, operand counts, repeated values).
