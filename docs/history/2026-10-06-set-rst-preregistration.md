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
