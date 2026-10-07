# Pre-registration: primer V4, a lazy primer that teaches on demand, on a new sealed set Z (written before any set-Z subject ran)

Date: 2026-10-07. Written and committed before any model was called on set Z. The only runs before this commit: the harness dry runs with no replies (`self-check: ok` on set Z, 32 of 32 tasks), the unit tests, the fresh Opus author of set Z (it saw only `experiments/set-z/AUTHOR_BRIEF.md`), and the design pilots below on the already used set Y.

## Why

`docs/design/cost-anatomy.md` and `results/primer-ledger-rescore.json` show the primer is the whole of A0's cost gap on single-function edits and that with V3 (244 tokens, plus 49 of protocol paragraph in the harness layout, 293 in all) A0 is still 141 to 218 tokens above TypeScript and Rust on set a. TypeScript pays no primer because the model already knows it. The lever here: ship almost nothing on every call (the edit protocol shape and one worked line), and move every other rule to where it costs tokens only when triggered.

## The surface (`src/lazy.ts`, off unless `A0_LAZY_HINTS=on`)

1. **Primer V4** (`experiments/primers/lazy/V4.txt`, 137 o200k tokens, the whole system text: the reply protocol is in it, so no separate protocol paragraph, `A0_EXPERIMENT_PRIMER=rules-merged`): the reply shape (bare lines, no fence, no handle), `id op args` with one worked line (`c mul a 2`), insert-after, delete, `ret`, the `fn` block and `-fn`, and "Errors explain the rest". No op list, no types line, no `fold`/`call`/`arr` notation.
2. **Rejections that name an op** (type, arity and operand faults: A0201-A0222 family, A0306, A0307) end with that op's signature, read from the rejected reply (about 12 tokens).
3. **An unknown op or callee** (A0011, A0102 without a did-you-mean) lists every op with its operands, `fold`, `loop`, `text`, and the io rules (about 110 tokens, paid only then).
4. **The first rejection of a session** ends with a 40-token rule card (one op per line, argument kinds, callees above callers, bare lines edit the shown function); later rejections do not repeat it.
5. **The view of a function that uses `fold`** ends with a one-line legend `# fold F n s a...: state = s; for i < n: state = F(state, i, a...)` (the precedent: the key legend of `src/wordkey.ts`). `loop` and io get no legend: V3 never described them either.

The hints are in the same build for both arms and gated by the environment variable; the V3 arm runs with the variable unset, so its diagnostics and views are exactly the shipped ones. `test/primer-v4.test.ts` pins each surface and the hints-off text.

## Design pilots (on used sets, before this commit; not part of the rule)

Haiku, set Y, one first reply per task, one subagent per prompt, no repair round (the number is the one-shot count; V3 on set Y had 21 of 28 recorded in `results/primer-v3.json`):

- V4a (113 tokens, example `c add a b`): 10 of 28. The model took `add` for the verb of an edit (`l add loop ...`) and wrote line numbers as ids.
- V4 as registered (137 tokens, example `c mul a 2`, "ids are names, never line numbers"): 13 of 28. The failures are unknown ops (`extract`, `load`, `mod`, `max`, `not`, `fld`), a type fault, and wrong logic; the model has no op list.
- V4c (217 tokens, V4 plus a names-and-operands op list): the run was stopped after a partial collection and is not scored: at 217 tokens the saving over V3's 293 is 76 tokens, too small to matter at the 10-task horizon (about 13 tokens), so it is not a candidate.

Deterministic cost of the hints (`tools/primer-v4-hint-cost.ts`, `results/primer-v4-hint-cost.json`): the recorded first replies of the V3 arm on sets X and Y, applied with hints off and on: 3.5 to 9.6 extra tokens per task on set Y and 6.5 to 9.4 on set X, almost all of it the fold legend on tasks that use `fold`, plus the rule card and signatures on the few replies the checker rejects. This is a floor: the V4 arm is rejected more often (the pilots), and the registered run measures that cost.

I expect, from the pilots, that the 10-task rule below is not met by Haiku. It is registered anyway: the owner's goal is a measured answer, and the pilots are one-shot counts on a used set.

## Set Z (sealed in this commit)

