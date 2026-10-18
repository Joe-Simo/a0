# A0 status

2026-10-18 shared lazy-error source control: the isolated A0 algorithm has lower frontend and
pipeline medians than its unchanged native C control on all six frozen inputs, while CPU, RSS
and fresh-child wall losses remain. It is not adopted as a default, and all historical Canonical
and Dense frontend medians remain lower. The complete run, raw cells, losses and exact source
history are retained (`results/source-cost-shared-lazy-error-decision.json`,
`results/source-cost-shared-lazy-error.json`, `results/source-cost-shared-lazy-error-samples.json`;
replay in `experiments/unification/compiler-codegen/shared-lazy-error.md`).

2026-10-18 read-array Wasm control: all 240 emitted C hashes match at maximum recorded load 1.9,
but the direct frontend remains slower than the C-derived control on all six applications
(1.23–2.08×). Boot takes 2640.11 ms versus 1299.51 ms for the C-derived frontend and 191.76 ms
for old Canonical. The two direct components total 143092 bytes, with a proved 16-byte arena stack;
smaller artifacts and lower linear memory do not clear the latency losses. This paired run does not
isolate the read-array fold optimization against the earlier direct backend. The official frontend
remains unchanged; full cells, audits and scope are in `results/unified-source-read-array-wasm.json`,
`results/unified-source-read-array-wasm-samples.json` and
`results/unified-source-read-array-wasm-decision.json`.

2026-10-18 direct Wasm control: all 240 emitted C hashes match at maximum recorded load 1.7,
but the boot frontend median is 2716.08 ms versus 189.73 ms for old Canonical and 1291.83 ms
for the C-derived frontend. The direct components total 143167 bytes and use less linear Wasm
memory than the C control after deriving the generic arena stack bound; these reductions do not
clear the latency loss. The public default is unchanged (`results/unified-source-direct-wasm.json`,
`results/unified-source-direct-wasm-samples.json`, `results/unified-source-direct-wasm-decision.json`).

2026-10-18 transport controls: borrowing LOAD replies passes the wire and graph controls but
loses on all six frontend latency and live RSS medians; boot rises from 1291.52 to 1350.19 ms
(`results/unified-source-reply-view.json`, raw cells in
`results/unified-source-reply-view-samples.json`). Its executable artifact grows from 356280 to
407914 bytes. Factoring its failure path still yields 402760 bytes; generic bulk writes yield
384748 bytes (`results/unified-source-transport-size-controls.json`). Those latter variants have
no latency or memory measurements. All are rejected; the production runtime and native fixture
retain the unchanged implementation. Replay patches and limits are in
`experiments/unification/runtime-transport/README.md`. Native frontend cost still blocks the
official single-syntax cutover.

2026-10-18 native graph checking: the shared dependency loader now parses each source file once,
composes its native IR and checks the complete graph once. Original and migrated projects pass all
178 accepted entries (`results/unified-native-graph-source-audit.json`); per-file checks are in
`results/unified-native-graph-unit-audit.json`. The candidate checks its own 609 functions across
19 modules with exact normalized IR and optimized C (`results/unified-native-graph-self-source.json`;
artifact provenance in `results/unified-native-graph-build.json`). This remains an internal candidate;
full diagnostics, editing integration, performance and public tooling cutover remain open.

2026-10-18 size-optimization control: all 240 backend hashes match at maximum recorded load 2.96,
but `-Os` is slower on the larger programs. Boot rises from 1277.79 to 1501.35 ms; page rises from
203.27 to 225.75 ms. The artifact shrinks from 356280 to 204765 bytes and the two small programs
improve, so the result is mixed. The default remains `-O3` (`results/unified-source-opt-size.json`,
raw cells in `results/unified-source-opt-size-samples.json`). These measurements do not clear the
old Canonical control or establish a shipping frontend improvement.

