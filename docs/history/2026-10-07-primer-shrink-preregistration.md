# Pre-registration: shrinking the shipped primer by moving rarely needed rules into diagnostics (written before any set-X subject ran)

Date: 2026-10-07. Written and committed before any model was called on set X or on the primer texts below. The only runs before this commit were the harness dry run with no replies (`self-check: ok`, 16 prompts dumped, no model) and the unit tests.

## Why, and what is already known

The cost anatomy (`docs/design/cost-anatomy.md`, `results/cost-anatomy.json`) shows that on single-function edits with the shipped guide (`MODEL_GUIDE.min.txt`, 395 o200k tokens, 447 with the harness's protocol paragraph) the primer and protocol are +398.8 of the +402.6 tokens by which A0 trails TypeScript per accepted edit at the cold task, +54.3 of +58.1 at the 10-task horizon and +16.0 of +19.8 unbounded; every other component together is within 4 tokens. Shorter primers have been measured many times: the 101- and 221-token edit primers cost 36 to 64 per cent less at the cold task and lost Haiku one-shot acceptance in every confirmation (sets K to W, `results/set-uvw.json`: Haiku 28 and 36 against 41 of 48 on one shot). Those shorter texts removed the language lines (types, arguments, notation) the Haiku subject uses. The difference here is the principle for what to remove:

1. Remove only text the single-function edit task does not use and that an existing diagnostic already carries, so the cost moves from every call to the call where the mistake happens (a diagnostic costs tokens only when triggered).
2. Replace prose by one exact edit example in the same line, never remove a clause that earlier ablations (`results/primer-ablation.json`) showed to matter (`Kx4`, the `fn ... block` sentence; `Kx5`, the operation list; the types and arguments line; the dense notation clauses).

## The texts (`experiments/primers/shrink/`; tokens are o200k, `js-tiktoken`, `results/primer-shrink.json` `primerTokensO200k` once measured)

- `S`: the shipped guide, `MODEL_GUIDE.min.txt`, 395 tokens (the control; system text 443 with the protocol paragraph in the harness's `always` layout, 447 in the cost anatomy's pooled average).
- `V1` (320; system text 368 in the harness): `S` without the `use "file.a0"` sentence, without `No forward refs or recursion;` (the unknown-callee diagnostic says "callees must be defined earlier; recursion is unsupported"), without the `io` type word, `(F earlier)`, the `loop` clause, the `text "s"` item and the whole `io:` line. Those rules now live in diagnostics (this commit, `src/core.ts` and `src/diagnostics.ts`): the unknown-callee fix of an unknown op names `text "s"`, `loop P F n s a... (F while P(state,i,a...) holds, at most n times)` and the io ops with their types and the linear-token rule; the `loop` arity diagnostic (`A0012`) has a `fix` stating the rule; the `use` misuse diagnostic (`A0017`) already stated its form. `test/primer-shrink.test.ts` pins each of these.
- `V2` (299; system text 348): `V1` with the `EDIT:` paragraph rewritten example first (`c add a b`, replaces or inserts before ret, `... @ x` inserts after x, `-c`, `ret c`, a `fn f u32 -> u32` block, `-fn f`) and the separate `Example:` line removed (every request's view is itself a worked function).
- `V3` (244): `V2` with the op list reduced to the ops whose behaviour a model cannot guess and the notes of `put` and handle-line dropped. Designed and counted only: it is the pattern (`Kx5`, `DR3`) that lost acceptance before and is not run in this round (budget). It is recorded as the next lever if `V1` or `V2` passes.

The diagnostics change is part of the repository state for every arm: `S`, `V1` and `V2` all see the same rejection and fix texts, so it is held constant across the comparison (it can only help a subject who writes an unknown op, and none of set X's tasks needs `loop`, `text` or io).

## What is compared

Set X (`tools/ai-edit-tasks-x.ts`, 16 tasks, SHA-256 in `tools/ai-edit-tasks-x.sha256`, sealed in this commit, never altered; authored by a task author who saw neither the language nor any model answer, from `experiments/set-x/AUTHOR_BRIEF.md`, converted and re-checked by `tools/ai-edit-tasks-h-gen.ts x` with the reference interpreter: 16 of 16 kept, nothing changed by hand; none of sets A to W's results was used to choose a text here other than as the history above). Not used before in any measurement.

Harness: `tools/ai-edit-experiment.ts`, scripted replies, A0 only, structured protocol, canonical form, `A0_EXPERIMENT_TASKSET=x A0_EXPERIMENT_PRIMER=always A0_EXPERIMENT_REPS=a0 A0_EXPERIMENT_PROTOCOLS=structured A0_EXPERIMENT_SPECS=none`, `A0_EXPERIMENT_GUIDE` set to the variant's file (`S`: the default). The system text is the guide followed by the harness's protocol paragraph, the same for every arm. Also for every arm: the edit protocol and diagnostics of the repository at this commit.

Subjects: fresh Haiku and Sonnet subagents (the Agent tool's `model` parameter), **one subagent per prompt** (96 first replies: 16 tasks, 2 models, 3 texts), each given only the dumped prompt file (system text and request: never the tests, never another reply), then **one repair round**: for every first reply the harness rejected, one fresh subagent of the same model gets the conversation so far and the harness's exact rejection (`ai-edit-subjects.ts repair`). Budget: 96 first-reply subjects and at most 96 repair subjects (expected under 40), at most 20 running at once; no other subject. Files are scored once, after every subject has reported and every expected reply file exists.

The subagent prompt (identical for every subject, `<file>` the prompt file, `<out>` the reply file; Haiku or Sonnet by the Agent tool's `model`):

> Read the file <file> with the Read tool. It holds a SYSTEM text and a REQUEST (a repair file also holds the conversation so far). Do not read any other file, do not run any command and do not use any tool except one Read and one Write. Answer the request as the system text says, and use the Write tool to write exactly your reply, with nothing else, to <out>. When it is written, reply with the single word done.

## Metrics

Per model and text, n = 16: one-shot and after-repair acceptance with Wilson 95% intervals, calls per task, tokens per accepted edit at the cold, 10-task (primary) and unbounded horizons (`horizons()` of `tools/app-edit-summary.ts`: system 1.25 / 0.17 / 0.05 times on the first call, 0.05 on later calls; view, task text, rejection messages and output 1 times), the per-task flips against `S`, and the first failure of each rejected task. (claim-ok: the weights are the declared model parameters, not measurements)

## The rule (fixed now)

Per model, separately: a text `V` passes against `S` if

1. its accepted count after one repair is not lower than `S`'s by more than 1 task (margin one task, declared before collection), and
2. its tokens per accepted edit at the 10-task horizon is lower (raw numbers, no band).

Both models pass, or no change. If both `V1` and `V2` pass, the one with the lower sum of the two models' 10-task costs is chosen. A change means: `MODEL_GUIDE.min.txt` becomes the chosen text and `skills/a0/references/primer.txt` follows through `bun run sync-skill`, with the tests that pin the guide updated, in a separate commit; `src/mcp.ts` carries no guide text (the MCP server surfaces tool descriptions only), so its descriptions do not change. One-shot acceptance, the cold and unbounded horizons, the per-set interval verdicts and the failure classes are reported with wins, ties and losses; none of them is part of the rule. The rule is evaluated by `tools/primer-shrink-summary.ts` (`results/primer-shrink.json`, `decision`) and not changed after the data are read.

## Limits stated in advance

- Set X has no task that needs `use`, `text`, `loop` or io, so it cannot show a loss from removing those rules; the protection is the diagnostics and their tests, not a measurement. A later set that needs them would test the move.
- n = 16 per cell separates nothing by itself (one Wilson interval is about 8 to 9 points wide at this n for a high rate): a pass means "acceptance within one task and cheaper", the registered rule, not a significance claim. (claim-ok: a property of the interval method at n = 16, not a measured value)
- Cost accounting is local o200k, with the repository's cache weights, as in every earlier round.

## Incidents, fixed in advance

A subject refused by an API safeguard gets the identical prompt once more in a fresh subagent; a second refusal is a missing reply and a failure. A subject that writes no reply file is re-asked once, identically; if still missing, a failure. Never reword a prompt. Controls and variants run in the same session.
