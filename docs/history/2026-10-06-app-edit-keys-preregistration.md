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
