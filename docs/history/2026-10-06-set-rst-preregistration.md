# Pre-registration: sets R, S and T pooled, the shipped guide against the selected short primer `canon.KR3b` (written before any set-R, S or T reply was collected)

Date: 2026-10-06. The selection recorded in `docs/history/2026-10-06-primer-reference-selection-preregistration.md` (`results/selection.json`) selected `canon.KR3b` (221 o200k tokens: the edit rules of the 101-token primer plus the guide's argument, type and operation reference lines)
from three candidates on sets K, L and M. This note fixes the confirmation on three further sets, in advance.

## The sets

Sets R, S and T (`tools/ai-edit-tasks-r.ts`, `-s.ts`, `-t.ts`, 16 tasks each, SHA-256 in the matching `.sha256` files, checked before the run, never altered; the seals of H to Q still verify), each written by an Opus subagent given only its own `experiments/set-<letter>/AUTHOR_BRIEF.md`
(the set-H brief plus stated requirements: R at least 5 non-u32 targets, 4 array tasks, 3 with shifts or masks and 3 with division or remainder; S at least 5 non-u32 targets, 4 with comparisons chained by `select`, 3 with a record and 3 with a helper call; T at least 5 non-u32 targets, 4 with `fold`, 3 combining bools and 3 with eight or more statements;
all with no repeat of the program ideas of earlier sets). Each author validated with an interpreter of its own outside the repository and `tools/ai-edit-tasks-h-gen.ts <letter>` converted and re-checked the tasks with the reference interpreter (16 of 16 passed for each, nothing changed by hand). None of these sets was used to choose a candidate.

## What is compared, and the rule

`S`: the shipped guide `MODEL_GUIDE.min.txt` (`A0_EXPERIMENT_PRIMER=always`, protocol paragraph separate, 443 o200k tokens). `K`: `experiments/primers/ablation/canon.KR3b.txt` (`rules-merged`, 221 tokens). Reported alongside, not part of the rule: `canon.KR3.txt` (101 tokens). Canonical form, structured protocol, A0 only, the edit protocol as it is in the repository (the delete-and-add fix included for every cell). Fresh Haiku
and Sonnet subagents, one group-file subagent per variant, model and set (18 first-reply cells of 16 requests, pooled to n = 48 per model and variant), then one repair round by a fresh subagent per cell with rejections. All collected in this session; no more than 20 subagents run at once, and a cell that has to wait for a slot is started later with the same instructions and said so. Files are scored only after every subagent has reported.
The decision is read from `results/set-rst.json` (`tools/set-h-summary.ts rst`), pooled over the three sets.

Rule: `K` may replace the shipped guide as the shipped edit text (guide, MCP text, skill copies are a separate step with their own tests) only if, for Haiku and Sonnet separately and pooled over R, S and T,
1. `K` one-shot count is not lower than `S`'s, and
2. `K` cold tokens per accepted edit is lower than `S`'s (raw numbers).
Both on both models, or nothing. Reported with wins, ties and losses and none hidden: the 10-task and unbounded horizons, acceptance after one repair, intervals, per-set counts, `KR3` alongside, and the failure classes. A cell dominated by one subagent instance's misreading is reported as the result it is, with the misreading named; it is not rerun. The decision is read from `results/set-rst.json` and not changed after.

## Result (collected after the rule above was committed; `results/set-rst.json`, `tools/set-h-summary.ts rst`)

Sets R, S and T were checked against their seals and not altered (the seals of H to Q verify); the harness self-check passed in all 18 first-reply reports; 18 fresh first-reply subagents (one per variant, model and set, 16 requests each) and 10 fresh repair subagents (R: Haiku S 1 reply, Haiku K 15, Haiku KR3 1; S: Haiku S 5, Haiku K 4, Haiku KR3 7, Sonnet K 1; T: Haiku S 2, Haiku K 1, Haiku KR3 8; the other eight cells needed none). No subject was refused or left a request unanswered. One departure, stated:
the first two scoring passes ran while the last repair file was still being written (the cells were re-scored from complete files and the numbers below are from that pass). Pooled over the three sets (n = 48 per cell), tokens per accepted edit:

| cell | system o200k | one shot | repaired | calls per task | cold (primary) | 10-task | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku S (shipped guide) | 443 | 40 of 48 | 47 | 1.2 | 713.1 | 224.5 | 170.2 |
| Haiku K (`KR3b`, 221) | 221 | 28 of 48 | 45 | 1.4 | 455.4 | 200.8 | 172.5 |
| Haiku KR3 (101, alongside) | 101 | 32 of 48 | 43 | 1.3 | 327.3 | 205.5 | 192.0 |
| Sonnet S | 443 | 48 of 48 | 48 | 1.0 | 669.4 | 191.0 | 137.8 |
| Sonnet K (`KR3b`) | 221 | 47 of 48 | 48 | 1.0 | 404.3 | 165.6 | 139.1 |
| Sonnet KR3 (alongside) | 101 | 48 of 48 | 48 | 1.0 | 242.5 | 133.4 | 121.3 |

**The pre-registered rule is not met on either model: K one shot is lower (28 against 40 on Haiku, 47 against 48 on Sonnet) although K's cold cost is lower on both (455.4 against 713.1, 404.3 against 669.4: 36 and 40 per cent less).** No change to the shipped text. Reported with none hidden: at the 10-task horizon K is lower on both (200.8 against 224.5, 165.6 against 191.0);
unbounded K is higher on both (172.5 against 170.2, 139.1 against 137.8, both within 2 per cent, `results/set-rst.json`); after the repair K accepts fewer on Haiku (45 against 47) and the same on Sonnet. The alongside cell `KR3` (101 tokens, outside the rule) is not lower than the guide on Sonnet one shot (48 against 48, cold cost 242.5 against 669.4: 64 per cent less) and lower on Haiku (32 against 40).
Per set, one shot (S, K, KR3): Haiku R 15, 1 and 15; S 11, 12 and 9; T 14, 15 and 8; Sonnet R 16, 16 and 16; S 16, 15 and 16; T 16, 16 and 16.

Failure classes (first reply). Haiku K's 20 first-reply failures were 15 `invalid delete target` (all in one cell, Haiku K on set R: 1 of 16 on one shot, the instance wrote every replacement as a delete with the old node text followed by the new line, `-b ne r 0` then `b eq r 0`; 15 of 16 accepted after the repair), 2 structure or reference errors, 2 wrong logic and 1 operand-count error: apart from that cell Haiku K was 27 of 32 on one shot against Haiku S's 25 of 32 on sets S and T.
Haiku S: 8 failures (3 structure, 2 wrong logic, 1 nesting, 1 operand count, 1 type error); Haiku KR3: 16 (6 wrong logic, 3 duplicate edits, 3 operand count, 2 structure, 1 nesting, 1 type). Sonnet K's single failure was an operand-count error; Sonnet S and Sonnet KR3 had none. Nothing was changed after seeing these results.

Reading, with the earlier four collections (`results/set-k.json`, `results/set-lmn.json`, `results/set-opq.json`, `results/selection.json`): over five collections the short primers cost 36 to 64 per cent less at the cold task than the shipped guide on both models, with Sonnet losing 0 to 3 tasks of 48 on one shot and Haiku losing more but unevenly: in three different cells (Haiku K on sets L, Q and R) one subagent instance failed almost every task on the same
delete-syntax misreading (`-id` with the node text), which dominates Haiku's deficit. That misreading is a protocol ambiguity, not a measured model weakness, and a general protocol fix for it is the next step; any acceptance claim for a fixed protocol needs a new pre-registered confirmation on new sets.
