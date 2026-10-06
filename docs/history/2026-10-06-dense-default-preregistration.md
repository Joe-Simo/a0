# Pre-registration: dense against canonical as the form for edit sessions (written before any set-H reply was collected)

Date: 2026-10-06. Written and committed before any subject saw set H. Question: the 325 canonical token losses of the ledger
(`results/loss-blockers.json`) close only if the dense form is the recommended one; sets e and f (`results/primer-ablation.json`)
show dense winning the session-length cost and losing the cold task, with a primer that was chosen on set d. This note fixes a
confirmation on a set nobody has used, in advance.

## The set

Set H (`tools/ai-edit-tasks-h.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-h.sha256`, checked before the run, never altered).
Written by an Opus subagent that was given only `experiments/set-h/AUTHOR_BRIEF.md` (a neutral JSON program model; it saw neither
the language nor any other set nor any model answer) and wrote the starting programs, instructions, hidden tests and wrong edits in
`experiments/set-h/h-tasks.neutral.json`. `tools/ai-edit-tasks-h-gen.ts` only converts the format and checks with the reference
interpreter (the starting program fails a test, the reference passes all of them, each wrong edit fails one, at least 8 tests):
16 of 16 tasks passed, none was changed by hand. A0 only (no TypeScript or Rust cell: the question is the form, not the language).

## What is compared

`D`: the dense primer `experiments/primers/ablation/dense.D0.txt` (145 o200k tokens) with the dense view (`A0_EXPERIMENT_DENSE=1`).
`K`: the best canonical primer `experiments/primers/ablation/canon.KR3.txt` (101 tokens) with the canonical view. Both as the sole system
text (`A0_EXPERIMENT_PRIMER=rules-merged`), structured protocol, `A0_EXPERIMENT_REPS=a0`, `A0_EXPERIMENT_TASKSET=h`. Fresh Haiku and
Sonnet Agent-tool subagents, one group-file subagent per variant and model (4 first-reply cells, n = 16 each, 64 trials), then one repair
round by a fresh subagent of the same model for every rejected first reply: one shot plus one repair. Cost counted as in the primer
ablation (`tools/primer-ablation-summary.ts`). All four cells are collected in the same session.

## The rule (fixed now)

Primary horizon: the 10-task session (the product's use is a multi-call editing session). Primary acceptance: one-shot count.
Recommend the dense form for edit sessions if, on set H and for Haiku and Sonnet separately,
1. `D` one-shot acceptance count is not lower than `K`'s, and
2. `D` tokens per accepted edit at the 10-task horizon is lower than `K`'s (raw numbers, no band).
Both conditions on both models, or no recommendation. Reported with wins, ties and losses and none hidden: the cold one-task and unbounded
horizons, acceptance after one repair, Wilson 95% intervals. A recommendation is only a recorded decision here; changing the shipped guide,
the MCP text or the skill copies is a separate step that needs its own shipped-text measurement.

## Incidents, fixed in advance

A subject refused by an API safeguard gets the identical request once more, never reworded; a second refusal is a recorded loss (a missing
reply is a failure). A subject that leaves a task unanswered is asked for that task alone. Failures are classified: protocol ambiguity (a
general fix with a test, not applied to this set) or model error (recorded). The decision is read from the summary and not changed after.
