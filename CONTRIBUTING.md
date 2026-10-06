# Contributing to A0

Thank you for looking. This file is the way in: what A0 is, how the repository is laid out, how to build and test it, the rules
that keep its measurements honest, and where the project is going. A0 is a research project with a working compiler, not a
finished product; the current state, with its losses and limits, is in [STATUS.md](STATUS.md).

## What A0 is

A0 is a programming language built for AI to read and write: compact, exactly specified, and edited through revision-checked
structured edits, so a model reads only what an edit touches and writes only the changed lines, and nothing invalid lands. One
program compiles to native machine code, wasm32, JavaScript, the JVM, .NET, GPU kernels and clocked SystemVerilog, and every target
is checked against one independent oracle. Ordinary compilation is deterministic and needs no model.

The goal is measurable: fewer tokens and fewer failed edits for an accepted change, fast compilation, and execution that ties or
beats strong hand-written baselines. A win, a tie and a loss are recorded separately, and a loss is never averaged away.

- Intent and semantics: [DESIGN.md](DESIGN.md). The language as a model sees it: [MODEL_GUIDE.txt](MODEL_GUIDE.txt) and the
  short primer `MODEL_GUIDE.min.txt`.
- Install, MCP server, LSP, agent integrations: [README.md](README.md).
- Rules for automated agents working on the repository: [AGENTS.md](AGENTS.md).

## How to contribute: fork, branch, pull request

You do not need write access, a paid service, an API key or a particular machine. Everything the checks need is free and runs locally.

1. **Fork** the repository on GitHub and clone your fork:
   ```bash
   git clone https://github.com/<your-user>/a0.git
   cd a0
   git remote add upstream https://github.com/Joe-Simo/a0.git
   ```
2. **Branch** from an up-to-date `main` (`git fetch upstream && git switch -c my-change upstream/main`). One branch per change; keep a change small
   enough to review.
3. **Install and build** (Bun and Node 22 or newer; see the next sections): `bun install --frozen-lockfile`, then `bun run build`.
4. **Make the change**, with a test for a behavior change. A new diagnostic is one row of `src/diagnostics.ts` with its examples; a change to
   `compiler/*.a0` also needs `bun run seed` (see below). Do not edit `results/*.json` by hand: tools write them.
5. **Check it locally** before you push:
   ```bash
   bun run lint        # Biome, claim check, loss ledger, results scrub check
   bun run typecheck
   bun run test
   ```
   The full gate (`bun run a0-dev -- gate`) runs every step that your installed toolchains allow and reports a step it cannot run as blocked with the
   reason, never as a pass. You do not have to run all of it: a pull request is checked by CI, and a maintainer runs the full gate before merging.
6. **Commit** with a message that says what changed and why. Do not commit local paths, usernames, `.env` files, keys or editor settings
   (`test/hygiene.test.ts` fails if you do). Never skip the repository's hooks.
7. **Push** to your fork and **open a pull request** against `Joe-Simo/a0:main`. Fill in the template: what the change does, how you checked it, and which
   `results/` file backs any number you quote. Reviewers may ask for changes; push them to the same branch.

Things that are welcome: a bug report with a minimal `.a0` program, a failing test, a new diagnostic or fix, a backend or an experiment language
(sections below), documentation fixes, and measurements that show where A0 loses. Things that are reworked rather than merged: a number or a
comparison without a `results/` reference, a timing claim from a loaded machine, a change that hides a loss, or one that edits a sealed task set.
Open an issue first for a change to the language itself (the grammar, the semantics, the edit protocol): those need a design discussion and a measurement.

