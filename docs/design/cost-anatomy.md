# Cost anatomy of an accepted edit: where A0 loses the AI cost axis, and the three largest levers

Date: 2026-10-07. Every number is computed by `tools/cost-anatomy.ts` from recorded results only (no model was called) and written to `results/cost-anatomy.json`; the inputs are `results/ai-edit-experiment.{a..f}.{haiku,sonnet}-min.json`, `results/ai-edit-scoped.json`, `results/app-edit/report.*.json` and, for the comparison with the other app-scale arms, `results/app-edit.json`, `results/app-edit-loop.json`. The sources of the tokens-per-accepted-edit rule and the horizons are `tools/app-edit-summary.ts` and `tools/primer-ablation-summary.ts`: o200k tokens (local counts), the system text counted 1.25 times on the first call of a one-task session (cold), 0.17 times in a 10-task session, 0.05 times in an unbounded session and 0.05 times on later calls; the "raw" column is weight 1, which is what the loss ledger's `ai-tokens-*` entries use (`results/loss-blockers.json`, blocker `primer-paid-per-call`, 44 entries).

Components, per accepted edit (the sum over a cell's trials divided by its accepted trials): **primer** (the language text, first call), **protocol** (the reply-format paragraph the harness appends to the guide), **code read** (the view), **task and repair text** (the instruction plus the harness's rejection messages), **repair re-pay** (the system text paid again on a second call), **reply** (output tokens).

## 1. Shipped guide, single-function tasks (the ledger cells)

`MODEL_GUIDE.min.txt` (395 tokens) plus the protocol paragraph, structured protocol, sets a, b, d, e, f, Haiku and Sonnet pooled: 124 trials per cell, A0 accepted 121, TypeScript 118. (`results/cost-anatomy.json`, `shippedGuide`.)

| horizon | form | primer | protocol | code read | task and repair text | repair re-pay | reply | total |
|---|---|---|---|---|---|---|---|---|
| raw (ledger) | A0 canonical | 400.4 | 51.7 | 52.7 | 40.8 | 29.3 | 33.3 | 608.1 |
| raw (ledger) | TypeScript | 32.6 | 100.5 | 47.9 | 47.9 | 7.5 | 28.3 | 264.6 |
| cold, one task | A0 canonical | 500.5 | 64.6 | 52.7 | 40.8 | 1.5 | 33.3 | 693.3 |
| cold, one task | TypeScript | 40.7 | 125.6 | 47.9 | 47.9 | 0.4 | 28.3 | 290.7 |
| 10-task session | A0 canonical | 68.1 | 8.8 | 52.7 | 40.8 | 1.5 | 33.3 | 205.0 |
| 10-task session | TypeScript | 5.5 | 17.1 | 47.9 | 47.9 | 0.4 | 28.3 | 147.0 |
| unbounded | A0 canonical | 20.0 | 2.6 | 52.7 | 40.8 | 1.5 | 33.3 | 150.8 |
| unbounded | TypeScript | 1.6 | 5.0 | 47.9 | 47.9 | 0.4 | 28.3 | 131.1 |

A0 minus TypeScript, by component: cold +402.6 of which primer and protocol +398.8 (the other four components net +3.8); 10-task +58.1 of which primer and protocol +54.3; unbounded +19.8 of which primer and protocol +16.0. **In this regime the primer is the whole loss at every horizon**, and it is larger than the total gap: code read, task text, repair and reply together are within 4 tokens of TypeScript. A0 accepts more tasks here (121 against 118 of 124), so acceptance is not the cause. The primer is "paid per call": it is the only component that is a fixed 395 tokens whatever the task, against TypeScript's 51-token language note.

## 2. The scoped-view matrix (`results/ai-edit-scoped.json`, sets b, c, c400, c4000 pooled, 96 trials per form)

The edit-only canonical primer (118 tokens) and the dense primer (145) against TypeScript, each with the view the form's tool returns (dependency-scoped function view and program handle). Code read and task text are one bucket in that file.

| horizon | form | primer | code read + task text | repair re-pay | reply | total | accepted |
|---|---|---|---|---|---|---|---|
| cold | A0 canonical | 153.9 | 151.0 | 0.4 | 26.2 | 331.6 | 92 of 96 |
| cold | A0 dense | 181.3 | 69.7 | 0.0 | 22.3 | 273.2 | 96 of 96 |
| cold | TypeScript | 258.8 | 101.9 | 0.6 | 25.1 | 386.4 | 96 of 96 |
| 10-task | A0 canonical | 20.9 | 151.0 | 0.4 | 26.2 | 198.7 | 92 of 96 |
| 10-task | A0 dense | 24.7 | 69.7 | 0.0 | 22.3 | 116.6 | 96 of 96 |
| 10-task | TypeScript | 35.2 | 101.9 | 0.6 | 25.1 | 162.8 | 96 of 96 |
| unbounded | A0 canonical | 6.2 | 151.0 | 0.4 | 26.2 | 183.9 | 92 of 96 |
| unbounded | A0 dense | 7.3 | 69.7 | 0.0 | 22.3 | 99.2 | 96 of 96 |
| unbounded | TypeScript | 10.4 | 101.9 | 0.6 | 25.1 | 138.0 | 96 of 96 |

