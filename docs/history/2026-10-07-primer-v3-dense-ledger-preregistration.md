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

Those entries compare whole-task tokens (primer + protocol + context + output at the cold task, `tools/loss-ledger.ts`) of A0 against TypeScript and Rust, from the headline files `results/ai-edit-experiment.<set>.<model>-min.json`. Budget stated now: at most 400 first-reply subjects over phases A to C in total (A 112, B at most 120, C at most 100 = 332, margin kept); no other subject. Phase C reruns only set a (13 tasks), the A0 cells (conventional and structured), both models, with the primer shipped after phase A: 13 x 2 x 2 = 52 first-reply subjects, repairs on top. Its output is the per-cell mean whole-task tokens of A0 with the new text, compared with the recorded TypeScript and Rust cells of the same set (not rerun: the TypeScript and Rust prompts are unchanged). The ledger rule is unchanged: an entry is removed only if the rerun A0 value is below the recorded rival's (`bun tools/loss-ledger.ts --update --reason ...`); the other sets (b to f) are not rerun in this round and their entries stay open with the evidence of set a and the arithmetic bound (labelled a hypothesis, not a measurement) that a primer change of 151 tokens cannot close a gap larger than that. (claim-ok: the budget and the gap bound are declared parameters and arithmetic on recorded values, not new measurements)

## Limits stated in advance

- n = 28 per cell in phase A and 44 in phase B separate nothing by themselves; a pass means the registered rule, not a significance claim. (claim-ok: a property of the interval method, not a measured value)
- Set Y is authored by a model, not a human, as sets H to X; its tasks are not the application-scale tasks of the cost anatomy.
- Cost accounting is local o200k with the repository's cache weights, as in every earlier round.

## Phase A result (collected after the rule above was committed; `results/primer-v3.json`, `tools/primer-compare-summary.ts v3`, reports and scripted replies in `results/primer-v3/`)

Set Y was verified against its seal (`test/primer-v3.test.ts`) and not altered; harness self-check ok in all four reports. 112 fresh first-reply subagents (28 tasks, Haiku and Sonnet, `V2` and `V3`, one subagent per prompt; some launches were refused only by the 20-subagent concurrency limit and started again with the identical prompt) and 24 fresh repair subagents (Haiku `V2` 12, `V3` 7; Sonnet `V2` 2, `V3` 3). No subject was refused by a safeguard; no reply is missing. Scored once after every reply existed.

| model | text | system o200k | one shot | accepted after repair | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | V2 (shipped) | 348 | 16 of 28 | 22 | 1.43 | 891.2 | 412.8 | 359.7 |
| Haiku | V3 | 293 | 21 | 24 | 1.25 | 673.0 | 303.8 | 262.8 |
| Sonnet | V2 (shipped) | 348 | 26 | 28 | 1.07 | 603.5 | 227.7 | 185.9 |
| Sonnet | V3 | 293 | 25 | 28 | 1.11 | 538.1 | 221.7 | 186.5 |

Tokens per accepted edit in the last three columns. **The registered rule is met on both models**: Haiku `V3` 24 against 22 accepted and 303.8 against 412.8; Sonnet `V3` 28 against 28 and 221.7 against 227.7. `V3` ships (separate commit).

Wins, ties and losses, none hidden. Acceptance after repair: Haiku `V3` 24 against 22, Sonnet 28 against 28 (every comparison a tie on the Wilson intervals at n = 28). Flips against `V2`: Haiku gained `y-echo-decay`, `y-vowel-pick`, `y-ticket-tail`, `y-overtime-pay` and lost `y-stock-scan` and `y-months-affordable`; Sonnet no flip. One shot: Haiku 21 against 16 (a gain), Sonnet 25 against 26 (a loss of one task). Cost: lower at the cold and 10-task horizons on both models; unbounded lower on Haiku and a near tie on Sonnet (186.5 against 185.9, a loss of 0.3 per cent). First failures of the tasks still not accepted: Haiku `V3`: `y-stock-scan` wrong logic (3 against 4), `y-months-affordable` a nested operand (syntax slip), `y-relay-scaled` a u32 expected where an io token was written (io semantics misread), `y-reorder-available` a reference to an undefined or later node; Haiku `V2` additionally failed `y-overtime-pay` with an unknown callee (the forward-reference rule that V1 and V2 moved to a diagnostic, the open risk named in the primer-shrink result). The tasks that exercise `loop`, `text` and io were the ones this set was written to test: the move of those rules out of the primer to diagnostics did not cost acceptance at this size.

The limit stated in advance still applies (`use` is not exercised by any edit set; n = 28 per cell).

