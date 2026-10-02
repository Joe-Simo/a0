# Session 2026-10-02: what does an agent pay and read on the shipped paths, and can the shipped text shrink? (STATUS next action 2)

The primer ablation (`docs/history/2026-10-02-primer-ablation.md`) picked a 101-token edit-only text as the sole system text. No shipped path uses that text: the product ships the whole-language guide (`MODEL_GUIDE.min.txt`, copied to the skill's `references/primer.txt`) and the MCP server's tool list. This record counts what those two paths really put in front of a model, then measures whether trimmed versions of the shipped texts keep acceptance. Every number comes from `results/shipped-accounting.json` (`bun run shipped-accounting`, `tools/shipped-accounting.ts`) or `results/shipped.json` (`bun run shipped-summary`, `tools/shipped-summary.ts`), with the per-cell reports in `results/shipped/<set>.<model>.<variant>.json` and their `.replies.json`.

**Answer.** Nothing is shipped. The two shrinking candidates that cleared the selection set d (a trimmed EDIT section of the guide, `G1`, 373 tokens against 395; a shorter wording of the tool descriptions, `T2`, 983 against 1082) did not win on both model sizes on the different confirmation sets e and f: `G1` is lower on Sonnet (21 of 24 one shot against 24 of 24) and its cost per accepted edit is a loss there; `T2` is lower on Haiku (12 of 24 against 16) and loses on cost there and pooled. `MODEL_GUIDE.min.txt`, the skill copies, the site, `src/mcp.ts` and `results/tokens.json` are unchanged. The accounting itself is the finding: on the MCP-only path the model reads 1082 tokens of tool list and nothing about the language, and that text alone teaches less than the 395-token guide it does not include (section 3). Rates are counts of 11 to 13 tasks per cell and model; no claim of significance is made except where the interval rule says so, and then it is marked.

## 1. What an agent pays and reads (`results/shipped-accounting.json`)

o200k tokens (js-tiktoken, the counting of `tools/dense-tokens.ts`; not the tokenizer of Claude). The tool list is the JSON a client sends (name, description, input schema), read from the running server over the SDK client; a client that renders tools differently sends a different count. The 1144 figure that prompted this record is not reproduced by any serialization tried: the compact JSON is 1082 (`mcp.toolListO200k`), the indented JSON 1543, the descriptions alone 291; the rest is the names and input schemas (`$schema` on every tool, the `file` parameter text repeated on all seven tools).

| path | what is read | per call (every call of the session) | cold one-task session (1.25x the first call) | per task of a 10-task session (0.17x) | later call (0.05x) |
|---|---|---|---|---|---|
| (a) MCP client only | tool list: 7 tools; server instructions 0, no resources, no prompts, so the guide is not surfaced | 1082 | 1352.5 | 183.9 | 54.1 |
| (b) skill, no server | `SKILL.md` body 275 (its front matter, 148, is listed in every session) + `references/primer.txt` 395 | 670 | 837.5 | 113.9 | 33.5 |
| (a) + (b), the user has both | skill body, primer and tool list | 1752 | 2190 | 297.8 | 87.6 |
| (a) + (b) after a rejection | plus `references/edit-protocol.md` 540 | 2292 | 2865 | 389.6 | 114.6 |

Per tool (`mcp.perTool`): `a0_open` 221, `a0_program` 138, `a0_apply` 205, `a0_check` 82, `a0_run` 197, `a0_emit` 152, `a0_save` 99; the descriptions are 36, 31, 117, 13, 30, 40 and 23 of those. The slash commands of the plugin are read only when run (135, 136 and 101). The long guide (`MODEL_GUIDE.txt`, 669) and the dense primer (145) are not loaded by either path. Findings: the guide is not surfaced to an MCP-only client at all; a user with both reads the edit-reply rules twice (the guide's EDIT section and the `a0_open` and `a0_apply` descriptions); the tool list is the largest single text on both paths where it is present, and most of it is schema, not prose.

## 2. Method (CONTRIBUTING.md measurement rules)

- **Variants** (`experiments/primers/shipped/`). `G0` the shipped guide (`guide.G0.txt`, byte-identical to `MODEL_GUIDE.min.txt`); `G1` its EDIT section moved toward the KR3 wording (the `Example:` line and one clause dropped, the language description untouched, handle remark and `@` insert kept; 373 tokens); `G2` the same with the handle remark also dropped (356). `T0` the tool list as served (1082); `T1` and `T2` shorter descriptions, parameter texts and `fix all` wording, every capability and every diagnostic field kept (`tools.T1.json`, `tools.T2.json` are the description overrides; `tools.T*.txt` the rendered lists; 1008 and 983). `B0` to `B2` the guide and the tool list together (1477, 1381, 1339). The system text of a cell is the variant text alone, so every token of the tool list is counted in the whole-task total. `src/mcp.ts` was not edited: the tool variants are overrides applied to the list the server serves (`tools/shipped-tool-text.ts`).
- **Sets and subjects.** Selection set d (13 tasks, all nine variants); confirmation sets e (11) and f (13), different sealed sets never used to choose, run for the variants that cleared the selection rule and for their controls, collected fresh (`G0`, `G1`, `T0`, `T2`). Set g and the sets a to c were not used; the `taskSetSha256` of each report is in `results/shipped.json`. Fresh Haiku and Sonnet Agent-tool subagents, one subagent per variant, model and set read one group file (the system text once, then every request of the set; `tools/ai-edit-subjects.ts group`) and wrote one reply per task, each answered as an independent conversation; every first reply the harness rejected went with the harness's exact rejection to a fresh subagent of the same model (one repair group per variant, model and set): one shot plus one repair round. Scoring is `tools/ai-edit-experiment.ts` in scripted-replies mode, a0, structured protocol, `A0_EXPERIMENT_PRIMER=rules-merged`.
- **Tool and combined cells.** The subagent is told that the system text is the tool list of the MCP server it is connected to, that the request shows the results of its `a0_open` and `a0_program` calls, and to answer with the `edit` string it would pass to `a0_apply`. That sentence is outside the system text and absent from the guide-only cells (there is no tool call to describe); it is the same for every tool cell.
- **Selection rule** (fixed before e and f): a variant is eligible when, pooled over both models on d, its one-shot count and its count after one repair are not lower than the control's of the same form. Verdicts: a rate is a win or a loss only when the Wilson 95 per cent intervals do not overlap; a cost is a win or a loss outside a 1 per cent band; the rest are ties. Cost per accepted edit counts the system text 1.25 times on the first call of a one-task session, 0.17 times per task in a 10-task session, 0.05 times on later calls and in an unbounded session, plus view, rejection messages and output.
- **Departure, stated.** Five Sonnet repair rounds on the confirmation sets (e: `G1`, `T0`, `T2`; f: `T0`, `T2`) were not collected: each of the five subagents, and a second launch of each, ended with an API error (the model's safeguard refusing the request) before writing a reply. The request was not reworded to get past it. Those trials keep their rejected first reply, so the Sonnet counts after repair of those four cells are lower bounds (the cost per accepted edit is inflated by the same missing acceptances), and the one-shot columns are the clean comparison. The `G0` Sonnet cells needed no repair (24 of 24 one shot). The repair message states the failing test and expected value as in every run of this harness, so a repair is better informed than a user's would be.

## 3. Selection on d (`results/shipped.json`, `cells["select(d)/..."]`)

Counts of 13 tasks per model; some cells have 12 trials with a score because a missing reply is a failure. System tokens, then Haiku and Sonnet one shot / repaired (of 13), pooled (of 26), pooled tokens per accepted edit: cold task / 10-task session / unbounded.

| variant | system o200k | Haiku | Sonnet | pooled | pooled tokens per accepted edit |
|---|---|---|---|---|---|
| G0 | 395 | 12 / 13 | 12 / 13 | 24 / 26 | 611.2 / 184.6 / 137.2 |
| G1 | 373 | 11 / 13 | 13 / 13 | 24 / 26 | 583.1 / 180.3 / 135.5 |
| G2 | 356 | 8 / 11 | 13 / 13 | 21 / 24 | 622.3 / 205.8 / 159.5 |
| T0 | 1082 | 11 / 12 | 12 / 12 | 23 / 24 | 1619.8 / 353.9 / 213.2 |
| T1 | 1008 | 9 / 11 | 13 / 13 | 22 / 24 | 1527.5 / 348.1 / 217.1 |
| T2 | 983 | 11 / 12 | 13 / 13 | 24 / 25 | 1425.9 / 321.8 / 199.1 |
| B0 | 1477 | 12 / 13 | 13 / 13 | 25 / 26 | 1961.2 / 366 / 188.8 |
| B1 | 1381 | 11 / 13 | 13 / 13 | 24 / 26 | 1845.8 / 354.4 / 188.6 |
| B2 | 1339 | 9 / 12 | 13 / 13 | 22 / 25 | 1879.4 / 375.4 / 208.3 |

Eligible (`selection`): `G1`, `T2`. Not eligible: `G2` (21 one shot, 24 repaired against 24 and 26: the model that dropped the handle remark and the example wrote bodies without `ret` or `end` and nested operands), `T1` (22 against 23 one shot), `B1` (24 against 25 one shot) and `B2` (22 and 25 against 25 and 26). No combined cell was eligible, so the combined text was not carried to e and f.

## 4. Confirmation on e and f (`cells["confirm(e+f)/..."]`, n = 24 per model, 48 pooled)

| variant | system o200k | Haiku one shot / repaired (of 24) | Sonnet one shot / repaired (of 24) | pooled (of 48) | calls per task | pooled tokens per accepted edit: cold task / 10-task / unbounded |
|---|---|---|---|---|---|---|
| G0 | 395 | 20 / 23 | 24 / 24 | 44 / 47 | 1.083 | 645.1 / 209.4 / 161 |
| G1 | 373 | 20 / 24 | 21 / 21 (repair not collected for 3 rejections) | 41 / 45 | 1.083 | 637.7 / 208 / 160.3 |
| T0 | 1082 | 16 / 17 | 17 / 17 (repair not collected for 7 rejections) | 33 / 34 | 1.167 | 2190.6 / 540.9 / 357.5 |
| T2 | 983 | 12 / 13 | 17 / 17 (repair not collected for 7 rejections) | 29 / 30 | 1.25 | 2290.6 / 592 / 403.3 |

Verdicts against the control of the same form (`verdictsAgainstControl`):

| candidate | scope | one shot | after repair | tokens per accepted edit: cold task | 10-task | unbounded |
|---|---|---|---|---|---|---|
| G1 | Haiku | 20/24 against 20/24: tie | 24/24 against 23/24: tie | 604.9 against 682.2: win | 202 against 237: win | 157.3 against 187.6: win |
| G1 | Sonnet | 21/24 against 24/24: tie | 21/24 against 24/24: tie (lower bound) | 675.3 against 609.5: loss | 214.9 against 182.9: loss | 163.7 against 135.5: loss |
| G1 | pooled | 41/48 against 44/48: tie | 45/48 against 47/48: tie | 637.7 against 645.1: win | 208 against 209.4: tie | 160.3 against 161: tie |
| T2 | Haiku | 12/24 against 16/24: tie | 13/24 against 17/24: tie | 2732.5 against 2253.2: loss | 772.6 against 603.4: loss | 554.8 against 420.1: loss |
| T2 | Sonnet | 17/24 against 17/24: tie | 17/24 against 17/24: tie (lower bound) | 1952.7 against 2128: win | 453.9 against 478.3: win | 287.4 against 295: win |
| T2 | pooled | 29/48 against 33/48: tie | 30/48 against 34/48: tie | 2290.6 against 2190.6: loss | 592 against 540.9: loss | 403.3 against 357.5: loss |

The Sonnet cost losses of `G1` are partly the missing repairs (three trials unrepaired lower the accepted count they are divided by); the one-shot count is the clean figure: 21 against 24, a tie by the interval rule and a lower point estimate, which the rule for this work does not accept ("acceptance not lower").

### Verdict per axis

| axis | wins | ties | losses |
|---|---|---|---|
| one-shot acceptance (n = 24 per model) | none | `G1` and `T2` on both models and pooled (point estimates: `G1` Haiku equal, Sonnet 3 lower; `T2` Haiku 4 lower, Sonnet equal) | none established |
| acceptance after one repair | none | `G1` and `T2` on both models and pooled | none established (Sonnet cells are lower bounds, see section 2) |
| tokens per accepted edit, cold task | `G1` on Haiku and pooled; `T2` on Sonnet | none | `G1` on Sonnet; `T2` on Haiku and pooled |
| tokens per accepted edit, 10-task session | `G1` on Haiku; `T2` on Sonnet | `G1` pooled | `G1` on Sonnet; `T2` on Haiku and pooled |
| tokens per accepted edit, unbounded | `G1` on Haiku; `T2` on Sonnet | `G1` pooled | `G1` on Sonnet; `T2` on Haiku and pooled |

Neither candidate wins on both model sizes with acceptance not lower, so neither is shipped. `G1` saves 22 tokens on every call and lowers the cost on Haiku, where it is a win on all three horizons, and costs more on Sonnet where three first replies it breaks (`e-guard-zero-div`, `e-sum-range`, `e-popcount-fold`) were not repaired; it may be worth a rerun with the five missing repair rounds collected, but not a change on this evidence. `T2` saves 99 tokens per call and loses on Haiku because the shorter wording of a text that is already the only language text the model has (section 5) is paid for in invented operations.

## 5. What the guide buys over the tool list (`crossFormVerdicts`)

Not a candidate comparison: the shipped guide `G0` against the shipped tool list `T0`, same sets and subjects. On e and f pooled, `G0` is a win over `T0` on one-shot acceptance (44 of 48 against 33; Wilson 95 per cent intervals 0.804 to 0.967 and 0.547 to 0.801, which just do not overlap), on acceptance after one repair (47 against 34, with the Sonnet repairs of `T0` missing) and on tokens per accepted edit at all three horizons (cold task 645.1 against 2190.6; 10-task 209.4 against 540.9; unbounded 161 against 357.5), on Sonnet alone on all five axes and on Haiku on the three cost axes (its rate difference is a tie). On d alone every rate is a tie and the cost verdicts are the same wins. The tool list costs 1082 tokens against the guide's 395 and teaches less: the failure counts of `T0` over all sets and both models are 9 invented operation names (none for `G0`), 8 wrong results (3), 5 replacement block shapes (1). The combined text `B0` (1477) was equal to `G0` on d (25 of 26 one shot against 24, 26 repaired against 26; ties) and was not run on e and f, so it is not confirmed (open item 1 in section 7).

## 6. Failure classification (`failureTaxonomy`)

Every non-accepted attempt (a first reply or a repair) of a variant over the sets run, by the first matching rule of `tools/primer-ablation-summary.ts`. Counts are attempts.

| variant | bool result without `-> bool` | operation name invented | nested operand | callee used before defined | replacement block shape | wrong result | other |
|---|---|---|---|---|---|---|---|
| G0 | 0 | 0 | 2 | 1 | 1 | 3 | 0 |
| G1 | 0 | 0 | 2 | 0 | 4 | 2 | 1 |
| G2 | 0 | 0 | 0 | 1 | 4 | 0 | 2 |
| T0 | 2 | 9 | 1 | 0 | 5 | 8 | 2 |
| T1 | 1 | 1 | 0 | 0 | 2 | 2 | 0 |
| T2 | 2 | 16 | 0 | 1 | 1 | 6 | 7 |
| B0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| B1 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| B2 | 1 | 0 | 0 | 1 | 2 | 0 | 1 |

- **Model errors, recorded:** with the tool list as the only text (`T0`, `T2`) the model invents operation names (for example `ifte` and `idx`) and writes `if ... else` blocks: the tool text describes the edit protocol, not the operations; this is the cost of not surfacing the guide, not a protocol ambiguity. `G1` and `G2` add `replacement block shape` failures (a body ended before `ret`, an `end` missing) that `G0` mostly avoids: the dropped `Example:` line was doing work.
- **Protocol ambiguities, unchanged from the primer ablation:** a bool or record result needs `-> bool` or a record type in the head (`T0` and `T2` hit it: the tool text does not say it either), and a callee must be defined above its caller.

## 7. What changed in the repository, and what is open

Added: `tools/shipped-accounting.ts`, `tools/shipped-tool-text.ts` (the served tool list as a model reads it, with description overrides), `tools/shipped-summary.ts`, the `group`, `ungroup`, `repair-group` and `ungroup-repair` commands of `tools/ai-edit-subjects.ts`, `experiments/primers/shipped/`, `results/shipped-accounting.json`, `results/shipped.json`, `results/shipped/`, `bun run shipped-accounting`, `bun run shipped-summary`, and a `shipped-text` source in `tools/loss-ledger.ts` (26 rows added, none worsened; the losses above are recorded, nothing is deleted). Not changed: `MODEL_GUIDE.min.txt`, `skills/a0/`, `plugin/skills/a0/`, `src/mcp.ts`, `tools/site-build.ts`, `results/tokens.json`, `COMPILER_VERSION`. Results collected before this record used the guide and tool text as they are today; nothing needs relabeling.

Open: (1) surfacing the guide to an MCP-only client (server instructions) would add 395 tokens to every call of that path and, on d, took the tool-list cell from 24 to 26 of 26 after repair; it needs e and f and the missing Sonnet repair rounds before it is a result. (2) The tool list is 1082 tokens of which the descriptions are 291; the other 791 are names, the input schemas (a `$schema` line on every tool, emitted by the SDK) and the parameter texts, the `file` text being repeated on all seven tools. `T1` and `T2` shortened the parameter texts; the schema structure was not touched. (3) Collect the five missing Sonnet repair rounds when the API accepts them and rerun `bun run shipped-summary`.
