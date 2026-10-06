# Pre-registration: set J, dense against canonical with all three protocol fixes in place (written before any set-J reply was collected)

Date: 2026-10-06. Sets H and I (`results/set-h.json`, `results/set-i.json`) did not meet the rule: dense lost on Haiku both times and won on Sonnet once. After
set I three general protocol changes are in the code, none measured: an unwritten dense result takes the type of the last statement (`test/dense.test.ts`), an
`ex` line written after a node is hoisted under the header, and `at`/`put` written on an array carries an exact edit to `get`/`set` (rule `array-op`, shown in the
rejection a repair round receives). This note fixes a confirmation on a new set, in advance. Nothing about set J was chosen from earlier failures except the
brief's requirement of array and record tasks, stated below.

## The set

Set J (`tools/ai-edit-tasks-j.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-j.sha256`, checked before the run, never altered; the seals of H and I still verify), written
by an Opus subagent given only `experiments/set-j/AUTHOR_BRIEF.md` (the set-H brief plus the stated requirements: at least 8 tasks whose target result is not u32 (3 bool, 3 array,
2 record), at least 6 reading or updating array elements, at least 2 reading or building a record, and no repeat of the program ideas of sets H and I). It validated its tasks
with an interpreter of its own outside the repository, and `tools/ai-edit-tasks-h-gen.ts j` converted and re-checked them with the reference interpreter (16 of 16 passed,
nothing changed by hand).

## What is compared, and the rule

Exactly as in the set-H and set-I notes: `D` (dense.D0 primer, dense view, with the parser as it is now) against `K` (canon.KR3 primer, canonical view), sole system text, structured
protocol, fresh Haiku and Sonnet subagents, one group-file subagent per variant and model (n = 16), then one repair round by a fresh subagent per cell with rejections. Recommend the
dense form only if, for Haiku and Sonnet separately, (1) `D` one-shot count is not lower than `K`'s and (2) `D` tokens per accepted edit at the 10-task horizon is lower than
`K`'s (raw numbers); both on both models, or nothing. Reported with wins, ties and losses and none hidden: the cold and unbounded horizons, acceptance after one repair, intervals,
and the one-shot counts on the non-u32-result tasks. Incidents are handled as in the earlier notes. The decision is read from `results/set-j.json` and not changed after.
