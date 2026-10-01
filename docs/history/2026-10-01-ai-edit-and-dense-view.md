# A0 history, 2026-10-01: AI-edit experiments, agent-facing errors and the dense view

claim-check: archive. This is a dated record of work on the date above, kept for the evidence trail. Figures are
as measured at the time; some were taken on a loaded benchmark host and are not publishable timings. The current
state and the current numbers are in [STATUS.md](../../STATUS.md) and in results/.

## Session 2026-10-01 (AI edits: eight more languages, sets b and c400)

Carries out the plan of "every chart on the full language set". Base: the merge of the rules-merged primer branch (a0c-0.1.26, relaxed structured protocol, `Division by zero gives 4294967295; remainder by zero gives the dividend.` in every language note).

Harness:
- Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir and Zig, one `LangSpec` module each in `tools/edit-langs/` (interface in `spec.ts`, wired through `tools/ai-edit-langs.ts`; `A0_EXPERIMENT_REPS=kotlin,...`). Each has a hand translation of the 12 set-B originals and references, of the project filler (set-A originals plus the fold-helper and examples extras) and of the six generated filler templates, with the same names, order, u32 semantics and quirks as the other languages.
- Real acceptance: write the candidate, compile or statically check it with the installed toolchain (kotlinc + java, swiftc, `ruby -c`, `php -l`, ghc, ocamlopt, elixirc, `zig build-exe`), run a generated driver that prints every test result in one canonical form, compare. Self-check ok on b and c400 in all eight (every reference passes, every original fails; the 400-function files build). `langTaskSetSha256`: b `bcce8fde…`, c400 `2f20c7c0…` (eight languages); `taskSetSha256` unchanged (b `21de5a34…`, c400 `ad0f14cd…`).
- Language rules a model has to be told (they are in each language's note, so the models saw them): PHP multiplies through a helper, because a u32 product can exceed int64 and silently become a float; Zig forbids a parameter that shadows a function, so `limit` is `lim` in `inc`, `below` and `countup` (no function is renamed), and every Zig parameter must be used or discarded.
- Elixir compile failures now report from the first error on (warnings had filled the 500-character message).

Method: relaxed structured protocol, A0 with the 118-token rules-merged primer (`MODEL_GUIDE.rules-merged.txt`), one group file per representation and set (b: 8 languages, 12 tasks each; c400: 8 languages + A0, each printing the shared numbered 400-function file once), one fresh Haiku and one fresh Sonnet Agent-tool subagent per file (34), one shot; then one retry of every failed trial by a fresh subagent per model, set and representation (16 groups), given system, request, reply and the exact rejection. No author-written replies. The A0 row on set b is the existing fresh rules-merged collection (`b.{haiku,sonnet}-rules-merged`: same prompts); A0 on c400 was collected here (c400 with the rules-merged primer did not exist). The Haiku Elixir and Zig c400 subjects wrote their reply keys without the `/lang/structured` suffix; The suffix was added, text untouched. Cost as in "No primer and lazy primer": o200k tokens per task, system text 1.25x on the first call and 0.05x later, task + view (retry: + reply + repair) and replies 1x. Results: `results/ai-edit-experiment.{b,c400}.{haiku,sonnet}-langs8.json` (+ `.replies.json`, first reply and retry), `results/ai-edit-langs8.json` (every cell's acceptance and cost).

Set b (12 tasks per model, pooled over Haiku and Sonnet = 24 trials; one shot / after one retry; cost per task for 1 task / 10-task session / unbounded):

| | one-shot | after retry | 1 task | 10-task | unbounded |
|---|---|---|---|---|---|
| A0 | 23/24 | 24/24 | 296 | 169 | 154 |
| Kotlin | 23/24 | 24/24 | 388 | 157 | 131 |
| Swift | 19/24 | 23/24 | 454 | 209 | 182 |
| Ruby | 24/24 | 24/24 | 293 | 128 | 109 |
| PHP | 19/24 | 23/24 | 584 | 312 | 282 |
| Haskell | 19/24 | 23/24 | 497 | 240 | 211 |
| OCaml | 24/24 | 24/24 | 343 | 135 | 112 |
| Elixir | 20/24 | 21/24 | 470 | 270 | 248 |
| Zig | 23/24 | 24/24 | 452 | 180 | 150 |

Set c400 (one 400-function program; same columns):

| | one-shot | after retry | 1 task | 10-task | unbounded |
|---|---|---|---|---|---|
| A0 (scoped view) | 20/24 | 23/24 | 357 | 230 | 216 |
| Kotlin | 21/24 | 23/24 | 14163 | 13931 | 13906 |
| Swift | 19/24 | 20/24 | 17326 | 17080 | 17053 |
| Ruby | 21/24 | 22/24 | 12878 | 12713 | 12695 |
| PHP | 20/24 | 23/24 | 18367 | 18096 | 18066 |
| Haskell | 23/24 | 24/24 | 12814 | 12557 | 12529 |
| OCaml | 23/24 | 24/24 | 10699 | 10491 | 10468 |
| Elixir | 20/24 | 21/24 | 15933 | 15734 | 15711 |
| Zig | 22/24 | 23/24 | 15230 | 14958 | 14928 |

By model after the retry, set b: Haiku A0 12/12, Kotlin 12, Swift 11, Ruby 12, PHP 11, Haskell 11, OCaml 12, Elixir 9, Zig 12; Sonnet 12/12 in every cell (Haskell 9/12 one shot, three protocol rejections on new-function tasks). Set c400: Haiku A0 11/12, Kotlin 11, Swift 8, Ruby 10, PHP 11, Haskell 12, OCaml 12, Elixir 9, Zig 11; Sonnet 12/12 one shot in all nine cells.

Where A0 loses:
- Acceptance on c400: Haskell and OCaml are 24/24 after retry against A0's 23/24, and one shot Haskell and OCaml (23/24), Zig (22) and Kotlin and Ruby (21) are ahead of A0 (20). The loss is Haiku only (Sonnet is 12/12 one shot everywhere). Haiku's A0 first-attempt failures (4): `fold addi 8 p0 p0` (extra operand; still rejected after the retry), `bounds` and `checksum` rewritten without the helper they need, and `pctof` dividing by 100.
- Acceptance on b: Ruby and OCaml are 24/24 one shot against A0's 23/24.
- Cost on b: Ruby is at or below A0 at every length (1 task 293 vs 296, 10-task 128 vs 169, unbounded 109 vs 154), OCaml and Kotlin in sessions (135 / 112 and 157 / 131), Zig only unbounded (150 vs 154). Once the primer is cached, A0's replies and retries are what remain, as in the TS/Rust comparison. A0 still wins the cold single task against every language but Ruby, and every length against Swift, PHP, Haskell and Elixir.
- c400: A0 is 27x (OCaml) to 51x (PHP) cheaper per task; the whole numbered file is 10.3k to 15.7k tokens in each language. Not a loss (results/ai-edit-langs8.json, results/ai-edit-experiment.c400.*-langs8.json).

What did not hold: no language beats A0 on cost at c400. On b only Ruby (tied at 1 task, ahead in sessions) and OCaml (ahead in sessions, equal after retry) match or beat A0 on both acceptance and cost at the lengths where they are not behind. One subject per cell: Haiku swings of 2-4 tasks per set are within subject variance, and each language is one hand translation, so the table says little about how well a language reads in general.

Residual failures after the retry, all Haiku (19 of 204 trials; Sonnet none): Elixir inserts outside the module or calls a function the module cannot see (6); Swift inserts that break the line-edit rule (3), a wrong `checksum`, and a `pctof` that divides by zero; `pctof` division by zero in Kotlin, PHP and Zig, and an undefined variable in Ruby; wrong `checksum` in PHP; Ruby `norm2` returning a helper name; Zig `norm2` inserted inside a function; Haskell indentation; the A0 fold operand count.

## Session 2026-10-01 (errors built for agents)

Aim: a repair turn re-pays the primer, which is why retries are A0's measured loss against TypeScript and Rust, so a rejection is made to be acted on. Branch `<branch>`, started from local `main` (4e0f21d), not `origin/main`: the LSP and the comment-keeping parser, which the LSP part of this needs, are merged on local `main` only. `COMPILER_VERSION` is not bumped: no emitted code changed.

What was built:
- **One diagnostics table, `src/diagnostics.ts`.** 133 rows, each a stable code (`A0nnnn`), the coarse class (unchanged: parse, type, structure, limit, edit, patch, revision, handle, runtime, cli), a `{0}` message template, a fix template and `a0 explain` text of 1 to 6 lines. Every front-end throw site (src/core.ts, src/edit.ts, src/link.ts, src/mcp.ts, src/cli.ts) calls `diag(id, args, detail)`; test/diagnostics.test.ts fails if one of those files spells a message itself. Backend-internal errors (`arm64: ...` and the like) stay plain `A0Error`s with `id` null.
- **Structured fields** `{code, id, message, line, expected, actual, fix, applicability, edits}` from `a0 check --json`, the edit protocol, the MCP server (`a0_apply` diagnostics) and the LSP (`code` is still the class; `data` carries `id`, `fix`, `applicability`, `edits`; an exact fix is the preferred quick fix, a suggestion a quick fix). `formatDiagnostic` keeps the class first and ends with `[A0nnnn]`.
- **Did you mean** for an unknown op or function (direct, `call`, fold and loop bodies), loop predicate, node, and type word, by the rule of TypeScript's `getSpellingSuggestion` (length difference at most max(2, 34%), distance below 40% plus one, nothing under three characters unless it differs by case, closest wins, first of equals wins), written in `spellingSuggestion` with distances in tenths. A callee or node defined later says so instead of guessing. Three implementations agree on 3000 random cases (test/diagnostics.test.ts, test/suggest.test.ts): the banded tenths one, a floating-point port of the TypeScript code, and a plain dynamic program.
- **Applicability.** `exact` fixes carry `edits` and are mechanical: a case-only op or callee, `a = add ...` (the `=`), `a: add ...` (the colon), commas between operands, a hexadecimal literal, an uppercase operand, a parenthesised operand moved to its own line (`ret (a, b)` becomes `ret rec a b`), a missing `end`, and the signature echoed after `-fn name`. Everything else is `maybe` (a typo, a negative literal, a result-type change). 10 exact fix rules in `EXACT_FIXES`.
- **`fix all`** (edit protocol reply, also under a handle line): replays the last rejected reply with every exact fix of every diagnostic applied in turn, through the ordinary path, so the program is validated before anything commits; if a diagnostic with no exact fix remains, nothing commits and that diagnostic is the rejection. `a0 check --fix` is the same loop for a file and writes it only when the result is accepted.
- **`a0 explain A0nnnn`** (no argument: the index; `--verify`: run every example). 82 rows have one failing and one fixed example that run (55 source, 17 edit reply, 5 patch, 5 run); the other 51 name why none can run (reachable only through the API or a file system, or an internal invariant). test/diagnostics.test.ts runs all of them, the way Rust runs `compile_fail` doctests. The explain text is not in any primer (the test checks MODEL_GUIDE.rules-merged.txt names no code).
- **Reject corpus, `corpus/reject/`.** 37 cases (30 programs, 7 edit replies), each `# err: A0nnnn LINE` and a `.fixed` file. test/reject.test.ts checks the code and line, that the exact fixes give the fixed file, that a suggestion's edit does, and that every fixed file is accepted; `node dist/tools/reject-corpus.js --bless` rewrites the headers and fixed files (and is idempotent), `--coverage` lists exact fixes no case exercises (none; a test removes the only hex case and sees it listed).
- **Self-hosted side.** `compiler/suggest.a0` (io front `suggestio`, 58 functions in the closure with lex.a0) is the same rule in A0, in exact tenths, over the token stream: for the token the parser rejects it names the row (A0001, A0101 to A0104) and the suggestion or "defined later". `tools/ref-parse.ts` `refSuggest` is its independent reference (no use of src/); tools/app.ts checks it on every target (a new `suggester` section of results/app.json); test/suggest.test.ts compares it to the reference at every token of 13 programs and to the TypeScript checker's row and suggestion. `compiler/native.a0` links it with the checker, and the native `a0 check` prints the row and the guess after the class line (results/native-check.json: 124 sources agree, 22 token errors checked against the reference line). compiler/parse.a0 and compiler/check.a0 are unchanged: their diagnostics keep the four classes plus position, so only unknown names get a table code in the self-hosted compiler; the other table rows are not reported by it.

Measurement (fresh Haiku and Sonnet subagents; A0 structured cell, MODEL_GUIDE.rules-merged.txt unchanged; sets a, b, d, e, f, 62 tasks per model; one shot plus one repair; scripted replies through tools/ai-edit-experiment.ts with `A0_EXPERIMENT_REPS=a0`, which now skips the TS and Rust reference checks; the prompts are byte-identical to the baseline's group files). Cost is mean o200k tokens per task, cache-adjusted as in the E and F section (system 1.25x on the first call, 0.05x on a repair call). Baseline is the recorded no-fix run, `results/ai-edit-experiment.{a,b,d,e,f}.{haiku,sonnet}-rules-merged.json`; the new runs are `results/ai-edit-experiment.{a,b,d,e,f}.{haiku,sonnet}-diag-fixes.json` (replies beside them); everything below is in `results/diagnostics-measurement.json`.

| model | run | one-shot | after 1 repair | repairs | primer | code read | write | cache-adj total |
|---|---|---|---|---|---|---|---|---|
| Haiku | baseline | 51/62 | 58/62 | 11 | 149 | 138 | 28 | 314 |
| Haiku | fixes | 55/62 | 59/62 | 7 | 148 | 128 | 29 | 305 |
| Sonnet | baseline | 62/62 | 62/62 | 0 | 148 | 89 | 24 | 260 |
| Sonnet | fixes | 62/62 | 62/62 | 0 | 148 | 89 | 23 | 259 |

- **Sonnet:** no failed first reply in either run, so no rejection was ever shown and the fixes cannot matter. The 1-token difference is a shorter reply.
- **Haiku, whole runs:** 55 against 51 one-shot is the same prompts answered by a fresh subject, so it is subject variance, not an effect of the diagnostics (a first reply is produced before any rejection exists). The after-repair 59 against 58 and 305 against 314 tokens are inside that variance.
- **Haiku, the repair turn itself is where the effect would show, and it did not win.** Checker rejections (the first attempt failed with a diagnostic): 5 in the new run, 3 repaired; 8 in the baseline, 7 repaired. The 2 first-reply failures with output mismatches (no diagnostic involved) were repaired 1 of 2 against 0 of 3. Mean repair-task cost rose, 688 against 592, because the rejection is longer.
- **Paired replay** (the 11 recorded baseline first replies that failed, Haiku, rejected by the new diagnostics, answered by a fresh Haiku subject; `results/ai-edit-experiment.{a,b,d,e,f}.haiku-diag-fixes-paired.json`, summarised in `results/diagnostics-measurement.json`): of the 8 checker rejections, 7 were repaired with the old text and 6 with the new; the rejection text grew from 30 to 66 tokens on average, and the mean task cost went from 505 to 555 (+10%). The 3 output-mismatch replies are the same text on both sides (2 repaired in the replay against 0 recorded: sampling noise, not diagnostics). Over all 11 the mean was 592 against 595.
- **`fix all` was never used** (`results/ai-edit-experiment.*.haiku-diag-fixes*.replies.json`). No repair reply in either Haiku collection was `fix all`, including the 2 cases whose rejection offered it (a nested operand): the subject rewrote the lines, as before. The primer does not mention the reply, and putting it there costs 1.25x of its tokens on every task to save a reply on about one in six, so it is left to tool descriptions (the MCP `a0_apply` description now names it).
- **Against TS and Rust (same sets, structured, recorded baseline in `results/diagnostics-measurement.json`):** Haiku TS 326 and Rust 337, Sonnet TS 283 and Rust 306, against A0 314 and 260 without the fixes; in this structured cell with the merged primer A0 is already the cheaper one, so the retry cost the task was written for is a conventional-protocol and a cold-start story rather than something these 62 tasks isolate.

Honest summary (numbers in `results/diagnostics-measurement.json`): the table, suggestions, applicability, `fix all`, `explain` and the corpus are built, tested and consistent across the TypeScript checker, the edit protocol, the MCP server, the LSP and (for unknown names) the self-hosted checker. On these tasks they did not reduce acceptance or cost: Sonnet never needed a repair, and Haiku's checker rejections got longer messages and were repaired no more often. The repair turn is 3 to 5 percent of tasks, so a 10% worse repair turn moves the mean by under half a percent, and 8 paired tasks cannot show a gain of that size either way. Follow-ups, none measured here: make the id and the `fix all` line opt-in for agents whose tool description names the reply (they cost about 36 tokens per rejection with no benefit while the subject does not use them); measure a model that is told `fix all` exists.

Disclosures: (1) after the first-round replies were in and before any repair was collected, one generic gap was closed (an unknown fold body or loop predicate with no close name had no fix text; it now says to define it); the repair groups were rebuilt after that, so every repair reply in these results saw the final text, but the change was made having seen which diagnostics the first round produced. No diagnostic text changed after the repair replies were collected. (2) One Haiku subject left one task unanswered (`b-checksum-poly`); its first reply came from a second fresh Haiku subject given only that task (the original file is kept as `replies-haiku-b.orig.json` in the scratch directory, not committed). (3) Subjects were Agent-tool subagents of the two models, one per group file, one more per repair file, none of them shown the repository. (4) The 51 rows without a runnable example are listed with their reasons in the table.

Gate (this branch, run step by step rather than `a0-dev gate`, to keep CPU modest on a shared machine): lint (biome plus claim-check) pass; typecheck pass; test 154/154; app exit 0 (the new suggester section passes on all six targets, results/app.json); native-check 124/124. NOT run: verify, equiv, hw, dotnet, gpu, selfhost, selfhost-c, bootstrap, site. The scope tool lists them because src/core.ts and src/edit.ts are shared core, but no emitted code, backend, optimizer or emitter source changed (compiler/parse.a0, check.a0 and the emitters are untouched), so there is no gate note for this commit and it should not be pushed before the full `a0-dev gate`.

**Decision (same day, coordinator): the default rejection is compact.** The measured build above ended every rejection with `[A0nnnn]` and, for exact fixes, a line naming `fix all`; that added about 36 tokens and no repair gain (`results/diagnostics-measurement.json`). `formatDiagnostic` now returns `class: message fix: ...` only; the id, `applicability` and `edits` stay in the structured fields (`a0 check --json`, MCP, LSP `data`), and the suffix and the `fix all` line are opt-in (`formatDiagnostic(e, hints)`, `a0 check --hints`, `A0_EXPERIMENT_HINTS=1` in the harness). The table, did-you-mean, explain, corpus, applicability and `fix all` as a command are unchanged. Paired replay rerun with the compact default (the same 11 recorded Haiku first replies, a fresh repair subject, `results/ai-edit-experiment.{a,b,d,e,f}.haiku-diag-fixes-paired.json`; the hints build is kept as `...-hints-paired.json`): of the 8 checker rejections 7 were repaired, as in the baseline (7), and the mean rejection grew from 30 to 60 tokens (it was 66 with hints) and mean task cost from 505 to 538 (it was 555), still +6.5%, because the fix texts that did-you-mean and the result-type hint add (30 tokens on average) remain. Over all 11, 9 repaired against 7 and 571 against 592 tokens, driven by output-mismatch tasks that no diagnostic touches, so that is subject variance. Cost is not back to the baseline: a compact default does not remove the cost of the fix text itself; trimming it is the next lever, unmeasured.

Full gate after the compact-default change (`a0-dev gate`, one step at a time): lint, typecheck, build, test, app, bootstrap, dotnet, gpu, site, selfhost, selfhost-c, verify, equiv, hw all pass (GATE RESULT: pass); `node dist/tools/token-bench.js` run. This supersedes the partial gate line above; results/*.json were regenerated by it.

## Session 2026-10-01 (AI edits: A0 against 48 languages, set b, fresh Haiku and Sonnet subjects)

Runs the project's measurement protocol on set b for every registered language and for A0 (current parser, rules-merged primer, structured protocol, relaxed edit format) and records wins, ties and losses as they fall.

Method (no author-written replies, no old reply rescored):
- One group file per language and model (the 12 set-b tasks, the system text printed once), one fresh Haiku and one fresh Sonnet Agent-tool subagent per file, each reading only its file, one shot. Replies are written as plain text in a delimited file (`==== REPLY <task key> ====`, then the reply verbatim), so no JSON escaping can alter a reply. Every failed first attempt then goes to a fresh subagent of the same model, per model and language, with the system text, the request, its first reply and the harness's exact rejection (`Rejected: ... Try again.`; the A0 cell with the current view): one repair round.
- Cells: A0 structured (rules-merged primer, 118 tokens) and the 48 other languages in the numbered line-edit structured protocol (`PROTOCOL_LINE_EDIT` in tools/ai-edit-apply.ts), which is the protocol the TS and Rust cells use in the rules-merged run. No language is run in the whole-file protocol here. Languages: TypeScript, Rust, Python, Go, Java, C#, C++, Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir, Zig, C, JavaScript, Lua, Perl, Tcl, Objective-C, Fortran, Dart, Nim, Groovy, Clojure, Visual Basic, F#, Scala, Prolog, Forth, Guile, Smalltalk, Racket, Erlang, Common Lisp, Pascal, R, Julia, Haxe, Chicken, Crystal, D, COBOL, V, Odin, Vala, Gleam. Acceptance is each language's own toolchain plus a generated driver; self-check ok in every scoring run (every reference passes, every original fails).
- Scoring ran at most 2 processes at a time and not while the 1-minute load was above 25 (other jobs shared the 8 cores).
- Cost per task as in "No primer and lazy primer": o200k tokens, system text 1.25x on the first call and 0.05x later, task + view (retry: + reply + repair) and replies 1x. "1 task" is a cold session, "10 tasks" spreads one primer write over ten, "unbounded" has the primer fully cached. Tokens per task: primer (system text, per call), code read (task, view, repair messages), write (replies). Each cell is 24 trials (12 tasks x Haiku and Sonnet).

Two collections (the first exposed an ambiguity in the harness text; it was fixed generally and all 48 languages were collected again):
- proto1, the line-edit text of the earlier runs (`+<number> <new text>` inserts after line <number>; "a number may be given once"). A0 and 40 languages were collected here (82 first-shot subjects, 45 repair subjects). Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir and Zig are the existing fresh collection `b.{haiku,sonnet}-langs8` of the langs8 branch, reused unchanged: this harness produces the same `langTaskSetSha256` (`bcce8fde...`) and `taskSetSha256` and the same system and view token counts for all 96 of its trials. The one difference is the Elixir compile message (that branch cut it to start at the first error; this harness reports it in full), which can only touch Elixir repairs. Results `results/ai-edit-experiment.b.<model>-<lang>.proto1.json` (+ `.replies.json`) for the 40 and the langs8 files for the 8.
- proto2, `PROTOCOL_LINE_EDIT`, which states what cost proto1 most first attempts. Of 157 first-attempt failures, 56 (55 Haiku) wrote a multi-line insertion with consecutive numbers (`+8 a`, `+9 b`: this anchors `b` after line 9, not after `a`) because the text said a number may be given once, and 33 of the 59 trials still failing after the repair were that. The new text says to repeat the same number once per new line (inserted in order), that the text after the single space following the number is the whole line including its indentation, that a line may be replaced or deleted once, and that every edit line starts with a view line number. The parser is unchanged; test/ai-edit-apply.test.ts (5 tests) pins its semantics: indentation kept verbatim, repeated `+n` in order, consecutive `+n` anchoring different lines, delete, replace once, optional handle, bad line, and that the system text states these. All 48 languages were collected again with fresh subjects (96 first-shot subjects, 51 repair subjects); A0 was not (its prompts and parser did not change). The longer text adds about 61 primer tokens per call to every non-A0 cell (TypeScript 155 -> 216; A0's 133 is unchanged). Results `results/ai-edit-experiment.b.<model>-<lang>.json` (+ `.replies.json`: first reply and repair), A0 `...-a0.json`.
- Pilot before the full collection (Haiku on Python, Java, Nim): multi-line insertions repeated the number; Python (3/12) and Nim (3/12) stayed at their proto1 first-shot level, because Haiku still wrote replacement text without the indentation in the indentation-significant languages, so that one is a model slip rather than text the harness can state better. (F# improved from 9 indentation slips to none.)

Summary files: `results/ai-edit-b48.json` (every cell: pooled and per model, tokens, cost, first-attempt status, A0 against the language, both protocols) and `results/ai-edit-b48.failures.json` (every first-attempt failure with its class and the classification rules).

### Result: proto2 (clarified protocol); A0 first, then by acceptance after repair

From `results/ai-edit-b48.json` (`proto2`): acceptance pooled over Haiku and Sonnet (24 trials) one shot and after one repair; the two models (one-shot>repaired, of 12 each); tokens per task primer / code read / write = total; model calls per task; cost for 1 task, 10 tasks and an unbounded session. Last column: A0 against that language on (one-shot, repaired, 1 task, 10, unbounded): W = A0 better, T = tie (acceptance equal, cost within 1%), L = A0 worse.

| language | one-shot | after repair | Haiku / Sonnet (one-shot>repair, of 12) | tokens/task primer / read / write = total | calls | 1 task | 10 tasks | unbounded | A0 vs it (1-shot, repair, 1, 10, unb.) |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 21/24 | 23/24 | 9>11 / 12>12 | 133 / 119 / 35 = 287 | 1.12 | 326 | 199 | 185 | - |
| Ruby | 24/24 | 24/24 | 12>12 / 12>12 | 217 / 85 / 19 = 321 | 1.00 | 375 | 141 | 115 | LLWLL |
| Erlang | 24/24 | 24/24 | 12>12 / 12>12 | 244 / 104 / 28 = 376 | 1.00 | 436 | 173 | 144 | LLWLL |
| Perl | 24/24 | 24/24 | 12>12 / 12>12 | 266 / 119 / 28 = 413 | 1.00 | 479 | 192 | 160 | LLWLL |
| Crystal | 24/24 | 24/24 | 12>12 / 12>12 | 304 / 92 / 21 = 416 | 1.00 | 492 | 164 | 128 | LLWLL |
| R | 24/24 | 24/24 | 12>12 / 12>12 | 272 / 346 / 19 = 636 | 1.00 | 704 | 411 | 378 | LLWWW |
| TypeScript | 23/24 | 24/24 | 11>12 / 12>12 | 216 / 99 / 25 = 340 | 1.04 | 388 | 165 | 140 | LLWLL |
| JavaScript | 23/24 | 24/24 | 11>12 / 12>12 | 232 / 95 / 24 = 352 | 1.04 | 401 | 161 | 134 | LLWLL |
| Go | 23/24 | 24/24 | 11>12 / 12>12 | 232 / 108 / 23 = 364 | 1.04 | 418 | 177 | 150 | LLWLL |
| C++ | 23/24 | 24/24 | 11>12 / 12>12 | 229 / 122 / 23 = 374 | 1.04 | 428 | 190 | 164 | LLWLL |
| Common Lisp | 23/24 | 24/24 | 11>12 / 12>12 | 256 / 96 / 25 = 377 | 1.04 | 431 | 165 | 136 | LLWLL |
| OCaml | 23/24 | 24/24 | 11>12 / 12>12 | 267 / 86 / 21 = 374 | 1.04 | 433 | 156 | 125 | LLWLL |
| Forth | 23/24 | 24/24 | 11>12 / 12>12 | 274 / 100 / 19 = 393 | 1.04 | 455 | 171 | 139 | LLWLL |
| Elixir | 23/24 | 24/24 | 11>12 / 12>12 | 259 / 114 / 28 = 401 | 1.04 | 462 | 193 | 163 | LLWLL |
| Kotlin | 23/24 | 24/24 | 11>12 / 12>12 | 290 / 94 / 22 = 405 | 1.04 | 470 | 169 | 136 | LLWLL |
| D | 23/24 | 24/24 | 11>12 / 12>12 | 291 / 93 / 22 = 405 | 1.04 | 470 | 169 | 135 | LLWLL |
| Haskell | 23/24 | 24/24 | 11>12 / 12>12 | 315 / 122 / 25 = 462 | 1.04 | 533 | 207 | 171 | LLWWL |
| Objective-C | 23/24 | 24/24 | 11>12 / 12>12 | 328 / 142 / 24 = 494 | 1.04 | 569 | 229 | 191 | LLWWW |
| Julia | 22/24 | 24/24 | 10>12 / 12>12 | 270 / 106 / 25 = 401 | 1.08 | 455 | 186 | 156 | LLWLL |
| Smalltalk | 22/24 | 24/24 | 10>12 / 12>12 | 266 / 110 / 33 = 410 | 1.08 | 466 | 200 | 171 | LLWTL |
| F# | 22/24 | 24/24 | 10>12 / 12>12 | 285 / 108 / 23 = 416 | 1.08 | 473 | 189 | 157 | LLWLL |
| Vala | 22/24 | 24/24 | 11>12 / 11>12 | 304 / 110 / 23 = 437 | 1.08 | 498 | 194 | 160 | LLWLL |
| Zig | 22/24 | 24/24 | 10>12 / 12>12 | 342 / 108 / 24 = 474 | 1.08 | 541 | 199 | 162 | LLWTL |
| Prolog | 22/24 | 24/24 | 10>12 / 12>12 | 299 / 139 / 40 = 478 | 1.08 | 542 | 244 | 210 | LLWWW |
| Scala | 22/24 | 24/24 | 10>12 / 12>12 | 330 / 129 / 26 = 486 | 1.08 | 553 | 224 | 187 | LLWWW |
| PHP | 22/24 | 24/24 | 10>12 / 12>12 | 341 / 187 / 29 = 557 | 1.08 | 627 | 287 | 249 | LLWWW |
| Fortran | 22/24 | 24/24 | 10>12 / 12>12 | 344 / 267 / 38 = 649 | 1.08 | 735 | 391 | 353 | LLWWW |
| Rust | 21/24 | 24/24 | 12>12 / 9>12 | 250 / 113 / 27 = 389 | 1.12 | 438 | 199 | 172 | TLWTL |
| Tcl | 21/24 | 24/24 | 9>12 / 12>12 | 279 / 113 / 30 = 422 | 1.12 | 472 | 204 | 174 | TLWWL |
| Swift | 21/24 | 24/24 | 9>12 / 12>12 | 327 / 112 / 25 = 464 | 1.12 | 518 | 204 | 169 | TLWWL |
| V | 20/24 | 24/24 | 10>12 / 10>12 | 320 / 120 / 26 = 465 | 1.17 | 512 | 216 | 183 | WLWWT |
| Visual Basic | 19/24 | 24/24 | 10>12 / 9>12 | 332 / 164 / 32 = 529 | 1.21 | 582 | 285 | 252 | WLWWW |
| Python | 15/24 | 24/24 | 3>12 / 12>12 | 300 / 100 / 25 = 424 | 1.38 | 438 | 202 | 176 | WLWWL |
| Nim | 14/24 | 24/24 | 3>12 / 11>12 | 368 / 131 / 24 = 523 | 1.42 | 527 | 246 | 215 | WLWWW |
| Racket | 23/24 | 23/24 | 11>11 / 12>12 | 261 / 121 / 24 = 406 | 1.04 | 466 | 195 | 165 | LTWLL |
| Dart | 23/24 | 23/24 | 11>11 / 12>12 | 283 / 99 / 26 = 408 | 1.04 | 478 | 184 | 151 | LTWLL |
| C | 23/24 | 23/24 | 11>11 / 12>12 | 286 / 145 / 23 = 455 | 1.04 | 522 | 225 | 192 | LTWWW |
| Clojure | 22/24 | 23/24 | 10>11 / 12>12 | 275 / 104 / 30 = 409 | 1.08 | 466 | 192 | 161 | LTWLL |
| Odin | 22/24 | 23/24 | 10>11 / 12>12 | 309 / 108 / 23 = 439 | 1.08 | 500 | 192 | 158 | LTWLL |
| Groovy | 22/24 | 23/24 | 11>11 / 11>12 | 351 / 156 / 24 = 531 | 1.08 | 606 | 257 | 218 | LTWWW |
| Haxe | 22/24 | 23/24 | 10>11 / 12>12 | 353 / 243 / 21 = 618 | 1.08 | 697 | 345 | 306 | LTWWW |
| Lua | 21/24 | 23/24 | 9>11 / 12>12 | 267 / 101 / 25 = 393 | 1.12 | 445 | 189 | 160 | TTWLL |
| Chicken Scheme | 20/24 | 23/24 | 8>11 / 12>12 | 336 / 133 / 26 = 495 | 1.17 | 543 | 232 | 197 | WTWWW |
| Gleam | 20/24 | 23/24 | 8>11 / 12>12 | 356 / 355 / 27 = 738 | 1.17 | 828 | 499 | 462 | WTWWW |
| Java | 19/24 | 23/24 | 8>11 / 11>12 | 272 / 137 / 26 = 435 | 1.21 | 479 | 236 | 209 | WTWWW |
| C# | 19/24 | 23/24 | 9>11 / 10>12 | 260 / 156 / 28 = 443 | 1.21 | 492 | 259 | 234 | WTWWW |
| Pascal | 18/24 | 23/24 | 9>11 / 9>12 | 349 / 205 / 40 = 594 | 1.25 | 664 | 363 | 329 | WTWWW |
| Guile | 17/24 | 23/24 | 5>11 / 12>12 | 307 / 119 / 26 = 452 | 1.29 | 480 | 223 | 194 | WTWWW |
| COBOL | 20/24 | 22/24 | 8>10 / 12>12 | 441 / 229 / 71 = 741 | 1.17 | 831 | 423 | 377 | WWWWW |

A0's rank among the 49 (1 = best): one-shot 34 of 49 (4 others tied), after repair 34 of 49 (14 others tied), 1 task 1 of 49 (0 others tied), 10 tasks 23 of 49 (3 others tied), unbounded 30 of 49 (1 others tied). Against the 48: one-shot 11 W / 4 T / 33 L, after repair 1 W / 14 T / 33 L, 1 task 48 W, 10 tasks 23 W / 3 T / 22 L, unbounded 18 W / 1 T / 29 L. By model, Sonnet: A0 12/12 one shot and 12/12 after repair; 39 languages also reach 12/12 one shot and all 48 after repair, none is better. Haiku: A0 9 -> 11 of 12 against a mean of 9.9 -> 11.7 over the other 48 (one-shot 36 languages ahead of A0, 5 level, 7 behind; after repair 33 ahead, 14 level, 1 behind).

Every loss (A0 worse than the language, pooled counts):
- One-shot acceptance (33 languages, each 22 to 24 of 24 against A0's 21): Crystal, Erlang, Perl, R, Ruby, Common Lisp, C++, D, Elixir, Forth, Go, Haskell, JavaScript, Kotlin, Objective-C, OCaml, TypeScript, Fortran, F#, Julia, PHP, Prolog, Scala, Smalltalk, Vala, Zig, C, Dart, Racket, Clojure, Groovy, Haxe, Odin. Level: Rust, Swift, Tcl, Lua.
- Acceptance after the repair (33 languages, each 24/24 against A0's 23/24): Crystal, Erlang, Perl, R, Ruby, Common Lisp, C++, D, Elixir, Forth, Go, Haskell, JavaScript, Kotlin, Objective-C, OCaml, TypeScript, Fortran, F#, Julia, PHP, Prolog, Scala, Smalltalk, Vala, Zig, Rust, Swift, Tcl, V, Visual Basic, Python, Nim. A0 beats COBOL (22/24) and is level with 14 languages at 23/24 (Java, C#, C, Lua, Dart, Groovy, Clojure, Guile, Racket, Pascal, Haxe, Chicken, Odin, Gleam). A0's one open trial is Haiku `b-sumfrom-eight`: the first reply `r fold addi 8 p0 p0` was applied to the function the view opens (`addi`, the first function) and rejected (`unknown fold body 'addi'`); the repair wrote a fold with an extra operand (`addi expects 0 extra arguments, got 1`), the fold-contract error of the rules-merged run, and was not corrected. Its other two Haiku misses were repaired (`bounds-largest`: a nested operand; `checksum-poly`: the step function left unchanged, result 7).
- 10-task session cost (22 languages): Crystal, Erlang, Perl, Ruby, Common Lisp, C++, D, Elixir, Forth, Go, JavaScript, Kotlin, OCaml, TypeScript, F#, Julia, Vala, Dart, Racket, Clojure, Odin, Lua. Level: Smalltalk, Zig, Rust.
- Unbounded session cost (29 languages): Crystal, Erlang, Perl, Ruby, Common Lisp, C++, D, Elixir, Forth, Go, Haskell, JavaScript, Kotlin, OCaml, TypeScript, F#, Julia, Smalltalk, Vala, Zig, Rust, Swift, Tcl, Python, Dart, Racket, Clojure, Odin, Lua. Level: V.
- 1 task: no loss; A0 is the cheapest cold task at 326 (Ruby 375, TypeScript 388, JavaScript 401, Go 418). With the proto1 text it was third (Ruby 293, TypeScript 319, A0 326, Rust 328), so the proto2 surcharge is part of the 1-task win; the proto1 table below is the same comparison without it.
- Cheapest sessions: 10 tasks Ruby 141, OCaml 156, JavaScript 161, Crystal 164 (A0 199); unbounded Ruby 115, OCaml 125, Crystal 128, JavaScript 134 (A0 185). Once the primer is cached, replies and code read decide: A0 reads 119 and writes 35 tokens per task against Ruby's 85 and 19 (R, Forth and Ruby write 19). A0's primer is the lowest of all (133, TypeScript 216, Ruby 217).

Failure taxonomy of the first attempts (class from the reply and the rejection by the rules in the failures file; every reply was complete, so truncation never occurred; the A0 misses, 3 trials, are in both columns):

| class | proto1 (157 failures; Haiku 146, Sonnet 11) | proto2 (119 failures; Haiku 102, Sonnet 17) |
|---|---|---|
| protocol ambiguity (consecutive `+` numbers for a multi-line insert; the proto1 text left the reading open) | 56 | 0 (fixed) |
| format slip | 37: indentation dropped (Python 9, Nim 9, F# 9, COBOL 2, Haskell 1), lines without a number or an omitted reply 7 | 30: indentation dropped (Python 9, Nim 9, COBOL 3, Fortran 1), consecutive numbers again 8 (Haiku: C# 3, Pascal 3, Haskell 1, C 1) |
| genuine model error | 64 (compile 45, runtime 9, wrong output 8, A0 checker 2) | 89 (compile 50, runtime 20, wrong output 17, A0 checker 2) |
| truncation | 0 | 0 |

Genuine errors are wrong code and wrong placement (a new function inserted after the closing brace or `end` of the module or class, so the file does not build), a missing wrap or division-by-zero rule, `>>` for `>>>`, `^` on booleans, a missing closing parenthesis on a replaced Lisp line, a wrong library name. They were left alone. After the repair 17 of 1176 proto2 trials stay open (59 in proto1): 13 genuine, 4 format slips, all Haiku: `pctof-limit` 9 (placement or numbering of the new function in Java, C#, C, Pascal; the wrap or division rule or a wrong result in Dart, Chicken, COBOL, Odin; Float division in Haxe), `onlyone-xor` 3 (Clojure, Guile, Racket: no boolean xor), `avgfloor-nowrap` 2 (Lua, Groovy), COBOL `checksum-poly`, Gleam `rot8-constant`, and A0's `sumfrom-eight`. Sonnet misses 17 first attempts in 9 languages (Rust 3, Visual Basic 3, Pascal 3, C# 2, V 2, Java, Nim, Groovy, Vala) and repairs all of them.

### Result: proto1 (earlier line-edit text), same comparison

A0's rank among the 49: one-shot 24 of 49 (8 others tied), after repair 23 of 49 (14 others tied), 1 task 3 of 49 (1 others tied), 10 tasks 23 of 49 (0 others tied), unbounded 25 of 49 (0 others tied). Against the 48: one-shot 17 W / 8 T / 23 L, after repair 12 W / 14 T / 22 L (A0 wins over Java, Perl, Groovy, Visual Basic, Smalltalk, Pascal, Haxe, Chicken, COBOL, Odin, Vala, Elixir, which stood at 17 to 22 of 24), 1 task 45 W / 1 T / 2 L (Ruby 293 and TypeScript 319 against A0's 326; Rust 328 level), 10 tasks 26 W / 22 L, unbounded 24 W / 24 L.

| language | one-shot | after repair | 1 task | 10 tasks | unbounded |
|---|---|---|---|---|---|
| A0 | 21/24 | 23/24 | 326 | 199 | 185 |
| Ruby | 24/24 | 24/24 | 293 | 128 | 109 |
| OCaml | 24/24 | 24/24 | 343 | 135 | 112 |
| Tcl | 24/24 | 24/24 | 354 | 155 | 133 |
| Rust | 23/24 | 24/24 | 328 | 157 | 138 |
| C++ | 23/24 | 24/24 | 345 | 177 | 158 |
| Clojure | 23/24 | 24/24 | 371 | 166 | 143 |
| Erlang | 23/24 | 24/24 | 373 | 179 | 157 |
| Dart | 23/24 | 24/24 | 386 | 161 | 136 |
| Kotlin | 23/24 | 24/24 | 388 | 157 | 131 |
| Crystal | 23/24 | 24/24 | 428 | 169 | 140 |
| Scala | 23/24 | 24/24 | 447 | 186 | 157 |
| Zig | 23/24 | 24/24 | 452 | 180 | 150 |
| Gleam | 23/24 | 24/24 | 671 | 411 | 382 |
| TypeScript | 22/24 | 24/24 | 319 | 164 | 147 |
| JavaScript | 22/24 | 24/24 | 332 | 160 | 141 |
| Go | 22/24 | 24/24 | 341 | 169 | 150 |
| D | 22/24 | 24/24 | 406 | 174 | 148 |
| Julia | 21/24 | 24/24 | 379 | 180 | 157 |
| C | 21/24 | 24/24 | 461 | 233 | 208 |
| V | 20/24 | 24/24 | 434 | 207 | 182 |
| Python | 15/24 | 24/24 | 357 | 191 | 172 |
| Nim | 14/24 | 24/24 | 449 | 238 | 214 |
| Common Lisp | 23/24 | 23/24 | 364 | 168 | 146 |
| Forth | 23/24 | 23/24 | 375 | 160 | 136 |
| Lua | 22/24 | 23/24 | 351 | 164 | 144 |
| Prolog | 22/24 | 23/24 | 469 | 240 | 214 |
| R | 22/24 | 23/24 | 639 | 414 | 389 |
| C# | 21/24 | 23/24 | 377 | 214 | 195 |
| Objective-C | 21/24 | 23/24 | 523 | 252 | 222 |
| Fortran | 21/24 | 23/24 | 669 | 394 | 364 |
| Swift | 19/24 | 23/24 | 454 | 209 | 182 |
| Haskell | 19/24 | 23/24 | 497 | 240 | 211 |
| PHP | 19/24 | 23/24 | 584 | 312 | 282 |
| Guile | 18/24 | 23/24 | 404 | 216 | 195 |
| Racket | 18/24 | 23/24 | 451 | 249 | 226 |
| F# | 14/24 | 23/24 | 507 | 292 | 268 |
| Odin | 22/24 | 22/24 | 431 | 193 | 166 |
| COBOL | 20/24 | 22/24 | 727 | 388 | 350 |
| Perl | 21/24 | 21/24 | 451 | 233 | 209 |
| Vala | 21/24 | 21/24 | 454 | 220 | 194 |
| Pascal | 21/24 | 21/24 | 516 | 284 | 258 |
| Java | 20/24 | 21/24 | 396 | 222 | 203 |
| Smalltalk | 20/24 | 21/24 | 415 | 219 | 197 |
| Elixir | 20/24 | 21/24 | 470 | 270 | 248 |
| Haxe | 19/24 | 21/24 | 671 | 388 | 356 |
| Groovy | 17/24 | 18/24 | 636 | 355 | 324 |
| Visual Basic | 17/24 | 18/24 | 639 | 411 | 386 |
| Chicken Scheme | 17/24 | 17/24 | 586 | 344 | 317 |

### Findings

- A0 is the cheapest cold task and the cheapest reader of its own language, but it is not ahead on acceptance: 21/24 one shot and 23/24 after repair, 33 languages one to three trials ahead on either measure, all of it Haiku; Sonnet is level everywhere. The only A0 trial open after the repair is the fold-with-an-extra-operand error that the checker's message names and that Haiku did not fix on the repair round.
- In a long session the primer stops mattering and A0 loses cost to the 22 to 29 languages whose replies and views are shorter (Ruby, OCaml, JavaScript, Crystal, Go, TypeScript, Erlang, Common Lisp, D, Kotlin, Perl ...); A0's primer saving is 83 tokens per call against TypeScript, which is about 4 tokens once cached.
- The line-edit protocol is where most other languages lose: Haiku drops the indentation in Python and Nim (9 of 12 tasks each, with and without the clarified text) and misplaces new functions (after the module's closing brace, or inside another function) in the module-wrapped languages (Java, C#, Visual Basic, Pascal, Vala, Haxe in proto1, mostly through the numbering ambiguity); the repair fixes most of it, so they end at 23 or 24 of 24 after the repair against 14 to 22 one shot (Nim 14, Python 15). A0's protocol has neither failure.
- One subject per cell, 12 tasks and one hand translation per language: a one-trial gap (23 against 24 of 24) is inside the swing of a single Haiku subject, so the 33 acceptance losses bound the comparison, they do not rank the languages.
- Not measured: whole-file replies for these languages (the structured cells here use the numbered line edits).

Gate: lint and typecheck pass. `bun run test` could not finish on the benchmark host: the x86-64 test binaries (compiled drivers run under Rosetta) hung in an uninterruptible state for every job sharing the host (more than 20 `driver` processes older than 20 minutes, not killable with SIGKILL), which stalls test/core and test/behavior. Run file by file with a timeout, every test file passes (ai-edit-apply 5, agents 3, dev-tools 26, edit 11, core 45, parallel 5, security 10, behavior 3, trap 6, seed 4, loss-ledger 7, mcp 3, macho 3, others) and the only non-passing entries are the two tests (one in core, one in behavior) cancelled by the hung x86-64 binaries; nothing this session changed touches them.

## Session 2026-10-01 (dense view: a token-minimal surface syntax)

Goal: `tokens-kernel` was 351 of the 477 recorded losses (results/lang-axes.json: o200k tokens to write the ten benchmark kernels; A0 41 of 49). A language built for agents should be the most compact to write and read. The dense view is a second surface syntax over the same programs; canonical stays the default, the hashed form and what every backend, proof and revision sees. COMPILER_VERSION is not bumped (no emitted code changes). Grammar: DESIGN.md section 5a. Code: `src/dense.ts` (printer, parser, `normalizeProgram`), `src/dense-edit.ts` (dense replies to the edit protocol), wired through `src/link.ts` (`.a0d` files, `--dense`), `src/cli.ts` (`--dense` on every command, `a0 dense`, `a0 canon`), `src/edit.ts` (`open(name, { dense: true })`, `openProgram`), `src/mcp.ts` (`dense: true`, `.a0d` files saved as dense), `src/lsp.ts` (`.a0d` diagnostics and formatting). Tests: test/dense.test.ts (round trips over every `.a0` file of the repository, the generated corpus, 1,500 random programs with odd ids, every printer style, errors, edits), plus dense cases in test/mcp.test.ts and test/lsp.test.ts. The self-hosted compiler (compiler/*.a0) does not read dense yet; the grammar is exact enough to port, and `a0 canon` converts for it meanwhile.

**1. Where the tokens go** (results/dense-tokens.json, `bun run build && node dist/tools/dense-tokens.js`; o200k_base). The ten kernels, canonical 559 tokens: types 88, parameters (`p0` is two tokens) 86, newlines 81, id references 67, literals 56 (a number costs its space), id definitions 52, operations 51, fn names 22, `fn` 14, `->` 14, `ret` 14, `end` 14. A parameter reference costs 2, `u32` costs 2, `shl` costs 2; every other op word is 1. Per feature (the same programs printed with that one feature off, kernels / five corpus files): prefix nesting 94 / 7,854 tokens, implicit ids 110 / 9,084, implicit result (no `ret`/`end`) 90 / 1,681, implicit types 89 / 278, parameter letters 43 / 2,214, `[0;8]` repeats 12 / 1,453, one-statement functions on the `fn` line 9 / 86, `<<`/`>>` 2 / 110. Simulated, not adopted (text transformations in the scratch run, not in the repository): no `fn` keyword saves 12 of 222 kernel tokens (a name without its space often costs two tokens), fused immediates (`>>19 a`) 6, fold bodies written inline 9 on the kernels.

**2. Design that came out of it.** Prefix expressions with fixed arity (no parentheses, none needed; `(EXPR)` groups anyway because Haiku wrote it), a value used once nests into its consumer, ids only where a value is named, default ids by position, the last statement is the result, `u32` is implicit (no type list when every parameter is u32; a type list needs `-> RESULT`), parameters are `A`, `B`, ... A canonical program converts to dense and back exactly (every id, node order and revision); programs written in the dense style are what shrinks, because the stored kernels use ids and an order the dense form cannot nest: `a0 dense --normalize` (reorder by data dependencies, default ids; same behavior, different revision) gives the compact form. The whole corpus: 58,278 canonical tokens in the five sampled files and the generated corpus, 49,304 as exact dense text (0.85), 31,766 normalized (0.55).

**3. Kernels against 48 languages** (results/lang-axes.json `tokens.a0.dense`, `--tokens-only` merges the tokens axis without re-running the timings). A0 dense 202 tokens for the ten kernels (inline fold/loop bodies, see 5), canonical 559. Rank 1 of 49 by the sum (canonical rank 41); 0.63 of the best single language (Forth, 323) and 0.75 of the sum of the per-kernel bests (300). Per kernel dense / best language: affine 7 / 15 (OCaml), rotl 13 / 31 (R), clamp 17 / 22 (Nim), mix 33 / 39 (Forth), ident 3 / 5 (OCaml), chain3 25 / 45 (Forth), branchy 32 / 49 (Forth), arrfill 31 / 48 (D), loop64 29 / 41 (Forth), and noop 12 / 5 (OCaml). **noop is a loss that stays:** the A0 kernel is `add 0`, `mul 1`, `xor 0` (it tests that the optimizer adds no work) while every other language writes `x`; dense cannot drop operations without changing the program. The loss ledger keeps both subjects (tools/loss-ledger.ts): canonical A0 rows are unchanged (the 351 `tokens-kernel` losses stay recorded, place 41 of 49) and dense is the separate subject `a0-dense` (source `lang-axes-dense`, place 1 of 49) with its own rows, the 26 noop rows among them; the ledger total is 503. Dense never replaces canonical, because canonical is the default surface. Dense wins by a lot on nine kernels (arrfill 0.65, loop64 0.71 of the best, the others 0.42 to 0.85) and loses noop.

**4. Models** (results/dense-experiment.json, results/ai-edit-experiment.{a,b,d,e,f}.{haiku,sonnet}-{dense,rules-merged-fresh}.json with `-retry.json` and `.replies.json`). Fresh Haiku and Sonnet subagents, one group file per set and form, one shot, then one retry per failed trial by a fresh subagent given the exact rejection, same method as "No primer and lazy primer". Dense primer `MODEL_GUIDE.dense.txt` (204 o200k tokens), canonical primer the existing `MODEL_GUIDE.rules-merged.txt` (118), fresh collections for both (the earlier rules-merged replies were not reused). Sets a, b, d (76 trials per cell) and the held-out e, f (48):

| cell | system | one shot | after 1 retry | calls/task | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|---|
| a+b+d dense | 204 | 68 | 74 | 1.11 | 364 | **144** | **119** |
| a+b+d canonical | 118 | 68 | 74 | 1.11 | **282** | 155 | 141 |
| e+f dense | 204 | 42 | 44 | 1.13 | 387 | 166 | **142** |
| e+f canonical | 118 | 43 | 46 | 1.10 | **289** | **162** | 148 |
| a-f dense | 204 | 110 | 118 | 1.11 | 373 | **153** | **128** |
| a-f canonical | 118 | 111 | 120 | 1.10 | **285** | 158 | 144 |

By model (a-f, 62 trials each): Sonnet dense 61/62 one shot, canonical 61/62, both 61 after retry; Haiku dense 49 -> 57, canonical 50 -> 59. The model writes less in dense (mean reply 22.9 tokens against 26.0) and reads a smaller view (76 against 89), so it wins every cached cost and loses the cold single task by the 86 extra primer tokens (373 against 285). Acceptance is level within the sample noise (about three trials per cell); Haiku after the retry is 57 against 59 and the e, f subset 44 against 46, which this sample cannot separate from noise but also does not call a win.

How the grammar got here, because the first collections found real problems (all Haiku; Sonnet was 38/38 in every round): round 1 (grammar v1, primer 190 tokens) Haiku a+b+d 28/38 against canonical 30/38. Its failures: an explicit type list without `->` (`fn absdiff u32 u32 u32`, the last type meant as the result; read as three parameters, so a runtime arity error, three trials) was an ambiguity and was fixed generally: a type list now needs its `->`, and the error says how; `_` as the printed `u32` in headers was copied as a wildcard (`fn sumsq _ -> u32` for a `u32x4` parameter), so the printer writes `u32`; `S`, a model-invented parameter letter, inflated a function to 19 parameters, so operand-count errors now name the callee and its parameter count; the first Haiku round also passed a name (`n`) for a parameter, so the unknown-word fix says parameters are `A`, `B`, ... Round 2 (primer 214 to 204 tokens) Haiku wrote Lisp-style `(lt A B)`, which the first parser read as a one-field record (a silent type error, six trials): `(EXPR)` is now grouping and a one-field record is `(x,)`; the same replies re-scored with that parser went 7/13 to 13/13 on set a. Round 3 is the table above, fresh replies with the final grammar and primer on a, b, d and the held-out e, f. Remaining Haiku failures are model errors that the canonical cell shares: `fold` given an extra operand (`d-total-six`, `b-sumfrom-eight`), a bool result without `-> bool` (`d-isdiv-bool`), `get` on a record, wrong arithmetic. One new dense-only shape: a Haiku subject copied the signature lines of the program view (`fn offset u32 u32 -> u32`) as a body-less header followed by a second `fn offset ...` line (five trials in the second d sample; the retry repaired five of that sample's six failures); the d set was collected twice for Haiku dense (9/13 and 7/13 one shot), the second file is the one kept. Not fixed: the grammar cannot tell that apart from a function with no result, and the error already says so.

Losses, recorded and not hidden: acceptance after the repair is 23/24 for dense, as for canonical, and 33 languages reach 24/24 (one trial, a wrong output by Haiku, stays unresolved); Ruby is ahead of dense on 10 tasks and, with Kotlin, OCaml, JavaScript, Common Lisp, Crystal and D, on unbounded sessions (Ruby reads 85 and writes 19 tokens per task against dense 99 and 23, with a 217-token primer that a long session amortizes). Dense cuts reading from 119 to 99 tokens and writing from 35 to 23 against canonical, which is what moves the 10-task rank from 23 to 2 and the unbounded rank from 30 to 8. Sample: 24 trials per cell, so a difference of one or two trials in acceptance is within noise; the canonical cell here is the b48 collection, a second fresh canonical collection on the same set (this session) costs 321 / 194 / 180 against its 326 / 199 / 185.

### Dense session-cost levers (set b first, then a, d, e, f)

Aim: the rows where dense A0 still lost in the 49-language set-B table (10 tasks 156 against Ruby 141, unbounded 138 against 115). Method as before: fresh Haiku and Sonnet subagents, one shot plus one retry by a fresh subagent given the rejection, o200k tokens, system text 1.25x on the first call and 0.05x after. Results: `results/ai-edit-experiment.{a,b,d,e,f}.{haiku,sonnet}-dense-{lean,lean2,lean3,lean4,bare}*.json`, `results/ai-edit-b48-dense.json`, `results/dense-experiment.json`.

Found first: `b-sumfrom-eight` had no `target`, so the A0 view showed its helper `addi`, not `sumfrom`, which holds the bug (models rewrote `sumfrom` from the instruction). The task now names its target (`tools/ai-edit-tasks-b.ts`); the earlier canonical and dense cells of that table were collected with the old view, so the table's canonical A0 row is not re-collected.

| lever | what | result (a-f, both models, 124 trials unless stated) |
|---|---|---|
| 1 read: lean view | function view only: no handle line (the reply applies to the one open function), no program handle with its signature lines | adopted. Read per task 74 to 54 tokens; one shot 114/124 (dense 111, canonical 111), after retry 122/124 (dense 114, canonical 120); cost 272 / 115 / 98 for 1 task / 10 tasks / unbounded against dense 299 / 142 / 125 and canonical 285 / 158 / 144 |
| 1b read: bare view | also drop the callee signature lines | not adopted: set b only, 3.5 fewer tokens per task (54 to 50), one shot 22/24 as lean, Haiku fails the same two tasks; callee arities are what fold and call replies need |
| 2 write: edit-line replies | `ret EXPR` and `ID EXPR` replies instead of whole functions | rejected: set b one shot 15/24 against 22/24 (Haiku 6/12 against 10/12, Sonnet 9/12 against 12/12); models mixed bare lines with `fn` blocks, and the system text is 21 tokens longer; replies shrink to 14 tokens only because they fail. This is the earlier numbered-edit failure in another form |
| 3 primer 145 to 124 (`MODEL_GUIDE.dense3.txt`, op list cut) | | not adopted: one shot 107/124, after retry 115/124 (Haiku f 6/13 one shot); cost 256 / 123 / 108, worse than lean at 10 tasks and unbounded. 108 tokens (`MODEL_GUIDE.dense4.txt`): set b one shot 20/24 |
| 4 inline fold and loop bodies | done earlier (arrfill 31, loop64 29 tokens) | nothing further |

Ranks in the 49-language set-B table (`results/ai-edit-b48-dense.json`, proto2; the subject against the 48 languages; W/T/L against the 48 with a 1% cost band; 24 trials per cell, set b only). The earlier dense cell is `a0-dense`; the lean cell is `a0-dense-lean`; `a0-dense-lean3` is the 124-token primer:

| subject | 1 task | 10 tasks | unbounded | one shot | after repair |
|---|---|---|---|---|---|
| canonical A0 | 326, rank 1 | 199, rank 23 | 185, rank 30 | 21/24 | 23/24 |
| a0-dense (before) | 312, rank 1 (48/0/0) | 156, rank 2 (46/1/1) | 138, rank 8 (39/2/7) | 23/24 | 23/24, rank 34 |
| a0-dense-lean | 297, rank 1 (48/0/0) | 141, rank 1 (47/1/0, a tie with Ruby 141) | 123, rank 2 (47/0/1) | 22/24, rank 21 | 24/24, rank 1 (33 ties) |
| a0-dense-lean3 | 284, rank 1 | 150, rank 2 | 135, rank 4 | 22/24 | 22/24, rank 48 |

Remaining loss: unbounded sessions, 123 against Ruby 115. Ruby reads 85 and writes 19 tokens per task; the lean cell reads 77 and writes 26 (the write mean includes the retried replies of the two Haiku tasks that fail first, `b-bounds-largest` and `b-checksum-poly`, which every form fails once). One fewer retry in twelve tasks is about 8 tokens, so that row is within the noise of 24 trials and not yet won. The harness variable is `A0_EXPERIMENT_DENSE_VIEW=lean|bare`; the MCP tool `a0_open` takes `lean: true` for the same view (test/mcp.test.ts).

**Follow-up (primer, shapes, diagnostics, inline bodies).**

- Ledger: canonical and dense are separate subjects (see 3); `test/loss-ledger.test.ts` covers the subject split.
- Primer: `MODEL_GUIDE.dense.txt` is rules-only now, 145 o200k tokens (was 204): the rules models violated (bare reply lines, whole functions, prefix arity, `A B C` parameters, `[a b]` array against `(a b)` record, `fold F n s a..`, types only when not all u32), a compact op list. Canonical is 118. Round 6 was collected fresh with Haiku and Sonnet on sets a, b, d, e, f (one shot plus one retry, all losses counted).
- Signature lines: the dense program view writes a function's signature as a comment (`# inc u32 -> u32`), so a model that copies it cannot produce a body-less header followed by a second `fn name` line, and a body-less header followed by a second `fn name` is an error whose hint says not to repeat `fn NAME` for the body. Tests: test/dense.test.ts.
- Diagnostics: dense edits and checks cite names the dense text shows (letters `A B`, the printed default ids, the dense statement), never canonical auto ids such as `sumsq.a`; `denseDiagnostic` in src/edit.ts, tests in test/dense.test.ts.
- Inline bodies: `fold {set A B add B C} 8 [0;8] A` and `loop {lt A C} {add A 1} 10 0 A`. A body is lifted to the function `CALLER_N` before its caller (single use, not `call`ed, no fold/loop inside, no comments, types inferred as state, u32 index and extras); a named helper is still accepted and a mixed loop (one named, one inline) works. Dense kernel tokens 224 to 202 (arrfill 48 to 31, loop64 34 to 29). `normalizeProgram` renames single-use helpers to `CALLER_N` (still behavior-preserving, different revision).
- Alias: a statement `x y` where `y` is a defined value is `x mov y`.
- Results of round 6 (results/dense-experiment.json, `.replies.json` and `-retry.json` per cell): a-f both models 124 trials per form.

| cell | system | one shot | after 1 retry | calls/task | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|---|
| a+b+d dense | 145 | 70 | 72 | 1.08 | 294 | **137** | **120** |
| a+b+d canonical | 118 | 68 | 74 | 1.11 | **282** | 155 | 141 |
| a-f dense | 145 | 111 | 114 | 1.10 | 299 | **142** | **125** |
| a-f canonical | 118 | 111 | 120 | 1.10 | **285** | 158 | 144 |

By model (a-f, 62 trials each): Sonnet dense 59 -> 61, canonical 61 -> 61 (cost 281 / 124 / 107 against 264 / 136 / 122); Haiku dense 52 -> 53, canonical 50 -> 59 (317 / 160 / 143 against 307 / 179 / 165). Cold single task: dense 299 against canonical 285 (14 tokens, 5%, a loss for dense; the old 373 is gone), 10-task 142 against 158 (-10%), unbounded 125 against 144 (-13%). Against TypeScript and Rust (STATUS "Rules-only primer", the same task sets: Rust 312 / 160 / 143, TypeScript higher): dense is cheaper than Rust at all three lengths (299 / 142 / 125). The loss in this table is Haiku's acceptance after one retry: dense 53/62 against canonical 59/62 (nine unresolved against three). The retry for round 6 was one batch by one fresh Haiku subagent, which wrote weaker corrections than the per-trial subagents of earlier rounds, so Haiku's retried acceptance is probably understated; it was kept as measured.

**x86_64 and the gate on the benchmark host.** `core.test` "fold state passed again as an extra: the A0 backends copy it" and the x86 native check hang because a freshly built x86-64 binary never starts under the x86-64 translation layer on that host (it sits in uninterruptible state; even a C hello world does; `/usr/bin/arch -x86_64 /usr/bin/true` and an x86 clang compile still succeed, so the existing probe reports the host as fine). It is the environment, not a defect: main's dist hangs the same way. `A0_SKIP_X86=1` makes `tools/verify.ts` (`x86Host`) and `test/core.test.ts` (`X86_64_HOST`) report x86-64 as skipped with that reason; the gate recorded below ran with it, so the x86 rows are skips on that host and must be run where x86-64 execution works.

**What this does not show.** Dense does not lower the cold single-task cost (a 145-token primer against 118; 299 against 285) and does not raise Haiku's acceptance on this sample; the token wins are at writing and reading, in cached sessions, and in the kernel benchmark. The primer is the next target (every clause that the three rounds found a failure for is in it; 204 is not minimal). Hand-written lambdas for fold bodies, fused immediates and a `fn`-less boundary were measured only by simulation (section 1) and not implemented; the first would help `arrfill` and `loop64` most. Dense diagnostics from the checker still name canonical node ids (`sumsq.a`) that the dense text does not show; the fix text usually carries the rule. The noop loss is the benchmark's definition of the kernel, not the syntax. Canonical remains the default everywhere; dense is opt-in per file (`.a0d`), per command (`--dense`), per MCP call and per session handle.