## Phase B result (collected after the rule above was committed; `results/dense-default.json`, `tools/primer-compare-summary.ts dense`, reports and scripted replies in `results/dense-default/`)

Sets X and Y were verified against their seals and not altered; the harness self-check passed in all eight reports. The `canon` arm is the shipped V3 text (set X run fresh, 32 first replies; set Y is the phase A V3 cells, not rerun). The `dense` arm is `MODEL_GUIDE.dense.txt` with the dense view (88 first replies). Fresh subagents, one per prompt, one shot plus one repair (repair subagents: dense X 6 Haiku and 6 Sonnet, canon X 5 Haiku and 1 Sonnet, dense Y 18 Haiku and 8 Sonnet). No subject was refused; no reply is missing; some launches were refused only by the concurrency limit and started again with the identical prompt.

| model | arm | system o200k | one shot (X+Y of 44) | accepted after repair | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | canon (V3) | 293 | 32 | 37 (X 13, Y 24) | 1.27 | 679.1 | 302.8 | 261.0 |
| Haiku | dense | 145 | 20 | 28 (X 13, Y 15) | 1.55 | 730.6 | 484.6 | 457.2 |
| Sonnet | canon (V3) | 293 | 40 | 44 (X 16, Y 28) | 1.09 | 524.7 | 208.3 | 173.1 |
| Sonnet | dense | 145 | 30 | 39 (X 14, Y 25) | 1.32 | 414.3 | 237.6 | 218.0 |

Tokens per accepted edit in the last three columns. **The registered rule is not met on either model** (`decision.change` is false): Haiku dense accepts 28 against 37 (more than 2 tasks lower, and Y alone 15 against 24) and costs more at the 10-task horizon (484.6 against 302.8); Sonnet dense accepts 39 against 44 (X 14 against 16 is within the margin, Y 25 against 28 is not) and costs more (237.6 against 208.3). Nothing ships: `src/mcp.ts` and the skill primer are unchanged; the dense surface stays an opt-in (`dense: true` or a `.a0d` file).

Wins, ties and losses, none hidden (numbers: `results/dense-default.json`). Wins for dense: the 145-token system text makes the cold task cheaper on Sonnet (414.3 against 524.7), and on set X alone Haiku dense is tied on accepted (13 against 13) and marginally cheaper at the 10-task horizon (297.5 against 300.8); dense Haiku also accepted `x-loan-quarter`, `x-signal-decay` and `y-stock-scan`, which canon V3 did not. Losses: every other cell, above all set Y (28 tasks that need `loop`, `text` and io, none of which the 145-token dense primer describes): Haiku one shot 10 against 21 and accepted 15 against 24, Sonnet one shot 20 against 25 and accepted 25 against 28.

Failure classes of the dense cells after the repair (class names of the failure taxonomy of commit 8fd7b10, read from the first rejection message; its results file is not on this branch): 

- syntax slip, the largest class: parameters written as a name (`io`, `i`, `count`) where the dense form wants `A`, `B`, ... (`y-tagged-reply`, `y-relay-scaled`, `y-ticket-tail`, and the Sonnet `step`/`count_tail` p-out-of-range cases), and "one statement per line, a value used twice needs a name" (`y-reading-tenths`, `y-last-slot`, `x-lift-load`, `x-stair-energy` on Sonnet, `y-echo-decay` `loop` arity);
- type/width mismatch: `at` on an array instead of `get` (`y-months-affordable`), an extra argument to `fold` (`x-tank-overflow`), `select` branches of different types (`y-sensor-maintenance`);
- ordering: a callee defined after its caller (`y-weighted-smooth`); io linearity: a token consumed twice (`y-swap-pair`);
- misunderstood semantics (`y-tag-score`, `y-banner-letter`, `y-reorder-available`, `x-armor-hit`, Haiku `x-lift-load`, Sonnet `y-free-slot`): the same class as on canonical.

Why it failed, and the next lever. The two dense-only classes (the name-for-`A` parameter and the value-used-twice line) are leniencies the parser does not offer, and the dense primer carries no clause for `loop`, `text`, io or `put`, so a set that needs them separates the forms (set X, which does not, nearly ties on Haiku). The next lever, to be measured on a new sealed set (set X and Y are used and not to be reused after a fix chosen from their failures): a dense parser leniency that reads a named parameter reference (`p0`, a declared name) as the positional letter and a repeated sub-expression as an implicit name, together with a dense primer that states `loop P F n s a...`, `text "s"` and the io linear token in the same 145 to 200 tokens (the canonical V3 carries only `fold` and no loop, so this adds clauses to a surface whose point is being short). It must pass the same rule on both models before the default changes.
