# A0 history, 2026-09-30: Tooling, security, MCP server and the site

claim-check: archive. This is a dated record of work on the date above, kept for the evidence trail. Figures are
as measured at the time; some were taken on a loaded benchmark host and are not publishable timings. The current
state and the current numbers are in [STATUS.md](../../STATUS.md) and in results/.

## Session 2026-09-30 (site: live-code hero, QA pass, agent files)

- Hero replaced by a "live code" scene built from tags, text, classes, and CSS keyframes only (no canvas, no scene shader): a model edits `clamp` through the view, the reply `e0 / hi lt p2 a` is accepted at the real revision `fe014071`, the view reorders as the edit session does, and A0's own AArch64 output appears with the measured 5.0 ns per call. The one runtime hook it needs is the existing `.reveal` → `in`. Prototype designed in plain HTML and ported into `page.a0` by the generator; protocol tags 24 h6, 25 b, 26 i added to the runtime and the prerenderer.
- Prerendering: the build runs each page program through the reference interpreter and ships the DOM as HTML (`tools/site-render.ts`), so agents and crawlers without JavaScript get the full page; the browser re-renders the identical tree. Text exports for agents: `/llms.txt`, `/llms-full.txt`, `/primer.txt`, `/docs.txt`, `/index.txt`, `/results/*.json`, `robots.txt`, `sitemap.xml`; canonical, Open Graph, and JSON-LD metadata.
- QA pass (agent, 31 findings) fixed: sections were never closed in the page program (all nested); mobile header, nav links, hero, chart columns, code wrapping, docs table, docs TOC as chips; focus-visible; balanced headline; FAQ grid; copy and number disagreements (primer 388 tokens, o200k). Home page decluttered to six charts and short copy.
- Wasm: a page program with hundreds of text literals overflowed wasm-ld's 64 KiB default stack ("memory access out of bounds"); `WASM_FLAGS` now links with a 1 MiB stack.
- Performance: no scene, content visible before JavaScript (reveal motion only for what scrolls in), fonts preloaded; measured on the deployed page: TTFB 10 ms, DOM ready ~500 ms, wasm 56 KB brotli, session compute 0 ms.
- In progress (agents): baselines for many more languages in exec-bench (Go, Java, Kotlin, C#, Swift, Zig, TypeScript, C++, Ruby, PHP, Lua, Perl, Dart, Nim, Crystal, D, OCaml, Haskell, Julia, R, Erlang/Elixir, Scala, Fortran, Pascal, Racket, Lisp, Clojure, Groovy, Tcl, COBOL as toolchains allow); A0 parser in A0; large arrays with in-place C updates.

## Session 2026-09-30 (playground)

- `site/play.a0` (goal item E): a live playground at `/play/`, the third page program, built and prerendered like the others (`site/play.html` shell, `data-program="/play.wasm"`, 138,944 bytes of wasm). It `use`s `../compiler/parse.a0` (and through it `lex.a0`): the source in the text area is lexed and parsed by the self-hosted A0 compiler stages in the browser, and the page shows the token count, a token table (index, kind, text), the word IR of DESIGN.md 7a (per function: name, parameter count, result type, node count; each node as `id op args` and the `ret` operand, symbols read back from the pool), and the first diagnostic (parse or structure error with its token, or "at the end of the input"). `analyze` runs the four parser passes exactly as `parseio` does, without io; op, kind and type names are fixed-width byte tables indexed by code (no strings in select). Default source: the home page's clamp function. Event 0 renders the state's source (or the default), event 1 runs the submitted text; the STATE is the source (n then n bytes), so the text survives a re-render. Sources are capped at 480 bytes (the compiler tables are u32x512).
- Runtime (`site/app.ts`, still generic): tag 27 `textarea` (also in `tools/site-render.ts` and the ui.a0 comment); `TEXT_CAP` 64 -> 480 and `IN_CAP` 512 -> 1024 (3 + 1 + 480 + 1 + 481 state words), with `tools/site-build.ts` giving the C io struct the same `ioInputCapacity` 1024; an event now sends the bytes of the page's `input` or `textarea`; ONSUBMIT on a textarea fires on Ctrl/Cmd+Enter and leaves the field's content to the program's TEXT (an input keeps Enter and its typed value as before). Fuel and output caps unchanged.
- Shared chrome: the identical `sec_nav`/`sec_foot` blocks of the generated `page.a0` and `docs.a0` moved to `site/ui.a0` as `nav` and `foot` (the generated files now call them; a "Play" link was added to the nav once, for all three pages). `/play/` is in the sitemap.
- Verified: `bun run site` builds three programs; new test (39/39) runs the play session through the interpreter on a submitted source and checks the token count, the node lines, the ret, the diagnostic, the echoed state and the state-driven re-render; lint and typecheck clean; served `site/dist` locally and drove `/play/` with Playwright (typed a program, Run, 22 tokens and the IR rendered by the wasm, no console errors); screenshot `.playwright-mcp/play.jpg` (gitignored).
- Checker in the playground: `site/play.a0` now `use`s `../compiler/check.a0` (play.wasm 138,944 -> 172,207 bytes). After `lex` and the pure `parse`, the parser's tables are widened as `checkio` does (u32x768/1024/4096/8192 copies, zero on a parse error) and `check` runs on them; every node line of the IR panel carries the node's type from `ntys` as a muted span, rendered like the source from the checker's extended tables (u32, bool, io, u32xN, `(u32,io)`, `(u32x2,u32x4)`; three levels of nesting, `ty0..ty3`), and the function's result type comes from the same renderer. An ill-typed program shows the checker's diagnostic (type/structure/limit error, `in fn NAME`, `at node ID` from `nodes[6i]`, `at ret`, or `in the header`, then a one-line meaning per code); the nodes before the error stay typed, the ones after are untyped. Both passes give a green `valid: parsed and type-checked` line. Names that clash with check.a0 were renamed (`irfn`, `irnode`). Test extended (40/40): typed node lines, the type error at node b, the ret structure error, and body-built types rendering; `bun run site` builds; served `site/dist` and drove `/play/` with Playwright (ill-typed program, Run, the diagnostic from the wasm, no console errors); screenshot `.playwright-mcp/play2.jpg`.
## Session 2026-09-30 (edit-loop validation latency)

`bun run edit-loop-bench` (tools/edit-loop-bench.ts, results/edit-loop.json): wall-clock time from "model reply received" to "edit applied and the whole 40-function program known to type-check", per accepted set-C edit, using the actual accepted replies of the set-C collections (reply texts committed as results/ai-edit-experiment.c.{sonnet,haiku}-min.replies.json; every accepted trial was one-shot, so the timed reply is the first one). TS/Rust samples use the structured line-edit replies applied to the 40-function file. Go has no collected replies: hand translations of the reference edits (tools/edit-loop-go.ts), checked against the same acceptance tests before timing. Python/mypy not measured: mypy is not installed on the benchmark host. 7 reps after one discarded warm-up round, path order rotated per (rep, task); per-task median of the reps, then median / p90 / sum over the tasks. Warm paths are reset to the original program (untimed) before every sample. TASKS_A moved to tools/ai-edit-tasks-a.ts and the TS/Rust line-edit applier to tools/ai-edit-apply.ts so the benchmark can import them.

Load: this 8-core machine was shared with other jobs; 1-minute load average 127.28 at the start, falling to 13.66 at the end (per-rep `uptime` in the JSON). Absolute numbers are inflated by that load; ratios come from interleaved runs and are less affected.

Sonnet replies (12 edits per path; Haiku: 9 to 11 accepted edits per path, full rows in the JSON):

| path | median ms | p90 ms | total ms | median vs A0 structured | Haiku median ms | derived end-to-end median ms (reply tokens) |
|---|---:|---:|---:|---:|---:|---:|
| a0.structured | 0.51 | 0.725 | 6.643 | x1 | 0.443 | 369.4 (29.5) |
| a0.conventional | 0.533 | 0.603 | 6.4 | x1 | 0.475 | 17169.4 (1373.5) |
| ts.cold | 637.454 | 719.447 | 7784.674 | x1249.9 | 594.71 | 1003 (25.5) |
| ts.warm | 15.142 | 15.877 | 183.206 | x29.7 | 13.64 | 335 (25.5) |
| rust.cold | 116.404 | 127.172 | 1401.5 | x228.2 | 106.285 | 396.7 (22.5) |
| rust.warm | 163.567 | 172.745 | 1934.77 | x320.7 | 151.874 | 451.2 (22.5) |
| go.build.cold | 161.728 | 164.851 | 1916.245 | x317.1 | n/a | n/a |
| go.build.warm | 97.416 | 104.421 | 1155.1 | x191 | n/a | n/a |
| go.vet.warm | 162.817 | 171.841 | 1955.912 | x319.2 | n/a | n/a |

Paths: a0.structured = EditSession.apply in-process (parse edit, type-check, commit); a0.conventional = parseAndValidate of the whole replied file; ts.cold = `tsc --noEmit -p` in a new process; ts.warm = a TypeScript LanguageService kept alive in-process (new file version, syntactic + semantic diagnostics), the fair best case for TS; rust.cold = `rustc --emit=metadata --crate-type lib`; rust.warm = `cargo check` in a crate already checked once; go.build.cold = `go build` with an empty GOCACHE; go.build.warm / go.vet.warm = warm GOCACHE with a unique trailing comment per sample so the content cache never replays. No gopls or rust-analyzer daemon was measured.

Findings: validating an A0 edit costs about half a millisecond, about 30x under the warm TypeScript language service and roughly 190x to 1250x under the process-based checkers. The end-to-end column is DERIVED, not measured: local o200k output tokens of the reply at an assumed 80 tokens/s plus the measured validation median. On that basis validation is small next to generation for every in-process or warm checker: warm TS (335 ms) is slightly ahead of A0 structured (369 ms) because the TS line-edit replies were shorter (25.5 vs 29.5 tokens median), and a whole-file conventional A0 reply costs about 17 s of generation. A0's validation advantage decides the inner loop only against cold, process-per-edit checking (tsc: about 1.0 s per edit end-to-end).
## Session 2026-09-30 (security fixes)

Nine findings from a security review, each fixed minimally with a regression test in
`test/security.test.ts`. COMPILER_VERSION a0c-0.1.15 -> a0c-0.1.16 (fuel and io semantics).

1. HIGH, fuel bypass (`src/core.ts` `run`): a zero-node body (`ret p0`) folded 2^32 times
   charged no fuel. Now every function entry costs one unit and every fold/loop iteration
   one more before the body runs. Test: that body folded 30,000,000 times under fuel 1000
   throws a `limit` fuel error in milliseconds (fold and loop).
2. Aggregate cost: `arr`/`rec`/`text` and `set`/`put` now charge max(1, length) for the copy
   they make; argument checking runs once at the `run` entry and internal calls (`exec`) no
   longer re-walk validator-typed arguments. Test: a `u32x65536` `set` folded 100 times
   exhausts fuel 10^6; 4 iterations finish.
3. C `a0_read` (`src/backends.ts`): the read also compares the position with the input
   capacity, so a host that sets `ninput` above it reads 0, not the words after `input[]`.
   Test: capacity 2, ninput 3, three reads sum to 12.
4. Direct wasm `a0_read` (`src/wasm.ts` `ioRead`): the same capacity comparison. Same test
   on the wasm module.
5. Linker (`src/link.ts`): `link(entry, read, { root })`; root defaults to the nearest
   ancestor of the entry directory containing package.json, else the entry directory.
   Every `use` target is realpath'd and rejected with a `structure` error unless it is an
   `.a0` file inside the root. `tools/site-build.ts` and `tools/app.ts` pass the repository
   root. Tests: `/etc/passwd`, `../../x.a0`, a non-.a0 file, a symlink escaping the root,
   and a narrower explicit root are refused; an in-root use links.
6. Parallel worker stack (`src/parallel.ts`): threads are created with a pthread attribute
   whose stack is max(8 MiB, the soft RLIMIT_STACK). Test: a forced-threads fold whose body
   holds two `u32x65536` arrays matches the interpreter (it crashed with the 512 KiB default
   secondary-thread stack).
7. `site/app.ts`: byte strings are read by `readBytes` (`site/wire.ts`), which clamps the
   length to the words that remain; ATTR drops an `href` not matching
   `/^(https?:|\/|#|mailto:)/i` (`safeHref`). Test: unit tests of both helpers.
8. `tools/verify.ts` C driver: `ninput` is clamped to the io capacity and to the tokens on
   the line, and a line with too few tokens prints `?`. Test: the driver under
   AddressSanitizer with ninput 1000000 and a truncated line.
9. Docs: STATUS/DESIGN now say literal iteration counts are bounded statically and variable
   counts by fuel in the interpreter only; compiled code has no execution budget.

- `tools/selfhost-verify.ts` runs `emitio` on the explicit 10^12 budget `tools/selfhost-c.ts`
  already uses: with aggregate copies charged by length the emitter exceeds the 10^8 default.
  `site/wire.ts` is emitted next to app.js by the site build (the page imports it).
- Gate: lint, typecheck, test 67/67, verify (all paths passed; 5262 cases each), app passed,
  equiv 48/48 proved, hw passed, dotnet passed, gpu passed, selfhost 50 passed / 3 skipped
  (6898 cases), selfhost:c 6371/6371.



## Session 2026-09-30 (MCP server)

- `src/mcp.ts`: MCP server on the official `@modelcontextprotocol/sdk` (stdio transport, zod
  input schemas), launched by `a0 mcp <file-or-dir>`. Tools over `EditSession`: `a0_open`,
  `a0_program`, `a0_apply`, `a0_check`, `a0_run`, `a0_emit`, `a0_save`. Failures return
  `isError` with the A0Error JSON (code/message/line/expected/actual/fix).
- Security: no shell; every path (and every `use` dependency) resolved inside the launch root
  with realpath, symlink and dangling-symlink escapes rejected, `.a0` only; `a0_run` fuel capped
  at `LIMITS.defaultFuel`; tool output capped at 1 MiB; edits capped at `maxSourceBytes`;
  `a0_save` refuses without an applied edit and refuses to flatten a multi-file program over
  its entry file (save to a new path instead).
- `test/mcp.test.ts`: in-memory client/server transport covering every tool, diagnostics,
  fuel exhaustion, and confinement (`..`, absolute, symlink, dangling symlink, `use` escape).
- Gate: lint, typecheck, test.

## Session 2026-09-30 (the site generator in A0)

- `tools/site-gen.py` is gone; the a0lang.com page programs are generated by an A0 program, `site/gen/sitegen.a0` (modules `sgio`, `sgwords`, `sgstore`, `sgcss`, `sgread`, `sgjson`, `sgphase`, `sgtables`, `sgvars`, `sgcalc`, 4.9K lines). `tools/site-gen.ts` compiles it through the TypeScript C backend (`optimize: false`, see below) and clang and feeds it the template and the files its `f` lines name (byte count, then bytes packed four to a word). `bun run site` regenerates `site/page.a0` and `site/docs.a0` with it before building; `test/sitegen.test.ts` requires both to equal its output byte for byte.
- Step 1 (commit 58762ab): the Python generator was first changed to integer arithmetic (JSON numbers as decimal fixed point truncated after 9 digits; geomeans and log bar lengths through Q20 log2 / 2^x tables of 1025 entries, linear in between; ties to even) and its prose, stylesheet, shader, hero markup and page structure moved into `site/gen/` (`page.tpl`, `docs.tpl`, `tags.tpl`, `style.css`, `scene.glsl`; `site/hero-live.html` folded in). The pages stayed byte-identical to the float version (257-entry tables had moved one ratio, 151.51x -> 151.52x, so the tables are 1025). Step 2: the A0 generator reproduces that output byte for byte; every extracted JSON value and every template variable was also checked against the Python rules during the port.
- Template language (documented at the top of the interpreter in `sitegen.a0`): op byte per line (`<` `.` `=` `+` `>` `"` `w` `c` `n` `s` `l` `{` `}` `[` `]`, raw `1`/`2` lines for the two passes), `$var$`, `{var|A|B}`, `\n` `\s` escapes. Pass 1 writes the section functions, pass 2 the session body, numbering nodes identically. The generator is driven only by the templates, so template/CSS redesigns need no code change.
- C backend (`src/backends.ts`, C only): `mutableHereC` treats `fold`/`loop`/`call` results as fresh storage and lets read-only uses before an update (call arguments, fold extras) keep a `set`/`put`/fold state in place. Before it, every nested fold on a fold body's state copied the whole state (the stylesheet scoping took 31 s, after it 0.3 s).
- Worked around at first, fixed generally in a0c-0.1.31/0.1.32 (next section): (1) `at` of a record's large array copied it; (2) a later literal-count fold after a call of a variable loop was rejected, so counts were `one mov 1` values and the optimizer was off; (3) io records after `at`. The `mov` counts are gone (83 lines) and `tools/site-gen.ts` compiles with the optimizer; the output is still byte-identical (test/sitegen.test.ts). The `(io, R)` interpreter state stays: it is the natural shape under the io rule below.
- Cost: the generator builds in 20-60 s (clang -O2 on the emitted C) and runs in about 35 s for the home page, 1 s for the docs; the home page time is the linear variable lookup and the per-call copies of the interpreter state. Not done: a variable index (hash table) to cut that; the Play page is not ported (it is being removed).

## Session 2026-09-30 (site-generator follow-ups: merge, optimizer counts, io fields; a0c-0.1.32)

- **Merged** the site generator (85e67b6). Its C-only `mutableHereC` (fold/loop/call results are
  fresh; call arguments and fold extras before an update are read-only) now sits under
  `cMutableHere`, which adds `borrowLive`: an update is in place only when both hold.
- **Optimizer (src/optimize.ts `keepCount`):** constant propagation no longer turns a variable
  fold/loop count into a literal when that literal times the body's literal bound exceeds
  LIMITS.maxStaticIterations (it keeps a `mov` of it): the source was valid because fuel bounds
  the count, and optimizing must not make it invalid. Counts within the bound still propagate.
  The generator's `n mov 4294967295` unbounded loop needed this; with the 0.1.31 checker fix the
  `one mov 1` counts were plain workarounds and are removed.
- **io records (decision: a linearity hole, not intended):** the reported limit ("an io record
  cannot be put or passed after an `at`") did not reproduce; the checker accepted all of it,
  including `t at p0 0; write t ...; call g p0`, which uses one token twice. Rule now (src/core.ts,
  compiler/check.a0, compiler/front512.a0, tools/ref-check.ts): `at` of a field without io only
  reads; `at` of the io-carrying field takes the token out, after which the record may only read
  its other fields or get that field back with `put r k <io>` (the natural update: take, write,
  put back). Passing, returning, taking again or putting another field is a `structure` error
  with a `fix` naming the put. Every .a0 file in the repo validates unchanged; one test string
  (play types rendering) returned a record after taking its io field and now reads field 0.
  New ILL_TYPED cases io-taken-{call,ret,twice,put-other,node}; tests `io linearity: ...`,
  `optimizer: a variable loop count stays a value ...`, and the play program's put-back case.

## Session 2026-09-30 (development loop tools: gate scope, merge pipeline, claim check)

Free, local, deterministic tools under `tools/dev/` (entry `a0-dev`; rules in `AGENTS.md`, reference in `docs/DEVELOPMENT.md`). No key, no network. Test: `test/dev-tools.test.ts` (21 tests, including a check that no tracked file names a decision-service vendor).

- **gate-scope** (`a0-dev scope`, `--light`, `--json`, `--add-steps`): maps a diff to gate steps. Each step names entry files; the import closure (TypeScript imports, A0 `use` lines) says what it exercises, with hand-written leaf-backend rules because every backend hangs off `src/backends.ts`. Docs-only and results-only changes run lint only; one leaf backend runs its verify path and the unit tests; shared core (`core`, `optimize`, `backends`, `edit`, `toolchain`), config and unmapped source run all 13 steps. Every step prints its reason. `--light` keeps lint, typecheck, test and site and prints what it skipped.
- **merge-plan** (`a0-dev plan`): pairwise `merge-tree` conflicts, shared files, shared core, shared steps; conflicts only in STATUS.md or results are soft (results regenerate). Independent branches batch together under one combined gate run, coupled ones split into batches ordered riskiest first. Merges nothing.
- **claim-check** (`a0-dev claims`, part of `bun run lint` as `--since=origin/main`): flags numeric and comparative claims in STATUS.md and `site/gen/*.tpl` with no `results/*.json` reference in the section window (templates: a placeholder counts as data-driven), references to missing result files, and speed claims recorded at load above 10. A full scan flags old ledger lines (see the next action below); lint only checks lines added or changed since the base, so new claims must be supported.
- **dev-gate** (`a0-dev gate`): runs the selected steps one at a time, riskiest first after lint, typecheck and the build, each in its own process group with a timeout (rc 124) and a log in its own run folder under the OS temp dir. Last line `GATE RESULT: pass|fail` with each step's rc. `--push=<remote>` refuses when a required step is missing, skipped, timed out or failed, or the run was `--light`. Runs by absolute path in the repo.
- **Merge pipeline**: a pass of a clean commit writes a note in `refs/notes/a0-gate` bound to the commit's tree (a changed tree invalidates it). `a0-dev drive` refuses branches without a passing note covering their light scope, merges batches, runs one combined gate per batch, and on a confirmed loss tries each suspect alone and reverts only the branch whose revert makes the failing steps pass (all suspects, labelled as an interaction, if none does). Without `--merge` it only prints the plan and the note checks. It never pushes.
- **Result sorting**: `decide` classifies a failed step as real regression, flake (two distinct runs on one tree disagree), pre-existing or unexplained (with the evidence still needed) from `.a0-cache/gate-history.json`; `classify` places failed model replies by rules (truncation, format slip, protocol ambiguity, model error, else unknown).
- **Before and during work**: `queue --brief` (failure groups from results, ranked by rows, generality and cost; environment-blocked last), `prereview` (symptom patch, hidden fallback, fabricated constant, thick shim, framework branch), `tests --run` (tests whose import closure holds a changed file), `order` (sentinels, fail-fast).
- **Loop checks** (`a0-dev check`): `stuck` (progressing, slow-from-load, stuck, finished-waiting), `bench-validity` (publishable, loaded-discard, needs-rerun; load above 10 is never publishable), `launch-gate`, `rank`, `verify-report` (supported-by-evidence, inference, from-memory, contradicted).
- **Timing**: `gate --mode=baseline|assisted` appends step wall-clock and load to `results/dev-loop.json` (empty so far). `a0-dev loop` reports a speedup only from quiet entries with three or more per mode.
- Extension points: only additions (`--add-steps`, `--couple`), `--json` everywhere. Nothing in the repository depends on a particular wrapper.
- Not done: a per-backend verify flag (`tools/verify.ts` runs every backend, so a backend change runs the whole verify step); the measured loop timings; the claims already in the ledger that lack a results reference.

#

## Session 2026-09-30 (minimal failing subset of a rejected edit)

- **Diagnostic.** `EditSession.diagnose(text, budget = 64)` (src/edit.ts) validates a reply exactly as `apply` does, without committing, and when it is rejected narrows it to a minimal subset of its lines that still fails with the same diagnostic (same code, message and fix; the `line N:` prefix is ignored since numbers move as lines drop). Deletion-based (a deletion-based reduction in the style of an unsat core, implemented as `minimalFailingSubset`): drop one line at a time, keep each drop that still fails, repeat passes until one drops nothing (1-minimal), at most `budget` validations; handle lines stay as context. One more check tells whether the reply without those lines is accepted (`restValid`). `formatRejection` renders it: `This line of N causes the rejection; …` or `These K of N lines are the smallest part of the reply that still fails this way; …`, the lines with their reply line numbers, then the fix. Tests in test/edit.test.ts (conflict of two items, budget cut-off, single bad line, duplicate-edit pair, two same-kind errors resolve to the named line, whole block, no commit).
- **Limit.** Inside a `fn` block the core keeps the lines the failure depends on (the header, the node an erroneous line uses, `ret`), so a one-line type error in a block is often reported as 2-5 lines. Of the 22 rejected replies measured, 12 cores were a single line; 3 had `restValid`.
- **Experiment.** `A0_EXPERIMENT_DIAGNOSE=core` appends `formatRejection` to the A0 structured rejection (tools/ai-edit-experiment.ts). Replayed the recorded first A0 structured replies of all 22 `results/*rules-merged.json` and `results/*primer-none*.json` configs under the current parser: 22 are still rejected by the edit protocol (the 5 other recorded protocol failures, all from the older primer-none runs, are now accepted by the guessable-spelling parser; wrong-output first attempts get no new message and are excluded). Fresh repair replies to the new messages, one Haiku subagent and one Sonnet subagent answering all their items from one file (system prompt, task and view, first reply, new rejection), were scored by the harness. Baseline = the recorded repair outcome of the same trial (answered with the old message).

| subject | trials | repaired, recorded | repaired, with core |
|---|---|---|---|
| Haiku | 19 | 15 | 15 |
| Sonnet | 3 | 3 | 3 |

  Haiku flips: +2 (b-bounds-largest primer-none, e-popcount-fold), -2 (b-bounds-largest rules-merged and f-countabove-gt: both new replies used an out-of-range parameter, a different error from the first). No measurable effect on repair rate at this size; with one sample per trial, ±2 flips is within noise. Sonnet repairs everything either way. Records: `results/ai-edit-repair-core.json` (messages, replies, outcomes).
- Gate (this branch): lint pass; typecheck pass; test 94/94; verify, hw, app, equiv, bench exit 0; tokens fails before and after this change (`life.a0 has no session`: examples/life.a0 lost `fn session` in eb796f0, unrelated); exec-bench was still running on a shared, loaded machine at commit time (not a result).