**Platforms.** Linux and macOS are the primary development platforms. On Windows the compiler, the tests, the MCP server and the language server work
with Bun and Node 22+ (git for Windows with `core.autocrlf` off or the repository's `.gitattributes`, which pins LF); the checks that need a C compiler
use `clang` or `gcc` if one is on PATH (`A0_CLANG` and `A0_GCC` point at others); timing benchmarks refuse to run there (Windows has no load average, so a
quiet-machine claim could not be verified), and the seed bootstrap (`seed/bootstrap.sh`) needs WSL or MSYS2. Tests that need a tool you do not have
are skipped or reported as blocked with the reason. Maintainer-only steps (`a0-dev drive`, release, pushing results) are not part of a contribution.

## Layout

| Path | What is there |
|---|---|
| `src/` | The TypeScript compiler: `core.ts` (grammar, types, validation, reference interpreter), `edit.ts` (revisions, sessions, handles), `optimize.ts`, `backends.ts` (emission and the target table), one file per direct backend (`arm64.ts`, `x86_64.ts`, `riscv64.ts`, `avr.ts`, `arm32.ts`, `wasm.ts`), `dense.ts`, `diagnostics.ts`, `mcp.ts`, `lsp.ts`, `cli.ts` |
| `compiler/` | The compiler written in A0: lexer, parser, checker, optimizer, C, AArch64 and wasm32 emitters |
| `seed/` | The text-only bootstrap seed (C) and its manifest; `sh seed/bootstrap.sh` needs only a C compiler |
| `test/` | `node --test` suites, compiled from TypeScript |
| `tools/` | Verification and benchmarks (`verify.ts`, `bench.ts`, `exec-bench.ts`, `lang-axes.ts`, ...), the AI-edit experiment (`ai-edit-*.ts`, `edit-langs/`), the results scrub (`scrub-results.ts`) and the development loop (`dev/`) |
| `results/` | Machine-readable evidence. Every number in the docs points at a file here |
| `examples/`, `corpus/` | Example A0 programs, rejected-program corpus |
| `site/` | The a0lang.com site, which is itself A0 programs (`page.a0`, `docs.a0`) plus a generic browser runtime |
| `editors/`, `plugin/`, `integrations/`, `mcpb/` | Editor grammars, the agent skill and plugin, ready-to-copy agent configs, the MCP bundle |
| `experiments/primers/` | Primer variants that were tried and not adopted; results files name them as `MODEL_GUIDE.<variant>.txt` |
| `docs/` | `DEVELOPMENT.md` (the development loop) and `docs/history/` (dated records of past work) |

## Build, test, run the gate

You need [Bun](https://bun.sh) and Node 22 or newer. Optional toolchains (clang, gcc, a JDK, a .NET SDK, Icarus Verilog, Yosys,
qemu) enable more of the verification; a step whose toolchain is missing reports itself as blocked or skipped with the reason and
never counts as a pass.

```bash
bun install --frozen-lockfile
bun run lint          # Biome, claim check, loss ledger, results scrub check
bun run typecheck     # tsc --noEmit
bun run test          # builds, then node --test over dist/test
bun run verify        # differential execution of the corpus on every target
bun run a0-dev -- gate   # every required step, in order; must print "GATE RESULT: pass"
```

`bun run a0-dev -- scope` says which gate steps a diff needs and why; `gate --light` runs the cheap ones while you iterate.
Run the full gate before a push. When one test file misbehaves, run it alone with a timeout:
`bun run build && timeout 600 node --test dist/test/<name>.test.js`. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) describes every
tool of the loop.

A change to `compiler/*.a0` also needs `bun run seed` (the checked-in seed is stale otherwise and `test/seed.test.ts` fails).
A change to a backend or the compiler keeps `bun run behavior` green.

## The edit protocol

Models do not rewrite files. They open a view, get a handle, and answer with only the lines that change:

- `bun run build`, then `node dist/src/cli.js check FILE` validates a program, and `a0 mcp <dir>` serves the edit tools
  (`a0_open`, `a0_apply`, `a0_check`, `a0_run`, `a0_emit`, `a0_save`).
- A function view comes with a handle (`e0`), the program view with `g0`. Under a function handle, `id op args...` replaces node
  `id` (or inserts it before `ret` when new), `id op args... @ other` inserts after `other`, `-id` deletes, `ret x` changes the
  result. A `fn NAME ... end` block adds or replaces a whole function, `-fn name` removes one.