`tools/ai-edit-tasks-z.ts`, 32 tasks, SHA-256 in `tools/ai-edit-tasks-z.sha256`, never altered. Authored by a fresh Opus subagent from `experiments/set-z/AUTHOR_BRIEF.md` (the brief of set Y, extended with 4 plain arithmetic/array tasks and an avoid-list of set Y's ideas; it saw neither the language, nor any set, nor any model answer), converted and checked by `tools/ai-edit-tasks-h-gen.ts z` with the reference interpreter (the starting program fails a test, the reference passes all, each wrong edit fails one, at least 8 tests): 32 of 32 kept, nothing changed by hand. Mix by the brief: 8 `loop`, 6 `text`, 8 io, 6 helper-before-caller, 4 plain, with `eq`/`ne` on bools and record `at`/`put` across them. Not used before in any measurement or pilot.

## Arms, subjects, rule

Harness `tools/ai-edit-experiment.ts`, scripted replies, A0 only, structured protocol, canonical form, `A0_EXPERIMENT_TASKSET=z A0_EXPERIMENT_REPS=a0 A0_EXPERIMENT_PROTOCOLS=structured A0_EXPERIMENT_SPECS=none`:

- `V3`: `A0_EXPERIMENT_PRIMER=always`, `A0_EXPERIMENT_GUIDE=MODEL_GUIDE.min.txt` (the shipped text and protocol paragraph, 293 tokens), hints unset.
- `V4`: `A0_EXPERIMENT_PRIMER=rules-merged`, `A0_EXPERIMENT_GUIDE=experiments/primers/lazy/V4.txt` (137 tokens), `A0_LAZY_HINTS=on`.

Subjects as in `docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md`: fresh Haiku and Sonnet subagents through the Agent tool's `model` parameter, one subagent per prompt (32 tasks x 2 models x 2 arms = 128 first replies), given only the dumped prompt file; one shot plus one repair (a fresh subagent of the same model with the conversation so far and the harness's exact rejection, `tools/ai-edit-subjects.ts repair`); at most 20 at once; files scored once after every expected reply file exists. The subagent prompt is the one of the primer-shrink pre-registration, unchanged. Incidents: a subject refused by a safeguard gets the identical prompt once more; a missing reply is asked once more identically, then a failure; a prompt is never reworded; a launch refused only by the concurrency limit is started again identically. Budget: 128 first-reply subjects and the repair subjects; no other subject.

**Rule, fixed now.** Per model: `V4` passes if (1) its accepted count after one repair is not lower than `V3`'s by more than 1 task, and (2) its tokens per accepted edit at the 10-task horizon (`horizons()`, weights 1.25 / 0.17 / 0.05 on the system text, declared parameters) is not higher than `V3`'s. Both models pass, or no change. The cold and unbounded horizons, one-shot counts, Wilson intervals, per-task flips and failure classes are reported with wins, ties and losses; none is part of the rule. Evaluated by `tools/primer-compare-summary.ts v4` (`results/primer-v4.json`).

If met: `MODEL_GUIDE.min.txt` becomes the V4 text, `A0_LAZY_HINTS` defaults on, `bun run sync-skill` follows to the skill and plugin primers, the tests that pin the text are updated, in a separate commit; the ledger is re-scored only if an entry closes or changes. If not met: nothing ships, the failure classes and the next lever are written below.

## Limits stated in advance

- n = 32 per cell separates nothing by itself; a pass means the registered rule. (claim-ok: a property of the interval method)
- Set Z is authored by a model, not a human; its tasks are not application-scale. Cost accounting is local o200k with the repository's cache weights.
- The arms differ in system layout (the V4 text carries its own protocol, the V3 text is followed by the harness paragraph): that is the shipped difference the comparison is about.

## Result (collected after the rule above was committed; `results/primer-v4.json`, `tools/primer-compare-summary.ts v4`, reports and scripted replies in `results/primer-v4/`)

Set Z was verified against its seal (`test/primer-v4.test.ts`) and not altered; the harness self-check passed in all four reports. 128 fresh first-reply subagents (32 tasks, Haiku and Sonnet, arms `V3` and `V4`, one subagent per prompt; launches refused only by the 20-subagent concurrency limit were started again with the identical prompt) and 40 fresh repair subagents (Haiku `V3` 11, `V4` 18; Sonnet `V3` 3, `V4` 8). No subject was refused by a safeguard; no reply is missing. Scored once after every reply existed.