2026-10-18 native artifact packaging: the default frontend fixture is 356280 bytes, down from
417837 bytes with debug metadata. Every standard Wasm section and import/export is byte-identical
(`results/unified-native-release-sections.json`). `--symbols=keep` retains the debugging build.
This establishes a packaging reduction; frontend timing and the public syntax cutover remain open.

2026-10-18 bulk-memory control: all 240 backend hashes match in the paired six-workload run,
but the result is mixed. Boot native time falls from 1270.91 to 1187.97 ms; frame rises from
23.74 to 24.35 ms and boot live frontend RSS rises from 143.69 to 156.58 MiB. The artifact builder
therefore keeps MVP code generation as its default; bulk memory remains an explicit research
option. Neither native build clears the old Canonical control (`results/unified-source-bulk-memory.json`,
raw cells in `results/unified-source-bulk-memory-samples.json`).

2026-10-18 source-cost control: the native candidate remains ineligible for cutover. The matched
192-cell run has identical backend outputs and maximum recorded load 2, but the boot frontend
median is 1269.10 ms versus 184.44 ms for old Canonical; the parser/checker plus C emitter takes
2387.88 ms versus 1311.49 ms (`results/unified-source-cost.json`, raw cells in
`results/unified-source-cost-samples.json`). These flattened inputs exclude graph I/O, shipping
startup and target execution. Peak RSS has a common measurement floor in smaller inputs and
must not be read as proof of equal frontend memory. That source revision's correctness audit passes all
177 source entries (`results/unified-source-cost-audit.json`); it does not erase the timing loss.

2026-10-16 publication update: first-party A0 source, editor and plugin packages use Apache 2.0 with copyright notices; third-party notices retain their original licenses. The website now includes the corrected independent Codex syntax study and its complete replay archive (`results/unification-codex-v2-replication.json`, `experiments/unification/README.md`). Earlier Dense-guide comparative conclusions are withdrawn (`results/unification-codex-guide-erratum.json`). This publication keeps the current compiler: unified syntax, native frontend performance, migration and the tool cutover remain unfinished. Historical language benchmarks retain their dates and scope.


Last updated 2026-10-18, compiler `a0c-0.1.66` (`COMPILER_VERSION` in `src/targets.ts`). This is the current state of the project:
what exists, what is measured and where the numbers live, what is lost or unknown, how to reproduce it, and what comes next.
Every number on this page is in the `results/` file named beside it, or is reproduced by the command shown. The long record of
how the project got here, session by session, is in [docs/history/](docs/history/) (index at the end). Contributing rules are in
[CONTRIBUTING.md](CONTRIBUTING.md); the design and semantics are in [DESIGN.md](DESIGN.md).

2026-10-17 path-conformance repair: the public and native linkers resolve missing paths through their nearest existing ancestor, preserving lexical entry identity and rejecting escapes through directory symlinks. This corrects aliased-root diagnostics. The standard emission matrix differs only by compiler version tags (`results/native-path-alias-conformance.json`, `results/compiler-0.1.63-emission-parity.json`).

## What exists

Syntax unification is in progress: the linker now connects parsed programs directly to the shared
validator, and `a0 migrate` creates a verified source-dependency copy using the existing Dense
printer. Both source readers still exist; the language has not yet met the single-syntax goal.
Scope, migration instructions and outstanding gates: [unified syntax](docs/design/unified-syntax.md).

The flat candidate builds from `compiler/source_frontend.a0` and shared compiler modules,
with a portable host that decodes checked IR without a second parser or validator. The committed
earlier corpus audit passed all 176 accepted source entries, including guarded migration and exact native
IR/type facts, and parses its own 604-function source to identical optimized C
(`results/unified-source-unit-frontend-audit.json`, `results/unified-source-unit-build.json`).
Source units use the same parser before whole-program checking (`results/unified-source-unit-audit.json`).
The independent specification controls pass 30 cases (`results/unified-source-unit-specs.json`).
The current increment adds native dependency IR composition through the shared graph loader and
an executable fixture bound to its source and transport inputs. Complete diagnostics/tool integration,
full gates and the recorded frontend performance losses still prevent an official source cutover; no compilation or AI accuracy gain
is claimed by this increment.

