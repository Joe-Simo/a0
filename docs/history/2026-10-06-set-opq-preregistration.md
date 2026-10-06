# Pre-registration: sets O, P and Q pooled, the shipped guide against the 101-token edit primer with the delete-and-add fix in force (written before any set-O, P or Q reply was collected)

Date: 2026-10-06. On sets L, M and N pooled (`results/set-lmn.json`) the rule was not met: the short primer was 8 tasks lower on Sonnet one shot (39 against 47). All 8 of those first-reply failures were one pattern, a
delete of a node id followed by an add of the same id in one reply, which the edit protocol rejected as `duplicate edit`. The protocol now accepts that pair as the replacement it plainly means (`test/edit.test.ts`; `-id` followed by `id op args`
without `@`). A mechanical replay of the recorded L, M, N replies through the fixed parser (not a measurement of any model; computed locally, not stored as a result) gives Sonnet K one shot 47 against S 47, and Haiku K 19 against S 17.
Because the fix was chosen from those failures, the replay cannot decide anything; this note fixes a confirmation on three new sets, in advance.

## The sets

Sets O, P and Q (`tools/ai-edit-tasks-o.ts`, `-p.ts`, `-q.ts`, 16 tasks each, SHA-256 in the matching `.sha256` files, checked before the run, never altered; the seals of H to N still verify), each written by an Opus subagent given only its own
`experiments/set-<letter>/AUTHOR_BRIEF.md` (the set-H brief plus stated requirements: O at least 5 non-u32 targets, 4 array tasks and 4 mid-function replacements; P at least 5 non-u32 targets, 4 inserts, 3 deletes and 3 helper calls; Q at least 5 non-u32 targets, 4 `fold`
tasks and 4 tasks combining two helpers; all with no repeat of the program ideas of earlier sets). Each author validated with an interpreter of its own outside the repository and `tools/ai-edit-tasks-h-gen.ts <letter>` converted and re-checked the tasks with the
reference interpreter (16 of 16 passed for each, nothing changed by hand).

## What is compared, and the rule

Exactly as in the set-LMN note, with the edit protocol as it is now in the repository (the delete-and-add fix included for every cell, S and K alike): `S` (`MODEL_GUIDE.min.txt`, `A0_EXPERIMENT_PRIMER=always`) against `K` (`canon.KR3.txt`, `rules-merged`), canonical form, structured protocol, A0 only; fresh
Haiku and Sonnet subagents, one group-file subagent per variant, model and set (12 first-reply cells of 16 requests, pooled to n = 48 per model and variant), then one repair round by a fresh subagent per cell with rejections. All collected in this session. The decision is read from
`results/set-opq.json` (`tools/set-h-summary.ts opq`), pooled over the three sets. Files are scored only after every subject has finished writing.

Rule: the shorter primer `K` may replace the shipped guide as the shipped edit text (guide, MCP text, skill copies are a separate step with their own tests) only if, for Haiku and Sonnet separately and pooled over O, P and Q,
1. `K` one-shot count is not lower than `S`'s, and
2. `K` cold tokens per accepted edit is lower than `S`'s (raw numbers).
Both on both models, or nothing. Reported with wins, ties and losses and none hidden: the 10-task and unbounded horizons, acceptance after one repair, intervals, per-set counts and the failure classes. A cell in which a subagent instance fails systematically on one misreading is reported as the result it is, with the
misreading named; it is not rerun. Incidents, refusals and unanswered requests are handled as in the earlier notes. The decision is read from `results/set-opq.json` and not changed after.
