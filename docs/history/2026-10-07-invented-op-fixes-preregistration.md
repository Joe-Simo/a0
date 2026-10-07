# Pre-registration: exact fixes for the op names models invent, on a new sealed set AA (written before any set-AA subject ran)

Date: 2026-10-07. Written and committed before any model was called on set AA. The only runs before this commit: the deterministic harvest and replay (no model), the unit tests, and the fresh Opus author of set AA (it saw only a copy of `experiments/set-aa/AUTHOR_BRIEF.md`, nothing else).

Set name: the single letters a to z are all taken by earlier sets (set Q is `tools/ai-edit-tasks-q.sha256`, sealed long ago), so the new set is **AA**; nothing of sets A to Z was altered.

## Why

`results/primer-v4.json` named the cheapest general lever: make the checker accept the names models invent as exact fixes, which costs tokens only when a model writes them and needs no primer change. This round does that and measures it.

## The fixes (src/core.ts, src/edit.ts, src/diagnostics.ts `EXACT_FIXES`; tests `test/invented-op-fixes.test.ts`; reject corpus `corpus/reject/op-*.a0`)

Already exact before this round: `mod`/`umod` to `rem`; `sel lte gte ule uge ult ugt neq equ` to the op they spell (A0102 `mod`, `alias`); `at`/`put` on an array. New (all behind `A0_NEW_FIXES`, on by default, `off` gives the diagnostics as they were):

1. `id == a b` and the other operator symbols in op position (`!= < <= > >= + - * / % & && | || ^ << >>`) become the op word, only with the operand count of the op (A0011, rule `symbol`).
2. `add mul and or xor` with more than two operands become the left-to-right chain of two-operand lines under fresh ids `<id>t0`, `<id>t1` (A0014, rule `chain`). In an edit reply a line with an existing id replaces that node, so the fix is exact only when no fresh id is a node of the function or a word of the reply (`guardChain` in `src/edit.ts`); otherwise it stays a suggestion.
3. `not x` where x is a bool becomes `xor x true` (A0102, rule `not`); on a u32 it has two meanings and stays a hint.
4. `max a b` / `min a b` on two u32 become `t gt a b` / `t lt a b` and `x select t a b` under a fresh id (A0102, rules `max`, `min`).
5. Hints only (never exact): `neg`, `abs`, `cmp`, and `not` on a u32 say what to write (`NAMED_HINTS`).
Not done, with the reason: `let`/`const` prefixes, `return x`, trailing semicolons, `end;`: zero occurrences in any recorded canonical-syntax reply (`results/invented-ops.json`), so nothing to justify a rule.

Every fix is verified by the checker before anything is committed (`fix all` applies edits to the reply and re-validates; a clash stops it). The harness shows the fix in the rejection message exactly as before (the repair subject reads it); it does not apply fixes by itself, and the MCP tool applies them only on `fix all`. This round changes neither.

## Evidence before the run (deterministic, no model; not a measurement of the fixes on models)

- Harvest (`tools/invented-ops.ts`, `results/invented-ops.json`): over every report in `results/`, the words the checker rejected as an unknown operation or callee: `sel` 21 (Haiku 1, Sonnet 20), `mod` 12 (9, 3), `cmp` 3, `not` 3, `min` 2, `udiv` 2, `max`, `neq`, `equ`, `gte`, `lte`, `ult` 1 each (Haiku); the rest are numbers, lone letters (a missing id) or undefined helper names. The operator-symbol rows (`>>`, `<<`) come from the dense-syntax runs only.
- Replay (`tools/invented-ops-replay.ts`, `results/invented-ops-replay.json`): recorded replies of V3 and V4 on sets X, Y, Z run through `fix all` and re-scored by the harness: no task is newly accepted by a new rule anywhere; V3 replies are not changed by any rule; V4 one-shot acceptance rises (Haiku 14 to 17, Sonnet 24 to 26) through the existing `mod`/`alias` rules and the new `not`/`max`/`min` once each, and Haiku loses one task whose changed reply is accepted by the checker and then wrong.
- What follows: the new rules fire rarely on what models wrote so far; I **expect V3new to tie V3old** and V4new to remain below V3 on Haiku. The run is registered anyway: the owner wants a measured answer, and a new blind set is the only test of a fix chosen from earlier failures.

