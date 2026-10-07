# Surface v2: a token-lean canonical spelling, studied deterministically

Status: research note, no language change. Everything below is computed by `tools/surface-v2-study.ts` and
`tools/surface-v2-failures.ts` into `results/surface-v2.json` and `results/surface-v2-failures.json` (o200k_base through
js-tiktoken, no model, no network). The converter prototype is `tools/surface-v2.ts` (test: `test/surface-v2.test.ts`).
No model wrote any v2 text: every statement about how models will cope is a labelled hypothesis, and a measured loss
beats it (AGENTS.md).

## Headline

| form | 10 token kernels | rank of 49 | 19 timed kernels | corpus programs (41 files + generated) | tokens-kernel losses closed (of 377) |
|---|---|---|---|---|---|
| canonical (today) | 559 | 41 | 51955 | 1025279 | 0 |
| dense (opt-in, `src/dense.ts`) | 202 | 1 | 1589 | 501462 | 325 |
| **v2 (proposal, normalised)** | **251** | **1** | **2064** | **489936** | **325** |
| v2, spaced like C | 321 | 1 (323 is next) | 2682 | 598396 | 293 |
| best other language (forth) | 323 | | | | |

- v2 reaches place 1 on the sum (22 per cent under forth) and closes exactly the 325 losses dense closes. The same 52 stay open
  in both: all are `noop`, whose A0 kernel carries three identity operations on purpose (5 tokens in ocaml against 12).
- **v2 cannot beat dense's total**: 251 against 202 on the 10 kernels, 2064 against 1589 on the 19 timed kernels. It does
  beat dense on the corpus programs (489936 against 501462) and on whole-function line edits (below). The gap on kernels is
  helper functions: dense inlines a fold body as `{...}` with positional parameters; v2 keeps helpers as separate functions on purpose.
- The lossless converter works: 59 of 61 programs round-trip exactly and normalised with the result type inferred, 61 of 61
  with the result type written. The two exceptions are `seed/chunks/01.a0` and `02.a0`, fragments that cannot be typed
  without the rest of the bootstrap program (their `a0boottypes` function does not check on its own), so there is no checker to infer from.
- **The central risk is real and the numbers do not make it go away.** On the cost the owner cares about (tokens per accepted edit), the source
  spelling is worth about 13 tokens per call out of 115, the primer costs 100 to 135 tokens a call, and one extra repair costs about 98. Predicted
  best case for v2: 6.7 per cent below canonical per accepted edit at the 10-task horizon, and it ties canonical if v2's acceptance falls to 90.3 per
  cent from 96.8 (the dense control cells showed 87.6 against 95.0). See the risk section.

Recommendation (numbers below): **GO on v2 as a second opt-in surface plus a new sealed set; NO-GO on making it canonical now.** Details at the end.

## 1. Per-token anatomy

Ten token kernels (`affine rotl clamp mix ident noop chain3 branchy arrfill loop64`), tokens per construct (`anatomy` in the results file):

| construct | canonical (559) | dense (202) | v2 (251) | C (512) | Rust (558) |
|---|---|---|---|---|---|
| newline and blank line | 81 | 11 | 24 | 2 | 2 |
| `u32` type words | 84 | 0 | 1 | 6 | 76 |
| `fn` | 14 | 12 | 14 | | 12 |
| `->` | 14 | 0 | 0 | | 12 |
| `ret`, `end` | 28 | 0 | 0 | | |
| parameters (`p0`: 2 tokens each; `A`: 1) | 86 | 43 | 71 | | |
| operation names | 51 | 41 | 14 | | |
| punctuation and operators | 25 | 31 | 52 | 173 | 209 |
| names (ids, function names, name fragments) | 130 | 34 | 41 | 256 | 213 |
| number literals | 44 | 30 | 33 | 75 | 34 |

