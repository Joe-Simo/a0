# Pre-registration: application-scale edits through the tools, A0 against TypeScript (written before any subject ran)

Date: 2026-10-06. Written and committed before any model subject was run in this arm. No model was called while the
harness or this note were written; the only runs were the harness self-check and the tests
(`results/app-edit-loop/self-check.json`, `test/app-edit-loop.test.ts`).

## The question

The one-shot arm (`docs/history/2026-10-06-app-edit-preregistration.md`, result in `results/app-edit.json`) gave each
subject one reply and one repair, and A0 accepted fewer edits than TypeScript on both models. An A0 author does not
work that way: it reads the guide, applies edits through the MCP server or the CLI, reads the diagnostics (with exact
fixes and `fix all`), runs the program on an input, and tries again. The question of this arm: on the same 14 sealed
tasks, with each side given the tools its author really has and the same budget of tool runs, how many edits are
accepted and how many tokens does an accepted edit cost?

## What stays from the one-shot arm

The task set `tools/app-edit-tasks.ts` (its seal `tools/app-edit-tasks.sha256` is checked by every command; nothing in
it changes), the two start programs (checked against `START_SHA256`), the hidden tests and their runner (`runTests` of
`tools/app-edit-bench.ts`), the primers (GUIDE.md is exactly the one-shot system text of the side: for A0 the shipped
`MODEL_GUIDE.min.txt` plus `A0_PROTOCOL`, for TypeScript the one-sentence `TS_PROTOCOL`), the request (TASK.md ends with
exactly the one-shot request: the instruction, then for A0 the e-handle views and the program handle, for TypeScript the
whole `front.ts`), the scoring of TypeScript through `tsc` strict before the tests, and the cost model of
`tools/app-edit-summary.ts`.

## Protocol

