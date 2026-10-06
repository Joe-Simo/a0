# Session 2026-10-06: Windows port, protocol fixes and the dense and short-primer comparisons

Dated record of a working session, moved out of `STATUS.md` so that file stays the current state. Every number below is in the `results/` file named beside it.
Written first-person plural where the session made a decision; the machine was a Windows 11 x64 laptop with Node 22, Bun and a Zig-based C compiler, which is why several
entries are about Windows.

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

Protocol fix 2 of 3 (2026-10-06, general, with tests in `test/dense.test.ts`): in the dense form a result that is not written (no `->`) is the type of the last statement, so a
reply that returns a bool or an aggregate needs no `-> bool` (the one failure every primer variant shared in `results/primer-ablation.json`); a u32 result and a written
result are unchanged, and the printer keeps a written `-> u32` where the body disagrees, so the dense text stays lossless. It changes the dense text of exactly one corpus file
(`corpus/reject/ret-bool-for-u32.a0`, an ill-typed program), re-blessed in `test/golden/spec-free-digests.json`. Not re-measured with fresh subjects: set H cannot be reused for it
(its dense failures were positional-parameter and operand-count errors, not result types, `results/set-h.json`), so no acceptance claim is made. The canonical form is unchanged: its
header still needs `-> T`, because widening the canonical grammar would also need the self-hosted front end and the seed. Still open: spec-line limits (opt-in, outside the guide) and dense
positional parameters in fold helpers.

Set I (2026-10-06, `results/set-i.json`, `docs/history/2026-10-06-set-i-preregistration.md`): the second pre-registered dense-against-canonical comparison, on a new sealed set with 8 non-u32-result tasks and
after the unwritten-result parser fix, split by model. Sonnet: dense one shot 16 of 16 against 14, 10-task cost 119.9 against 138.9 per accepted edit (rule met for this model). Haiku: dense 12 against 15, 169.7 against 130.5
(rule not met). Both models are required, so dense is still not recommended; sets H and I together say dense is a loss on Haiku twice and a mixed result on Sonnet. Open decision: a per-model recommendation would need a new
pre-registered rule, which these two sets cannot supply.

Open decision 11 (return literals of 2^28 or more), `selfhost:wasm` complete on the `bigret` list, 2026-10-06 (`results/selfhost-wasm.json`, compiler `a0c-0.1.38`, Windows x64 with a Zig-based clang, recorded as a correctness result, not a timing): 6 of 6 programs identical to the TypeScript reference (the corpus, `kernels.a0`, `life.a0`, the behavior program `bigret`, `site/page.a0` and `site/docs.a0`), tables and source at O0 and O1 where the source path is not skipped for the program (`site/page.a0` O0 source: skipped, `chart_tk` does not fit a chunk), and the A0 optimizer IR identical for every function (48, 5, 14, 6, 65 and 28). The earlier note that this was never run to completion on the `bigret` list is closed by this run. Still not run with a big literal: `efnstep`, `qfn`, `evalrun.a0` and `shape.a0`. The Windows fix that made the run possible: the stage drivers (`tools/selfhost-wasm.ts`, `tools/bootstrap.ts`) read and write binary words on stdin and stdout, which Windows translates in text mode; they now switch both streams to binary under `_WIN32`. This run was not on the arm64 machine; the gate there regenerates the file.

Protocol fix 3 (2026-10-06): `at` or `put` written on an array (the failure of three Haiku dense first replies on set I, `results/set-i.json`: `get` and `set` are for arrays, `at` and `put` for records) now carries an exact edit: the diagnostic A0220 rewrites that line to `get` or `set` at the same index, and `a0 check --fix` applies it (`corpus/reject/array-at.a0`, rule `array-op` in `EXACT_FIXES`). It changes no emission and no accepted program, only what the rejection offers; the first reply is still rejected, so one-shot acceptance does not change and no acceptance claim is made. `seed/stage-main.c` was regenerated for the binary-stdio guards (`_WIN32` only; the compiler seed `a0c-seed.c` is unchanged); the seed command's own rebuild check needs the POSIX driver and could not run on Windows.

Distribution (2026-10-06, item 6): `npx skills add Joe-Simo/a0` was run once, from a scratch directory (it installed the `a0` skill, `SKILL.md` and `references/`, for the universal agent set), and the skills.sh page for the repository answers with a listing (`https://www.skills.sh/joe-simo/a0`, HTTP 200). The other free directory submissions (Smithery, Cursor, Cline, Goose, Kilo, opencode, Hugging Face tiny-agents) were not made: each is a public post under the owner's account and waits for the owner's go-ahead.

Set J (2026-10-06, `results/set-j.json`, `docs/history/2026-10-06-set-j-preregistration.md`): the third pre-registered dense-against-canonical comparison, on a new sealed set after the three protocol fixes, is a loss on both models:
dense one shot 9 and 15 of 16 against 12 and 16, and a higher cost per accepted edit at every horizon. Over H, I and J dense met the rule once (Sonnet, set I), so it stays out of the shipped form and the 325 dense-view token entries stay
open. The dominant dense failure (6 of 16 Haiku first replies) is a protocol ambiguity not fixed yet: a callee's signature, printed in the dense view as a `#` comment line, is copied into the reply without its `#`.

