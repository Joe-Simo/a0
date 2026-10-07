# Pre-registration: the word-key legend in the A0 view, application-scale edits (written before any subject saw the legend)

Date: 2026-10-06. Written and committed before any subject saw the legend.

## The question

The deps-view arm (`docs/history/2026-10-06-app-edit-deps-preregistration.md`, `results/app-edit-deps.json`) left the keyword-hash tasks failing: `compiler/parse.a0`
compares the parser's word key (`kwcode`, `opcode`: the first 6 characters of a word, a-z = 1..26, 0-9 = 27..36, `_` = 37, summed as code*37^i; longer words key 0),
and the view shows the integer but not the word nor how a key is computed. `src/wordkey.ts` adds a view-only legend: when a function shown has an `eq`/`ne` against an
integer that is the key of a known word, the view ends with one `#` comment line naming the words and giving the rule. Canonical text, revisions and `compiler/*.a0`
are unchanged. It is off unless `A0_KEY_LEGEND=on` (the shipped views are unchanged until this note decides).

## What is compared

The deps-view arm of the benchmark with the legend on (`A0_KEY_LEGEND=on A0_PROGRAM_VIEW=deps`) against the collected deps-view arm without it
(`results/app-edit-deps/report.<model>.a0.json`), same 14 sealed tasks, same guide and protocol, one shot plus one repair by a fresh subagent per prompt.
Only the requests that differ are rerun: `op-alias-mod`, `drop-unsigned-aliases`, `number-leading-zero`, `unreserve-patch`, `use-alias-import` (checked by diffing the
two dumps; the other nine prompts are byte-identical, so their collected results carry over and are not rerun). 10 fresh first-reply subagents (Haiku and
Sonnet, 5 tasks) and one fresh repair subagent per rejected reply. Scored once after every subagent has reported.

## The rule (fixed now)

Per model, over the 14 tasks (nine carried plus five rerun): the legend is the better form if

1. its accepted count after repair is higher than the deps arm's, or equal with lower tokens per accepted edit at the 10-task horizon (raw numbers), and
2. on the five rerun tasks its accepted count is not lower than the deps arm's on those tasks.

Both conditions on both models, or no change. A change means: the legend is on by default in `EditSession` and the shipped skill/MCP wording mentions it (separate step, own
tests and, for wording, its own pre-registration). Reported with wins, ties and losses: one-shot, after repair, tokens per accepted edit, failure classes (a failure that
still needs a word or key the legend did not give is a view gap, named).

## Incidents

An API-safeguard refusal gets the identical request once more, never reworded; a second is a recorded loss. A subject that does not answer is not accepted and not rerun.
The decision is read from `results/app-edit-keys.json` and not changed after.

## How to run

```
A0_KEY_LEGEND=on A0_PROGRAM_VIEW=deps bun tools/app-edit-bench.ts dump results/app-edit-keys/dump.a0.json a0
bun tools/ai-edit-subjects.ts prompts results/app-edit-keys/dump.a0.json <scratch>/<model>/a0/prompts   # only the five keys above
# replies, run, repair as in the deps arm, into results/app-edit-keys/report.<model>.a0.json
```

## Result (collected after the rule above was committed; `results/app-edit-keys.json`, `tools/app-edit-keys-summary.ts`)

10 fresh first-reply subagents (Haiku and Sonnet, the five tasks whose request changes) and 3 fresh repair subagents (Haiku), scored once after every agent had reported. No subject was refused. The nine other tasks carry over from the deps arm (their requests are byte-identical).

| model | form | accepted after repair (14 tasks) | accepted on the five rerun tasks | tokens per accepted edit (10-task horizon) |
|---|---|---|---|---|
| Haiku | deps view | 9 | 3 | 2348.3 |
| Haiku | deps view + key legend | 10 | 4 | 2143.5 |
| Haiku | TypeScript (sealed arm) | 13 | | 7960 |
| Sonnet | deps view | 13 | 4 | 1576.5 |
| Sonnet | deps view + key legend | 14 | 5 | 1485.2 |
| Sonnet | TypeScript (sealed arm) | 14 | | 7277.3 |

Rule: met on both models (more accepted overall, lower cost, and not fewer on the rerun tasks). The legend is on by default in `EditSession` (`A0_KEY_LEGEND=off` removes it). Sonnet with the legend ties TypeScript on acceptance (14 of 14) at 1485.2 against 7277.3 tokens per accepted edit. Haiku still trails TypeScript, 10 against 13; the four remaining misses (`fat-arrow`, `profile-canonical`, `param-limit`, `number-leading-zero`) are model errors in the edit language, not view gaps; the Haiku loss is in the ledger and in `results/loss-blockers.json`. The shipped skill and MCP wording are unchanged (they are pinned by the wording arm's sealed variant); the rule for the key is carried inside the legend line itself.
