# Pre-registration: set J, dense against canonical with all three protocol fixes in place (written before any set-J reply was collected)

Date: 2026-10-06. Sets H and I (`results/set-h.json`, `results/set-i.json`) did not meet the rule: dense lost on Haiku both times and won on Sonnet once. After
set I three general protocol changes are in the code, none measured: an unwritten dense result takes the type of the last statement (`test/dense.test.ts`), an
`ex` line written after a node is hoisted under the header, and `at`/`put` written on an array carries an exact edit to `get`/`set` (rule `array-op`, shown in the
rejection a repair round receives). This note fixes a confirmation on a new set, in advance. Nothing about set J was chosen from earlier failures except the
brief's requirement of array and record tasks, stated below.

## The set

Set J (`tools/ai-edit-tasks-j.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-j.sha256`, checked before the run, never altered; the seals of H and I still verify), written
by an Opus subagent given only `experiments/set-j/AUTHOR_BRIEF.md` (the set-H brief plus the stated requirements: at least 8 tasks whose target result is not u32 (3 bool, 3 array,
2 record), at least 6 reading or updating array elements, at least 2 reading or building a record, and no repeat of the program ideas of sets H and I). It validated its tasks
with an interpreter of its own outside the repository, and `tools/ai-edit-tasks-h-gen.ts j` converted and re-checked them with the reference interpreter (16 of 16 passed,
nothing changed by hand).

## What is compared, and the rule

Exactly as in the set-H and set-I notes: `D` (dense.D0 primer, dense view, with the parser as it is now) against `K` (canon.KR3 primer, canonical view), sole system text, structured
protocol, fresh Haiku and Sonnet subagents, one group-file subagent per variant and model (n = 16), then one repair round by a fresh subagent per cell with rejections. Recommend the
dense form only if, for Haiku and Sonnet separately, (1) `D` one-shot count is not lower than `K`'s and (2) `D` tokens per accepted edit at the 10-task horizon is lower than
`K`'s (raw numbers); both on both models, or nothing. Reported with wins, ties and losses and none hidden: the cold and unbounded horizons, acceptance after one repair, intervals,
and the one-shot counts on the non-u32-result tasks. Incidents are handled as in the earlier notes. The decision is read from `results/set-j.json` and not changed after.

## Result (collected after the rule above was committed; `results/set-j.json`, `tools/set-h-summary.ts j`)

Set J was checked against its seal and not altered (the seals of H and I verify); the harness self-check passed in all four reports; four fresh first-reply subagents
(one per variant and model, 16 requests each) and three fresh repair subagents (Haiku dense 7 replies, Haiku canonical 4, Sonnet dense 1; Sonnet canonical needed none). No subject
was refused or left a request unanswered.

| cell | system o200k | one shot | repaired | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|
| Haiku D | 145 | 9 of 16 | 10 | 1.4 | 586.9 | 336.3 | 308.5 |
| Haiku K | 101 | 12 of 16 | 15 | 1.3 | 346.9 | 230.5 | 217.6 |
| Sonnet D | 145 | 15 of 16 | 16 | 1.1 | 309.5 | 152.9 | 135.5 |
| Sonnet K | 101 | 16 of 16 | 16 | 1.0 | 251.1 | 142.0 | 129.9 |

Tokens per accepted edit. **The pre-registered rule is not met on either model, on either condition: dense one shot is lower (9 against 12, 15 against 16) and dense costs more per accepted edit at the 10-task horizon
(336.3 against 230.5, 152.9 against 142.0); the cold and unbounded horizons are losses too.** No recommendation is made. One-shot on the 9 non-u32-result tasks: Haiku dense 6 of 9
against canonical 8 of 9; Sonnet dense 8 of 9 against 9 of 9 (`tools/set-nonu32.mjs j`). No interval separates any one-shot count at n = 16.

Failure classes (first reply). Dense, Haiku: six of seven were one protocol ambiguity: a helper function's signature line was written as a statement (`'u32' is not an operation`; the dense view prints a callee's
signature as a `#` comment line, and Haiku copied it without the `#`), and one was a bool operand mistake; six tasks stayed unsolved after the repair, whose one-line explanation of the comment form
did not carry across the group (model error after a repair that named the rule). Dense, Sonnet: one callee written after its caller (a known ambiguity). Canonical, Haiku: three wrong-logic errors (model errors) and one `p2 out of range` in a fold
helper (a protocol ambiguity). Sonnet canonical: none. None of the three fixes made after set I (unwritten result type, `ex` hoist, `array-op` exact edit) was the deciding factor in any task here: no first-reply failure was of those classes, so this set does not measure them. Nothing was changed after seeing these results.

Reading, with sets H and I: three sets, six model-by-set comparisons, and dense met the rule once (Sonnet, set I). Dense is a loss on Haiku in all three and on Sonnet in two of three; the evidence of sets e and f does not
repeat on new sets. The shipped form stays canonical.