- The compiler validates the complete result (parse, types, revision match, no forward references or recursion) and commits
  atomically. A rejection carries a stable code (`A0nnnn`), `expected`, `actual` and a `fix`; the reply `fix all` applies every
  exact fix of the last rejected reply. `a0 explain A0nnnn` shows a failing and a fixed example.
- Source: `src/edit.ts`; the full text is DESIGN.md section 5 and `plugin/skills/a0/references/edit-protocol.md`. A new
  diagnostic is one row of `src/diagnostics.ts` with its examples; `test/diagnostics.test.ts` runs every example.

## Adding a backend

A backend declares the operations it supports, its ABI, its limits and its validation status, and it must keep the exact A0
semantics (wrapping `u32`, logical shifts with the distance masked to five bits, unsigned comparison, no implicit bool to number).

1. Write `src/<target>.ts`: emit one function at a time (see `src/riscv64.ts` for a compact direct backend) and an assemble step
   that joins the function bodies into a module.
2. Register it in `src/backends.ts`: the `Target` union, `TARGETS`, the per-function emit and the `assemble` switch; add it to the
   `a0 emit` help in `src/cli.ts`. Bump `COMPILER_VERSION`.
3. Verify it against the oracle: add a `check<Target>` function to `tools/verify.ts` that builds and runs the generated corpus
   with whatever toolchain exists, reporting `blocked` with a reason when the toolchain is absent, and wire it into the report
   (`results/verification.json`).
4. Add the target to the behavior table run (`tools/behavior.ts`). A row a target cannot run goes in `SKIPS` with a reason; it is
   never dropped silently.
5. Tell the scope tool which gate steps the file needs (`LEAF_OVERRIDES` in `tools/dev/gate-scope.ts`) and add focused tests under
   `test/`.
6. If speed is part of the claim, add the baselines to `tools/exec-bench.ts` and let `bun run loss-ledger` show where the target
   loses. Update the table in DESIGN.md section 7 with what was actually verified.

## Adding a language to the AI-edit experiments

The experiment compares A0 with other languages on the same tasks, with the same acceptance tests and an equally capable edit
protocol. A language is one module in `tools/edit-langs/`, shaped by `LangSpec` in `tools/edit-langs/spec.ts`:

1. Create `tools/edit-langs/<lang>.ts` exporting a `LangSpec`: the `u32` semantics note the model is given, a `head` pattern that
   finds a top-level function, the `file` wrapper, hand translations of the twelve set-B tasks (`b`: an `original` that fails the
   acceptance tests and a `reference` that passes), an acceptance `driver` that prints `R<i> <value>` per test and then `DONE`, and
   `buildAndRun`, which writes the files, builds and runs them.
2. Find the toolchain with `tool(name, ENV_VAR, [fallback paths])` so a missing tool is a clear message and an environment
   variable can point at it.
3. Register it in `tools/edit-langs/index.ts` (`SPEC_LANGS` and `SPECS`).
4. Run the self-check, which executes no model: `A0_EXPERIMENT_TASKSET=b bun run experiment` builds every prompt and checks that
   every original fails and every reference passes in every language.

Give each language an implementation as strong as the A0 one: idiomatic, with its own equally capable editing tool. A language
that is hard to translate faithfully is reported as such, not tuned.

## Measurement rules

These are binding; a pull request that breaks one is reworked, not merged.

- **Fresh subjects.** A model answers each task from a fresh context that sees only the prompt the harness built (system text,
  view, task), never earlier answers or the acceptance tests. Dump the prompts with `A0_EXPERIMENT_DUMP`, collect the replies,
  score them with `A0_EXPERIMENT_REPLIES`; a live run is opt-in (`A0_ALLOW_PAID_MODEL_CALLS=1` and provider credentials) and
  never implicit. Task sets that were used to tune a primer are not held-out; sets d, e and f are sealed by SHA-256.