Most expensive spellings in canonical, in order: `\n` 81, `32` 43 (the digits of `u32`, plus literals), ` p` 43 and the digit after it ~40
(`p0` is two tokens, every use), ` u` 42 (`u32` is two tokens, 84 in total with its digits, 15 per cent of the text), ` ->` 14, `ret` 14, `end` 14, `fn` 14.
So the structural words around the program (`u32`, `->`, `ret`, `end`, `fn`, newlines) are 205 tokens, 37 per cent; `p0`-style parameters 86 (15 per cent);
ids and operation names 181. Single-token spellings: ` add ` ` mul ` ` xor ` ` select ` ` fold ` ` get ` ` ->` `fn` `ret` `end`; two tokens: ` shl` (`sh`+`l`),
` p0`, ` u32`, `u32x8`. `<<` and `>>` are one token each (dense already uses them). A name of one letter plus a space is one token; a letter plus a digit is two (`x1`).
Merging helps: `(A`, `,B`, `)\n` and `)+` are single tokens, so parentheses and commas are cheap, while a space after a comma or around an operator costs real
tokens (v2 spaced is +70, 28 per cent; spaces after commas alone +32, around operators alone +36).

Best case in other languages for the same kernels: forth 323 in total; per kernel (`perKernelBestOther`): affine 15 (ocaml), rotl 31 (r), clamp 22 (nim),
mix 39 (forth), ident 5 (ocaml), noop 5 (ocaml), chain3 45 (forth), branchy 49 (forth), arrfill 48 (d), loop64 41 (forth); sum of per-kernel bests 300.
C writes the set in 512 (`static inline uint32_t`, `return`, `;`, `{ }`: 173 tokens of punctuation), Rust 558 (`wrapping_mul`), Python 417, TypeScript 507.
A0's current lead over C in structure (no types, no `return`, no braces) is already thrown away by `u32`, `->`, `ret`, `end` and `p0`.

## 2. The v2 spelling table

Chosen to keep one canonical text per program, exact parse-validate round trip and no ambiguity, with every rule measured (ablation in
`totals` of the results file; tokens on the 10 kernels, normalised):

| rule | v2 | saves against the alternative |
|---|---|---|
| function | `fn name(A,B)` then body lines; ends at the next `fn` or blank line | no `end`, no `ret`: +39 if kept (`v2-ret-end`) |
| result | the last line is the result (an expression or a bare name); no `ret` | in the same +39 |
| parameters | capital letters `A`, `B` (a lowercase id can never be one); the parser accepts the writer's names (`x`, `y`) and the formatter writes the letters | +70 for `p0` |
| types | none for u32; `A:u32x8` only when not u32; the result type is inferred by the checker (it already reports it as A0201) | `-> T` written: +6 on the kernels, +19029 (3.9 per cent) on the corpus |
| operations | infix for the 16 binary operators (`+ - * / % & \| ^ << >> == != < <= > >=`), calls for the rest: `select(c,a,b) get(a,i) set(a,i,v) at(r,k) put(r,k,v) rec(a,b) mov(x) fold(f,n,s,a..) loop(p,f,a..) f(a,b)` | calls only: +48 |
| precedence | none: any nested operator expression is parenthesised, `(A*B)+C`; the single exception is a left chain of one operator, `a+b+c`; mixed operators without parentheses are a parse error with an exact fix | |
| nesting | a value used once is written inside its consumer; a value used twice, or one whose id is not the default of its position, is a statement `id=expr` | one op per line: +116 |
| ids | nested values take default names `a, b, c, ...` in creation order, skipping explicit names; statements keep their id | |
| literals | `[x;N]` for N equal atoms, `[a,b]` otherwise, `"text"` | 19 timed kernels: 2064 against 49735 without `[0;4096]` |
| spacing | none (`a+b`, `f(a,b)`, `x=a+b`) | spaces cost +70 (the spaced variant is the readable fallback) |
| no lambdas | a fold body is a separate named function | dense's `{...}` body and prefix form save the other ~50 on the kernels and bring back positional parameter order inside a body |

Kernels in v2 (normalised, result inferred), for orientation:

