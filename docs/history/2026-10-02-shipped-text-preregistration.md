# Pre-registration: surface the guide to MCP-only clients (written before any set-g reply was collected)

Date: 2026-10-02. Written and committed before any subject saw set g in this experiment. The previous round
(`docs/history/2026-10-02-shipped-text.md` section 8) did not ship the guide for MCP-only clients because its rule
asked for a cost win at every horizon, and the cold single-task horizon on Sonnet was a loss; fixing the horizon after seeing
that data would have been choosing it after the fact. This note fixes it now, in advance.

## What is compared

`B0` (the guide followed by the tool list, 1477 o200k tokens, `experiments/primers/shipped/both.B0.txt`) against `T0` (the tool
list alone, as the MCP-only client gets it today, 1082 tokens; the guide is not surfaced), on set g (16 tasks, sealed in
`tools/ai-edit-tasks-g.sha256`, checked against the file before running, never altered; not used in any earlier shipped-text round),
with `A0_EXPERIMENT_SPECS=none`. Fresh Haiku and Sonnet Agent-tool subagents, n = 16 trials per cell (one cell per variant and model,
64 trials in all), collected in the same session, same harness (`tools/ai-edit-experiment.ts` in scripted-replies mode, a0, structured
protocol, `A0_EXPERIMENT_PRIMER=rules-merged`), same method and same accounting as section 2 of the shipped-text record: one shot plus one
repair round, the tool-cell sentence outside the system text, cost counted by `tools/shipped-summary.ts`.

## Fixed choices

- Primary cost horizon: the 10-task session. The product's MCP use is a multi-call editing session, and the tool list stays in the
  client's context for the session.
- Primary acceptance measure: one-shot acceptance (count of the 16 tasks accepted on the first reply).
- Secondary, reported with wins, ties and losses stated and none hidden: the cold one-task and the unbounded cost horizons, and acceptance after one repair.

## The rule

Ship if, on set g, for both Haiku and Sonnet separately:

1. `B0` one-shot acceptance count is not lower than `T0`'s (counts; no interval is needed for the rule, intervals are reported); and
2. `B0` tokens per accepted edit at the 10-task horizon is lower than `T0`'s (raw numbers, no band).

Both conditions on both models, or nothing ships. If met: the MCP server `instructions` field in `src/mcp.ts` carries the guide
text read at build from `MODEL_GUIDE.min.txt` (a single source, no duplicate copy), tests in `test/mcp.test.ts`,
`bun run shipped-accounting` regenerated, STATUS and history updated, the loss ledger updated with `--update --reason` for any new loss, no
`COMPILER_VERSION` change. If not met: nothing ships and the result is recorded.

## Handling of incidents, fixed in advance

A subject refused by an API safeguard gets the identical request once more, never reworded; a second refusal is recorded as a loss
(a missing reply is a failure, as in the earlier rounds) and the cell is reported with that stated. Controls and variants are collected in the
same session. The decision is read from `results/shipped.json` (a new scope for set g) and not changed after it is read.

## Result (collected after the rule above was committed; `results/shipped/s3/`, `results/shipped.json` scope `registered(g)`, `preRegisteredDecision`)

Set g was verified against its seal before the run (the SHA-256 of `tools/ai-edit-tasks-g.ts` equals `tools/ai-edit-tasks-g.sha256`) and was not altered. n = 16 tasks per cell, 64 trials, four fresh first-reply subagents (one per variant and model, one group file each) and two fresh Haiku repair subagents (`T0` six rejected first replies, `B0` one); the Sonnet cells needed no repair. No subject was refused by an API safeguard and none died; no reply is missing. Harness self-check ok in all four reports.

One shot / repaired (of 16), then tokens per accepted edit: cold task / 10-task session (primary) / unbounded:

| cell | system o200k | one shot | repaired | calls per task | cold | 10-task | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku T0 | 1082 | 10 | 14 | 1.375 | 1796.8 | 461.3 | 312.9 |
| Haiku B0 | 1477 | 15 | 16 | 1.063 | 1977.8 | 382.6 | 205.4 |
| Sonnet T0 | 1082 | 16 | 16 | 1 | 1488.9 | 320.3 | 190.5 |
| Sonnet B0 | 1477 | 16 | 16 | 1 | 1967.1 | 372 | 194.7 |
| pooled T0 | 1082 | 26 of 32 | 30 of 32 | 1.188 | 1632.6 | 386.1 | 247.6 |
| pooled B0 | 1477 | 31 of 32 | 32 of 32 | 1.031 | 1972.5 | 377.3 | 200.1 |

Verdicts, `B0` against `T0` (the rate rule of section 2 of the shipped-text record for the interval column; the pre-registered rule uses the raw counts and the raw 10-task numbers):

| scope | one shot (count; interval verdict) | repaired | cold task | 10-task (primary) | unbounded |
|---|---|---|---|---|---|
| Haiku | 15 against 10: not lower; tie | 16 against 14: tie | loss | win (382.6 against 461.3) | win |
| Sonnet | 16 against 16: not lower; tie | 16 against 16: tie | loss | loss (372 against 320.3) | loss |
| pooled | 31 against 26: tie | 32 against 30: tie | loss | win (377.3 against 386.1) | win |

**Decision by the pre-registered rule (`results/shipped.json`, `preRegisteredDecision.ruleMet` is false): not met, nothing ships.** Condition 1 (one-shot count not lower) holds on both models. Condition 2 (lower tokens per accepted edit at the 10-task horizon) holds on Haiku (382.6 against 461.3) and fails on Sonnet (372 against 320.3): on set g Sonnet answers every task in one shot from the tool list alone, so the 395 tokens of guide buy no acceptance and no fewer calls and cost more at every horizon (the Sonnet unbounded difference, 194.7 against 190.5, is outside the 1 per cent band, a loss). The pooled 10-task number is a narrow win (377.3 against 386.1) and the pooled number is not the rule, which asks for each model. `src/mcp.ts`, `MODEL_GUIDE.min.txt` and the skill copies are unchanged; no `COMPILER_VERSION` change; the loss ledger is unchanged.

What the record shows beyond the rule: on Haiku the guide still helps (one shot 15 against 10; `T0` invented three operation names and used `at` or `get` on the wrong aggregate twice, `B0` failed once, a bool result without `-> bool`); on Sonnet it does not on this set. Together with the e and f session (Sonnet one shot 24 against 17) the Sonnet benefit is task-set dependent and the Haiku benefit appeared on all three sets; the horizon is now fixed in advance and the rule is not met on a sealed set, so a further attempt needs a new sealed set and a new pre-registration, not a reading of this one.