- **Language.** Types `u32`, `bool`, fixed-size arrays and records, and the linear `io` token; pure, total, exactly specified
  operations (wrapping unsigned arithmetic, logical shifts, total `div`/`rem`); `call`, bounded `fold`, early-exit `loop`, `text`.
  No recursion, no heap, no floating point. Reference: `DESIGN.md`, `MODEL_GUIDE.txt`.
- **Edits.** Revision-checked structured edits through handles (function `e0`, program `g0`): replace, insert, delete, change the
  result, whole-function add and replace, validated as one program and committed atomically. Diagnostics are one table
  (`src/diagnostics.ts`) with stable codes, fixes and `a0 explain`. A dense surface syntax (`src/dense.ts`) is opt-in.
- **Targets.** JavaScript, C (also valid C++), Java, C#/.NET, SystemVerilog, Metal, direct AArch64, x86-64, RISC-V RV64, AVR and
  ARM32 assembly, direct wasm32, and parallel C. One program, one oracle (`tools/corpus.ts`, independent BigInt arithmetic).
- **Self-hosting in progress.** A0 implementations of the lexer, parser, checker, optimizer and C, AArch64 and wasm32
  emitters exist in `compiler/`. The shipped CLI still depends on TypeScript for compiler logic and other targets.
  The C and AArch64 bootstraps reach a byte-identical fixed point; a text-only bootstrap seed is in `seed/`.
  The remaining work and completion criteria are in [Entire compiler in A0](docs/design/compiler-selfhosting.md).
- **Tools.** The `a0` CLI, an MCP server (`a0 mcp`), an LSP server (`a0 lsp`), editor grammars, an agent skill and plugin, and the
  development loop in `tools/dev/` (`a0-dev`). The site a0lang.com is two A0 programs (`site/page.a0`, `site/docs.a0`).

## Current results

Source unification is in progress: grammar-independent A0 arena construction and direct parsed-IR
linking are implemented. The recorded edit-study outcomes are preserved, but their Dense guidance
incorrectly described generated IDs and omitted operation/function-name escaping. Their comparative
AI-cost conclusions are withdrawn. A matched corrected-guidance replication meets the bounded
AI-cost rule; its small reused task set does not establish production readiness.
Compiler timings still contain losses, and the official syntax and tooling cutover remain unfinished.
Raw outcomes, timing samples and conversion evidence are recorded in `results/unification-codex-v1.json`,
`results/unification-codex-v2.json`, `results/unification-codex-v2-replication.json`,
`results/unification-link-header-scan.json` and
[the refactor record and guide erratum](docs/history/2026-10-16-unified-source-refactor.md).
An integrated A0 grammar/checker/verifier prototype now rebuilds to a portable artifact and preserves
whole-program typed IR, Specs and emitted output in component comparisons. Its measured compilation
time and memory regressions block cutover; the existing public frontend remains authoritative.
The raw matrices and reproducible snapshot are recorded in `results/unification-portable-frontend.json`
and `experiments/unification/frontend-a0/README.md`.
The first feature gate failed native-link parity and stale corpus-count checks; the native header fix
passes focused verification. Updated whole-suite and promotion gates remain pending. Evidence:
`results/unification-initial-gate.json`, `results/unification-native-link-header.json`.
The next feature gate passed those fixes but failed Java checks against stale linked-graph
expectations. Independent linking and evaluation confirm the corrected expectations, and the
isolated Java checks pass. The whole-suite rerun is pending. The original and corrected rows
are preserved in `results/unification-java-oracle-correction.json`.

