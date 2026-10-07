# Pre-registration: tiebreak of primer V4 against V3 on a third blind sealed set BB, pooled with sets Z and AA (written before any set-BB subject ran)

Date: 2026-10-07. Committed before any model was called on set BB. The only runs before this commit: the harness dry runs, the unit tests and the fresh Opus author of set BB (it saw only a copy of `experiments/set-bb/AUTHOR_BRIEF.md`).

## Why

The two registered tests of the same two texts disagree: on set Z (`results/primer-v4.json`) V4 fails on Haiku (21 accepted against 26, dearer at the 10-task horizon); on set AA (`results/invented-ops-fixes.json`) V4 passes on both models (Haiku 25 against 22, Sonnet 30 against 30, cheaper on both). The coordinator ruled that neither alone ships V4 and asked for a tiebreak on a third blind set.

## Set BB

`tools/ai-edit-tasks-bb.ts`, 30 tasks, SHA-256 in `tools/ai-edit-tasks-bb.sha256`, never altered. Authored by a fresh Opus subagent from `experiments/set-bb/AUTHOR_BRIEF.md` (the brief of set AA, the same mix: 7 `loop`, 6 `text`, 7 io, 6 helper-before-caller, 4 plain; the avoid-list extended with the ideas of set AA; no language, no set, no model answer, no fix list), converted and checked by `tools/ai-edit-tasks-h-gen.ts bb`: 30 of 30 kept, nothing changed by hand. Not used before.

## Conditions and subjects

Harness `tools/ai-edit-experiment.ts`, scripted replies, A0 only, structured, canonical, `A0_EXPERIMENT_TASKSET=bb`: `V3` is the shipped text (`A0_EXPERIMENT_PRIMER=always`, `A0_EXPERIMENT_GUIDE=MODEL_GUIDE.min.txt`, hints unset), `V4` is `experiments/primers/lazy/V4.txt` (`rules-merged`, `A0_LAZY_HINTS=on`); the current checker (new exact fixes on) in both. Subjects as in `docs/history/2026-10-07-invented-op-fixes-preregistration.md`: fresh Haiku and Sonnet subagents, one per prompt (30 x 2 models x 2 texts = 120 first replies), the unchanged subagent prompt, one repair subject per rejected first reply, at most 20 at once, files scored once after every expected reply exists; incident rules unchanged. Sets Z and AA are NOT rerun: their recorded results are reused (for AA, the `V3old` arm stands for V3: it is identical to `V3new`). Z's V4 arm ran before the new fixes existed and AA's after; the difference is stated, not corrected.

## Rule (fixed now)

Per model: V4 passes if (1) pooled over Z, AA and BB its accepted count after repair is not lower than V3's by more than 3 tasks, (2) pooled tokens per accepted edit at the 10-task horizon (`horizons()`, trials pooled as in `tools/primer-compare-summary.ts`) is lower than V3's (raw numbers), and (3) on no single set is V4's accepted count lower than V3's by more than 3 tasks. Both models pass, or no change. If it passes, V4 ships in a separate commit (`MODEL_GUIDE.min.txt`, both skill primer copies via `bun run sync-skill`, `A0_LAZY_HINTS` on by default for the canonical surface, tests pinning the text updated; the dense surface and its primer D1 are untouched). If it fails, the result is recorded and nothing ships. Evaluated by `tools/primer-v4-tiebreak-summary.ts` (`results/primer-v4-tiebreak.json`); not changed after the data are read. One-shot counts, cold and unbounded horizons, flips and failure classes are reported with wins, ties and losses, outside the rule.

## Limits stated in advance

- The margin of 3 tasks in 90 per model is wide; a pass means the registered rule, not significance. (claim-ok: a property of the interval method)
- Z and AA were evaluated against rules of margin 1; reusing them is the coordinator's instruction.
