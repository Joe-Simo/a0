# Pre-registration: selecting a short edit primer with the language reference added back (written before any candidate reply was collected)

Date: 2026-10-06. The 101-token edit primer `canon.KR3` costs 50 to 62 per cent less than the shipped guide at the cold task in four collections, and loses one-shot acceptance to it on wrong-logic answers (`results/set-lmn.json`, `results/set-opq.json`); it carries
an edit rule and an op list but no argument orders, wrap rules or zero-divisor rules. This note fixes, in advance, a selection among three longer candidates built only from lines of the shipped guide (`MODEL_GUIDE.min.txt`), and the confirmation that follows.

## Candidates (`experiments/primers/ablation/`, o200k tokens, counted by `js-tiktoken`)

- `canon.KR3a` (204): the edit line of KR3, then `Params p0 p1... Args: earlier ID, pN, u32 literal, true, false.` and one op list with the guide's semantics (and/or/xor on u32 or bool, shifts by count&31, div and rem by zero, comparisons unsigned, `select c x y`, `get a i (i mod N)`, `set a i v`, `at r k`, `put r k v`, `fold F n s a...: s=F(s,i,a...) for i<n`).
- `canon.KR3b` (221): `KR3a` plus the line `Types u32 bool, arrays u32x4, records (u32,bool).`
- `canon.KR3c` (313): the guide without its `io:` line, its `EDIT:` line and its example, followed by KR3's edit line.
Baselines: `canon.KR3` (101) and the shipped guide `S` (`MODEL_GUIDE.min.txt`, 443 with the protocol paragraph).

## Selection

On sets K, L and M (already used for the earlier comparisons, never used to choose a primer; their seals verify), pooled to n = 48 per model and variant: fresh Haiku and Sonnet subagents, one group-file subagent per candidate, model and set (18 first-reply cells), then one repair round per cell by a fresh subagent, A0 only,
canonical form, structured protocol, `A0_EXPERIMENT_PRIMER=rules-merged` for every candidate, the edit protocol as it is now in the repository (the delete-and-add fix included). The baselines `S` and `KR3` use their already collected replies on K, L and M, re-scored with the current protocol by replay (the same replies, the parser as it is now;
this is stated, not a new collection). A candidate is eligible if, for Haiku and Sonnet separately and pooled over K, L and M, (1) its one-shot count is not lower than `S`'s and (2) its tokens per accepted edit at the cold task is lower than `S`'s (raw numbers). Of the eligible candidates the one with the fewest system tokens is selected; ties go to the higher one-shot count.
If none is eligible, none is selected and nothing goes on. Files are scored only after every subagent has reported.

## Confirmation (only for a selected candidate)

On three further sealed sets R, S and T (written, sealed and checked before any subject runs; authored like the earlier sets by Opus subagents that saw only the neutral brief), pooled to n = 48: the selected candidate against `S`, same procedure and accounting, and `KR3` reported alongside. The rule is the one of the earlier notes: the selected candidate may replace the shipped
guide as the shipped edit text only if, for both models separately and pooled, its one-shot count is not lower than `S`'s and its cold tokens per accepted edit is lower than `S`'s. A second pre-registration for that confirmation is committed before any R, S or T reply is collected. Incidents, refusals, unanswered requests and a cell dominated by one misreading are handled as in the earlier notes.

## Selection result (collected after the rule above was committed; `results/selection.json`, `tools/selection-summary.ts`)

All 18 first-reply cells (3 candidates, 2 models, sets K, L, M; 16 requests each) and 14 repair cells were collected by fresh subagents and scored only after every subagent had reported; the harness self-check passed everywhere. One departure, stated: 17 of the 18 first-reply subagents started together and the 18th (Sonnet, set M, `KR3c`) started a few minutes later because the session's limit
of 20 concurrent subagents was reached; it was collected in the same session with the same instructions. Pooled over K, L and M (n = 48 per cell), tokens per accepted edit at the cold task (primary), one shot and accepted after the repair:

| cell | system o200k | one shot | accepted | cold | 10-task | unbounded |
|---|---|---|---|---|---|---|
| Haiku S (shipped guide, replayed) | 443 | 29 | 38 | 961.5 | 357.2 | 290.0 |
| Haiku KR3 (replayed) | 101 | 22 | 38 | 418.5 | 280.7 | 265.4 |
| Haiku KR3a | 204 | 30 | 41 | 531.5 | 273.6 | 244.9 |
| Haiku KR3b | 221 | 30 | 42 | 573.1 | 300.3 | 270.0 |
| Haiku KR3c | 313 | 36 | 44 | 646.0 | 277.3 | 236.3 |
| Sonnet S (replayed) | 443 | 46 | 48 | 685.7 | 207.3 | 154.1 |
| Sonnet KR3 (replayed) | 101 | 45 | 48 | 265.0 | 155.9 | 143.8 |
| Sonnet KR3a | 204 | 45 | 48 | 399.1 | 178.8 | 154.3 |
| Sonnet KR3b | 221 | 47 | 48 | 411.2 | 172.5 | 146.0 |
| Sonnet KR3c | 313 | 46 | 48 | 527.6 | 189.5 | 152.0 |

Eligibility, by the rule written above: `KR3a` is not eligible (Sonnet one shot 45 against S's 46); `KR3b` and `KR3c` are eligible on both models; of the eligible the one with fewest system tokens is `KR3b` (221). **`KR3b` is selected and goes to the confirmation; nothing is changed in the shipped text by this selection.**
Stated plainly: the baselines are replays of earlier collections (not new collections), the candidates were chosen and collected on sets already used in other comparisons (not used to choose a primer), and one-shot counts differ by one or two tasks between candidates, which at n = 48 is noise: the selection is a filter, not a finding.
