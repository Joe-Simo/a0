# Pre-registration: the shipped wording of the program view, application-scale edits through the tools (written before any subject ran)

Date: 2026-10-06. Written and committed before any model subject was run in this arm. No model was called while the
harness or this note were written; the only runs were the tests (`test/app-edit-wording.test.ts`, `test/app-edit-loop.test.ts`).

## The question

The deps-view arm (`docs/history/2026-10-06-app-edit-deps-preregistration.md`, `results/app-edit-deps.json`,
`results/app-edit-deps/view-tokens.json`) measured that an A0 request with the program view scoped to the functions the
target reaches (what `a0_program` returns when given a target) costs about a quarter of the tokens of the full signature
listing, with acceptance not lower on either model. But the shipped skill (`skills/a0/SKILL.md`: "`a0_program` for
whole-program work") and the shipped MCP description of `a0_program` ("every function signature, or with target only
those around it") present the bare listing first. The question: does wording that steers the author to the scoped view
make authors choose it, and cost less per accepted edit, with acceptance not lower?

## Design

The tool-loop arm (`docs/history/2026-10-06-app-edit-loop-preregistration.md`, `tools/app-edit-loop.ts`) with these
changes, A0 side only, selected by `--arm wording --variant current|revised` (the loop arm's commands and behaviour are
unchanged; `test/app-edit-loop.test.ts` and the self-check still hold):

- Each of the 14 sealed tasks of `tools/app-edit-tasks.ts` (seal checked by every command; nothing in it changes) gets a
  scratch directory holding `TASK.md` with only `# Task` and the task's instruction (no view, no handle open),
  `GUIDE.md` (exactly the loop arm's: the shipped `MODEL_GUIDE.min.txt` plus `A0_PROTOCOL`), `SKILL.md` (the variant's
  skill text), the program `front.a0`, the same `./tool` and `.loop/`.
- The tool has the loop arm's commands (view FUNCTION, program [TARGET], apply, check, revision, explain, run, lex,
  parse, help), the same budget of 12 tool runs and the same refusal. `./tool help` carries the variant's descriptions of
  `view` (a0_open) and `program` (a0_program); the other lines are the loop arm's. No handle is open at the start.
- Scoring and the cost model are the loop arm's (`scoreDir`), with the system part = the subagent prompt + GUIDE.md +
  the variant's SKILL.md (counted per model call by the horizon, as the loop arm counts GUIDE.md); the request is TASK.md
  as written; the help, when asked for, is a tool output and counts as tool context.
- Each trial also records `programViews`: every `program` run from the tool log, `bare` for no target, else the target.

Limitation, recorded in advance: TASK.md names no function, so a subject must find the function to change with the
tools (for example `check`, which lists every function, or a program view). This applies equally to both variants; it
is part of what the wording is meant to steer.

## The two variants (files in `experiments/wording/`)

`current`: `experiments/wording/current/SKILL.md` is byte-identical to the shipped `skills/a0/SKILL.md`, and
`experiments/wording/current/tools.json` holds the shipped descriptions of `a0_open` and `a0_program` from `src/mcp.ts`
(`test/app-edit-wording.test.ts` fails if either drifts). `revised`: the same text with the wording changed only on the
choice of view. The exact diff:

```diff
--- a/experiments/wording/current/SKILL.md
+++ b/experiments/wording/revised/SKILL.md
@@ -8,7 +8,7 @@
 # A0
 
 1. If the `a0_*` MCP tools are available (`a0_open`, `a0_program`, `a0_apply`, `a0_check`, `a0_run`, `a0_emit`, `a0_save`), use them for all reading and editing. Do not edit .a0 files as text.
-   - `a0_open` a function (or `a0_program` for whole-program work), send bare edit lines to `a0_apply` under the handle, then `a0_check` or `a0_run`, and `a0_save` only after a successful apply.
+   - `a0_open` the function you change; when other functions are needed, `a0_program` with that function as `target` (the listing around it), not `a0_program` without a target (every signature of the program) unless the whole program is needed. Send bare edit lines to `a0_apply` under the handle, then `a0_check` or `a0_run`, and `a0_save` only after a successful apply.
    - On a diagnostic, apply its `fix` and resend under the same handle.
 2. Without the MCP tools, use the CLI: `a0 check f.a0`, `a0 run f.a0 FN ARGS...`, `a0 emit TARGET f.a0`. `a0 mcp <dir>` starts the MCP server.
--- a/experiments/wording/current/tools.json
+++ b/experiments/wording/revised/tools.json
 {
   "a0_open": "Open one function: returns a handle line followed by the function (with callee signatures under scope \"deps\"). Reply to a0_apply with the handle line then replacement node lines.",
-  "a0_program": "Open a program handle: every function signature, or with target only those around it. The handle accepts whole fn ... end blocks that add or replace functions."
+  "a0_program": "Open a program handle around a target: with target, the signatures of the functions around it (use this when an edit needs other functions); without target, every function signature of the program (only when the whole program is needed). The handle accepts whole fn ... end blocks that add or replace functions."
 }
```

