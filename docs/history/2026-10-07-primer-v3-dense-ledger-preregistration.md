# Pre-registration: primer V3 on a new sealed set Y, the dense surface as default, and the ledger re-score (written before any set-Y or phase B/C subject ran)

Date: 2026-10-07. Written and committed before any model was called on set Y, on the dense arm or on the phase C cells. The only runs before this commit are the harness dry runs with no replies (`self-check`, prompts dumped, no model) and the author of set Y (a fresh Opus subagent that saw only `experiments/set-y/AUTHOR_BRIEF.md`).

## Why

`docs/history/2026-10-07-primer-shrink-preregistration.md` shipped the 299-token primer V2 after it passed on set X, and named the open risk: set X has no task that needs `loop`, `text` or io, the rules V2 moved into diagnostics. V3 (244 tokens, `experiments/primers/shrink/V3.txt`) was designed and counted but not run. The dense primer and view (`MODEL_GUIDE.dense.txt`, 145 tokens) wins every horizon in `results/ai-edit-scoped.json` but did not confirm on set H (`results/set-h.json`). The ledger has 44 `primer-paid-per-call` entries recorded with the old 395-token guide (`results/loss-blockers.json`).

## Set Y (sealed in this commit)

`tools/ai-edit-tasks-y.ts`, 28 tasks, SHA-256 in `tools/ai-edit-tasks-y.sha256`, never altered. Authored by a fresh Opus subagent from `experiments/set-y/AUTHOR_BRIEF.md` (a neutral JSON program model extended with `loop`, `text` constants and the io type; it saw neither the language, nor any earlier set, nor any model answer), converted and checked by `tools/ai-edit-tasks-h-gen.ts y` with the reference interpreter (the starting program fails a test, the reference passes all, each wrong edit fails one, at least 8 tests): 28 of 28 kept, nothing changed by hand. Mix by the brief: 8 `loop` tasks, 6 `text` tasks, 8 io tasks (`read`, `write`, `puts`, token passed to an earlier helper), 6 tasks that add a helper written before its caller (the forward-reference and no-recursion rule V2 moved to a diagnostic), bool `eq`/`ne` and record `put` tasks across them. io tests are `{ io: [words] }` arguments and `{ out: [words] }` results, run by the harness (`ioArgOf` in `tools/ai-edit-experiment.ts`) and the generator.

Stated limit: `use "file.a0"` cannot be exercised by an edit task. The edit protocol edits one function or whole functions of one program; a reply cannot contain a `use` line and the language's linker is not part of the edit session. The `use` sentence V1 and V2 dropped is therefore not tested by any edit-task set, only by its diagnostic (`test/primer-shrink.test.ts`). `mov` and the other op-list notes that V3 drops are exercised only where an author needed them.

## Subjects, common to every phase

Fresh Haiku and Sonnet subagents through the Agent tool's `model` parameter, **one subagent per prompt**, given only the dumped prompt file; one shot plus one repair (a fresh subagent of the same model with the conversation so far and the harness's exact rejection, `tools/ai-edit-subjects.ts repair`); at most 20 running at once; files scored once after every expected reply file exists. Harness: `tools/ai-edit-experiment.ts`, scripted replies, A0 only. The subagent prompt is the one of the primer-shrink pre-registration, unchanged. Incidents as there: a subject refused by a safeguard gets the identical prompt once more in a fresh subagent; a missing reply file is asked once more identically, then a failure; a prompt is never reworded; a launch refused only by the concurrency limit is started again identically.

## Phase A: V3 against V2 on set Y

Arms: `V2` (the shipped `MODEL_GUIDE.min.txt`, 299 tokens) and `V3` (244), `A0_EXPERIMENT_TASKSET=y A0_EXPERIMENT_PRIMER=always A0_EXPERIMENT_REPS=a0 A0_EXPERIMENT_PROTOCOLS=structured A0_EXPERIMENT_SPECS=none`, `A0_EXPERIMENT_GUIDE` the arm's file. 28 tasks x 2 models x 2 arms = 112 first-reply subjects, repairs on top.

