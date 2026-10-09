# Pre-registration: six dense-text rules, with a held-out set (written before any change or measurement)

Date: 2026-10-09. Committed before `src/dense.ts` changes and before any tool below is run on the changed writer.

## Starting point

The rules come from a scratch sweep that rewrote dense texts by hand and counted o200k_base tokens. Its numbers are estimates: nothing was round-tripped and nothing is recorded in `results/`, so they back no claim and are not repeated here. The measured start is the kernel dense sum in `results/lang-axes.json` (193), against the best single language (323) and per-kernel bests (300). The 2x line against the best single language is a kernel sum of 161 or less.

## Sets (the anti-fitting split)

- **(a) kernels**: the 10 kernels `tools/lang-axes.ts` counts (`TOKEN_KERNELS` in `tools/dense-tokens.ts`).
- **(b) held-out**: every in-tree `.a0` program the dense round-trip test reads (every `.a0` outside dot directories, `node_modules`, `dist`, `results` and `corpus/reject`, whose files the checker must reject and which have no dense form), plus the generated corpus (`tools/corpus.ts`). The kernels are not `.a0` files, so (a) and (b) do not overlap.

## Rules (fixed now; not tuned after any number is seen)

All are printer spellings the reader inverts; the reader accepts each always, the printer writes each only when its style flag is on (the default `formatDense` output, which `compiler/dense.a0` reads, is unchanged; the measurement tools turn the kept rules on).

1. **tab**: `fold {S;...;set A B E} N [0;N] REST` is written `tab N {S;...;E} REST` when `N` is a number literal, the initial array is `N` zeros, and the body does not mention `A` except as the `set` target. The zero fill is part of the rule (a different fill has no `tab` spelling, so the text stays lossless).
2. **min/max**: `select lt X Y X Y` is written `min X Y` and `select lt X Y Y X` is written `max X Y`, when the comparison is used once and `X` and `Y` are operands (parameter, number, named value), not nested operations. The `le`, `gt` and `ge` forms keep their spelling: one word can stand for only one canonical form, or the text is not lossless.
3. **hex**: a u32 literal is written in hexadecimal when that is strictly fewer o200k tokens. The source code must not depend on a tokenizer, so the rule is the result of a tokenizer sweep done before this note (every value written as one repeated hex digit of 2 to 8 digits, every 2^k and 2^k-1, and 200000 other values): only `0xffffff`, `0xffffffff` and `0xaaaaaaaa` are shorter. The printer writes those three in hex. claim-ok: the sweep chose the rule before measurement; its effect is measured in results/dense-six-rules.json.
4. **no `call`**: the printer already writes a call to a declared function without `call`; it keeps `call` only when the callee's name is an operation or a structure word, where leaving it out would change the meaning. Expected: no change; the tool counts the remaining `call` words to confirm.
5. **trailing parameters**: the operands of a `fold` that are exactly all of the enclosing function's parameters in order (`A B ...`), at the end of the fold and at the end of the statement, are left out; the reader fills operands missing at the end of a statement with `A`, `B`, ... Not inside an inline body.
6. **one line per function**: `fn ` is dropped and a function's lines are joined with `;` on one line (`name [types] stmt;stmt`). `use` and `profile` lines keep their markers; a text with comments keeps the line-per-statement form. The reader takes a text with no `fn` line as this form.

## Measure

o200k_base, `bun tools/lang-axes.ts --tokens-only` (kernel sum against 323 and 300) and `bun tools/dense-tokens.ts`, plus a new `tools/dense-six-rules.ts` that, for (a) and (b) separately, counts the dense text with no rule, each rule alone, and all kept rules, and checks canonical -> dense -> canonical on every program with all rules on. Results go to `results/dense-six-rules.json`.

## Keep rule

A rule is kept only if (1) the round trip stays lossless on every program in (a) and (b), and (2) it saves tokens on the held-out set (b) on its own, or it is neutral on (b) and this note argues it is a general construct (rule 1, the tabulate pattern; rule 5, a default for trailing operands). A rule that costs tokens on (b) is dropped whatever it saves on (a). Savings on (a) and (b) are recorded for every rule, kept or not, and the kernel sum is reported whatever it is.

## Risk

Rules 4 to 6 are medium risk to AI edit accuracy (fewer anchors: long lines, operands not written). Before any public claim from them, an AI edit-accuracy run must show no loss; until then they are measured but not claimed. The site is not edited. claim-ok: a condition for a future claim, not a measured value.

## Outcome (measured after the change; `results/dense-six-rules.json`)

Canonical -> dense -> canonical is lossless and a fixed point with every rule on, for all 10 kernels and all 54 held-out programs (`roundTripFailures` is empty). Tokens saved by each rule alone, (a) kernels / (b) held-out, from `results/dense-six-rules.json`:

| rule | (a) | (b) | kept |
| --- | --- | --- | --- |
| 1 tab | 8 | 0 | yes (neutral on (b), argued general above) |
| 2 min/max | 6 | 66 | yes |
| 3 hex | 0 | 828 | yes |
| 4 no `call` | 0 | 0 | no: already the printer's spelling |
| 5 trailing parameters | 2 | 86 | yes |
| 6 one line per function | 14 | 7467 | yes |

With the kept rules the kernel sum is 163 (from 193), 0.505 of the best single language (323) and 0.543 of per-kernel bests (300); the 2x line (161) is missed by 2 tokens. The held-out total falls from 536374 to 527931 (`results/dense-six-rules.json`); `results/dense-tokens.json` records the compact column (kernels 163, corpus sample 41929 against 43344 dense), and `results/lang-axes.json` records it beside the dense row as `dense.compact`, outside the rank and the ledger.

Deviations: rule 2 covers only the `lt` forms (lossless needs one canonical form per word). The one-line form and the filled fold operands are read only when the caller says the text is compact (`parseDense(text, { compact: true })`): read always, a statement written outside a function and a fold missing operands would lose their diagnostics, which the edit protocol relies on. Rule 1 saves nothing on (b): no held-out program has the tabulate pattern, so its kernel saving rests on the argument, not on held-out evidence. Rules 5 and 6 are not claimed until an AI edit-accuracy run shows no loss. `compiler/dense.a0` does not read any compact spelling (follow-up).
