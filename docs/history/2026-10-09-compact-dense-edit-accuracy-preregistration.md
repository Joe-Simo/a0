# Pre-registration: AI edit accuracy of the compact dense style (written before any subject runs)

Date: 2026-10-09. Committed with the sealed task set CD and before any model is called on it. The only runs before this commit are the set's generator (`bun tools/ai-edit-tasks-cd-gen.ts`, the reference interpreter only) and one harness dry run with no replies (prompts counted, no model).

## Why

`docs/history/2026-10-09-dense-six-rules-preregistration.md` kept five compact spellings (tab, min/max, hex, trailing parameters, one line per function; `results/dense-six-rules.json`) and named the risk: rules 5 and 6 remove edit anchors (operands not written, long lines). It says no public claim may rest on them until an AI edit-accuracy run shows no loss. This note fixes that run. claim-ok: restates a condition, no measured value.

## Task set CD (sealed in this commit)

`tools/ai-edit-tasks-cd.ts`, 45 tasks, SHA-256 in `tools/ai-edit-tasks-cd.sha256`, checked by `test/compact-dense-edit.test.ts`; never altered. No author and no model: `tools/ai-edit-tasks-cd-gen.ts` draws every task from the in-tree `.a0` programs by the rule written in its header, then `biome format`. In short: every `.a0` file of the held-out list of the six-rules note (sorted path, files with `use` or that do not validate alone skipped); every function whose parameters and result are `u32` and whose body has a decimal literal operand; the first such literal L becomes L + 1 (the bug; the reference is the original), L + 2 is the wrong edit; the task program is the target plus its transitive callees; tests from a fixed pool plus a seeded generator, expected values from the reference interpreter; the instruction names one failing call and its expected value. Checks as set H: the start fails a test, the reference passes all, the wrong edit fails one, at least 8 tests. 58 drawn, 45 kept: 6 dropped because the start passed every test, 7 because an earlier file (a site or example copy of the same program) gave the same id.

Drafting note, stated so nothing is hidden: the first draft took one function per file and gave 10 tasks, and embedded whole files (3.5 MB); the rule was changed to every qualifying function and to the callee closure before sealing, on the count and size alone, with no model run. Limits: every task is a one-literal fix (a narrow edit kind); many tasks come from a few files (`site/lib/fx.a0`, `compiler/asm_arm64.a0`); the instruction states the expected value, which helps every arm alike.

Set CD is A0 only: in-tree A0 programs have no TypeScript or Ruby translation, and writing them after seeing the set would be authored, not drawn.

## Arms

- `dense`: the current dense view and replies, `A0_EXPERIMENT_DENSE=1 A0_EXPERIMENT_PRIMER=rules-merged A0_EXPERIMENT_GUIDE=MODEL_GUIDE.dense.txt`, structured, as set H and phase B of the primer-V3 note.
- `compact`: the same with the kept compact spellings on in the view (`DenseStyle` `tab`, `minmax`, `hex`, `trailingParams`, `oneLine`) and replies read with `parseDense(..., { compact: true })`, and one primer clause per spelling a reply may need (text fixed in the follow-up commit that adds the arm, counted in o200k, before any run).
- References, as earlier experiments: TypeScript and Ruby, structured, on sealed set B (12 tasks, the only sealed set with translations). Ruby is the other language with the lowest pooled 10-task tokens per accepted edit on set B in `results/ai-edit-langs8.json` (128 against Kotlin 157, OCaml 135, A0 169). Set B also runs `dense` and `compact`, so the references are compared on the same tasks.

Harness: `A0_EXPERIMENT_TASKSET=cd` selects set CD (this commit). The compact arm needs a flag `A0_EXPERIMENT_DENSE_STYLE=compact` that cannot be added in the harness alone: the view is printed in `src/edit.ts` (`scopedViewDense`, `programView`, `formatDenseFunction` calls take no `DenseStyle`) and replies are parsed in `src/dense-edit.ts` (`parseDense` without `compact`). Needed before any run, in a separate commit, without touching `src/dense.ts`: (1) a `style?: DenseStyle` option on `EditSession.open`/`openProgram` passed to those printers; (2) a `compact` option threaded to `denseEditBody`'s `parseDense` call; (3) the harness flag passing both; (4) the primer clauses above. Until then the compact arm cannot run and nothing below is measured.

## Subjects

Fresh Haiku and Sonnet subagents through the Agent tool's `model` parameter, one subagent per prompt, given only the dumped prompt file; one shot plus one repair (a fresh subagent of the same model with the conversation so far and the harness's exact rejection, `tools/ai-edit-subjects.ts repair`); at most 20 at once; scored once after every expected reply file exists, with scripted replies (`A0_EXPERIMENT_REPLIES`). Budget: set CD 45 x 2 arms x 2 models = 180 first replies; set B 12 x 4 arms x 2 models = 96; 276 in total, repairs on top. No other subject. (claim-ok: planned budget counts, not results)

## Metrics

Per model and arm: one-shot and accepted-after-repair counts with Wilson 95% intervals (`wilson` in `tools/app-edit-summary.ts`); tokens per accepted edit at the existing horizons (`horizons()`: cold, 10-task, unbounded; local o200k with the repository's weights 1.25 / 0.17 / 0.05 on the system text, declared parameters, not measurements); calls per task; per-task flips between `dense` and `compact`; failure classes of the first rejection. Results will go to `compact-dense-edit.json` in `results/`, with reports and replies in the `compact-dense-edit/` folder beside it (not written yet). (claim-ok: planned metrics and output paths; no result exists yet)

## Pass rule (fixed now)

Per model, on set CD (n = 45): `compact` passes if (1) its accepted-after-repair count is not below the lower bound of the Wilson 95% interval of `dense`'s accepted rate (times 45), and (2) its tokens per accepted edit at the 10-task horizon are lower than `dense`'s. Both models must pass. Set B is a check, not a second chance: if `compact` accepts fewer than `dense` on set B by more than 1 task on either model, the result is "not shown" whatever set CD says. The TypeScript and Ruby cells are reported beside them with their gaps and decide nothing. (claim-ok: a pre-registered rule, not a result)

If met: rules 5 and 6 may be claimed with this note and that results file as the source. If not met: no claim; the failing classes and flips are written below and the compact style stays a measurement-only option. Every number is reported whatever it is.

## Limits stated in advance

- n = 45 and n = 12 separate only large effects; a pass means the registered rule, not significance. (claim-ok: a property of the interval method, not a measured value)
- One edit kind (a literal off by one); a pass does not cover structural edits.
