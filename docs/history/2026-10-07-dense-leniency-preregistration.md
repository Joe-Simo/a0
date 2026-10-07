# Pre-registration: dense leniency and primer D1 on a new sealed set DL (written before any set-DL subject ran)

Date: 2026-10-07. Written and committed before any model was called on set DL. The only runs before this commit are the harness dry runs with no replies (self-check ok, prompts dumped) and the author of set DL (a fresh Opus subagent that saw only `experiments/set-dl/AUTHOR_BRIEF.md`).

## Why

`docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md` (phase B, `results/dense-default.json`): the dense surface (145-token primer, dense view) lost to canonical V3 on acceptance (Haiku 28 against 37 of 44, Sonnet 39 against 44) and on the 10-task cost, but won on source tokens and on Sonnet's cold task. Its failures were mostly syntax slips the parser could read, plus a primer with no `loop`, `text` or io clause. The lever tested here: a lenient dense parser (input only, the printer unchanged) and a primer D1 that adds those clauses.

## The changes (committed before this document, `src/dense.ts`, `src/dense-edit.ts`, `test/dense-lenient.test.ts`)

All are accepted on input only and give the canonical program the explicit spelling gives; the formatter output is unchanged and every existing dense test passes.

1. `0x5F` and `0b101` literals.
2. `mod` is `rem` (read last: a named value, function or op of that name wins).
3. `s` and `i` in a body are parameters A and B (the primer writes `fold F n s a..: s=F(s,i,a..)`); a defined name wins.
4. `io` is the one parameter of type io when the function's types are known.
5. A header that lists parameter letters (`fn month A B C`, at least two, from A in order) declares them; a lone letter stays the body.
6. Edit replies only: a name written again shadows the earlier value (fresh id for the new one); a file keeps the duplicate-id error.
7. Edit replies only: a header without types replaces a function whose parameter count the body uses exactly: the old types and result are kept.

Not changed: callee-after-caller is already accepted by the edit tool (blocks of one reply are ordered by need, `validateOrdered` hoists callees); "value used twice" had no recorded case that a leniency could read (the recorded errors were extra operands), so nothing was added for it. Recorded-failure replay (`tools/dense-lenient-replay.ts`, `results/dense-lenient-replay.json`; recorded data, not a measurement of new behaviour): of the 120 recorded dense cells per model (sets X, Y, H) Haiku one shot 32 to 36 and accepted 41 to 46, Sonnet one shot 44 to 45 and accepted 55 to 55, no cell lost; on X+Y alone Haiku accepted 28 to 30 of 44, Sonnet 39 to 39. These leniencies were chosen from the failures of sets X, Y and H, which is why a new set is required.

## Primer D1

`experiments/primers/dense/D1.txt`, 189 tokens (o200k): the 145-token dense primer plus `loop`, `"txt"` bytes, the io clause, and "A B C parameters by position", `s`/`i` in the fold line unchanged. Frozen now; not edited after any result.

## Set DL (sealed in this commit)

