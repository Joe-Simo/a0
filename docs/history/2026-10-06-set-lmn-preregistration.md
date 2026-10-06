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

## Result (collected after the rule above was committed; `results/set-lmn.json`, `tools/set-h-summary.ts lmn`)

Sets L, M and N were checked against their seals and not altered (the seals of H, I, J and K verify); the harness self-check passed in all twelve first-reply reports; twelve fresh first-reply subagents (one per variant, model and set,
16 requests each) and nine fresh repair subagents (L: Haiku S 4 replies, Haiku K 16, Sonnet K 4; M: Haiku S 11, Haiku K 7, Sonnet S 1; N: Haiku S 16, Haiku K 7, Sonnet K 5; the other three cells needed none). No subject was refused or left a request
unanswered. One departure, stated: the first scoring pass ran while the last subagent files were still being written; the cells were re-scored from complete files and the numbers below are from that pass.

Pooled over the three sets (n = 48 per cell), tokens per accepted edit:

| cell | system o200k | one shot | repaired | calls per task | cold (primary) | 10-task | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku S (shipped guide) | 443 | 17 of 48 | 33 | 1.6 | 1236.1 | 540.2 | 462.8 |
| Haiku K (101-token primer) | 101 | 18 of 48 | 28 | 1.6 | 552.1 | 365.1 | 344.3 |
| Sonnet S | 443 | 47 of 48 | 48 | 1.0 | 687.9 | 209.5 | 156.3 |
| Sonnet K | 101 | 39 of 48 | 48 | 1.2 | 263.0 | 153.9 | 141.8 |

**The pre-registered rule is met for Haiku (K one shot 18 against 17, cold cost 552.1 against 1236.1) and not for Sonnet (K one shot 39 against 47, cold cost 263.0 against 687.9: the cost condition holds, the acceptance condition fails by eight tasks). Both models are
required, so the rule is not met and the shipped text is not changed.** Reported as a split, with none hidden: K costs less at every horizon on both models (cold: 55 and 62 per cent less); after the repair K accepts fewer on Haiku (28 against 33 of 48)
and the same on Sonnet (48 of 48 both); Sonnet's one-shot Wilson 95 per cent intervals (S 0.891 to 0.996, K 0.681 to 0.898) overlap narrowly, so the deficit is not separated at this n; Haiku's (0.234 to 0.496 and 0.252 to 0.516) overlap fully.

Per set, one shot (S then K): Haiku L 12 and 0, M 5 and 9, N 0 and 9; Sonnet L 16 and 12, M 15 and 16, N 16 and 11. The heterogeneity between sets for the same model and variant is large (Haiku S 12, 5 and 0), which says a cell is dominated by the particular subagent instance that
answered it: one instance per cell is the design's main limit, and a rate from one cell is not a rate of the model.

Failure classes. Haiku K on set L: all 16 first replies and all 16 repairs wrote a replacement as a delete of the id followed by an add of the same id (`-small` then `small lt p0 500`), which the edit protocol rejects (`invalid delete target` when the delete carried the node text, `duplicate edit` when it did not): zero accepted in that cell
after both rounds. That is a recorded loss of K there and a protocol ambiguity (a delete followed by an add of the same id in one reply could be accepted as the replacement it plainly means); it is not fixed in this set. Haiku S on set N: all 16 first replies were wrong logic (0 of 16 one shot, 10 of 16 after the repair).
Sonnet K's first-reply failures were nesting and operand-count errors, all repaired. Nothing was changed after seeing these results.

Reading, with set K and `results/primer-vs-ts-cold.json`: the short primer's cost saving replicates (55 to 62 per cent less at the cold task on both models, K lower at every horizon); the acceptance finding does not settle: on Sonnet K is 8 tasks lower on one shot over three sets and equal after the repair, on Haiku the two are equal on one shot and K is 5 lower after the repair.
Taken as the rule is written, the answer is no; the unresolved question is whether the one-shot deficit on Sonnet is worth the saving, and that is a decision, not a measurement.