- **Losses are recorded.** Wins, ties, losses, missing capabilities and unmeasured dimensions are separate. A loss is never
  averaged into a headline, a tie is never called a win, and a finite benchmark is never described as proof for every program.
  `results/loss-ledger.json` can only shrink: a new or worsened loss fails lint, and growing the ledger needs
  `bun run loss-ledger -- --update --reason "..."`.
- **Timing claims only from quiet runs.** No timing claim from a run recorded above a 1-minute load average of 10. Runs are
  interleaved, reported as medians, with the load written beside the number (`a0-dev check bench-validity` says whether a result
  is publishable). Sanitizer correctness runs are never performance runs.
- **Claims need results.** Every number or comparison ("N times faster", "fewer", a percentage) in `STATUS.md`, `docs/history/`
  or a site template needs a `results/*.json` reference nearby or a recorded value; `bun run claims` (also part of lint) flags the
  rest. A claim that cannot be backed is deleted or marked `claim-ok: reason`. A retraction goes next to the claim it corrects.
- **No assistant output overrides a measurement.** A prediction from a model or a wrapper is a hypothesis; only real runs,
  checksums and benchmarks confirm a result, and a measured loss wins over any prediction.
- **Whole-task cost.** Compare the cost of an accepted change, including primer, view, output, tool calls and repairs, with the
  encoding or model recorded; unknown usage is recorded as unknown, not zero.

## How results files are regenerated

Results are produced by their tools, never edited by hand: `bun run verify`, `bun run exec-bench`, `bun run lang-axes`,
`bun run experiment` and the others write `results/*.json`, and the gate regenerates the pass/fail files. Two kinds exist:

- Pass/fail reports (verification, equivalence, hardware, behavior, selfhost, bootstrap, app, dotnet, gpu) are regenerated by the
  gate; on a merge conflict the current side wins and is regenerated.
- Measurements (timings, token counts, AI-edit runs) are merged by a rule: a run with a load gate is never dropped for one without,
  then the lower recorded load wins, then the newer run. `a0-dev setup` configures the merge drivers in your clone.

Every writer goes through `tools/scrub-results.ts`, which replaces local paths (a home directory, a temp or scratch directory) with
`<repo>`, `<home>` and `<tmp>` and changes no number. If you add a tool that writes a results file, write it with `writeReport`.
`bun run scrub-results` cleans existing files; `bun tools/scrub-results.ts --check` (part of lint) fails when one is unclean.
`test/hygiene.test.ts` fails when a tracked file contains an absolute home path, a temp path, a session identifier, a secret
or key file, or editor or agent local state, so keep those out of commits.

## Roadmap

In rough order, as the measurements justify:

1. Quiet-host reruns of the results recorded under load, then publish or drop each timing.
2. A smaller primer: a model pays the language instructions on every cold call, and every clause it does not need costs.
3. A decision on the dense view with callee bodies as the recommended form of the MCP server and the docs.
4. The A0 optimizer on the C and AArch64 emitters, SIMD fills on the arm64 and x86-64 backends.
5. Per-backend verification, so a change to one backend does not run the whole verify step.
6. Language growth with defined semantics before backend work: libraries and FFI, browser API bindings, mobile packaging, memory
   regions beyond fixed arrays, hardware pipelining.

Open items with their evidence are in the "Known limits" and "Next actions" sections of [STATUS.md](STATUS.md).

## Pull requests

Keep a change focused, on its own branch. Say which gate steps it needs (`a0-dev scope`), run them, and include the gate result.
Add or update the tests, the model guide and DESIGN.md together when semantics change: a feature the parser accepts but the
checker, optimizer, backends and tests do not support is not supported. Do not commit secrets, keys, local paths, editor or agent
state, or scratch output.

## License

MIT, see [LICENSE](LICENSE). By contributing you agree your contribution is licensed the same way.