Current integration (`a0c-0.1.63`) adds experimental arena services for Darwin arm64, RISC-V64, Wasm and Java,
plus canonical formatting, semantic revisions and UTF-8 provenance. Native C/x86 emitters reuse private
intermediate record storage when lifetime and alias checks permit it. Component tests and limits are linked
from [Entire compiler in A0](docs/design/compiler-selfhosting.md). The public compiler still uses TypeScript;
full Dense and optimizer migration remain unfinished. The project now uses Apache-2.0, with third-party
licenses retained in the distributed notices.

Previous migration milestone (`a0c-0.1.60`): canonical checked arithmetic and array access are implemented in the A0 C,
AArch64 and Wasm emitters. A0 optimization now uses weighted expansion costs and recognizes square-matrix recurrences;
the reference optimizer also preserves the unsigned exponent when an earlier call exposes a large iteration count.
The website compiler tool builds from the verified A0-generated seed. A0 optimization supports canonical checked
operations; strict trapping semantics remain explicitly unsupported in these A0 paths.
The experimental arena frontend now includes parsing, typing, ordered spec verification, interpretation and a partial diagnostic formatter.
Additional A0 JavaScript, Java, SystemVerilog, x86, RISC-V and ARM32 emitters and ELF/PE writers are available
for integration. Their source/table interfaces and limits are documented in [Compiler ports](docs/design/compiler-ports.md).
The shipped CLI still uses TypeScript compiler stages; the entire compiler migration is in progress.
Reproduce the focused coverage with `node --test dist/test/selfhost-*.test.js dist/test/matrix-u32-exponent.test.js dist/test/arena-frontend.test.js dist/test/arena-program.test.js`
after `bun run build`; the bootstrap reproduction check is `bun run seed`.

Readonly C iteration extras (`a0c-0.1.58`): minmax, filtering and binary search improved
62.01×, 67.39× and 10.21× against the previous compiler; UTF-8 decoding, tokenization and
heap operations improved 2.66×, 1.91× and 1.17×. These are quiet, interleaved Linux measurements
of emitted C. Several still trail handwritten C; they do not establish a universal ranking.
Evidence: `results/c-readonly-extras-linux.json`. See
[the internal callback change](docs/history/2026-10-16-c-readonly-extras.md).

JavaScript deep record state (`a0c-0.1.57`): the Linux heap comparison improved from
3,218,934 to 17,128 ns/call (187.93×); handwritten JS measured 11,950 ns/call. One observed
call dropped 1,651 typed-array copies (3,381,248 bytes) to zero. The generated heap module
grew 42 bytes; the warm compilation study's median increased about 1.1%.
Evidence: `results/js-deep-owned-heap-linux.json`.

Previous iteration work (`a0c-0.1.56`, 2026-10-16): JavaScript sieve and insertion sort improved
20.01× and 14.17× against the previous compiler; direct x86 heap operations improved 6.51×.
Evidence: `results/owned-iterations-linux.json`. This comparison predates the deep-state
measurements above. See
[the ownership and predicate changes](docs/history/2026-10-16-owned-iterations.md).

Earlier native work (`a0c-0.1.55`, 2026-10-16): hash lookup improved 10.00× for emitted C and
9.93× for direct x86 against the previous compiler in a quiet, interleaved Linux run.
Both still trail handwritten C. Evidence: `results/native-readonly-hash-linux.json`. See
[the native ownership change](docs/history/2026-10-16-native-readonly-ownership.md).

Earlier JavaScript work (`a0c-0.1.54`, 2026-10-15): hash lookup improved 93.75× against
the previous compiler in a quiet, interleaved Linux run; it still trails handwritten JavaScript.
Evidence: `results/js-readonly-hash-linux.json`. See
[the scalar-read ownership change](docs/history/2026-10-15-js-readonly-ownership.md).

