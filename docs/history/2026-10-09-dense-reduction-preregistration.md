# Pre-registration: general dense-text reductions (written before any change or re-measurement)

Date: 2026-10-09. Committed before `src/dense.ts` changes and before `tools/lang-axes.ts --tokens-only` or `tools/dense-tokens.ts` is re-run.

## Starting point

A read-only analysis (text rewrites of the dense kernel texts and of the 81 migrated `dense/` files, counted with o200k_base; not recorded in `results/`, so it backs no claim) ranked ten surface rules. It found no combination of general rules that brings the kernel sum near the 2x line (161 against the best single language, 323; 150 against per-kernel bests, 300; `results/lang-axes.json`). The rest of the kernel tokens are operations, names and number literals, already one token each where the tokenizer allows. This note does not expect, and does not claim, progress toward that line.

## Chosen candidate

Only rules with a corpus-wide saving and an argued low risk to AI edit accuracy qualify:

- **Rule 7: no blank line between functions.** Each function already starts with its `fn` header line, which the reader uses as the boundary (blank lines are ignored by `parseDense`), so the blank line carries no information. Risk to edit accuracy argued low: function starts stay on their own line, nothing is renamed and no line gets longer.

Not chosen:

- Rule 3 (drop the final newline): `tools/dense-tokens.ts` and `tools/lang-axes.ts` already count `trimEnd()` text, so it changes nothing measured.
- Rule 1 (one line per function body, `;`-joined): medium risk; long lines make edits harder to anchor. It needs an AI edit-accuracy measurement first, which is out of scope here.
- Rules 2, 4, 5, 6 (medium or high risk), 8, 9, 10 (cost tokens).

## Measure

o200k_base via `bun tools/lang-axes.ts --tokens-only` (per-kernel dense tokens, sum against 323 and 300) and `bun tools/dense-tokens.ts` (kernels and corpus sample, canonical, dense exact, dense). Before = this commit; after = the change commit, same tools, same inputs.

## Win rule

Kept only if all hold: (1) canonical -> dense -> canonical stays lossless on every program the existing dense round-trip tests and `tools/dense-tokens.ts` cover; (2) no kernel's dense count rises; (3) the dense corpus total falls (both read from `results/lang-axes.json` and `results/dense-tokens.json` as the tools write them). A tie on (3) is recorded as no gain and the change is reverted. Whatever is measured is recorded, including that the 2x line stays out of reach.

## Outcome (measured after the commit above)

Rule 7 was implemented (`fns.join('\n')` in `formatDense`) and both tools were re-run. Every number was identical before and after: kernel dense sum 193 (per kernel affine 7, rotl 13, clamp 17, mix 33, ident 3, noop 3, chain3 25, branchy 32, arrfill 31, loop64 29), ratio 0.598 of the best single language and 0.643 of per-kernel bests (`results/lang-axes.json`); kernel totals canonical 541, dense exact 277, dense 193, corpus sample totals canonical 83594, dense exact 70650, dense 43344 (`results/dense-tokens.json`, unchanged). The kernels are single functions, and in o200k_base a blank line `\n\n` is one token, the same as `\n`. Win condition (3) is a tie, so by the rule above the change was reverted; `src/dense.ts` is unchanged. No candidate from the analysis that qualifies on risk saves a measured token. The 2x line (161 or 150) remains out of reach of general surface rules; reaching it would need a change in what the text says, which this lane does not attempt.
