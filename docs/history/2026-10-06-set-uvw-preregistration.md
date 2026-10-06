# Pre-registration: sets U, V and W pooled, the shipped guide against the selected short primer `canon.KR3b` under the fixed edit protocol (written before any set-U, V or W reply was collected)

Date: 2026-10-06. The confirmation on sets R, S and T (`results/set-rst.json`) did not meet the rule: `KR3b` cost 36 and 40 per cent less at the cold task but was lower on one shot (28 against 40 on Haiku, 47 against 48 on Sonnet). 15 of the 20 Haiku first-reply failures were one pattern in one cell, a replacement written as a delete with the old node text
(`-b ne r 0` then `b eq r 0`), which the edit protocol rejected. The protocol now accepts that pair as the replacement it means (`test/edit.test.ts`), as it already did for a delete followed by an add of the same id. A mechanical replay of the recorded R, S, T replies through the fixed parser (not a measurement of any model) moves Haiku `KR3b` to 40 of 48, equal to the guide, and leaves Sonnet at 47 against 48.
Because that fix was chosen from those failures, the replay decides nothing; this note fixes a confirmation on three new sets, in advance.

## A decision stated openly

Over five collections the one-shot gap of the short primers on Sonnet has been 0 to 3 tasks of 48, which at n = 48 is inside the width of one Wilson 95 per cent interval (about 8 percentage points, 4 tasks): a strict "not lower" rule is decided by one task of noise. This confirmation therefore declares a non-inferiority margin of 3 tasks on one shot, chosen after seeing the earlier collections (it is not a blind choice), and
reports the strict reading (margin 0) next to it. The margin is part of the rule below and is not changed after collection.

## The sets

Sets U, V and W (`tools/ai-edit-tasks-u.ts`, `-v.ts`, `-w.ts`, 16 tasks each, SHA-256 in the matching `.sha256` files, checked before the run, never altered; the seals of H to T still verify), each written by an Opus subagent given only its own `experiments/set-<letter>/AUTHOR_BRIEF.md` (the set-H brief plus stated requirements:
U at least 5 non-u32 targets, 4 mid-function replacements, 3 with arrays and 3 with unsigned boundary comparisons; V at least 5 non-u32 targets, 4 with a helper call, 3 choosing between two computed values with `select` and 3 needing an inserted statement; W at least 5 non-u32 targets, 4 with `fold`, 3 with records and 3 with shifts by constants; all with no repeat of the program ideas of earlier sets). Each author validated with an interpreter of its own outside
the repository and `tools/ai-edit-tasks-h-gen.ts <letter>` converted and re-checked the tasks with the reference interpreter (16 of 16 passed for each, nothing changed by hand). None of these sets was used to choose or to confirm anything before.

## What is compared, and the rule

As in the set-RST note: `S` (`MODEL_GUIDE.min.txt`, `A0_EXPERIMENT_PRIMER=always`, 443 o200k tokens) against `K` (`experiments/primers/ablation/canon.KR3b.txt`, `rules-merged`, 221 tokens), with `KR3` (101 tokens) reported alongside and not part of the rule. Canonical form, structured protocol, A0 only, the edit protocol as it is in the repository at this commit (both delete fixes included for every cell). Fresh Haiku and Sonnet subagents, one group-file subagent per variant, model and set
(18 first-reply cells of 16 requests, pooled to n = 48 per model and variant), then one repair round by a fresh subagent per cell with rejections. All collected in this session, at most 20 subagents at once, a cell waiting for a slot started later with the same instructions and said so. Files are scored only after every subagent has reported and every expected file exists. The decision is read from `results/set-uvw.json` (`tools/set-h-summary.ts uvw`), pooled over the three sets.

Rule: `K` may replace the shipped guide as the shipped edit text (guide, MCP text, skill copies are a separate step with their own tests) only if, for Haiku and Sonnet separately and pooled over U, V and W,
1. `K` one-shot count is not lower than `S`'s by more than 3 (the declared margin), and
2. `K` cold tokens per accepted edit is lower than `S`'s (raw numbers).
Both on both models, or nothing. Reported with wins, ties and losses and none hidden: the strict reading of condition 1, the 10-task and unbounded horizons, acceptance after the repair, intervals, per-set counts, `KR3` alongside and the failure classes. A cell dominated by one subagent instance's misreading is reported as the result it is, with the misreading named; it is not rerun. The decision is read from `results/set-uvw.json` and not changed after.

## Result (collected after the rule above was committed; `results/set-uvw.json`, `tools/set-h-summary.ts uvw`)

Seals of H to W verified. 18 fresh first-reply subagents (one per variant, model and set, 16 requests each) and 10 fresh repair subagents (U: Haiku guide, KR3b, KR3; V: Haiku guide, KR3b, KR3; W: Haiku guide, KR3b, KR3, Sonnet KR3b); the other eight cells needed none. No subject was refused. Files were scored once, after every subagent had reported. Pooled over U, V, W (n = 48 per cell):

| model | variant | one shot | repaired | cold tokens per accepted edit | 10-task | unbounded |
|---|---|---|---|---|---|---|
| Haiku | guide | 41 | 46 | 736.3 | 237.1 | 181.6 |
| Haiku | KR3b | 28 | 39 | 612.8 | 319.0 | 286.4 |
| Haiku | KR3 | 36 | 45 | 315.8 | 199.4 | 186.5 |
| Sonnet | guide | 48 | 48 | 672.0 | 193.5 | 140.4 |
| Sonnet | KR3b | 47 | 48 | 399.8 | 161.1 | 134.6 |
| Sonnet | KR3 | 48 | 48 | 246.8 | 137.7 | 125.6 |

Verdict (`results/set-uvw.json`): Sonnet meets both conditions (47 against 48 on one shot, inside the declared margin of 3; cold cost 40 per cent lower; the strict reading, margin 0, is not met). Haiku does not: KR3b is 13 tasks lower on one shot (28 against 41) and 7 lower after the repair (39 against 46), and its 10-task and unbounded costs are higher than the guide's. **The rule is not met on both models, so nothing ships.** The alongside cell KR3 is lower than the guide on cold cost on both models and ties it on Sonnet (48 against 48), but loses 5 tasks on one shot on Haiku (36 against 41) and is outside the rule.
The finding agrees with sets K to T: the short primers cost less at the cold task and lose acceptance on Haiku. Losses recorded, none hidden; no shipped text changed.

## Failure classes read from the first replies, and the general change they led to (not measured)

Haiku's 13 first-reply failures under `KR3b` on sets U, V, W included 6 on set W where the reply rewrote the body of the fold step (a callee the view shows only as a signature) as bare lines; bare lines always edit the function the view opened, so the lines referred to `p2` in a function with fewer parameters (`A0105`, `parameter p2 out of range`). The other `KR3b` and guide failures were wrong logic or one-off structure errors (model errors, recorded). The general change: when a reply's `A0105` names a parameter that another function of the program has, the session's diagnostic now says that bare lines edit the opened function only and names the `fn` block that rewrites the other one (`src/edit.ts`, test in `test/edit.test.ts`). It is not measured: it takes a new sealed set and fresh subjects, and no result above depends on it.