```
fn rotl(A,B)
(A<<B)|(A>>(32-B))

fn mix(A,B)
a=A^B
f=(((a<<13)|(a>>19))*2654435761)+A
f^(f>>16)

fn branchy(A,B)
f=select(A==B,0,select(A<B,B-A,A-B))
select((f&1)==1,f,A)

fn put8(A:u32x8,B,C)
set(A,B,B+C)

fn arrfill(A,B)
b=fold(put8,8,[0;8],A)
get(b,B)+get(b,3)
```

Per kernel (`kernelRows`): v2 against canonical, dense and the best other language.

| kernel | canonical | dense | v2 | best other |
|---|---|---|---|---|
| affine | 29 | 7 | 11 | 15 ocaml |
| rotl | 41 | 13 | 15 | 31 r |
| clamp | 44 | 17 | 20 | 22 nim |
| mix | 65 | 33 | 34 | 39 forth |
| ident | 13 | 3 | 5 | 5 ocaml (tie) |
| noop | 31 | 12 | 12 | 5 ocaml (loss) |
| chain3 | 80 | 25 | 33 | 45 forth |
| branchy | 81 | 32 | 33 | 49 forth |
| arrfill | 98 | 31 | 47 | 48 d |
| loop64 | 77 | 29 | 41 | 41 forth (tie) |

Where the ids of the written program are not the default ones (the "exact" mode: `formatV2` keeps ids and node order, so a single-use value with
another id stays a statement), the 10 kernels cost 319 and the corpus 943605: v2 is a spelling for programs written for it, not a way to shrink
existing text. Normalising renames the ids; for the existing compiler sources this is a one-time rewrite.

## 3. Converter results

`formatV2` / `canonicalOfV2` / `normalizeV2` in `tools/surface-v2.ts` (a printer, a recursive-descent parser to canonical text, and a normaliser
that orders nodes the way the text creates them). Nesting is decided by a fixpoint: a single-use node is nested only if the parse reproduces its
position and its default name, so the round trip is exact by construction and `canonicalOfV2(formatV2(p))` parses to the canonical form of `p`.

| check | result |
|---|---|
| kernels (19), examples, compiler, site, seed, generated corpus: 61 programs, result type written | 61 exact, 61 normalised |
| the same with the result type inferred | 59 exact, 59 normalised (the 2 exceptions above) |
| no infix, no nesting, call-only, spaced variants | as the proposal (59 of 61) |
| a mutated operator reads back as a different program | yes (control) |
| `A+B*C` | rejected: mixed operators need parentheses |
| writer-named parameters `fn f(x,y)` | accepted, printed as `A,B` |

Not covered by the prototype: comments (not part of the canonical form), spec lines (`ex`, `pre`, `post`: passed through in their canonical spelling),
`use` and `profile strict` lines (passed through). A real implementation needs the spec expressions rewritten to parameter letters.

## 4. Totals and ranks