Here the primer is not the loser: the canonical edit primer wins the cold task (331.6 against 386.4, A0 pays 118 tokens where TypeScript pays 207 for its protocol paragraph) and loses the 10-task (+35.9) and unbounded (+45.9) horizons entirely on **code read and task text** (151.0 against 101.9, +49.1; the primer is -14.3 and -4.2). Dense wins every horizon (cold -113.2, 10-task -46.2, unbounded -38.8): its view is 32.2 tokens below TypeScript's and its primer is below TypeScript's at every horizon (181.3 against 258.8 cold, 24.7 against 35.2, 7.3 against 10.4). That is the ledger's `dense-view-wins-canonical-loses` blocker (325 entries). This matrix is a measurement of the opt-in dense form; the shipped dense decision is separate (`results/set-h.json`: dense did not meet its pre-registered rule against canonical in five of six model-by-set comparisons, so it stays out of the default).

## 3. Application-scale edits (`results/app-edit/report.*.json`, 14 tasks, Haiku and Sonnet pooled, 28 trials per side; one shot plus one repair)

| horizon | form | primer + protocol | code read + task text | repair re-pay | reply | total per accepted | accepted |
|---|---|---|---|---|---|---|---|
| 10-task | A0 canonical | 112.3 | 7180.4 | 12.2 | 145.1 | 7450.0 | 19 of 28 |
| 10-task | TypeScript | 7.6 | 7409.3 | 0.2 | 188.9 | 7606.0 | 27 of 28 |

Per accepted edit A0 is 2 percent below TypeScript (primer +104.7, code read -228.9, reply -43.8, repair +12.0), but per trial it is 31 percent below (5055 against 7335 tokens, the same totals times accepted over trials). **The loss at application scale is the denominator, acceptance, not a token component**: 9 of 28 A0 edits are not accepted against 1 of 28. The per-model rule values: Haiku 10130 against 7960 (7 of 14 accepted against 13), Sonnet 5893 against 7277 (12 against 14), so Sonnet already wins tokens per accepted edit (`results/app-edit.json`); the tool-loop arm is worse for A0 on Haiku (30741 against 12199, 7 of 14 accepted against 12) and Sonnet (9045 against 7599; `results/app-edit-loop.json`); those cells record the tool runs per task and the re-read context (`rereadTokensPerAcceptedEdit`, 245126 against 131532 on Haiku), which the primer does not explain (the system text is 936 against 381 tokens).

## 4. Which component makes A0 lose, by horizon

| regime | cold | 10-task session | unbounded |
|---|---|---|---|
| shipped guide, single function (section 1) | primer (+398.8 of +402.6) | primer (+54.3 of +58.1) | primer (+16.0 of +19.8) |
| edit primer, scoped views (section 2) | none (A0 wins by 54.8) | code read and task text (+49.1 of +35.9) | code read and task text (+49.1 of +45.9) |
| dense, scoped views (section 2) | none (wins by 113.2) | none (wins by 46.2) | none (wins by 38.8) |
| application scale (section 3) | acceptance | acceptance | acceptance |

## 5. The three largest levers, ranked by tokens saved per accepted edit

Counterfactual savings are computed from the tables above by replacing one component and leaving the others (so they are upper bounds that do not include the acceptance cost of the replacement, which is what the measurements in `docs/history/` price).

Single-function regime (the 44 `primer-paid-per-call` entries), saved per accepted edit at the cold task / 10-task / unbounded horizons:

1. **Primer size** (section 1, system text 447 tokens: guide 395 plus the 52-token protocol paragraph): 
   - to the dense primer, 145 tokens (the dense form carries its own reply format): 377.5 / 51.3 / 15.1;
   - the measured candidates of this round (`docs/history/2026-10-07-primer-shrink-preregistration.md`): `V1` 372 tokens saves 93.8 / 12.8 / 3.8, `V2` 351 saves 120.0 / 16.3 / 4.8 against the shipped 447.
2. **Code read** (view plus task text, section 1 93.5 tokens, to the dense scoped view's 69.7): 23.8 at every horizon (weight 1 on all of them), the largest lever at the unbounded horizon (above primer: 23.8 against 15.1).
3. **Reply and repair** (reply 33.3 and repair re-pay 1.5 against dense 22.3 and 0): 12.5 at every horizon.

Where the loss is acceptance (application scale): the largest lever by far is the accepted count: 19 of 28 to TypeScript's 27 of 28 would take A0 from 7450 to 5243 tokens per accepted edit at the 10-task horizon, 2207 saved, two orders of magnitude above any text lever. It is a model-accuracy lever (front-end edits fail on `fat-arrow`, `op-alias-mod`, `profile-canonical`, `number-leading-zero`, `unreserve-patch`, `use-alias-import`; `results/app-edit-wording.json` lists them), reachable by diagnostics that carry the rule the failing edit missed, not by a shorter primer.

Ranking at the 10-task horizon, single-function: primer (51.3 with the dense text, 16.3 with the best measured candidate) > code read (23.8) > reply and repair (12.5); ranking at the unbounded horizon: code read (23.8) > primer (15.1) > reply and repair (12.5). The primer lever is the one that can still turn the cold-task and 10-task ledger entries; it is the one measured in `docs/history/2026-10-07-primer-shrink-preregistration.md`.

## 6. Limits

Token counts are local o200k counts (`js-tiktoken`), not the vendor tokenizer; the cache weights are the repository's fixed assumption (1.25, 0.17, 0.05), not a measurement of any provider's billing; section 1 mixes sets a, b, d, e, f with unequal numbers of tasks per cell and pools two models; the scoped matrix has no separate view bucket; the application-scale cells have 14 tasks per model, so their acceptance is separated from TypeScript's by Wilson intervals only for Haiku (`results/app-edit.json`). Nothing here is a claim about untested programs.