In `./tool help` these appear as `./tool view FUNCTION  a0_open: <a0_open text>` and
`./tool program [TARGET]  a0_program: <a0_program text>`, after the line saying that view is the MCP tool a0_open
(scope deps) and program is a0_program.

## Subjects

14 tasks, Haiku and Sonnet, 2 variants: 56 subjects, one fresh subagent per working directory, scored once after every
subject has finished. There is no repair round: the loop is the repair.

### The exact subagent prompt (`WORDING_PROMPT` of `tools/app-edit-loop.ts`; `<dir>` is the working directory)

> You are making one change to a program. Your working directory is &lt;dir&gt;. First read &lt;dir&gt;/TASK.md,
> &lt;dir&gt;/SKILL.md and &lt;dir&gt;/GUIDE.md with the Read tool; together they are everything you need. Then make the
> change using only the tool in that directory, run with the Bash tool as: cd "&lt;dir&gt;" && ./tool COMMAND ARGS
> (./tool help lists the commands; text for apply goes on standard input, for example with a quoted heredoc). You have
> at most 12 tool runs; the tool counts them and refuses more. Do not read, write or list any other file or directory,
> do not edit any file directly, and use no other tool. When the change is complete, or you cannot do better, reply
> with the single word done.

It is the loop arm's prompt with SKILL.md added to the files read first; it is the same for both variants.

## Metrics (`tools/app-edit-wording-summary.ts`, which writes its results file after the run)

Per model and variant, n = 14: acceptance (the final program passes every hidden test; a program file changed outside
the tool is not accepted) with a Wilson 95% interval (claim-ok: the interval level of the method, not a measured value);
tool runs per task and per accepted edit, runs refused at the budget; tokens per accepted edit (o200k_base, local
counts) at the three horizons of `tools/app-edit-summary.ts`, primary the 10-task horizon; the re-read context
(secondary); and the number and share of subjects that asked for the bare listing (`program` with no target) at least
once, with a Wilson interval, plus the number that asked for a targeted one, and every subject's program views.

## The rule (fixed now)

Per model, separately: the revised wording passes if

1. its accepted count is not lower than the current wording's by more than 1 task (a margin of one task, declared
   before collection), and
2. its tokens per accepted edit at the 10-task horizon is lower (raw numbers).

Both models pass, or no change. A change means: `skills/a0/SKILL.md` (and its synced copies) and the `a0_program`
description in `src/mcp.ts` become the revised text, in a separate commit with its own checks. The share of subjects
using the bare listing is reported but is not part of the rule. Wins, ties and losses are all reported, whatever the
outcome, in a Result section added to this note; nothing else is changed or claimed in STATUS.md from this arm beyond
what that section records.

## Incidents, fixed in advance

A subject refused by an API safeguard gets the identical prompt once more in a fresh directory; a second refusal, or a
subject that stops without saying done, is scored on whatever state its directory holds. Never reuse a directory: a
rerun is a fresh setup. The decision is read from the summary file and not changed after.

## How the orchestrator runs it (exact commands)

```
bun tools/app-edit-loop.ts self-check                                     # must print: self-check ok
bun tools/app-edit-loop.ts setup <scratch>/<model>/current a0 --arm wording --variant current
bun tools/app-edit-loop.ts setup <scratch>/<model>/revised a0 --arm wording --variant revised
#   for each of the 28 files <scratch>/<model>/<variant>/a0/prompts/<task>.txt: one fresh subagent of <model>
#   (haiku or sonnet) whose whole prompt is that file's text; wait until it says done (or stops).
bun tools/app-edit-loop.ts score <scratch>/<model>/current a0 <model> --arm wording --variant current
bun tools/app-edit-loop.ts score <scratch>/<model>/revised a0 <model> --arm wording --variant revised
#   writes results/app-edit-wording/report.<model>.<variant>.json
bun tools/app-edit-wording-summary.ts                                     # after both models and both variants
```

Subjects may run in parallel (each has its own directory); the two variants of one task may run at the same time.
