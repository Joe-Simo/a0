# Pre-registration: a dependency-scoped program view against the full signature listing, application-scale edits (written before any subject saw the new view)

Date: 2026-10-06. Written and committed before any subject saw the deps-scoped view.

## The question

In the application-scale edit benchmark (`docs/history/2026-10-06-app-edit-preregistration.md`, `results/app-edit.json`) an A0 request is the
function under edit plus a program view that lists the signature of every function of the program. Measured on the 14 sealed tasks (`results/app-edit-deps/view-tokens.json`)
(o200k tokens, request without the system text): the full listing makes a request average 4827 tokens, of which about 3900 are the listing; with the
program view scoped to the functions the first target reaches (`openProgram({ scope: 'deps', target })`, the form the shipped MCP tool
`a0_program` returns when it is given a target) the average is 1245, and with no program listing 1011. The numbers are a deterministic count of
the harness's own prompts; what is not known is whether a model edits as well with the smaller view, since a reply that adds a whole function with a
`fn` block or calls an existing one needs its name and signature.

## What is compared

The A0 side of the benchmark with the program view scoped to dependencies (`A0_PROGRAM_VIEW=deps tools/app-edit-bench.ts`, every other
part of the harness as in the sealed arm: the same 14 tasks, the same guide and protocol text, structured edits, one shot plus one repair by a fresh
subagent of the same model) against the already collected A0 side with the full listing (`results/app-edit/report.<model>.a0.json`). The TypeScript
side is not rerun; it is reported alongside. 28 fresh first-reply subagents (Haiku and Sonnet, 14 tasks), one subagent per prompt, then one fresh
repair subagent for every rejected first reply. Scored once, after every subagent has reported.

## The rule (fixed now)

Per model, separately, on the repaired acceptance count of the 14 tasks and on tokens per accepted edit at the 10-task horizon (`tools/app-edit-summary.ts`
formulas): the deps view is the better form for the product's application-scale use if

1. its accepted count is not lower than the full listing's by more than 1 task (a margin of one task, declared before collection), and
2. its tokens per accepted edit is lower (raw numbers).

Both conditions on both models, or no change. A change means: the shipped guidance and the harness default use the dependency-scoped program view
(a separate step with its own tests); nothing in the shipped text changes on the strength of this note. Reported with wins, ties and losses and none
hidden: one-shot counts, acceptance after repair, the cold and unbounded horizons, Wilson 95% intervals, the failure classes, and the TypeScript side
alongside. A failure is classified as a view gap (the reply needed a name or signature the view did not show; counted against the deps view and named) or
a model error.

## Incidents, fixed in advance

A subject refused by an API safeguard gets the identical request once more, never reworded; a second refusal is a recorded loss. A subject that does
not answer is scored as not accepted and not rerun. The decision is read from `results/app-edit-deps.json` (`tools/app-edit-deps-summary.ts`) and not changed after.

## How to run (exact commands)

```
A0_PROGRAM_VIEW=deps bun tools/app-edit-bench.ts dump results/app-edit-deps/dump.a0.json a0
bun tools/ai-edit-subjects.ts prompts results/app-edit-deps/dump.a0.json <scratch>/<model>/a0/prompts   # one fresh subagent per prompt
bun tools/ai-edit-subjects.ts collect results/app-edit-deps/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/replies.json
A0_PROGRAM_VIEW=deps bun tools/app-edit-bench.ts run <scratch>/<model>/a0/replies.json results/app-edit-deps/report1.<model>.a0.json a0 <model>
bun tools/ai-edit-subjects.ts repair results/app-edit-deps/report1.<model>.a0.json results/app-edit-deps/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/repair-prompts
# repair replies as <key>.repair.txt in the replies folder, then collect and run again into results/app-edit-deps/report.<model>.a0.json
bun tools/app-edit-deps-summary.ts
```