| model | text | system o200k | one shot | accepted after repair | calls per task | cold | 10-task (primary) | unbounded |
|---|---|---|---|---|---|---|---|---|
| Haiku | V3 (shipped) | 293 | 21 of 32 | 26 | 1.34 | 738.2 | 348.7 | 305.4 |
| Haiku | V4 | 137 | 14 | 21 | 1.56 | 692.9 | 467.5 | 442.4 |
| Sonnet | V3 (shipped) | 293 | 29 | 31 | 1.09 | 539.8 | 213.2 | 176.9 |
| Sonnet | V4 | 137 | 24 | 31 | 1.25 | 360.1 | 207.3 | 190.4 |

Tokens per accepted edit in the last three columns. **The registered rule is not met** (`decision.change` is false): Haiku `V4` accepts 21 against 26 (lower by 5, the margin is 1) and costs more at the 10-task horizon (467.5 against 348.7); Sonnet `V4` passes (31 against 31, 207.3 against 213.2). Both models must pass, so nothing ships: `MODEL_GUIDE.min.txt`, the skill and plugin primers, `src/mcp.ts` and the ledger are unchanged, and `A0_LAZY_HINTS` stays off by default.

Wins, ties and losses, none hidden. Sonnet: the same acceptance (31 of 32; gained `z-job-warmup`, lost `z-lucky-roll`), the cold task 33 per cent cheaper (360.1 against 539.8), the 10-task horizon 2.8 per cent cheaper, but the unbounded horizon dearer (190.4 against 176.9) and one shot lower (24 against 29): the lazy text pays its saving on the first call and pays it back in repair rounds and rule cards when the session is long. Haiku: lower at the cold horizon (692.9 against 738.2), higher at the 10-task and unbounded horizons, one shot 14 against 21, five tasks lost (`z-indent-width`, `z-tagged-pair`, `z-box-cost`, `z-lucky-roll`, `z-clock-end`), none gained. (claim-ok: the per cent figures are arithmetic on the recorded values of `results/primer-v4.json`)

First failures of the Haiku `V4` tasks not accepted: a node edited twice in one reply (`z-ammo-volley`, `z-indent-width`, id reuse); an op name the model invented (`mod`, in `z-light-wait`, whose rejection listed the ops and still did not get the repair accepted); a syntax slip (`loop:` as a node id, `z-bracket-rounds`); the io token misused (`z-meter-usage`, `z-door-agree`, `z-tagged-pair`); a bool returned where a u32 was expected (`z-lucky-roll`); wrong logic (`z-job-warmup`, `z-box-cost`, `z-clock-end`). The V3 arm's six unaccepted tasks are of the same families but four of them are logic.

Cost of the hints (not part of the rule): the deterministic floor on the V3 arm's recorded replies is 3.5 to 9.6 extra tokens per task (`results/primer-v4-hint-cost.json`); on set Z the V4 arm's rejected first replies (18 of 32 for Haiku, 8 of 32 for Sonnet) each paid the rule card on top of the signature or table.

What the pilots and the run say. A primer without the op list is paid for in Haiku's first replies: it invents op names and misreads the line shape (the first V4a pilot read `add` in the example as the verb of an edit). The diagnostics can name every op and the first repair usually succeeds for Sonnet, rarely enough for Haiku to erase the saving at the 10-task horizon. The saving is real on the first call (Sonnet 33 per cent, Haiku 6 per cent),. The ledger compares the cold task with TypeScript and Rust on other sets (set a, `results/primer-ledger-rescore.json`); set Z has no rival cells, so no ledger entry is closed or changed by this run.

Next levers, to be measured on a new sealed set (sets X, Y and Z are used and a fix chosen from their failures needs a new blind set): (1) accept the invented names as exact fixes in the checker (`mod` to `rem`, `neq` to `ne`, `not` to a `select`, `max` and `min` to a `lt` with a `select`), which costs tokens only when a model writes them and needs no primer at all; (2) a primer of the V4 shape with the bare op names (V4c, 217 tokens) only if (1) does not recover Haiku's one shot; (3) the lazy text for models that pass the rule alone, which needs a per-model surface and is not available to a host that cannot name its model. The pilots' V4c run was stopped and is not evidence for or against (2).
