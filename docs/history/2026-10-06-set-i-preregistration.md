# Pre-registration: set I, dense (with the unwritten-result fix) against canonical (written before any set-I reply was collected)

Date: 2026-10-06. Set H (`results/set-h.json`) did not confirm dense: its rule was not met on either model. After it, the dense parser was changed
so that a result not written in the header is the type of the last statement (`test/dense.test.ts`), the general fix for the one failure every variant
of the primer ablation shared (a bool or aggregate result without its type in the head). Set H cannot test that fix (its dense failures were positional
parameters and operand counts), so this note fixes a confirmation on a new set, in advance.

## The set

Set I (`tools/ai-edit-tasks-i.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-i.sha256`, checked before the run, never altered), written by an Opus
subagent that was given only `experiments/set-i/AUTHOR_BRIEF.md` (the set-H brief plus one requirement stated in advance: at least 8 tasks whose
target result is not u32, 4 bool, 2 array, 2 record, and no repeat of set-H program ideas). It validated its own tasks with an interpreter it wrote,
then `tools/ai-edit-tasks-h-gen.ts i` converted and re-checked them with the reference interpreter (16 of 16 passed, nothing changed by hand). Set H is
untouched (its seal still verifies).

## What is compared, and the rule

Exactly as in the set-H note: `D` (dense.D0 primer, dense view; the parser now includes the unwritten-result fix) against `K` (canon.KR3 primer, canonical
view), as the sole system text, structured protocol, fresh Haiku and Sonnet subagents, one group-file subagent per variant and model (n = 16 each), then one
repair round by a fresh subagent per cell with rejections. Recommend the dense form only if, for Haiku and Sonnet separately, (1) `D` one-shot count is not lower
than `K`'s and (2) `D` tokens per accepted edit at the 10-task horizon is lower than `K`'s (raw numbers). Both on both models or nothing. Reported with wins, ties
and losses: cold and unbounded horizons, acceptance after one repair, intervals, and the one-shot acceptance on the 8 non-u32-result tasks separately for `D` and `K`.
Incidents, refusals and unanswered requests are handled as in the set-H note. The decision is read from `results/set-i.json` and not changed after.

## Result (collected after the rule above was committed; `results/set-i.json`, `tools/set-h-summary.ts i`)

Set I was checked against its seal and not altered; the harness self-check passed in all four reports; four fresh first-reply subagents (one per variant and
model, 16 requests each) and three fresh repair subagents (Haiku dense 4 replies, Haiku canonical 1, Sonnet canonical 2; Sonnet dense needed none). No subject was
refused or left a request unanswered.

| cell | system o200k | one shot | repaired | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku D | 145 | 12 of 16 | 14 | 1.3 | 348.6 | 169.7 | 149.8 |
| Haiku K | 101 | 15 of 16 | 16 | 1.1 | 239.6 | 130.5 | 118.4 |
| Sonnet D | 145 | 16 of 16 | 16 | 1.0 | 276.5 | 119.9 | 102.5 |
| Sonnet K | 101 | 14 of 16 | 16 | 1.1 | 247.9 | 138.9 | 126.7 |

Tokens per accepted edit. **The pre-registered rule is met for Sonnet (dense one shot 16 against 14, 10-task cost 119.9 against 138.9) and not for Haiku (12 against 15; 169.7
against 130.5), so it is not met: both models are required, and no recommendation is made.** Reported as a split result, not an average: dense wins on Sonnet at every horizon
except the cold task (276.5 against 247.9), and loses on Haiku at every horizon. On the 8 non-u32-result tasks, one shot: Haiku dense 5 of 8 against canonical 7 of 8; Sonnet dense
8 of 8 against canonical 6 of 8 (`tools/set-i-nonu32.mjs`). No interval separates any one-shot count at n = 16.

Failure classes, after the repair. Dense, Haiku: three first-reply failures wrote `at` on an array (`at expects a record`; dense lists `get set(arrays) at put(records)`, a protocol
ambiguity between `get` and `at`, repaired from the diagnostic's exact fix) and one was a wrong parity logic (model error); two tasks stayed unsolved after the repair (`i-contains`,
`i-weighted-sum`, model errors in the logic). No dense failure was the result-type-in-head class the fix targets; the dense results show the fix was not what decided any task here, so
this set neither confirms nor refutes its value. Canonical: Haiku's one failure wrote a u32 where a bool was needed (the result-type class, repaired from the diagnostic); Sonnet's two
were edit-format errors (`duplicate edit for 'r'`, a canonical edit-protocol ambiguity), both repaired. Nothing was changed after seeing these results.