`bun tools/app-edit-loop.ts setup OUTDIR` creates one working directory per task and side, `OUTDIR/<side>/<task>/`,
holding only: `TASK.md` (the tool's help, then the request), `GUIDE.md`, the program (`front.a0`, the linked front end as
formatted, or `front.ts`), the script `tool`, and `.loop/` (the tool's state and log). One fresh subagent per directory
(Haiku and Sonnet, A0 and TypeScript, 14 tasks: 56 subjects) receives the prompt below and nothing else, works through
`./tool` with the Bash tool, and ends by saying done. Then `score` reads the final program file and runs the hidden tests.
There is no separate repair round: the loop is the repair.

### The exact subagent prompt (the same on both sides; `<dir>` is the working directory)

`SUBAGENT_PROMPT` of `tools/app-edit-loop.ts`, written per task by `setup` into `OUTDIR/<side>/prompts/<task>.txt` with the
directory filled in:

> You are making one change to a program. Your working directory is &lt;dir&gt;. First read &lt;dir&gt;/TASK.md and
> &lt;dir&gt;/GUIDE.md with the Read tool; together they are everything you need. Then make the change using only the tool
> in that directory, run with the Bash tool as: cd "&lt;dir&gt;" && ./tool COMMAND ARGS (./tool help lists the commands;
> text for apply goes on standard input, for example with a quoted heredoc). You have at most 12 tool runs; the tool
> counts them and refuses more. Do not read, write or list any other file or directory, do not edit any file directly,
> and use no other tool. When the change is complete, or you cannot do better, reply with the single word done.

### What the tool shows

A0 side (what `a0 mcp` and the CLI offer for editing; each A0 command is the MCP tool's behaviour):

- `view FUNCTION` (a0_open, dependency scope), `program [TARGET]` (a0_program);
- `apply` (a0_apply, the edit on standard input; a rejected edit changes nothing and prints the JSON diagnostic with
  id, expected and actual, fix and applicability; the edit `fix all` applies every exact fix of the last rejected edit);
- `check` (a0_check: one line per function with its revision), `revision FUNCTION` (`a0 revision`),
  `explain A0nnnn` (`a0 explain`), `run FUNCTION ARGS` (a0_run, JSON arguments, the interpreter's fuel bound);
- `lex TEXT` and `parse TEXT`: the program's `lexsrc` and `parseio` on a text (a harness wrapper: packing a text into
  the word arrays those functions take is not something either author should spend runs on).

The session is rebuilt on every run from the program file and the views opened so far, replayed in order, so handle
names are those a live MCP session would show; the last rejected edit is kept for `fix all`. One documented deviation
from `src/mcp.ts`: after an accepted edit whose handle line was left out (the guide allows it when one e handle is open),
a0_apply returns the whole program (the view of the first line fails), all 106 functions; the tool
returns the view of the implied handle instead. This favours A0 against the shipped server, is the same information,
and the shipped behaviour was a defect: it is fixed in `src/mcp.ts` (a0_apply now returns the view of the implied handle, test in `test/mcp.test.ts`), so the tool and the shipped server now agree.

TypeScript side (what an author of a TypeScript file has): `show [FROM [TO]]` (numbered lines of the file), `apply`
(a unified diff on standard input, applied by `applyDiff` of the one-shot arm: hunks found by their old text), `check`
(`tsc` with the one-shot arm's strict options; up to 20 diagnostics, or ok), `lex TEXT` and `parse TEXT` (`refLex` and
`refParse` of the current file, run even when it does not type-check, as `tsx` would, bounded at 10 s).

Both sides print `[tool run k of 12; m left]` after each output.

### What the tool hides

The hidden tests, their inputs and expected values, the reference and wrong replies. Neither side has a "run the tests" command.
Limitation, recorded in advance: the `tool` script names the harness
in the repository, which holds the tests; a subject that ignored the prompt could read them. The orchestrator checks
each subject's transcript for any tool use other than Read of TASK.md and GUIDE.md and Bash running `./tool`; such a
subject is scored as not accepted and reported by name.

### The budget: N = 12 tool runs

Every invocation of `./tool` counts (help, a failing command and a malformed one included); after 12 the tool refuses
and runs nothing. Why 12: TASK.md already carries the view (A0) or the whole file (TypeScript), so no run is needed to
read. A careful edit is: one or two probes of the current behaviour (`lex`, `parse`), one `apply`, one `check`, two or
three runs to confirm the new behaviour and that old inputs are unchanged; that is about six. A second round after a
rejection or a wrong probe doubles it. 12 allows one full repair round on both sides and still bounds cost; it is the
same number for both sides and fixed before any subject ran.

## Metrics (`tools/app-edit-loop-summary.ts`, writing `results/app-edit-loop.json`)

Per model and side, n = 14:

- acceptance: the final program file passes every hidden test (TypeScript: and type-checks), count with a Wilson 95%
  interval (claim-ok: the interval level of the method, not a measured value); a program file whose hash differs from
  the one the tool last wrote is "edited outside the tool" and not accepted;
- tool runs per task and per accepted edit, runs refused at the budget;
- tokens per accepted edit (o200k_base, local counts) at the three horizons of `tools/app-edit-summary.ts`, computed by
  its `horizons`, from these buckets per subject:
  - system: the subagent prompt (with the `<dir>` placeholder) + GUIDE.md + the tool help, weighted per model call
    by the horizon; model calls = logged tool runs + 1 (the final reply);
  - toolContext: the request (the one-shot request text) + every tool output as logged (including the run counter
    line and refusals);
  - output: every command as `./tool ARGS` plus its standard input;
- secondary: the re-read context, the sum over model calls of everything before that call (system, request, earlier
  commands and outputs), per accepted edit. An agent loop re-reads its context on every call; the primary cost model
  counts each token once, as the one-shot arm did, so the arms compare; the re-read figure shows what that leaves out.

Not counted, on either side: the subagent's own framework prompt and tool schemas, its reasoning and any prose it writes
between runs, and the line-number prefix of the Read tool. These are invisible to the harness and the same kind of
cost on both sides.

## The rule

The one-shot arm's rule, on this arm's numbers: for each model, A0 wins when its accepted count is not lower than
TypeScript's and its tokens per accepted edit at the 10-task horizon are lower; TypeScript wins the same way round; a tie
is equal accepted counts with costs within 5 percent of the lower (claim-ok: a decision band fixed in advance, not a
measured value); anything else is mixed. Tool runs, the other horizons, the re-read figure and the comparison with the
one-shot arm are secondary and reported for every cell. Wins, ties and losses are all reported, whatever the outcome, in
a Result section added to this note; nothing is shipped or claimed in STATUS.md from this arm beyond what that section
records.

## How the orchestrator runs it (exact commands)

```
bun tools/app-edit-loop.ts self-check results/app-edit-loop/self-check.json   # must print: self-check ok
bun tools/app-edit-loop.ts setup <scratch>/<model> a0
bun tools/app-edit-loop.ts setup <scratch>/<model> ts
#   for each of the 28 files <scratch>/<model>/<side>/prompts/<task>.txt: one fresh subagent of <model>
#   (haiku or sonnet) whose whole prompt is that file's text; wait until it says done (or stops).
#   Never reuse a directory: a rerun is a fresh setup.
bun tools/app-edit-loop.ts score <scratch>/<model> a0 <model>   # results/app-edit-loop/report.<model>.a0.json
bun tools/app-edit-loop.ts score <scratch>/<model> ts <model>   # results/app-edit-loop/report.<model>.ts.json
bun tools/app-edit-loop-summary.ts                            # after both models and both sides
```

Subjects of one model and side may run in parallel (each has its own directory). A subject refused by an API safeguard
gets the identical prompt once more in a fresh directory; a second refusal, or a subject that stops without saying done,
is scored on whatever state its directory holds. Scoring happens once, after every subject has finished.
