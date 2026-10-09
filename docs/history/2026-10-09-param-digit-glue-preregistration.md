# Pre-registration: parameter-digit glue and comma before a digit (written before either is implemented)

Date: 2026-10-09. Committed before the `src/dense.ts` changes below and before `tools/dense-combined.ts` is run with them.

## Question

On top of the combined compact style (kernel sum 162 without `tab` and rotate, `results/dense-combined.json`), does the kernel sum reach the 2x line (161 or less) with the rules below, still without `tab` and without a rotate shorthand? claim-ok: 162 and 161 are recorded in results/dense-combined.json.

## Rules (fixed now)

9. **param-digit glue** (`paramDigit`): a parameter reference, one uppercase letter `A`-`Z`, followed by a space and a decimal digit is written without the space: `B 0` is `B0`. Never inside a string literal. The compact reader splits a word matching `^[A-Z][0-9]` into the parameter and the literal that follows (`B0x10` is `B` and `0x10`); hex `0x` literals and the negative wrap `-N` keep working. A user id of the form uppercase letter plus digits is printed escaped (`$A1`) whenever a compact spelling is on, as for `X.K` (rule 3), so the reader can always split.
10. **comma before a digit** (`commaDigit`): an operator symbol followed by a space and a digit, where the space must stay (the `-` before a digit, which would read as a negative literal), is written with a comma: `-,5`. Commas are blanks to the reader. Outside `( )`, where a comma marks a record. Measured only if it composes with rule 9 (both on round-trip).

Rule 9 is the stated scratch estimate: 159 for the kernel sum (an estimate from rewriting printed texts by hand, not round-tripped, not in `results/`; it backs nothing). claim-ok: an estimate, labelled as such.

## Measure

`tools/dense-combined.ts` with the new flags writes `results/dense-combined.json`: each rule alone over the start style and over the previous combination, both together, the held-out total and the round-trip failures. The headline is the kernel sum of the real printer output read back by the real reader, `tab` off, no rotate.

## Gates (a rule is kept only if all hold)

1. **Held-out**: it saves tokens on the 54 held-out programs alone.
2. **Lossless**: 0 round-trip failures on every kernel and held-out program with every kept rule on.

The kernel sum is reported whatever it is; above 161 the answer is no.

## Outcome (measured after the change; `results/dense-combined.json`, `digitRules` and `alone`)

**Yes.** With rules 1 to 10 on, `tab` off and no rotate, the kernel sum is **158** (2x is 161); round-trip failures 0 on all 10 kernels and 54 held-out programs, as written and normalized. The held-out total falls from 486694 (rules 1 to 8) to 480210.

| over rules 1 to 8 | kernels | held-out | failures |
| --- | --- | --- | --- |
| none (rules 1 to 8) | 162 | 486694 | 0 |
| + rule 9 | 159 | 480262 | 0 |
| + rule 10 | 161 | 486642 | 0 |
| + rules 9 and 10 | 158 | 480210 | 0 |

Alone over the start style: rule 9 saves 3 kernel tokens and 8088 held-out; rule 10 saves 0 and 12. Both pass both gates and are kept. Rule 9 matched the scratch estimate (159). Side column with `tab`: 152 (not the headline).

Finding: canonical A0 already rejects an uppercase node id (`invalid node identifier 'A1'`), so the guard is that rejection plus the compact reader always splitting `A1`; the printer escapes such an id (`$A1`) whenever a compact spelling is on. `compiler/dense.a0` reads neither rule; that is the follow-up.
