# Pre-registration: sets L, M and N pooled, the shipped guide against the 101-token edit primer (written before any set-L, M or N reply was collected)

Date: 2026-10-06. Set K (`results/set-k.json`) split by model: the shorter primer cost about 57 and 59 per cent less at the cold task on Haiku and Sonnet, was one task higher on Haiku and one task
lower on Sonnet on one shot, and the rule (both models) was not met by one task. At n = 16 a one-task difference is noise, so this note fixes a replication on three new sets pooled to 48 tasks per cell,
in advance. Set K is reported but is not part of this decision (it was seen before the rule was written).

## The sets

Sets L, M and N (`tools/ai-edit-tasks-l.ts`, `-m.ts`, `-n.ts`, 16 tasks each, SHA-256 in the matching `.sha256` files, checked before the run, never altered; the seals of H, I, J and K still verify), each written by an Opus
subagent given only its own `experiments/set-<letter>/AUTHOR_BRIEF.md` (the set-H brief plus stated requirements: L at least 6 non-u32 targets and 5 array tasks; M at least 6 tasks calling a helper, 4 using `fold` and 5 non-u32 targets;
N at least 5 record tasks, 4 with `select` chains of three or more branches and 5 non-u32 targets; all with no repeat of the program ideas of earlier sets). Each author validated its tasks with an interpreter of its own outside
the repository, and `tools/ai-edit-tasks-h-gen.ts <letter>` converted and re-checked them with the reference interpreter (16 of 16 passed for each, nothing changed by hand).

## What is compared, and the rule

As in the set-K note: `S` (`MODEL_GUIDE.min.txt`, `A0_EXPERIMENT_PRIMER=always`, protocol paragraph separate, 443 o200k tokens) against `K` (`experiments/primers/ablation/canon.KR3.txt`, `rules-merged`, 101 tokens), canonical form,
structured protocol, A0 only. Fresh Haiku and Sonnet subagents, one group-file subagent per variant, model and set (12 first-reply cells of 16 requests, pooled to n = 48 per model and variant), then one repair round by a fresh subagent per cell
with rejections. All collected in this session. The decision is read from `results/set-lmn.json` (`tools/set-h-summary.ts lmn`), pooled over the three sets.

Rule: the shorter primer `K` may replace the shipped guide as the shipped edit text (guide, MCP text, skill copies are a separate step with their own tests) only if, for Haiku and Sonnet separately and pooled over L, M and N,
1. `K` one-shot count is not lower than `S`'s, and
2. `K` cold tokens per accepted edit is lower than `S`'s (raw numbers).
Both on both models, or nothing. Reported with wins, ties and losses and none hidden: the 10-task and unbounded horizons, acceptance after one repair, intervals, per-set counts and the failure classes.
Incidents, refusals and unanswered requests are handled as in the earlier notes. The decision is read from `results/set-lmn.json` and not changed after.