Rank among the 49 languages of `results/lang-axes.json` on the sum over the 10 kernels (a language with all ten): canonical 41, dense 1, v2 1, v2 spaced 1
(321 against forth's 323: too close to call a win, one kernel edit flips it), v2 with `p0` parameters 321, v2 without nesting 367 (rank 4), v2 with
`ret`/`end` kept 290. On the 19 timed kernels the other languages' sources exist for C, Rust and JS only: 1851, 1936 and 1859 tokens against v2 2064
and dense 1589: on the 19 kernels v2 is about 11 per cent above C, so the timed-kernel token axis is not won by v2 on the sum (dense wins it).

Effect on the ledger (`ledger`, computed entry by entry: a loss closes when v2's count is no more than the competitor's, the competitor count unchanged):

| form | closed | strictly below | still losing | still losing by kernel |
|---|---|---|---|---|
| dense | 325 | 318 | 52 | noop 52 |
| v2 | 325 | 315 | 52 | noop 52 |
| v2, result type written | 323 | 313 | 54 | |
| v2 call-only | 303 | 300 | 74 | |
| v2 spaced | 293 | 286 | 84 | |
| v2 `p0` | 292 | 286 | 85 | |
| v2 without nesting | 268 | 258 | 109 | |

All 325 are the entries ledgered as `dense-view-wins-canonical-loses`; the 52 `loses-in-both-views` are noop and stay. noop cannot be closed by spelling: its three identity
operations are the point of the kernel (the optimizer must not add work). Ties (ident against ocaml 5, loop64 against forth 41) count as
"not above the competitor" as the ledger counts them; they are one token from a loss.

## 5. The sealed task sets' edits in v2

334 tasks over sets a, b, d to w (`editTokens`, the files are only read). Tokens summed over all tasks:

| | canonical | dense | v2 (normalised) | v2 (ids kept) |
|---|---|---|---|---|
| source programs | 16536 | 6743 | 7720 | 10500 |
| reference whole-function edits | 17933 | 7363 | 8415 | 11590 |
| reference edit as changed lines only | 3918 | 6198 | 3714 | 3496 |

A whole-function reply is 53 per cent shorter in v2 (59 in dense). The changed-line view is the surprise: dense's nested statements make a
one-operation change rewrite the whole statement (6198, 58 per cent worse than canonical's 3918); v2 is 5 per cent better than canonical because its lines are
short enough to pay for the nesting. The primer is not saved by this: the protocol in the ablations is whole-function replies for dense and line edits for canonical.

## 6. The central risk: why dense lost on cost

Recorded evidence (`results/surface-v2-failures.json`, every A0 trial in `results/` on the sets that exist in both forms, rules-merged primer):

1. The pre-registered rule on set H was not met on either model: dense one shot 12 and 14 of 16 against 13 and 16, dense 187.0 and 120.5 tokens per accepted edit at the 10-task horizon
   against 162.9 and 114.9 (`results/set-h.json`). Dense had three unrecovered Haiku failures there, all `get C B` on a fold step (a named or mis-ordered index in a body whose parameters are positional).
2. Controls only (dense.D0 against canon.K0 and canon.KR3): dense 266 trials, 84.2 per cent one shot, 87.6 per cent accepted after one repair (33 not accepted);
   canonical 340 trials, 89.4 and 95.0 per cent (17 not accepted). Pooled over every primer variant: dense 88.0 / 91.2 per cent over 2146 trials, canonical 84.7 / 93.7 over 1881:
   dense is easier to get right first time but harder to repair, and the ablation variants include deliberately damaged primers.
3. By class, per 100 control trials (failed attempts; in brackets the trials not accepted after repair):

| class | dense | canonical | v2 handling (hypothesis) |
|---|---|---|---|
| parameter written as a name (`x`) where the form wants `A` | 7.1 (3.8) | 0 | **removed**: the header names parameters, any names are read |
| duplicate or reused id (`r` twice) | 2.3 (2.3) | 0 | kept (statements are named); the diagnostic carries an exact rename |
| get/set on the wrong value in a fold body | 1.9 (1.9) | 0 | smaller: helpers are separate functions with a header; the argument order of `fold` stays |
| operand count, value used twice | 1.1 (0.4) | 0 | **removed**: calls name their arity with parentheses, a repeated sub-expression is allowed (two nodes) |
| callee used before it is defined | 0.8 (0.4) | 0 | removable: accept any order, print callees first |
| result type not written | 1.1 (0.4) | 2.4 (0.6) | **removed**: inferred |
| edit protocol (line edit shape) | 0 | 1.8 (0.6) | **removed**: whole-function replies |
| block shape (`ret`/`end`) | 0 | in the pooled data 1.6 | **removed** |
| nested operand | 0 | 0.3 (0.3) (pooled 1.4) | **removed** (nesting is the syntax) |
| wrong result (well formed, wrong logic) | 3.0 (1.1) | 5.0 (2.4) | unchanged |
| other type errors | 4.1 (2.3) | 2.7 (0.9) | unchanged |

What made dense fragile, in order of weight: positional, unnamed parameters (the largest single class, half of dense's excess), prefix operations
without delimiters (arity and "a value used twice" errors), implicit parameter counts and lambda bodies whose parameter order is a convention. None of those
is a token-saving device that v2 needs, except nesting, which v2 delimits. v2 keeps the familiar one-token English words (`select`, `get`, `set`, `fold`), operators that are
one token (`<<`, `>>`, `==`, `<=`, `&`, `^`), and merges that make `(A` and `)+` one token. It avoids symbols that cost two or more tokens: it never uses `->` except for a non-u32 result in the explicit variant,
never `u32`, never `p0`. Its odd merged tokens (`)|(`, `))*`) are the price of compactness; they are not syntax.

New v2-only traps, not measured and not removable by choice: (a) a missing parenthesis is now a possible error (loud, never a silent regrouping, but a new class that dense did not have;
if it looks like dense's operand-count class it costs 1 to 2 failures per 100); (b) writer names for parameters are accepted but printed as letters, so a model that copies a printed view sees
`A`, `B` while its primer shows names; (c) default ids for nested values mean an edit that inserts a statement renames later nested values (the cost of positional naming; a whole-function reply removes it).

### The cost arithmetic (`cost.model` in the failures results)

Recorded cells: canonical 118-token primer, prompt 89, reply 26, 1.1 calls per task, 158 tokens per task at 10 tasks; dense 145, 74, 23.9, 1.1, 142. A model fitted on these two cells
(tokens per task = primer × (1.25 + 0.05 (n−1))/n + calls × (view + reply) + 11.4) reproduces dense's 142 as 143.8. Applied to v2 (view scaled by v2's 53 per cent source saving against dense's 59: 13.5 tokens
saved; reply 27.3; the drafted primer of 134 tokens, see `primers`):

| cell | per task, 10-task horizon | accepted | per accepted edit |
|---|---|---|---|
| canonical, recorded | 158.0 | 96.8% | 163.3 |
| dense, recorded | 143.8 | 91.9% | 156.4 |
| v2, canonical failure behaviour | 147.5 | 96.8% | 152.4 (−6.7%) |
| v2, dense's failure behaviour | 147.5 | 91.9% | 160.4 (−1.8%) |
| v2, 100-token primer, canonical failures | 141.5 | 96.8% | 146.3 (−10.4%) |

So the surface can buy at most about 7 to 10 per cent per accepted edit; **one extra repair call per 6 tasks (0.175 calls per task, break-even for dense's own saving) cancels it**, and v2
ties canonical at 90.3 per cent acceptance. Every figure above that is not the "recorded" rows is a model prediction, labelled as such; set H used n = 16 with 95 per cent intervals 0.5 to 0.9, so
a 7 per cent difference needs on the order of 150 tasks per cell to be seen (not computed here).

The recorded data also say where a real gain could come from: failure classes that v2 removes by design but that have nothing to do with token count: canonical's 8.9 failed attempts per 100 trials
(pooled) in block shape, nested operand, edit protocol, callee order and result type are each about a repair call (98 tokens), worth about 9 tokens a task, as much as the spelling.

## 7. Cheaper alternatives the numbers expose

- **Dense with the first trap fixed**: the largest dense class (named parameters, 7.1 per 100, half its excess) is a parser leniency (name the parameters by first use, or accept a header with names), not a new surface. It
  keeps dense's 202 tokens and its 145-token primer. Not prototyped; the replies are not replayable because a dense reply has no header to take the names from.
- **Canonical with the three cuts** (no `end`, no `ret`, no u32 types in headers): 476 tokens (`results/canon-syntax-tokens.json`), rank not in the top, closes 143 of 377. Not enough alone.
- **Whole-function replies for canonical too**: removes the edit-protocol and block-shape classes without any new syntax (pooled 2.5 per 100 trials).

## 8. Migration plan if v2 becomes canonical

Files that change (counts from `git ls-files`):

| area | what | size |
|---|---|---|
| `src/core.ts` (2189 lines) | v2 parser and formatter beside `parse`/`formatProgram`; `revision` hashes over v2 text; diagnostics reworded (`dense.ts` already has `reworded`) | large |
| `src/edit.ts`, `dense-edit.ts`, `fix.ts`, `lsp.ts`, `explain.ts`, `mcp.ts`, `spec.ts` | line edits become whole-function edits; fix edits (`edits` carry canonical lines), spec expressions with parameter letters | large |
| `compiler/*.a0` (19 files, 2.3 MB with the rest of the 41 .a0 files) | the self-hosted lexer (690 lines) and parser (3569) read one-op-per-line text; v2 needs an expression parser in a language without recursion (explicit stack), a default-name generator, a normaliser; then every compiler source is rewritten in v2 (normalised ids) | the dominant cost |
| `seed/` | `bun run seed` after every `compiler/*.a0` change; `seed/a0c-seed.c` is 530 KB of generated C; `test/seed.test.ts` fails otherwise | mechanical, repeated |
| site (`site/*.a0`, `site/gen/*.a0`), `examples/`, `corpus/reject` (81 rejected programs: their expected diagnostics are canonical) | rewrite or keep a canonical reader | medium |
| docs, `MODEL_GUIDE*.txt`, skills, plugin, integrations, editors, README, DESIGN.md (39 files mention `ret`) | rewrite; `tools/sync-skill.ts --check` | medium |
| tests (23 of 48 test files carry canonical text), `test/golden`, wasm size budgets, digests | regenerate | medium |
| `tools/*`: 59 tools import `src/core.js`; lang-axes, loss-ledger (`results/loss-ledger.json` growth needs `--update --reason`), kernels | v2 kernel text; ledger re-record | medium |
| sealed sets `tools/ai-edit-tasks-*.ts` and their `.sha256` | untouched (rule), they stay canonical; a reader keeps them runnable | none |
| **new sealed set** `tools/ai-edit-tasks-x.ts` | authored blind (the set H procedure: a neutral JSON program model, an author who has seen neither language nor answers), at least 60 tasks, v2 and canonical cells, Haiku and Sonnet, one repair | needed |

Effort (rough, one agent working through the gate; an estimate, not a measurement): converter hardening and `a0 view --v2` / `a0 fmt --v2`: 2 to 3 days;
the experiment (primer drafts, new sealed set, four cells, summary, preregistration): 3 to 4 days; the self-hosted v2 front end: 2 to 4 weeks; rewriting the compiler sources, seed, docs, tests and ledger: 1 to 2 weeks.
The compiler rewrite and the self-hosted parser are why this should not start before the measurement.

## 9. Recommendation: go / no-go

- **Token axis.** v2 reaches rank 1 of 49 (251 against forth 323) and closes the same 325 of 377 ledger losses as dense; the 52 left are noop in both. Lossless converter: yes (61 of 61 with the result written, 59 of 61 inferred).
  v2 cannot beat dense's total (251 against 202) and does not try to: it gives up about 50 tokens for regularity.
- **Cost axis.** Not established and capped: best predicted 6.7 to 10 per cent per accepted edit below canonical, wiped out by about 0.17 extra repair calls per task or by acceptance below 90 per cent.
  Dense proved this can go the wrong way in a fresh set (set H).
- **Decision.** GO on building v2 as a second, opt-in surface (converter exists; `a0 view`/`a0 fmt` style flags, whole-function replies, a primer of 100 to 135 tokens) and running a new sealed set with a preregistered rule
  like set H's (not lower one shot on both models, lower tokens per accepted edit at 10 tasks, plus unrecovered failures reported by class). NO-GO on changing the canonical text, rewriting `compiler/*.a0` or
  the seed until that rule is met. If it is met, promote; if v2 is not lower per accepted edit, the token axis is still won by the opt-in surface the way dense already wins it, and the ledger can count it as a recorded subject.
  In parallel, test the cheapest candidate first: dense with parameter-naming leniency (section 7), which would keep 202 tokens.
- What would change this: a v2 acceptance within 3 points of canonical on a 60-task set; or a primer of 100 tokens that holds acceptance; or evidence that the failure classes v2 removes (block shape, callee order, result type, edit protocol: 8.9 per 100 pooled) are what actually decide cost.
