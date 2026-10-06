# Pre-registration: set K, the shipped guide against the 101-token edit primer, same session (written before any set-K reply was collected)

Date: 2026-10-06. The 44 `ai-tokens-*` losses of the ledger are costs of the shipped guide at the cold single-task horizon. A cross-session analysis on sets e and f
(`results/primer-vs-ts-cold.json`) suggests the 101-token edit primer would cost about as much as TypeScript where the shipped guide costs about twice as much, but its numbers
come from different collections and are not a registered result. This note fixes a same-session test on a new set, in advance.

## The set

Set K (`tools/ai-edit-tasks-k.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-k.sha256`, checked before the run, never altered; the seals of H, I and J still verify), written by an
Opus subagent given only `experiments/set-k/AUTHOR_BRIEF.md` (the set-H brief plus stated requirements: at least 6 tasks with a non-u32 target result, at least 5 touching arrays, at
least 2 calling an existing helper, and no repeat of the program ideas of sets H, I and J). It validated its tasks with its own interpreter outside the repository; then
`tools/ai-edit-tasks-h-gen.ts k` converted and re-checked them with the reference interpreter (16 of 16 passed, nothing changed by hand).

## What is compared

`S`: the shipped guide `MODEL_GUIDE.min.txt` as the language primer (`A0_EXPERIMENT_PRIMER=always`, protocol paragraph separate; system 443 o200k tokens), as in the `-min` cells of the loss
ledger. `K`: `experiments/primers/ablation/canon.KR3.txt` as the sole system text (`rules-merged`; 101 tokens). Both canonical form, structured protocol, `A0_EXPERIMENT_REPS=a0`,
`A0_EXPERIMENT_TASKSET=k`. Fresh Haiku and Sonnet subagents, one group-file subagent per variant and model (n = 16 each, 64 trials), then one repair round by a fresh subagent per cell
with rejections. All collected in this session. Cost counted as in the primer ablation (`tools/set-h-summary.ts k`).

## The rule (fixed now)

Primary horizon: the cold single task (what the `ai-tokens-*` losses measure). Primary acceptance: one-shot count. The shorter primer `K` may replace the shipped guide as the shipped
edit text (guide, MCP text, skill copies are a separate step with their own tests) only if, on set K and for Haiku and Sonnet separately,
1. `K` one-shot count is not lower than `S`'s, and
2. `K` cold tokens per accepted edit is lower than `S`'s (raw numbers, no band).
Both on both models, or nothing. Reported with wins, ties and losses and none hidden: the 10-task and unbounded horizons, acceptance after one repair, intervals, and the failure classes.
Incidents, refusals and unanswered requests are handled as in the earlier notes. The decision is read from `results/set-k.json` and not changed after. A note on what the rule cannot
show: `K` carries no language reference (only edit rules), which is the point of the question; a task that needs a rule `K` omits will show as a failure of `K`, not be set aside.

## Result (collected after the rule above was committed; `results/set-k.json`, `tools/set-h-summary.ts k`)

Set K was checked against its seal and not altered (the seals of H, I and J verify); the harness self-check passed in all four reports; four fresh first-reply subagents (one per variant and model, 16 requests each)
and four fresh repair subagents (Haiku S 4 replies, Haiku K 3, Sonnet S 1, Sonnet K 2). No subject was refused or left a request unanswered.

| cell | system o200k | one shot | repaired | calls per task | cold (primary) | 10-task | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku S (shipped guide) | 443 | 12 of 16 | 14 | 1.3 | 830.5 | 283.8 | 223.0 |
| Haiku K (101-token primer) | 101 | 13 of 16 | 15 | 1.2 | 357.5 | 241.1 | 228.2 |
| Sonnet S | 443 | 15 of 16 | 16 | 1.1 | 698.9 | 220.5 | 167.3 |
| Sonnet K | 101 | 14 of 16 | 16 | 1.1 | 284.1 | 175.0 | 162.9 |

Tokens per accepted edit. **The pre-registered rule is met for Haiku (K one shot 13 against 12, cold cost 357.5 against 830.5) and not for Sonnet (K one shot 14 against 15, cold cost 284.1 against 698.9: the cost
condition holds, the acceptance condition fails by one task). Both models are required, so the rule is not met and the shipped text is not changed.** Reported as a split, with none hidden: K costs less at the cold task on both models (about 57 and 59 per cent
less) and at the 10-task horizon on both; at the unbounded horizon K is higher on Haiku (228.2 against 223.0: a loss by the raw numbers) and lower on Sonnet. After the repair K is at least S on both
(15 against 14, 16 against 16). No interval separates any one-shot count at n = 16 (Sonnet 14 against 15 is one task).

Failure classes after the repair. `k-index-checksum` failed in all four cells (first reply and repair): the expected value needs a particular hash recurrence that no cell wrote, so it is recorded as a model error in
all four, not removed from the set. S: Haiku `k-bit-length` and `k-adjacent-equal` stayed unsolved (bool and u32 operand mix-ups); K: Haiku none besides the checksum. Sonnet K's two first-reply failures were `k-borrow-sub` (the record's flag value inverted) and the checksum;
Sonnet S's one was the checksum. Nothing was changed after seeing these results.

Reading, with the cross-session analysis (`results/primer-vs-ts-cold.json`): the saving is real and large and does not depend on the session, but a one-task acceptance deficit on Sonnet means the rule, as written, says no.
