# Pre-registration: the failure-driven diagnostics and edit-tool changes, application-scale edits (written before any subject ran)

Date: 2026-10-07. Written and committed before any subject saw a request or a repair message produced by the changed code.

## The question

`docs/design/failure-taxonomy.md` (`results/failure-taxonomy.json`) classifies the 1447 first-attempt failures of A0 subject trials recorded under `results/`. Five
changes follow from its top classes where the cause is the language or the tooling, not the model (the changes are general; none names a task):

1. a markdown code fence round an edit reply is ignored (`stripCodeFences`, `src/edit.ts`);
2. `-id <old node text>` with no replacement carries the exact edit `-id` (A0504, rule `delete-text`);
3. a callee that is `sel`, `lte`, `gte`, `ule`, `uge`, `ult`, `ugt`, `neq` or `equ`, with the operand count of the op it names, carries the exact rename (A0102, rule `alias`);
4. an edit that makes a function call one defined below it is accepted with the callee moved just above its first caller (`validateOrdered`, `src/edit.ts`);
5. A0026 (`unexpected 'end' before ret`) names the line to write (`ret <last node>`), as a suggestion.

The question: do they raise the accepted count on the application-scale tasks that failed after repair?

## What is rerun, and why only that

The application-scale benchmark (`tools/app-edit-bench.ts`, 14 sealed tasks `tools/app-edit-tasks.ts`, `tools/app-edit-tasks.sha256`, never altered) with the form that
is the A0 default today: dependency-scoped program view (`A0_PROGRAM_VIEW=deps`) and the word-key legend on (the default), as measured in `results/app-edit-keys.json`.
The tasks not accepted after repair in that arm are:

- Haiku: `fat-arrow`, `profile-canonical`, `param-limit`, `number-leading-zero` (4 of 14).
- Sonnet: none (14 of 14).

The older arms (`results/app-edit.json`, full listing; `results/app-edit-deps.json`, deps view without the legend) have a different A0 request for some tasks
(`op-alias-mod`, `drop-unsigned-aliases`, `use-alias-import` and others failed there); those arms are superseded by the keys arm, whose A0 side is
the shipped default, so their failures are not rerun and their numbers are not mixed in.

Rerun with fresh subagents, one per prompt, one shot plus one repair by a fresh subagent per rejected first reply:

- Haiku on the 4 tasks above (the tasks that failed);
- Sonnet on the same 4 tasks (a non-regression check: those tasks were accepted before, and the changes must not make Sonnet worse).

8 fresh first-reply subagents and one fresh repair subagent per rejected reply. The other 10 tasks are not rerun: their requests are byte-identical and nothing in
the changes touches a reply that was accepted (the changes only widen what the tool accepts or say more in a rejection); their keys-arm trials carry over for the 14-task totals.
The A0 requests of the 4 tasks are checked byte-identical to `results/app-edit-keys` (the guide, the view and the protocol text are unchanged), so only the
tool's behaviour on a reply and the text of a rejection differ from the collected arm.

Single sample per cell: four tasks and one trial each. The result cannot separate a gain from sampling noise; it is a check that the changes do not hurt and a
count of what they did, and the claim made from it is bounded accordingly.

## The rule (fixed now)

Accepted count after repair, on the 4 rerun tasks, per model:

- Haiku: more than the keys arm's (0 of 4).
- Sonnet: not fewer than the keys arm's (4 of 4; counts from `results/app-edit-keys.json`).

Both conditions, or the changes are reported as not shown to help at application scale (they stay in the tree if the unit tests and the reject corpus hold; the language
and checker are unchanged, only the edit tool's tolerance and the rejection text, so there is no emission change and no `COMPILER_VERSION` bump). Reported with wins, ties
and losses and none hidden: one-shot and after-repair counts on the 4 tasks and on the 14 (rerun plus carried), tokens per accepted edit at the 10-task horizon
(`tools/app-edit-summary.ts` formulas), and for every non-accepted trial the first rejection message and its class (a failure that needed a fact the view did not give is
a view gap, named). For each trial the raw replies and the harness's rejection messages are read for whether one of the five changes fired (a fence in the reply, an exact delete or alias fix in
a rejection, a reply that calls a function defined below, the A0026 text shown); a change that fired in no trial is reported as not exercised, not as effective.

## Incidents, fixed in advance

A subject refused by an API safeguard gets the identical request once more, never reworded; a second refusal is a recorded loss. A subject that does not answer is not accepted
and not rerun. The decision is read from `results/app-edit-fixes.json` (`tools/app-edit-fixes-summary.ts`) and not changed after.

## How to run (exact commands)

```
A0_PROGRAM_VIEW=deps bun tools/app-edit-bench.ts dump results/app-edit-fixes/dump.a0.json a0
bun tools/ai-edit-subjects.ts prompts results/app-edit-fixes/dump.a0.json <scratch>/<model>/a0/prompts   # only the four tasks, one fresh subagent per prompt
bun tools/ai-edit-subjects.ts collect results/app-edit-fixes/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/replies.json
A0_PROGRAM_VIEW=deps bun tools/app-edit-bench.ts run <scratch>/<model>/a0/replies.json results/app-edit-fixes/report1.<model>.a0.json a0 <model>
bun tools/ai-edit-subjects.ts repair results/app-edit-fixes/report1.<model>.a0.json results/app-edit-fixes/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/repair-prompts
# repair replies as <key>.repair.txt, then collect and run again into results/app-edit-fixes/report.<model>.a0.json
bun tools/app-edit-fixes-summary.ts
```

## Result (collected after the rule above was committed; `results/app-edit-fixes.json`, `tools/app-edit-fixes-summary.ts`)

8 fresh first-reply subagents (Haiku and Sonnet, the four tasks) and 5 fresh repair subagents (Haiku 4, Sonnet 1), scored once after every agent had reported. No subject was refused. The A0 requests were byte-identical to `results/app-edit-keys/dump.a0.json`.

| model | one shot (4 tasks) | accepted after repair (4 tasks), before | after |
|---|---|---|---|
| Haiku | 0 | 0 | 0 |
| Sonnet | 3 | 4 | 3 |

Rule: **not met** (Haiku did not rise; Sonnet fell by one). Not shown to help at application scale. Per trial: Haiku `fat-arrow` and `number-leading-zero` were refused at first on a nested operand and a 5-operand `select` (syntax slips that the repair message described and the repair still did not fix; `number-leading-zero` finished on a wrong result), `profile-canonical` was refused twice on the function header, `param-limit` ran wrong twice. Sonnet `profile-canonical` was accepted in the keys arm and in this run was a wrong result at first and a type error in the repair (a loss; sampling noise cannot be excluded at one trial per cell). Of the five changes, none fired in any of the 13 replies (no fence, no `-id text` delete, no `sel`-style spelling, no callee defined below, no A0026): they were not exercised here, so this measurement says nothing for or against them; their evidence is the unit tests and the reject corpus. The remaining misses are model errors in the edit language and wrong behaviour, not view gaps. The changes stay in the tree (tolerance and message text only; no emission change, no `COMPILER_VERSION` bump).
