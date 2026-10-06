# Pre-registration: set I, dense (with the unwritten-result fix) against canonical (written before any set-I reply was collected)

Date: 2026-10-06. Set H (`results/set-h.json`) did not confirm dense: its rule was not met on either model. After it, the dense parser was changed
so that a result not written in the header is the type of the last statement (`test/dense.test.ts`), the general fix for the one failure every variant
of the primer ablation shared (a bool or aggregate result without its type in the head). Set H cannot test that fix (its dense failures were positional
parameters and operand counts), so this note fixes a confirmation on a new set, in advance.

## The set

Set I (`tools/ai-edit-tasks-i.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-i.sha256`, checked before the run, never altered), written by an Opus
subagent that was given only `experiments/set-i/AUTHOR_BRIEF.md` (the set-H brief plus one requirement stated in advance: at least 8 tasks whose
target result is not u32, 4 bool, 2 array, 2 record, and no repeat of set-H program ideas). It validated its own tasks with an interpreter it wrote,
then `tools/ai-edit-tasks-h-gen.ts i` converted and re-checked them with the reference interpreter (16 of 16 passed, nothing changed by hand). Set H is
untouched (its seal still verifies).

## What is compared, and the rule

Exactly as in the set-H note: `D` (dense.D0 primer, dense view; the parser now includes the unwritten-result fix) against `K` (canon.KR3 primer, canonical
view), as the sole system text, structured protocol, fresh Haiku and Sonnet subagents, one group-file subagent per variant and model (n = 16 each), then one
repair round by a fresh subagent per cell with rejections. Recommend the dense form only if, for Haiku and Sonnet separately, (1) `D` one-shot count is not lower
than `K`'s and (2) `D` tokens per accepted edit at the 10-task horizon is lower than `K`'s (raw numbers). Both on both models or nothing. Reported with wins, ties
and losses: cold and unbounded horizons, acceptance after one repair, intervals, and the one-shot acceptance on the 8 non-u32-result tasks separately for `D` and `K`.
Incidents, refusals and unanswered requests are handled as in the set-H note. The decision is read from `results/set-i.json` and not changed after.
