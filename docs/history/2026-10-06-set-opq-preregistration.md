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

## Result (collected after the rule above was committed; `results/set-opq.json`, `tools/set-h-summary.ts opq`)

Sets O, P and Q were checked against their seals and not altered (the seals of H to N verify); the harness self-check passed in all twelve first-reply reports; twelve fresh first-reply subagents (one per variant, model and set, 16 requests each) and eight fresh repair subagents
(O: Haiku S 6 replies, Haiku K 3, Sonnet S 1, Sonnet K 1; P: Haiku K 3; Q: Haiku S 5, Haiku K 16, Sonnet K 3; the other four cells needed none). No subject was refused or left a request unanswered. Files were scored only after every subagent had reported.

Pooled over the three sets (n = 48 per cell), tokens per accepted edit, with the delete-and-add fix in force for every cell:

| cell | system o200k | one shot | repaired | calls per task | cold (primary) | 10-task | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku S (shipped guide) | 443 | 37 of 48 | 44 | 1.2 | 783.8 | 261.9 | 203.9 |
| Haiku K (101-token primer) | 101 | 26 of 48 | 40 | 1.5 | 389.8 | 258.9 | 244.3 |
| Sonnet S | 443 | 47 of 48 | 48 | 1.0 | 667.5 | 189.1 | 135.9 |
| Sonnet K | 101 | 44 of 48 | 47 | 1.1 | 261.1 | 149.7 | 137.3 |

**The pre-registered rule is not met on either model: K one shot is lower (26 against 37 on Haiku, 44 against 47 on Sonnet) although K's cold cost is lower on both (389.8 against 783.8, 261.1 against 667.5: 50 and 61 per cent less).** No change to the shipped text. Reported with none hidden: at the 10-task horizon K is lower on both (258.9 against 261.9, 149.7 against 189.1,
the Haiku difference being 1 per cent, `results/set-opq.json`); unbounded K is higher on both (244.3 against 203.9, 137.3 against 135.9); after the repair K accepts fewer (Haiku 40 against 44, Sonnet 47 against 48). Wilson 95 per cent intervals of one shot overlap on Sonnet (S 0.891 to 0.996, K 0.804 to 0.967) and
nearly overlap on Haiku (S 0.635 to 0.867, K 0.403 to 0.674; 0.635 against 0.674 overlap). Per set, one shot (S then K): Haiku O 10 and 13, P 16 and 13, Q 11 and 0; Sonnet O 15 and 15, P 16 and 16, Q 16 and 13.

Failure classes (first reply). The delete-and-add pattern that caused all 8 of Sonnet K's first-reply failures on sets L, M and N did not recur on Sonnet (the fix works for that pattern). Sonnet K's 4 failures here were 3 wrong-logic and 1 operand-count error; Sonnet S's 1 was wrong logic. Haiku K's 22 first-reply failures were 18 wrong logic (16 of them in one cell, Haiku K on set Q, which was
0 of 16 on one shot and 10 of 16 after the repair: well-formed edits with wrong values, one instance's misreading of the tasks), 3 structure or reference errors and 1 duplicate edit; Haiku S's 11 were 5 wrong logic, 2 duplicate edits, 2 nesting, 1 operand count and 1 structure error. Three Haiku `duplicate edit` failures remain (two edits of one id that are not a delete followed by an add): not fixed.
Nothing was changed after seeing these results.

Reading, with sets K and L, M, N: over four collections the short primer's cold-cost saving is consistent (50 to 62 per cent); its acceptance deficit is real but small on Sonnet (3 tasks of 48 here, 0 after the repair on sets L, M and N, with the delete-and-add pattern accounting for L, M, N's deficit) and larger and noisier on Haiku, where single instances dominate (one cell failed every task in two different sets).
A mechanism the data suggest and do not show: the short primer states the edit rules and no language reference, so a model that does not already know what an operation does makes more logic errors. Whether adding the missing reference lines back costs less than the guide while recovering the acceptance is a new question for a new pre-registered set.