Earlier WebAssembly work (`a0c-0.1.53`, 2026-10-15): WebAssembly hash lookup improved 5.55× against
the previous compiler in a quiet, interleaved Linux run; it still trails clang. Evidence:
`results/wasm-readonly-hash-linux.json`, with the broader run in `results/wasm-readonly-ab-linux.json`.
See [the ownership change](docs/history/2026-10-15-wasm-readonly-ownership.md) for scope and reproduction.

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
| Token counts | the ten lang-axes kernels: 541 tokens canonical, 193 in the dense view (o200k_base). Corrected 2026-10-09 from 559 and 202: the token axis now counts A0 noop as the identity every competitor writes (`ret p0`), not the timed noop with three redundant ops (docs/history/2026-10-09-noop-token-identity-declaration.md); noop is 13 canonical and 3 dense against best 5 (OCaml) | `results/dense-tokens.json`, `results/lang-axes.json` |

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

`results/loss-ledger.json` (`bun run loss-ledger`, part of `bun run lint`) holds 616 historical loss rows:
337 for kernel tokens, 90 for whole-task tokens, 107 for acceptance, 41 for execution time,
28 for startup time and 13 for artifact size. All 69 timing rows have a recorded load within
the limit of 10; none is unverified by that criterion. Non-timing rows do not require a load.
This corrects the earlier stale counts of 446 losses and 21 unverified timings. Newer paired
ownership reports above supersede some older measurements; the ledger is not a current universal
ranking. A new or worsened ledger loss fails lint, and growing it needs `--update --reason`.

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

1. Re-run the results recorded under load (`results/parallel.json`, `results/edit-loop.json`)
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
14. TODO: start recording what building A0 costs (tokens and money per session or per merged branch, and which commits were written by a person and which by an agent). The repository records neither today; the README section "How A0 was built" says "not tracked" until this exists.
15. Record the compiler and runtime version of every language in `results/exec-benchmark-full.json` (today only `node`, `clang` and `rustc` are written), and have the `/benchmarks` page read the machine, tool versions and sample counts of its Method section from the results files (they are text in `site/gen/bench.tpl` today).

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


