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