Rule, as in the shrink pre-registration, fixed now: per model, `V3` passes if (1) its accepted count after one repair is not lower than `V2`'s by more than 1 task, and (2) its tokens per accepted edit at the 10-task horizon (`horizons()`, weights 1.25 / 0.17 / 0.05 on the system text, declared parameters not measurements) is lower. Both models pass, or no change. If both pass, `MODEL_GUIDE.min.txt` becomes the V3 text, `bun run sync-skill` follows to `skills/a0/references/primer.txt` and `plugin/skills/a0/references/primer.txt`, tests that pin the text are updated, in a separate commit. Evaluated by `tools/primer-compare-summary.ts v3` (`results/primer-v3.json`).

## Phase B: the dense surface as the default

Arms on the same tasks of sets X (16) and Y (28), both models:

- `canon`: the canonical shipped primer after phase A (V3 if phase A changed it, else V2), canonical view, `A0_EXPERIMENT_PRIMER=always`, structured. Set Y's cells are the phase A cells of that text (same prompts, same session, not rerun). Set X's cells are `results/primer-shrink/report.<model>.V2.json` when V2 stays shipped (already collected, same harness, sealed set); when V3 ships they are run fresh (32 first replies).
- `dense`: `MODEL_GUIDE.dense.txt` (145 tokens, identical to `experiments/primers/ablation/dense.D0.txt`) as the sole system text with the dense view and dense replies, `A0_EXPERIMENT_DENSE=1 A0_EXPERIMENT_PRIMER=rules-merged A0_EXPERIMENT_GUIDE=MODEL_GUIDE.dense.txt`, as set H. Unchanged: the primer does not describe `loop`, `text` or io, and set Y will show whether a surface that is read from the view alone holds. 44 tasks x 2 models = 88 first-reply subjects.

Rule, fixed now. Per model, pooled over sets X and Y (n = 44): `dense` passes if (1) accepted after one repair is not lower than `canon`'s by more than 2 tasks (the one-in-sixteen margin of the shrink rule, scaled to 44 and rounded up), (2) on neither set alone is it lower by more than 2 tasks, and (3) tokens per accepted edit at the 10-task horizon, pooled, is lower (raw numbers, no band). Both models, or no change. One-shot counts, the cold and unbounded horizons, Wilson intervals, per-task flips and failure classes (taken from `results/failure-taxonomy.json`, the class names of `docs/design/failure-taxonomy.md`) are reported with wins, ties and losses; none is part of the rule. Evaluated by `tools/primer-compare-summary.ts dense` (`results/dense-default.json`).

If met: the dense surface becomes the default in `src/mcp.ts` (the `dense` field defaults to true for views, with a documented opt-out `dense: false`), `skills/a0/references/` gets the dense primer beside the canonical text as the default one, with tests, in a separate commit. If not met: nothing ships, the failure classes of the failed cells and the next dense-leniency lever are written in the result below.

## Phase C: the 44 primer-paid-per-call ledger entries

Those entries compare whole-task tokens (primer + protocol + context + output at the cold task, `tools/loss-ledger.ts`) of A0 against TypeScript and Rust, from the headline files `results/ai-edit-experiment.<set>.<model>-min.json`. Budget stated now: at most 400 first-reply subjects over phases A to C in total (A 112, B at most 120, C at most 100 = 332, margin kept); no other subject. Phase C reruns only set a (13 tasks), the A0 cells (conventional and structured), both models, with the primer shipped after phase A: 13 x 2 x 2 = 52 first-reply subjects, repairs on top. Its output is the per-cell mean whole-task tokens of A0 with the new text, compared with the recorded TypeScript and Rust cells of the same set (not rerun: the TypeScript and Rust prompts are unchanged). The ledger rule is unchanged: an entry is removed only if the rerun A0 value is below the recorded rival's (`bun tools/loss-ledger.ts --update --reason ...`); the other sets (b to f) are not rerun in this round and their entries stay open with the evidence of set a and the arithmetic bound (labelled a hypothesis, not a measurement) that a primer change of 151 tokens cannot close a gap larger than that.

## Limits stated in advance

- n = 28 per cell in phase A and 44 in phase B separate nothing by themselves; a pass means the registered rule, not a significance claim. (claim-ok: a property of the interval method, not a measured value)
- Set Y is authored by a model, not a human, as sets H to X; its tasks are not the application-scale tasks of the cost anatomy.
- Cost accounting is local o200k with the repository's cache weights, as in every earlier round.