Git-connected Vercel deploys: the site build needs clang (not in Vercel's build image), so the prebuilt site is committed in `deploy/` (`bun run site:publish`) and the root `vercel.json` serves it with no build, with the same headers and redirects as `site/dist/vercel.json` (`test/vercel-config.test.ts`). Refresh `deploy/` and commit it whenever the site or the results it shows change.

2026-10-07 failure taxonomy (`docs/design/failure-taxonomy.md`, `results/failure-taxonomy.json`): 1447 first-attempt failures of A0 subject trials classified by root cause; five tooling fixes made from it (markdown fences ignored in edit replies, exact `-id` delete fix A0504, exact op-spelling renames `sel` to `select` etc., a callee defined below its caller moved above it on edit, A0026 names the `ret` line), each with unit tests and reject-corpus cases. Rerun of the four application-scale tasks Haiku missed (`results/app-edit-fixes.json`, pre-registered in `docs/history/2026-10-07-failure-fixes-preregistration.md`): Haiku 0 of 4 accepted (0 before), Sonnet 3 of 4 (4 before); the pre-registered rule is not met and none of the five changes fired in those 13 replies, so the measurement neither supports nor refutes them.

## Lazy primer V4 (2026-10-07)

A 137-token self-contained primer with the rules moved into triggered hints (`src/lazy.ts`, off by default behind `A0_LAZY_HINTS=on`) was measured against the shipped V3 on the new sealed set Z (32 tasks), fresh Haiku and Sonnet subagents, one shot plus one repair (`results/primer-v4.json`, pre-registration and result in `docs/history/2026-10-07-primer-v4-lazy-preregistration.md`). Not shipped: the registered rule needs both models and Haiku fails it (21 accepted against 26, 10-task cost 467.5 against 348.7); Sonnet passes it (31 against 31, 207.3 against 213.2, cold task 360.1 against 539.8). The shipped primer, the skill copies and the ledger are unchanged. Next lever, on a new blind set: accept the op names models invent as exact fixes in the checker, which costs nothing unless a model writes them.

## Exact fixes for invented ops, and V4 again on set AA (2026-10-07)

The checker now rewrites operator symbols in op position, `add mul and or xor` with more than two operands (a chain), `not` on a bool and `max`/`min` on u32 as exact fixes, and names what to write for `neg`, `abs`, `cmp` (`A0_NEW_FIXES=off` restores the old diagnostics). Deterministic replay of the recorded replies (`results/invented-ops-replay.json`) accepts no extra task through the new rules. Live run on the new sealed set AA (30 tasks, `results/invented-ops-fixes.json`, pre-registration and result in `docs/history/2026-10-07-invented-op-fixes-preregistration.md`): V3 with the new fixes ties V3 with the old (Haiku 22 and 22 accepted, Sonnet 30 and 30; no new rule fired); the V4 text meets the registered rule (Haiku 25 against 22, 10-task cost 279.5 against 382.0; Sonnet 30 against 30, 173.2 against 190.9), which it did not on set Z. The primer is not changed here: the two sets disagree and the result is not an effect of the fixes; the decision is the owner's.

## V4 tiebreak on set BB (2026-10-07)

A third blind sealed set (BB, 30 tasks) settles the disagreement between sets Z (V4 fails on Haiku) and AA (V4 passes): pooled over Z, AA and BB, V4 accepts 69 against 73 (Haiku) and 88 against 91 (Sonnet) of 92, and costs 355.5 against 353.3 and 208.3 against 203.0 tokens per accepted edit at the 10-task horizon, so the registered rule is not met (`results/primer-v4-tiebreak.json`, `docs/history/2026-10-07-primer-v4-tiebreak-preregistration.md`). V4 is cheaper only on the cold task. The shipped canonical primer V3 stays; nothing else changes.

## Combined edit protocol, pre-registered run (2026-10-10)

The combined A0 edit protocol (bodies view, DR2 primer, typed header, compact three-tool MCP surface) FAILS its
pre-registered rule for Haiku and Sonnet (`results/edit-protocol-2026-10-10.json`,
[record](docs/history/2026-10-10-edit-protocol-preregistration.md)). Against the shipped dense control it costs
0.30x / 1.57x / 2.95x tokens per accepted edit (Haiku; Sonnet 0.28x / 1.53x / 3.04x) at the cold / 10-task / unbounded
horizons, with equal after-repair acceptance: its system text is too short to cache, the control's is cached. Against
TypeScript it costs 1.35x (Haiku) and 1.26x (Sonnet) and accepts one task fewer after repair. Recorded as losses in the
ledger; the shipped default stays. Rust was not scored (no Rust toolchain on the scoring machine).

Correction (2026-10-10): the ratios above priced every cache read at 0.05x (the Opus rate) and the unbounded horizon
never charged the 1.25x cache write. Re-priced from the per-trial reports at the Haiku/Sonnet rule (write 1.25x once per
session, read 0.1x, 512-token minimum; costs modelled from local o200k counts, not billed), the combined arm against
the dense control costs 0.30x / 1.31x / 1.86x / 2.08x (Haiku; Sonnet 0.28x / 1.27x / 1.86x / 2.10x) at cold / 10 / 50 /
unbounded edits (control 1825.4 / 419.4 / 294.4 / 263.2 tokens per accepted edit for Haiku, 1750.3 / 384.4 / 263.0 / 232.6
for Sonnet; `results/edit-protocol-2026-10-10.json`). Against TypeScript the figures do not change (1.35x, 1.26x; neither
system text is cached). The verdicts do not change: FAIL for both models. Fairness caveat: any A0 advantage over
TypeScript at long horizons (the dense control at unbounded: 263.2 against 405.8 for Haiku, 232.6 against 388.6 for Sonnet)
comes from A0's system text crossing the cache minimum while TypeScript's does not, not from shorter edits.