Protocol fix 4 (2026-10-06, `test/dense.test.ts`): a callee signature copied from the dense view without its `#` (`step u32 u32 u32x4 -> u32`) is skipped like the comment it is printed as, instead of failing with `'u32' is not an operation`; an ordinary statement and a bare type word are unaffected. A mechanical replay of the already collected set-J Haiku dense replies (no new subject, so not a measurement of any model) shows what it does not do: the signature line no longer fails, but the six replies then fail one step later, `duplicate id 'r'`, because Haiku wrote the helper's body lines inside `fn f` after the signature line instead of in a `fn step` block (one count unchanged, 9 of 16 first replies accepted, 10 after the repair). So this fix is correct and general but does not recover those replies; the remaining ambiguity is where a new helper's body goes, which the dense primer does not say and a parser cannot guess.

Canonical syntax and the 377 token losses (2026-10-06, `results/canon-syntax-tokens.json`, `tools/canon-syntax-tokens.ts`, deterministic, no model): three hypothetical cuts to the canonical text of the ten lang-axes kernels (drop the `end` line; drop `ret X` when X is the last node; leave out the parameter types of an all-u32 header) would together close 143 of the 377 canonical token losses (alone: 38, 41 and 74; the first two together 76). The other 234 need the dense form's nesting or a different program structure, and dense failed the pre-registered rule on three sets, so there is no measured way to close most of them. Nothing here is implemented or tested with a model: it prices a design, it does not show models write it correctly, and each cut is a grammar change touching the parser, the self-hosted front end and the seed. The `noop` entries (73 of the 377) compare programs of different structure (A0's carries three identity operations on purpose, every competitor's is `return x`) and are recorded as they are, not redefined.

Speed on Windows (2026-10-06, item 3): blocked here with evidence, not skipped. `os.loadavg()` is always `[0, 0, 0]` on Windows, so the repository's load gate (`tools/quiet.ts`) could never see a loaded machine and would record a false "load 0" beside any timing number; `waitQuiet()` now refuses to start a timing run on Windows with that reason (correctness runs are unaffected). The competitor toolchains the speed table needs are also absent here (only Zig is installed; no Rust, Go, JVM). The per-kernel arm64 loop table stays unmeasured until a quiet arm64 or Linux machine runs `bun run exec-bench`.

Whole-task token cost, what the 44 `ai-tokens-*` losses are made of (2026-10-06, `results/primer-vs-ts-cold.json`, `tools/primer-vs-ts-cold.ts`, no new subject, cross-session): on sets e and f (24 tasks per model) the cold single-task cost per task of A0 with the shipped guide is 665.1 tokens on Haiku and 619.9 on Sonnet, against 312.2 and 232.1 for TypeScript structured (2.13 and 2.67 times); with the 101-token `canon.KR3` edit primer it is 285.7 and 245.5 (0.915 and 1.058 times: about 8 per cent under TypeScript on Haiku, about 6 per cent over on Sonnet). The three numbers come from different collections with the same harness accounting, so this is not a same-session comparison and is not a pre-registered result. It says the recorded token losses against the shipped guide are mostly a shipping consequence: no shipped path (guide, MCP text, skill copies) uses the shorter edit primer, because the shipped-text trials did not meet their pre-registered rules. A same-session pre-registered test of the shorter text as the shipped edit text on a fresh set would settle it.

Set K (2026-10-06, `results/set-k.json`, `docs/history/2026-10-06-set-k-preregistration.md`): the same-session, pre-registered test of the 101-token edit primer against the shipped guide on a new sealed set (the cold single task is primary).
Cold cost per accepted edit 357.5 against 830.5 on Haiku and 284.1 against 698.9 on Sonnet (about 57 and 59 per cent less); one shot 13 against 12 on Haiku and 14 against 15 on Sonnet. The rule needs both models: met for Haiku, not for Sonnet
(by one task), so the shipped text is not changed. The cost saving is large and consistent; acceptance is equal within noise. Open decision: whether a one-task Sonnet deficit should stop a text that halves the cold cost; the rule as written said it does.

Sets L, M, N pooled (2026-10-06, `results/set-lmn.json`, `docs/history/2026-10-06-set-lmn-preregistration.md`): the pre-registered replication of the shipped guide against the 101-token edit primer, 48 tasks per cell,
fresh Haiku and Sonnet subagents. The primer costs 55 and 62 per cent less at the cold task (552.1 against 1236.1 tokens per accepted edit on Haiku, 263.0 against 687.9 on Sonnet) and is lower at every horizon; one shot 18 against 17 on Haiku and 39 against 47 on Sonnet; after the repair 28 against 33 and 48 against 48.
The rule needs both models: met for Haiku, not for Sonnet, so the shipped text is not changed. One Haiku cell (primer, set L) failed every task in both rounds on one protocol misreading (a replacement written as a delete and an add of the same id); that ambiguity is open.
