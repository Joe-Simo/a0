# Session 2026-10-02: is there a shorter primer that keeps acceptance? (STATUS next action 2)

The loss being worked: the primer is paid on every cold call, so the whole-task token cost of an A0 edit stays above TypeScript's (`results/loss-ledger.json`, the `ai-tokens-*` rows; the dense primer is 145 o200k tokens and the canonical one 118, `results/primer-ablation.json`, `primers`). Nothing in the language changed. Every number below comes from `results/primer-ablation.json` (the summary; `tools/primer-ablation-summary.ts`, `bun run primer-ablation`) or from the per-cell reports `results/primer-ablation/<set>.<model>.<variant>.json` with their `.replies.json`.

**Answer.** One shorter primer kept acceptance and lowered the cost of an accepted edit on both model sizes: a rewrite of the canonical primer (`KR3`, 101 tokens against 118). It is now `experiments/primers/MODEL_GUIDE.rules-merged.txt`. No shorter dense primer kept acceptance: the three that were confirmed (88, 102 and 110 tokens against 145) are lower on one-shot acceptance on Haiku and lose on the 10-task and unbounded cost, so `MODEL_GUIDE.dense.txt` is unchanged. Rates are counts of 11 to 13 tasks per cell and model; no rate difference below separates at that n (every interval comparison is a tie), so nothing here is a significance claim.

## 1. Method (CONTRIBUTING.md measurement rules)