## Set AA (sealed in this commit)

`tools/ai-edit-tasks-aa.ts`, SHA-256 in `tools/ai-edit-tasks-aa.sha256`, never altered. 30 tasks authored by a fresh Opus subagent from `experiments/set-aa/AUTHOR_BRIEF.md` (the brief of set Z with 30 tasks, the mix 7 `loop`, 6 `text`, 7 io, 6 helper-before-caller, 4 plain, and the avoid-list extended with set Z's ideas; no language, no set, no model answer, no fix list), converted and checked by `tools/ai-edit-tasks-h-gen.ts aa` with the reference interpreter: 30 of 30 kept, nothing changed by hand. Not used in any measurement or pilot.

## Arms and subjects

Harness `tools/ai-edit-experiment.ts` (one robustness change in this commit: after an edit that applies but fails the tests, a reply of whole `fn` blocks closes the handle; the next view is then opened again, or omitted if the target is gone; it crashed on replays of the V4 replies and is identical for every arm), scripted replies, A0 only, structured, canonical, `A0_EXPERIMENT_TASKSET=aa A0_EXPERIMENT_REPS=a0 A0_EXPERIMENT_PROTOCOLS=structured A0_EXPERIMENT_SPECS=none`:

- `V3old`: V3 text (`A0_EXPERIMENT_PRIMER=always`, `A0_EXPERIMENT_GUIDE=MODEL_GUIDE.min.txt`), `A0_NEW_FIXES=off`.
- `V3new`: the same prompts, new fixes on.
- `V4new`: `A0_EXPERIMENT_PRIMER=rules-merged`, `A0_EXPERIMENT_GUIDE=experiments/primers/lazy/V4.txt`, `A0_LAZY_HINTS=on`, new fixes on.

Pairing (registered now): `V3old` and `V3new` have byte-identical prompts, so **one set of first replies per model serves both** (30 x 2 = 60 V3 first replies), and `V4new` has its own (60). Subjects are fresh Haiku and Sonnet subagents (the Agent tool's `model`), one subagent per prompt, given only the dumped prompt file, the subagent prompt of `docs/history/2026-10-07-primer-shrink-preregistration.md` unchanged; at most 20 at once. Repairs: for every first reply the harness rejects, one fresh subagent of the same model gets the conversation so far and the exact rejection (`tools/ai-edit-subjects.ts repair`). For `V3old` and `V3new` the rejection text of a task is compared: when identical, the one repair reply serves both arms; when it differs (a new rule or hint fired), each arm gets its own fresh repair subject. Budget: 120 first-reply subjects and their repair subjects; no other subject. Files are scored once, after every expected reply file exists. Incidents: a subject refused by a safeguard gets the identical prompt once more; a missing reply is asked once more identically, then a failure; a prompt is never reworded. (claim-ok: counts of subjects, not measurements)

## Rule (fixed now)

Per model, a candidate arm (`V3new`, `V4new`) passes against `V3old` if (1) its accepted count after one repair is not lower than `V3old`'s by more than 1 task, and (2) its tokens per accepted edit at the 10-task horizon (`horizons()`, weights 1.25 / 0.17 / 0.05) is not higher than `V3old`'s. A candidate passes if both models pass. The arm that passes with the lowest sum of the two models' 10-task costs ships (`V3new` on a tie). If `V3new` ships: the fixes stay on by default as a diagnostics-only change, no primer change. If `V4new` ships: `MODEL_GUIDE.min.txt` becomes the V4 text, `A0_LAZY_HINTS` defaults on, `bun run sync-skill`, in a separate commit. If neither passes: the new fixes are switched off by default (`A0_NEW_FIXES` default `off`) and nothing else changes. Cold and unbounded horizons, one-shot counts, Wilson intervals, flips and failure classes are reported with wins, ties and losses and are not part of the rule. Evaluated by `tools/invented-ops-summary.ts` (`results/invented-ops-fixes.json`), not changed after the data are read.

## Limits stated in advance

- n = 30 per cell separates nothing by itself; a pass means the registered rule. (claim-ok: a property of the interval method)
- Because `V3old` and `V3new` share first replies and the fixes act only in rejection text, they can differ only on tasks whose first reply a new rule touched; a tie is the expected and informative outcome.
- The arms differ in system layout (the V4 text carries its own protocol): the shipped difference.

## How to run

```
A0_EXPERIMENT_DUMP=<scratch>/dump.V3.json <V3 env> bun tools/ai-edit-experiment.ts      # and the same for V4
bun tools/ai-edit-subjects.ts prompts <dump> <dir>; collect; run per arm (A0_NEW_FIXES=off for V3old);
bun tools/ai-edit-subjects.ts repair <report> <dump> <dir> <outdir>; collect; run again into results/invented-ops/report.aa.<model>.<arm>.json
bun tools/invented-ops-summary.ts
```

## Result (collected after the rule above was committed; `results/invented-ops-fixes.json`, `tools/invented-ops-summary.ts`, reports, dumps and scripted replies in `results/invented-ops/`)

120 fresh first-reply subagents (30 tasks, Haiku and Sonnet, prompts `V3` and `V4`; launches refused only by the 20-subagent limit were started again identically) and 25 fresh repair subagents (Haiku `V3` 12, Sonnet `V3` 1, Haiku `V4` 10, Sonnet `V4` 2). No subject was refused or missing. Scored once after every reply existed. Because the rejection texts of `V3old` and `V3new` were byte-identical for every rejected task (no new rule fired on any V3 first reply), the repair replies were shared, as registered.

| model | arm | system o200k | one shot | accepted after repair | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | V3old | 293 | 18 of 30 | 22 | 1.40 | 813.5 | 382.0 | 334.0 |
| Haiku | V3new | 293 | 18 | 22 | 1.40 | 813.5 | 382.0 | 334.0 |
| Haiku | V4new | 137 | 20 | 25 | 1.33 | 457.0 | 279.5 | 259.8 |
| Sonnet | V3old | 293 | 29 | 30 | 1.03 | 507.3 | 190.9 | 155.7 |
| Sonnet | V3new | 293 | 29 | 30 | 1.03 | 507.3 | 190.9 | 155.7 |
| Sonnet | V4new | 137 | 28 | 30 | 1.07 | 321.2 | 173.2 | 156.8 |

**Registered rule, as evaluated:** both candidates pass on both models (`decision.ships` = `V4new`, the cheaper of the two). `V3new` ties `V3old` exactly (no flips): the new rules changed nothing on any recorded V3 rejection. `V4new` gains five Haiku tasks (`aa-stock-days`, `aa-keyrow-digit`, `aa-change-due`, `aa-stamped-payment`, `aa-span-puts`) and loses two (`aa-traffic-cycle`, `aa-invoice-prefix`); Sonnet has no flips.

**What this does and does not show, none of it hidden.**
- None of the new rules (`symbol`, `chain`, `not`, `max`, `min`, the named hints) fired in any rejection of this run; the only invented op written was `mod` (Haiku, `aa-shift-starts`, `aa-traffic-cycle`), which the older `mod` rule already fixed. The `V4new` result therefore is not an effect of the new fixes. It is the V4 text against the V3 text on a fresh set.
- It contradicts the earlier registered run of the same two texts on set Z (`results/primer-v4.json`: Haiku accepted 21 against 26, rule not met). Pooling Z and AA, Haiku accepts 46 (V4) against 48 (V3) of 62 and Sonnet 61 against 61; the two sets disagree in sign, so n = 30 per cell cannot rank the texts. The unregistered pooling is arithmetic on recorded values. (claim-ok: arithmetic on results/primer-v4.json and results/invented-ops-fixes.json)
- The replay (`results/invented-ops-replay.json`) predicted the null result for the fixes; it did not predict V4's pass.

**What shipped.** The new exact fixes and hints stay in the tree, on by default (`A0_NEW_FIXES` unset): they cost no tokens unless a model writes the names, and the run found no harm. The primer text was **not** changed in this commit, although the registered rule selects `V4new`: shipping V4 means replacing `MODEL_GUIDE.min.txt`, turning `A0_LAZY_HINTS` on by default, `bun run sync-skill`, and regenerating the site and `deploy/` files that embed the primer (`deploy/primer.txt`, `llms*.txt`), which this track may not edit, on a tree where `sitegen.test` and the site entries of the spec golden already disagree after the last merge. The decision is left to the owner with the evidence above (the rule is met on set AA, was not met on set Z).
