# Pre-registration: tiebreak of primer V4 against V3 on a third blind sealed set BB, pooled with sets Z and AA (written before any set-BB subject ran)

Date: 2026-10-07. Committed before any model was called on set BB. The only runs before this commit: the harness dry runs, the unit tests and the fresh Opus author of set BB (it saw only a copy of `experiments/set-bb/AUTHOR_BRIEF.md`).

## Why

The two registered tests of the same two texts disagree: on set Z (`results/primer-v4.json`) V4 fails on Haiku (21 accepted against 26, dearer at the 10-task horizon); on set AA (`results/invented-ops-fixes.json`) V4 passes on both models (Haiku 25 against 22, Sonnet 30 against 30, cheaper on both). The coordinator ruled that neither alone ships V4 and asked for a tiebreak on a third blind set.

## Set BB

`tools/ai-edit-tasks-bb.ts`, 30 tasks, SHA-256 in `tools/ai-edit-tasks-bb.sha256`, never altered. Authored by a fresh Opus subagent from `experiments/set-bb/AUTHOR_BRIEF.md` (the brief of set AA, the same mix: 7 `loop`, 6 `text`, 7 io, 6 helper-before-caller, 4 plain; the avoid-list extended with the ideas of set AA; no language, no set, no model answer, no fix list), converted and checked by `tools/ai-edit-tasks-h-gen.ts bb`: 30 of 30 kept, nothing changed by hand. Not used before.

## Conditions and subjects

Harness `tools/ai-edit-experiment.ts`, scripted replies, A0 only, structured, canonical, `A0_EXPERIMENT_TASKSET=bb`: `V3` is the shipped text (`A0_EXPERIMENT_PRIMER=always`, `A0_EXPERIMENT_GUIDE=MODEL_GUIDE.min.txt`, hints unset), `V4` is `experiments/primers/lazy/V4.txt` (`rules-merged`, `A0_LAZY_HINTS=on`); the current checker (new exact fixes on) in both. Subjects as in `docs/history/2026-10-07-invented-op-fixes-preregistration.md`: fresh Haiku and Sonnet subagents, one per prompt (30 x 2 models x 2 texts = 120 first replies), the unchanged subagent prompt, one repair subject per rejected first reply, at most 20 at once, files scored once after every expected reply exists; incident rules unchanged. Sets Z and AA are NOT rerun: their recorded results are reused (for AA, the `V3old` arm stands for V3: it is identical to `V3new`). Z's V4 arm ran before the new fixes existed and AA's after; the difference is stated, not corrected. (claim-ok: counts of subjects, not measurements)

## Rule (fixed now)

Per model: V4 passes if (1) pooled over Z, AA and BB its accepted count after repair is not lower than V3's by more than 3 tasks, (2) pooled tokens per accepted edit at the 10-task horizon (`horizons()`, trials pooled as in `tools/primer-compare-summary.ts`) is lower than V3's (raw numbers), and (3) on no single set is V4's accepted count lower than V3's by more than 3 tasks. Both models pass, or no change. If it passes, V4 ships in a separate commit (`MODEL_GUIDE.min.txt`, both skill primer copies via `bun run sync-skill`, `A0_LAZY_HINTS` on by default for the canonical surface, tests pinning the text updated; the dense surface and its primer D1 are untouched). If it fails, the result is recorded and nothing ships. Evaluated by `tools/primer-v4-tiebreak-summary.ts` (`results/primer-v4-tiebreak.json`); not changed after the data are read. One-shot counts, cold and unbounded horizons, flips and failure classes are reported with wins, ties and losses, outside the rule.

## Limits stated in advance

- The margin of 3 tasks in 90 per model is wide; a pass means the registered rule, not significance. (claim-ok: a property of the interval method)
- Z and AA were evaluated against rules of margin 1; reusing them is the coordinator's instruction.

## Result (collected after the rule above was committed; `results/primer-v4-tiebreak.json`, `tools/primer-v4-tiebreak-summary.ts`, set-BB reports, dumps and scripted replies in `results/primer-v4-tiebreak/`)

Set BB: 120 fresh first-reply subagents (30 tasks, Haiku and Sonnet, texts V3 and V4; launches refused only by the 20-subagent limit were started again identically) and 28 fresh repair subagents (Haiku V3 8, V4 11; Sonnet V3 2, V4 7). No subject refused; no reply missing. Scored once after every reply existed. Sets Z and AA are the recorded results (AA's V3 is its `V3old` arm).

| model | text | set BB one shot | BB accepted | BB 10-task | pooled Z+AA+BB accepted (of 92) | pooled 10-task | pooled cold | pooled unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | V3 | 22 | 25 | 332.9 | 73 | 353.3 | 752.1 | 309.0 |
| Haiku | V4 | 19 | 23 | 335.9 | 69 | 355.5 | 552.8 | 333.6 |
| Sonnet | V3 | 28 | 30 | 204.7 | 91 | 203.0 | 523.0 | 167.5 |
| Sonnet | V4 | 23 | 27 | 248.5 | 88 | 208.3 | 363.0 | 191.1 |

Per set accepted (V3 against V4): Haiku Z 26/21, AA 22/25, BB 25/23; Sonnet Z 31/31, AA 30/30, BB 30/27.

**The registered rule is not met** (`decision.shipV4` is false). Haiku: pooled accepted 69 against 73 is lower by 4 (the margin is 3), the pooled 10-task cost is 355.5 against 353.3 (not lower), and set Z alone is lower by 5. Sonnet: pooled accepted 88 against 91 holds (3), no set is lower by more than 3, but the pooled 10-task cost is 208.3 against 203.0 (not lower). Nothing ships: `MODEL_GUIDE.min.txt`, the skill and plugin primers, `A0_LAZY_HINTS` (off by default) and the dense surface are unchanged.

Wins, ties and losses: on the new blind set V4 is below V3 on both models (Haiku 23 against 25; Sonnet 27 against 30, one shot 23 against 28) and dearer at the 10-task horizon for Sonnet (248.5 against 204.7), level for Haiku; it is cheaper only at the cold horizon (Haiku 528.9 against 712.6; Sonnet 412.9 against 521.2) and loses it back by 10 tasks. Set AA's pass was one of three samples: the two other sets point the other way. (claim-ok: arithmetic on the recorded values of results/primer-v4-tiebreak.json)