`tools/ai-edit-tasks-dl.ts`, 30 tasks, SHA-256 in `tools/ai-edit-tasks-dl.sha256`, never altered. The name is DL, not W: set W exists (`tools/ai-edit-tasks-w.ts`, sealed earlier). Authored by a fresh Opus subagent from `experiments/set-dl/AUTHOR_BRIEF.md` (a neutral JSON program model; it saw neither the language, any earlier set's tasks, nor any answer; the brief names earlier ideas to avoid), converted and checked by `tools/ai-edit-tasks-h-gen.ts dl` with the reference interpreter: 30 of 30 kept, nothing changed by hand. Mix: 8 arithmetic and array, 6 `loop`, 5 `text`, 7 io, 4 helper written before its caller, at least 5 bool `eq`/`ne` and 4 record `at`/`put` tasks across them. Not used before in any measurement.

## Arms

Harness `tools/ai-edit-experiment.ts`, scripted replies, A0 only, structured protocol, `A0_EXPERIMENT_TASKSET=dl A0_EXPERIMENT_REPS=a0 A0_EXPERIMENT_PROTOCOLS=structured A0_EXPERIMENT_SPECS=none`:

- `canon`: shipped V3 (`MODEL_GUIDE.min.txt`, 244 tokens), canonical view, `A0_EXPERIMENT_PRIMER=always`.
- `dense`: D1 as the sole system text, dense view and dense replies, `A0_EXPERIMENT_DENSE=1 A0_EXPERIMENT_PRIMER=rules-merged A0_EXPERIMENT_GUIDE=experiments/primers/dense/D1.txt`, with the lenient parser of this commit. Same diagnostics otherwise.

30 tasks x 2 models x 2 arms = 120 first-reply subjects, repairs on top (at most 120). No other subject.

## Subjects

As in the phase B pre-registration, unchanged: fresh Haiku and Sonnet subagents (Agent `model`), one subagent per prompt, given only the prompt file; the subagent prompt is the one of the primer-shrink pre-registration; one shot plus one repair by a fresh subagent of the same model with the conversation and the harness's exact rejection (`ai-edit-subjects.ts repair`); at most 20 running at once; scored once after every reply file exists. Incidents: a safeguard refusal gets the identical prompt once more; a missing reply is asked once more identically, then a failure; a prompt is never reworded; a launch refused only by the concurrency limit is started again identically.

## The rule (fixed now)

Per model, on set DL (n = 30): `dense` passes if (1) accepted after one repair is not lower than `canon`'s by more than 2 tasks and (2) tokens per accepted edit at the 10-task horizon (`horizons()`, weights 1.25 / 0.17 / 0.05 on the system text, declared parameters not measurements) is lower (raw numbers). Both models, or no change. One-shot, cold and unbounded horizons, Wilson intervals, flips and failure classes are reported with wins, ties and losses; none is part of the rule. Evaluated by `tools/primer-compare-summary.ts lenient` (`results/dense-lenient.json`).

If met: the dense surface becomes the default AI surface in `src/mcp.ts` (views dense by default, documented opt-out `dense: false`) and the skill/primer references carry D1, with tests, in a separate commit. If not: nothing ships and the result is recorded with the failure classes.

## Limits stated in advance

- n = 30 per cell separates nothing by itself; a pass means the registered rule, not a significance claim. (claim-ok: a property of the interval method)
- Set DL is authored by a model; cost accounting is local o200k with the repository's cache weights.
- The leniencies and D1 were designed from failures of sets X, Y and H; DL has not been seen by whoever designed them beyond the mix in its brief.

## Result (collected after the rule above was committed; `results/dense-lenient.json`, `tools/primer-compare-summary.ts lenient`, reports and scripted replies in `results/dense-lenient/`)

Set DL was verified against its seal (`test/dense-lenient-set.test.ts`) and not altered; the harness self-check passed in all four reports. 120 fresh first-reply subagents (30 tasks, Haiku and Sonnet, `canon` and `dense`, one subagent per prompt; launches refused only by the concurrency limit were started again with the identical prompt) and 32 fresh repair subagents (Haiku canon 11, Haiku dense 11, Sonnet canon 3, Sonnet dense 7). No subject was refused by a safeguard; no reply is missing. Scored once after every reply existed.

| model | arm | system o200k | one shot | accepted after repair | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | canon (V3) | 293 | 19 of 30 | 23 | 1.37 | 807.2 | 394.5 | 348.6 |
| Haiku | dense (D1, lenient) | 189 | 19 | 24 | 1.37 | 557.4 | 302.2 | 273.9 |
| Sonnet | canon (V3) | 293 | 27 | 29 | 1.10 | 553.4 | 226.0 | 189.6 |
| Sonnet | dense (D1, lenient) | 189 | 23 | 29 | 1.23 | 411.4 | 200.2 | 176.8 |

Tokens per accepted edit in the last three columns. **The registered rule is met on both models** (`decision.change` is true): Haiku dense 24 against 23 accepted and 302.2 against 394.5 at the 10-task horizon; Sonnet 29 against 29 and 200.2 against 226.0. The dense surface ships as the default AI surface (separate commit).

Wins, ties and losses, none hidden. Acceptance after repair: Haiku +1, Sonnet tie (every comparison a tie on the Wilson intervals at n = 30). Flips: Haiku dense gained `dl-hand-total` and `dl-trip-stamps` and lost `dl-damage-ticks`; Sonnet dense gained `dl-hand-total` and lost `dl-dough-rise`. One shot: Haiku tie (19 against 19), Sonnet a loss (23 against 27); calls per task on Sonnet 1.23 against 1.10 (a loss). Cost: lower at the cold, 10-task and unbounded horizons on both models (cold Haiku 557.4 against 807.2, Sonnet 411.4 against 553.4). Failures of the dense cells still not accepted after the repair: Haiku `dl-damage-ticks`, `dl-overbooked-slot`, `dl-dough-rise` (a statement with an extra operand, "unexpected A/B after a complete expression"), `dl-quarter-change` (a helper written as a bare line outside a function), `dl-playlist-fit` (`at` on an array), `dl-pin-unlock` (a wrong call arity); Sonnet `dl-dough-rise` (an extra operand). The canonical cells failed on logic (`dl-dough-rise`, `dl-playlist-fit`, `dl-trip-stamps`, `dl-hand-total`) and syntax (`dl-pin-unlock`, `dl-overbooked-slot`, `dl-quarter-change`). The extra-operand slip (a three-operand `add`/`mul`) is the largest remaining dense class and the next lever; none of the leniencies reads it.

Limits that still hold: n = 30 per cell, a pass is the registered rule and not a significance claim; the earlier sets X and Y (28 and 44 task-pooled results against canonical, `results/dense-default.json`) are not rerun with D1 and the lenient parser, so this result says the surface passes on a set it was not designed from, not that it beats V3 on X and Y.