- **Sets.** Selection set d (13 tasks); confirmation sets e (11 tasks) and f (13 tasks), different sealed sets that were never used to choose a candidate. Set g and the sets a to c were not used. The sealed task files are unchanged (`taskSetSha256` of each report in `results/primer-ablation.json`).
- **Variants** (`experiments/primers/ablation/<variant>.txt`; tokens in `results/primer-ablation.json`, `primers`). Controls: `dense.D0` (the current `MODEL_GUIDE.dense.txt`, 145 o200k tokens) and `canon.K0` (the text of `MODEL_GUIDE.rules-merged.txt` as it was, 118). Drop one clause: `Dx1` the reply-format sentence, `Dx2` the prefix-arity sentence with its example, `Dx3` the operation list, `Dx4` the fold sentence, `Dx5` the array and record notation, `Dx6` the types sentence; `Kx1` the "reply bare edit lines only (no fence, no handle)" sentence, `Kx2` the parenthesis "(one op, no nesting, lowercase id)", `Kx3` the `-id` and `ret x` sentence, `Kx4` the `fn ...` block sentence, `Kx5` the operation list, `Kx6` the fold sentence. Rewrites: `DR1` shorter wording, `DR2` example first, `DR3` only the operations a model cannot guess, `DR4` the same with fewer words, `KR1` shorter wording, `KR2` only the operations a model cannot guess, `KR3` example first. Combinations of drops and rewrites that did not hurt on d: `DC` (a `DR4` without its fold sentence) and `KC` (a `KR3` without its operation list). `DT` and `KT` are the current primers with one clause added, the test in section 6.
- **Subjects.** Fresh Haiku and Sonnet Agent-tool subagents (the Agent tool's `model` parameter), no author-written reply. One subagent per variant, model and set read one group file (the system text once, then every request of the set) and wrote one reply per task, each answered as an independent conversation; the group file holds only the primer, the view and the task text, never the tests or an earlier reply. Every first reply the harness rejected went, with the harness's exact rejection, to a fresh subagent of the same model (one repair group per variant, model and set): one shot plus one repair round. Scoring is `tools/ai-edit-experiment.ts` with the scripted-replies mode, a0 and the structured protocol, `A0_EXPERIMENT_PRIMER=rules-merged` (the guide alone is the system text), the dense view for the dense variants.
- **Departures, stated.** Earlier collections of this repository used one subagent per task for some sets and group files for others; here every cell is a group file of the whole set, because 25 variants, two models and three sets were not affordable one task at a time. A subject that left a task of its group file unanswered was asked for that task alone (3 times: Haiku `dense.Dx6` on d, `canon.KR3` and `dense.DR4` on e); a repair subagent that never wrote its file was relaunched once. The repair message states the failing test and expected value as in every run of this harness, so a repair is better informed than a user's would be; the one-shot columns are the clean comparison.
- **Cost.** o200k tokens, local counts (`js-tiktoken`): the system text counted 1.25 times on the first call of a one-task session, 0.17 times per task in a 10-task session, 0.05 times on later calls and in an unbounded session; view, tool context and output as counted by the harness; cost per accepted edit is the total over the cell's trials divided by its accepted trials (`results/primer-ablation.json`, `cells.*.tokensPerAcceptedEdit`).
- **Verdicts.** A rate is a win or a loss only when the Wilson 95 per cent intervals do not overlap; a cost is a win or a loss outside a 1 per cent band; the rest are ties (`verdictsAgainstControl`).

## 2. Clause ablation on the selection set d

`results/primer-ablation.json`, `cells["select(d)/..."]`. Counts of 13 tasks per model (n = 26 pooled); a few cells have 12 or 13 trials with a score because a missing reply is a failure and was re-asked; the repaired count is out of the cell's n. Control rows first in each block.

| variant | system o200k | Haiku one shot / repaired (of 13) | Sonnet one shot / repaired (of 13) | pooled one shot / repaired (of 26) | pooled tokens per accepted edit: cold task / 10-task session / unbounded |
|---|---|---|---|---|---|
| canon.K0 | 118 | 12 / 13 | 13 / 13 | 25 / 26 | 257 / 129.6 / 115.4 |
| canon.Kx1 | 106 | 12 / 13 | 13 / 13 | 25 / 26 | 249 / 134.5 / 121.8 |
| canon.Kx2 | 108 | 10 / 13 | 13 / 13 | 23 / 26 | 253.5 / 136.9 / 123.9 |
| canon.Kx3 | 112 | 11 / 13 | 13 / 13 | 24 / 26 | 254.2 / 133.3 / 119.8 |
| canon.Kx4 | 100 | 9 / 13 | 11 / 13 | 20 / 26 | 247.5 / 139.5 / 127.5 |
| canon.Kx5 | 82 | 12 / 13 | 13 / 13 | 25 / 26 | 211 / 122.4 / 112.6 |
| canon.Kx6 | 101 | 11 / 13 | 13 / 13 | 24 / 26 | 247 / 137.9 / 125.8 |
| canon.KR1 | 106 | 10 / 13 | 13 / 13 | 23 / 26 | 250.2 / 135.7 / 123 |
| canon.KR2 | 88 | 11 / 13 | 13 / 13 | 24 / 26 | 225.5 / 130.5 / 119.9 |
| canon.KR3 | 101 | 12 / 13 | 13 / 13 | 25 / 26 | 234.9 / 125.8 / 113.7 |
| canon.KC | 73 | 8 / 12 | 12 / 13 | 20 / 25 | 229.1 / 147.1 / 138 |
| dense.D0 | 145 | 11 / 12 | 13 / 13 | 24 / 25 | 293.2 / 130.3 / 112.2 |
| dense.Dx1 | 119 | 11 / 12 | 12 / 13 | 23 / 25 | 263 / 129.4 / 114.5 |
| dense.Dx2 | 113 | 12 / 13 | 13 / 13 | 25 / 26 | 230.2 / 108.1 / 94.6 |
| dense.Dx3 | 113 | 10 / 12 | 13 / 13 | 23 / 25 | 248.7 / 121.8 / 107.7 |
| dense.Dx4 | 122 | 12 / 12 | 13 / 13 | 25 / 25 | 251.3 / 114.3 / 99 |
| dense.Dx5 | 133 | 10 / 12 | 12 / 13 | 22 / 25 | 272.8 / 123.4 / 106.8 |
| dense.Dx6 | 125 | 11 / 13 | 12 / 12 | 23 / 25 | 262.6 / 122.2 / 106.6 |
| dense.DR1 | 131 | 11 / 12 | 13 / 13 | 24 / 25 | 265.8 / 118.7 / 102.3 |
| dense.DR2 | 121 | 12 / 13 | 13 / 13 | 25 / 26 | 240.8 / 110.1 / 95.6 |
| dense.DR3 | 110 | 12 / 12 | 13 / 13 | 25 / 25 | 238.9 / 115.4 / 101.7 |
| dense.DR4 | 102 | 11 / 13 | 13 / 13 | 24 / 26 | 222.1 / 111.9 / 99.7 |
| dense.DC | 88 | 11 / 12 | 13 / 13 | 24 / 25 | 210.6 / 111.8 / 100.8 |

(Rows of `canon.KT` and `dense.DT` are in section 6.) Reading, with the limits of n = 26: dropping any one clause of the dense primer left the pooled one-shot count within two of the control's 24 (22 to 25), and Sonnet was at 12 or 13 of 13 in every cell (it does not separate anything on d). Dropping the `fn ...` block sentence of the canonical primer (`Kx4`) is the one single canonical drop with a visible cost (20 against 25 one shot pooled: Haiku wrote bodies ending in `end` before `ret`), and `KC`, which drops the operation list from `KR3`, shows the same count (20). Most cells of both forms are within noise of their control; the token column mostly follows the system tokens, plus the repairs a cell needed.

### Selection (`results/primer-ablation.json`, `selection`)

A variant was eligible when, pooled over both models on d, its one-shot count and its count after one repair were not lower than the control's; the eligible variants with the fewest system tokens went on to e and f. Canonical, eligible: `Kx5` (82), `KR3` (101), `Kx1` (106); not eligible: `KC` and `Kx4` (20 one shot against 25) and the others with 23 or 24. Dense, eligible: `DC` (88), `DR4` (102), `DR3` (110), `Dx2` (113), `DR2` (121), `Dx4` (122), `DR1` (131); not eligible: `Dx1`, `Dx3`, `Dx5`, `Dx6`. The first two of each form were run on e and f; the third (`Kx1`, `DR3`) was added after the first two had lost there, so that the shorter primers get a fairer chance (same rule, the next one in line). `KT` and `DT` are not candidates.

## 3. Confirmation on the sets e and f (different sets from the selection)

`results/primer-ablation.json`, `cells["confirm(e+f)/..."]`; n = 24 per model (11 + 13), 48 pooled. The controls were collected fresh in the same session (not reused).

| variant | system o200k | Haiku one shot / repaired (of 24) | Sonnet one shot / repaired (of 24) | pooled one shot / repaired (of 48) | calls per task (pooled) | pooled tokens per accepted edit: cold task / 10-task session / unbounded |
|---|---|---|---|---|---|---|
| canon.K0 | 118 | 18 / 21 | 23 / 23 | 41 / 44 | 1.15 | 315.1 / 176 / 160.6 |
| canon.KR3 | 101 | 18 / 23 | 23 / 23 | 41 / 46 | 1.15 | 277.2 / 163.3 / 150.7 |
| canon.Kx1 | 106 | 16 / 23 | 23 / 24 | 39 / 47 | 1.19 | 295.7 / 178.8 / 165.8 |
| canon.Kx5 | 82 | 15 / 17 | 17 / 22 | 32 / 39 | 1.33 | 320.8 / 211.8 / 199.7 |
| dense.D0 | 145 | 21 / 22 | 23 / 23 | 44 / 45 | 1.08 | 316.1 / 149 / 130.5 |
| dense.DR4 | 102 | 18 / 19 | 22 / 23 | 40 / 42 | 1.17 | 294.7 / 168.8 / 154.8 |
| dense.DC | 88 | 15 / 20 | 19 / 23 | 34 / 43 | 1.29 | 282.3 / 176.2 / 164.4 |
| dense.DR3 | 110 | 14 / 14 | 23 / 23 | 37 / 37 | 1.23 | 363.7 / 209.5 / 192.4 |

Tokens per accepted edit by model (`cells["confirm(e+f)/haiku"]` and `.../sonnet`), cold task / 10-task session / unbounded:

| variant | Haiku | Sonnet |
|---|---|---|
| canon.K0 | 352.2 / 206.5 / 190.3 | 281.2 / 148.2 / 133.5 |
| canon.KR3 | 298.1 / 184.3 / 171.7 | 256.2 / 142.4 / 129.7 |
| canon.Kx1 | 341.9 / 222.5 / 209.2 | 251.4 / 136.9 / 124.2 |
| canon.Kx5 | 378.9 / 253.9 / 240 | 275.9 / 179.3 / 168.5 |
| dense.D0 | 339.7 / 168.9 / 149.9 | 293.4 / 130 / 111.9 |
| dense.DR4 | 359.3 / 220.1 / 204.7 | 241.3 / 126.3 / 113.5 |
| dense.DC | 323.8 / 209.7 / 197.1 | 246.2 / 147 / 136 |
| dense.DR3 | 552.1 / 348.4 / 325.8 | 249 / 125 / 111.2 |

Per set and model, one shot / repaired counts (d: 13 tasks, e: 11, f: 13), from the reports: `canon.K0` d 12/13 and 13/13, e 10/10 and 11/11, f 8/11 and 12/12 (each pair is one shot / accepted after the repair, Haiku then Sonnet within a set); `canon.KR3` d 12/13 and 13/13, e 8/10 and 11/11, f 10/13 and 12/12. KR3 is one-shot lower on e for Haiku (8 against 10) and higher on f (10 against 8): the pooled equality is two offsetting sets, not a uniform tie.

### Verdicts against the control (`verdictsAgainstControl`, rate rule: interval overlap; cost rule: 1 per cent band)

| variant | scope | one shot | after repair | tokens per accepted edit: cold task | 10-task session | unbounded |
|---|---|---|---|---|---|---|
| canon.KR3 | Haiku | 18/24 against 18/24: tie | 23/24 against 21/24: tie | 298.1 against 352.2: win | 184.3 against 206.5: win | 171.7 against 190.3: win |
| canon.KR3 | Sonnet | 23/24 against 23/24: tie | 23/24 against 23/24: tie | 256.2 against 281.2: win | 142.4 against 148.2: win | 129.7 against 133.5: win |
| canon.KR3 | pooled | 41/48 against 41/48: tie | 46/48 against 44/48: tie | 277.2 against 315.1: win | 163.3 against 176: win | 150.7 against 160.6: win |
| canon.Kx1 | pooled | 39/48 against 41/48: tie | 47/48 against 44/48: tie | 295.7 against 315.1: win | 178.8 against 176: loss | 165.8 against 160.6: loss |
| canon.Kx5 | pooled | 32/48 against 41/48: tie | 39/48 against 44/48: tie | 320.8 against 315.1: loss | 211.8 against 176: loss | 199.7 against 160.6: loss |
| dense.DR4 | Haiku | 18/24 against 21/24: tie | 19/24 against 22/24: tie | 359.3 against 339.7: loss | 220.1 against 168.9: loss | 204.7 against 149.9: loss |
| dense.DR4 | Sonnet | 22/24 against 23/24: tie | 23/24 against 23/24: tie | 241.3 against 293.4: win | 126.3 against 130: win | 113.5 against 111.9: loss |
| dense.DR4 | pooled | 40/48 against 44/48: tie | 42/48 against 45/48: tie | 294.7 against 316.1: win | 168.8 against 149: loss | 154.8 against 130.5: loss |
| dense.DC | pooled | 34/48 against 44/48: tie | 43/48 against 45/48: tie | 282.3 against 316.1: win | 176.2 against 149: loss | 164.4 against 130.5: loss |
| dense.DR3 | Haiku | 14/24 against 21/24: tie | 14/24 against 22/24: tie | 552.1 against 339.7: loss | 348.4 against 168.9: loss | 325.8 against 149.9: loss |
| dense.DR3 | Sonnet | 23/24 against 23/24: tie | 23/24 against 23/24: tie | 249 against 293.4: win | 125 against 130: win | 111.2 against 111.9: tie |
| dense.DR3 | pooled | 37/48 against 44/48: tie | 37/48 against 45/48: tie | 363.7 against 316.1: loss | 209.5 against 149: loss | 192.4 against 130.5: loss |

### Verdict per axis

| axis | wins | ties | losses |
|---|---|---|---|
| one-shot acceptance (n = 24 per model) | none | every candidate on both models (the widest point gaps: `Kx5` 17 of 24 against 23 for Sonnet, `DR3` 14 against 21 for Haiku, `DC` 15 against 21 for Haiku; none separates on the interval rule) | none established; point estimates are lower for `Kx5`, `DC`, `DR3`, `DR4` and `Kx1` |
| acceptance after one repair | none | every candidate on both models | none established; lower point estimates for `Kx5` (39 of 48 against 44), `DR3` (37 against 45), `DR4` (42 against 45) |
| tokens per accepted edit, cold task | `KR3`, `Kx1` and `DC` on both models and pooled; `DR4` on Sonnet and pooled; `Kx5` and `DR3` on Sonnet | none | `Kx5` on Haiku and pooled; `DR4` on Haiku; `DR3` on Haiku and pooled |
| tokens per accepted edit, 10-task session | `KR3` on both models and pooled; `Kx1`, `DR4` and `DR3` on Sonnet | none | `Kx1` on Haiku and pooled; `Kx5`, `DC` on both models and pooled; `DR4` and `DR3` on Haiku and pooled |
| tokens per accepted edit, unbounded | `KR3` on both models and pooled; `Kx1` on Sonnet | `DR3` on Sonnet | every other candidate on Haiku and pooled; `Kx5`, `DC`, `DR4` on Sonnet (a shorter primer that needs more repairs and more calls loses the amortized cost) |
| calls per task (`cells.*.callsPerTask`, pooled; not a verdict row of the file) | none | `KR3` (1.15 against 1.15) | `Kx1` 1.19, `Kx5` 1.33, `DR4` 1.17, `DC` 1.29, `DR3` 1.23 against 1.15 (canonical) and 1.08 (dense) |

Only `canon.KR3` has no loss on any axis, and it is not behind on a single scope. For dense, the shorter the primer, the larger the first-call win and the larger the loss once repairs are counted: the cold-task win of `DR4` and `DC` (-21 and -34 tokens against `dense.D0`, pooled) is more than gone at 10 tasks (+20 and +27) and unbounded (+24 and +34). The dense primer's clauses all pay: the fold sentence and the notation clauses are what Haiku uses on e and f (`DR3` dropped three of them and Haiku fell to 14 of 24 one shot against 21).

## 4. The decision

The rule given for this work: edit the primer text only when a candidate clearly wins on the confirmation set on both model sizes with acceptance not lower. `canon.KR3` does: on Haiku and on Sonnet its tokens per accepted edit are lower on all three horizons (cold task by 54.1 and 25 tokens, 10-task session by 22.2 and 5.8, unbounded by 18.6 and 3.8), and its acceptance counts are equal or higher on both sizes (18 and 23 of 24 one shot, 23 and 23 after the repair, against 18 and 23, 21 and 23). The cold-task part of that win is mostly the 17 tokens the primer no longer has times the 1.25 first-call weight (21 tokens); the later horizons are small for Sonnet (3.8 to 5.8 tokens, 3 to 4 per cent) and partly output length, so only the cold-task win is large. Among the canonical rewrites it is also the only one not behind the control on the selection set (25 of 26 against 25 one shot and 26 of 26 after the repair, both equal). No dense candidate meets the rule, so `MODEL_GUIDE.dense.txt` is not changed.

What changed in the repository: `experiments/primers/MODEL_GUIDE.rules-merged.txt` (118 to 101 o200k tokens; the text it replaces is kept as `experiments/primers/ablation/canon.K0.txt`). Nothing pins that file's text or token count except a test that it carries no explain or error-code text (`test/diagnostics.test.ts`, still true); `bun run tokens` measures `MODEL_GUIDE.min.txt` (the shipped skill primer), which is not touched, and `tools/sync-skill.ts` copies that file, not this one. **Earlier numbers used the old text and are not rescored**: every `results/ai-edit-experiment.*rules-merged*` cell, the `canon` cells of `results/spec-lines.json` and the "canonical 118" in the earlier history files were collected with the 118-token text (their reports record `languagePrimer`); the spec-line primers `experiments/primers/MODEL_GUIDE.rules-merged-spec.txt` still carry it plus one sentence. The experiment harness reads whichever guide it is given (`A0_EXPERIMENT_GUIDE`), so a rerun of an old cell names the old text.

## 5. Failure classification (`failureTaxonomy`)

Every non-accepted attempt (a first reply or a repair) of a variant over d, e and f and both models, by the first rule that matches the checker's message (`tools/primer-ablation-summary.ts`, `CATEGORIES`). Counts are attempts, not trials.

| variant | bool result without `-> bool` in the head | record result type not written | dense operand count or a value used twice | callee used before it is defined | operation name invented | nested operand | at or get on the wrong aggregate | replacement block shape | wrong result | other |
|---|---|---|---|---|---|---|---|---|---|---|
| canon.K0 | 2 | 1 | 0 | 0 | 0 | 1 | 0 | 5 | 3 | 0 |
| canon.KR3 | 2 | 2 | 0 | 1 | 0 | 0 | 0 | 2 | 3 | 0 |
| canon.Kx1 | 2 | 2 | 0 | 0 | 1 | 2 | 0 | 2 | 2 | 0 |
| canon.Kx5 | 2 | 1 | 0 | 0 | 11 | 1 | 1 | 8 | 1 | 1 |
| canon.KC | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 3 | 0 | 0 |
| dense.D0 | 0 | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 4 | 1 |
| dense.DR4 | 1 | 4 | 2 | 1 | 2 | 0 | 1 | 0 | 4 | 1 |
| dense.DC | 1 | 3 | 3 | 0 | 6 | 0 | 1 | 1 | 6 | 0 |
| dense.DR3 | 0 | 2 | 4 | 0 | 10 | 0 | 1 | 2 | 1 | 4 |

- **Protocol ambiguity, result type in the head** (a bool result, a record result: `d-isdiv-bool`, `f-addover-bool`, `f-divrem-pair`). Neither primer says that a result that is not u32 goes in the head (canonical: only `ge(->bool)` as an operation result; dense: `-> bool` inside one example), and no primer text writes a record type; models wrote `{u32 u32}`, `(u32 u32)`, `u32x2`, `rec`. It is the one failure every variant shares, including both controls, and the repair always fixes it. General fix, proposed and not applied: a whole-function reply without a head result takes the result type from its last statement (the checker already knows it), which costs no primer text. The text alternative was tested (section 6).
- **Protocol ambiguity, dense operand count** (`mul` takes three operands, a fold seed is a separate operand, a repeated value needs a name): the same finding as the 2026-10-02 spec-line record (`results/spec-lines.json`, `failureTaxonomy`); proposal unchanged (say it in the dense primer, or name a repeated pure sub-expression in the parser).
- **Protocol ambiguity, callee defined after its caller** (`d-rename-twice`, `e-popcount-fold`): neither primer says a callee is defined above its caller. Proposal: the edit session orders the functions of one reply by dependency.
- **Model errors, recorded:** wrong results (`e-sum-range` accounts for most: indices 1 to 3 through a fold over 0 to 2), `at` for arrays, nested operands after the primer says not to, a block ended before `ret`, and the operation names a model invents when the operation list is gone (`Kx5`: 11 attempts, `DR3`: 10, `DC`: 6, against none for the controls): that last class is the cost of the dropped list, not an ambiguity of the language.

## 6. Does teaching the head fix the ambiguity? (`canon.KT`, `dense.DT`)

A test of the first proposal in section 5, run on d, e and f (not a candidate and not selected on any set): the current primer plus one clause ("a result that is not u32 goes in the head: `fn f u32 u32 -> bool`, records `(u32,u32)`"; the dense text gets `-> (u32,u32)` added to its types sentence). 149 and 154 o200k tokens (31 and 9 more than the controls). `results/primer-ablation.json`, `failureTaxonomy` and `cells`.

- The failure class is gone: the head failures (bool or record result) drop from 3 attempts (`canon.K0`) to 0 and from 4 (`dense.D0`) to 0 over d, e and f.
- Acceptance did not move at this n: confirmation pooled `canon.KT` 40 one shot and 47 repaired of 48 against 41 and 44, `dense.DT` 41 and 45 against 44 and 45; on d, 24 of 26 one shot for both against 25 and 24.
- The text costs more than it saves on the cold task (`canon.KT` 327.5 and `dense.DT` 346.3 against 315.1 and 316.1 tokens per accepted edit, losses) and wins or loses at longer sessions by form (`canon.KT` 163.2 and 144.9 against 176 and 160.6, wins; `dense.DT` loses all three). So the head clause removes its failure and does not pay for itself in tokens; the checker-side fix (no primer text) is the open proposal and is untested here.

## 7. Loss ledger

`bun run loss-ledger -- --update --reason ...` recorded 64 new rows, source `primer-ablation` (`results/loss-ledger.json`; axes `primer-accepted-one-shot` 41, `primer-accepted-repaired` 11 and `primer-tokens-per-accepted` 12): every variant cell of a scope that is behind its control on a rate (by more than one trial) or on the cost of an accepted edit for one cold task (by more than the tie band), on both selection and confirmation scopes. `canon.KR3` has no row. The ledger total is 550 (it was 486); the loss being worked (the `ai-tokens-*` rows) is unchanged, because those rows come from cells that used the shipped `MODEL_GUIDE.min.txt`, and no dense primer won.

## 8. Limits

- n is 11 to 13 tasks per cell and model; Wilson intervals overlap for every pair, so wins and losses on a rate are not established, and the point estimates that fall for the shorter dense primers are a prediction, not a result. The token verdicts use a 1 per cent band and include noise from output length and from repairs.
- Sonnet answers 22 to 24 of 24 on e and f with almost every primer (`Kx5` 17 one shot and `DC` 19 are the exceptions), so the discriminating cells are Haiku's.
- The three confirmed dense candidates are the shortest eligible ones, not a sweep of the combination space; a primer that drops only the arity sentence (`Dx2`, 113, 25 of 26 one shot on d) or only the fold sentence (`Dx4`, 122) was eligible and was not confirmed.
- The selection on d chose the three shortest eligible variants of each form; the winner among them (`KR3`) is not the shortest. Selecting on d and confirming on e and f keeps the confirmation honest, and it still found that two of the three shortest per form lose.
- Task-set d: the seal file `tools/ai-edit-tasks-d.sha256` does not match the SHA-256 of `tools/ai-edit-tasks-d.ts` as committed (the e and f seals match); it was already so in the commit that added both and is not changed here. The hash every report records (`taskSetSha256`) is the same for every cell of a set.
- The subject groups were run at the budget of this session; the group-file method gives a subject 11 to 13 independent tasks in one context, as in earlier collections of this repository, and is not the one-subagent-per-task method of the spec-line record.
