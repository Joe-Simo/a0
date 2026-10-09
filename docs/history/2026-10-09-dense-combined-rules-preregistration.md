# Pre-registration: eight more compact dense rules, combined (written before any of them is implemented)

Date: 2026-10-09. Committed before the `src/dense.ts` changes below and before `tools/dense-combined.ts` is run.

## Question

Does the compact dense style reach 2x the best single language on the 10 kernels (Forth, 323; 2x is a kernel sum of 161 or less) **without** the `tab` spelling and **without** a rotate shorthand? Both fail the held-out gate (`tab` saves 0 on the held-out set, `results/dense-six-rules.json`; no held-out program has the rotate pattern), so neither may carry the headline. claim-ok: the line and the start are recorded in results/dense-six-rules.json.

## Start

The kept six-rule style with `tab` off: `minmax`, `hex` (the general test, see the correction in `2026-10-09-dense-six-rules-preregistration.md`), `trailingParams`, `oneLine`. Its kernel sum is 171 and the held-out set is the same 54 programs (`results/dense-six-rules.json`). claim-ok: recorded values.

## Rules (fixed now)

The candidates come from a scratch sweep of 20 agents that rewrote printed texts and counted tokens, each rule alone. Those numbers are estimates (not round-tripped, not in `results/`) and back nothing here. Every rule below is a printer spelling under its own `DenseStyle` flag, off by default (the default text, which `compiler/dense.a0` reads, is unchanged), and read by `parseDense(text, { compact: true })`.

1. **fill**: an array of three or more equal elements prints `[e;k]` also when `e` is a named value (today only a number or parameter). The reader already expands `[e;k]`.
2. **bit/nbit**: `select C 1 0` prints `bit C` and `select C 0 1` prints `nbit C` (both u32 literals). An id or function named `bit`/`nbit` is escaped or turns the spelling off, as for `min`/`max`.
3. **record access**: `at X K`, with `X` a plain operand (parameter, named value) and `K` a number literal, prints `X.K`. The reader reads a word `X.K` as `at X K`.
4. **result type from the body**: the header leaves out `-> T` whenever the reader would infer `T` from the last statement (the same `typerFor` the reader calls), for any `T` and also after a type list; today this is done only for `u32` without a type list. The compact reader accepts a type list without `->`. ("the verified subset": only results the reader's own inference reproduces are left out.)
5. **negative literal**: a u32 literal `v` prints `-N` with `N = 2^32 - v` when that text has strictly fewer characters than the decimal; otherwise the hex rule, otherwise decimal. The compact reader reads `-N` (1 <= N < 2^32) as `2^32 - N`. claim-ok: a rule definition, not a measured claim.
6. **foldN**: `fold BODY N ...` with `N` a number literal prints `foldN BODY ...` (`fold8 {...} [0;8]`). The compact reader reads `fold` followed by digits as that fold, unless the word is a defined name or function; an id spelled like it is escaped.
7. **default names with `i` first**: DROPPED before implementation. The sweep chose the letter by trying all 26 against the held-out total, so the held-out gate cannot test it, and the order is a constant fitted to the data (AGENTS.md: no fabricated constants). Its sweep kernel saving was 1 token, and every other first letter except `b`, `c`, `e` gave the same kernel number.
8. **operator symbols, glued**: `add sub mul xor and or eq select lt gt` print `+ - * ^ & | = ? < >` (`shl`/`shr` already print `<<`/`>>`). A space in a statement next to a symbol is left out whenever the compact lexer reads the same tokens without it. The compact lexer splits symbols by maximal munch over `<< >> == != <= >= + - * / % & | ^ < > = ?`, and reads `-` followed by a digit as a negative literal; so two symbols that would merge into a longer operator (`<` `<`, `<` `=`, `=` `=`, ...) and a `-` before a digit keep their space. In compact text `=` is always `eq` (the lenient `name = expr` form is not read there).

## Measure

`tools/dense-combined.ts` writes `results/dense-combined.json` (o200k_base, dense text after `normalizeProgram`, trimmed):

- **headline**: the kernel sum with the start style plus every kept rule, `tab` off and no rotate shorthand;
- side columns, never the headline: the same plus `tab`; the same plus a rotate shorthand (`or << X K >> X sub 32 K` written `<<< X K`, applied as a text rewrite, an estimate that is not round-tripped);
- per rule: kernel and held-out saving alone over the start style, and its saving when removed from the combination;
- the held-out total with every kept rule;
- round-trip failures with every kept rule on, which must be 0.

## Gates (a rule is kept only if all hold)

1. **Held-out**: it saves tokens on the 54 held-out programs alone over the start style.
2. **Lossless**: every kernel and held-out program, as written and normalized, prints with every kept rule on and reads back through `parseDense(text, { compact: true })` to the identical canonical text, and prints again to the identical dense text.

A rule that fails either gate is dropped and the reason recorded; the kernel sum is reported whatever it is. If it is above 161 the answer is no.

## Not in this change

`compiler/dense.a0` (the self-hosted reader) reads none of these spellings; reading them there is a follow-up. Rules 4 to 8 change what a model reads and writes; no AI edit-accuracy claim is made from this measurement. claim-ok: a condition, not a measured value.

## Outcome (measured after the change; `results/dense-combined.json`)

**No.** With every kept rule on, `tab` off and no rotate shorthand, the kernel sum is **162**, one token above the 2x line (161); 162/323 = 0.502 of the best single language. Every rule passed both gates; with all of them on, all 10 kernels and all 54 held-out programs read back to the identical canonical text and print again to the identical dense text (`roundTripFailures` is empty). The held-out total falls from 527935 to 486694.

Saved alone over the start style, kernels / held-out (`alone` in the result):

| rule | kernels | held-out | kept |
| --- | --- | --- | --- |
| 1 fill | 0 | 12684 | yes |
| 2 bit/nbit | 0 | 4372 | yes |
| 3 record access `X.K` | 0 | 4149 | yes |
| 4 result type from the body | 0 | 7278 | yes |
| 5 negative literal | 0 | 689 | yes |
| 6 foldN | 2 | 658 | yes |
| 7 default names with `i` first | - | - | dropped before implementation (fitted to the held-out set) |
| 8 operator symbols, glued | 7 | 11368 | yes |

Side columns, not the headline: with `tab` 156; with the rotate text rewrite 155 (an estimate, not read back); with both 149.

Deviations and findings:
- The start held-out total is 527935, not 527933: compact text now escapes ids spelled like the new words (`bit`, `nbit`, `foldN`) whenever a compact spelling is on, so the compact reader can read every spelling always.
- Rule 4 saves 7278 on the held-out set, far more than the sweep's estimate for its "verified subset": the general form leaves out every result the reader's own inference reproduces.
- The pre-registration said no held-out program has the rotate pattern; the rotate rewrite in `tools/dense-combined.ts` matches 3 held-out programs (`heldOutMatched`). Rotate stays a side column: it is not implemented in the reader, so it is not round-tripped.
- `compiler/dense.a0` reads none of rules 1 to 8; that reader is the follow-up.
