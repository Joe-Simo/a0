# Failure taxonomy of A0 subject trials

Source of every number below: `results/failure-taxonomy.json`, written by `tools/failure-taxonomy.ts` (run `bun tools/failure-taxonomy.ts`)
over every report under `results/` that holds A0 subject trials: `ai-edit-experiment.*` (all letters, A0 and dense representations),
`set-h` to `set-w`, `primer-ablation/`, `shipped/`, `selection/`, `dense-rounds/`, `app-edit/`, `app-edit-deps/`, `app-edit-keys/`,
`app-edit-loop/`, `app-edit-wording/`. Scripted oracle runs, `report1.*` one-shot duplicates and a base file superseded by its `-retry` or
`-repair` file are skipped (they would count one trial twice). `spec-*.json`, `set-*.json` and `primer-ablation.json` at the top of
`results/` are summaries of the per-trial reports above and are covered through them.

## What is counted, and what the numbers do not say

- A trial is counted when its first attempt was not accepted (a one-shot failure): **1447 trials** (Haiku, Sonnet and 22 whose model the file
  name does not give). Of those **864 were not accepted after the one repair** and 583 were repaired. "Repaired" is the recorded `accepted` flag.
- Trials repeat across arms: the same task and the same kind of subject appear in many ablation arms, so these are trials, not distinct
  tasks, and a rejected wording arm (the `short`, `tiny` and `min` variants) contributes many rows of one slip. The table is therefore given twice:
  over every arm, and over the **current arms** (the arms that ran the shipped wording: `set-*`, `app-edit*`, `shipped/`; 465 of the 1447).
- The class is a labelled reading of the first harness rejection message and the attempt status (rules in `tools/failure-taxonomy.ts`,
  tested in `test/failure-taxonomy.test.ts`), not a measurement of what the model meant. The diagnostic id is found by matching the message
  against the `DIAGNOSTICS` table of `src/diagnostics.ts`; "(no id)" is a result mismatch or a harness line that is not a diagnostic.
- Wrong results are split by one rule: a result near 2^32 where the expected one is not is read as a width mismatch (u32 wraparound);
  every other wrong result is "misunderstood semantics". The harness records a wrong result, not the model's reasoning.
- **View gap: 0 recorded.** The result files do not mark a failure as a missing view fact. The one carried finding is in
  `docs/history/2026-10-06-app-edit-keys-preregistration.md` (the word-key legend closed the gap the deps view left; the four misses that remained were
  model errors). **Budget exhaustion: 0 recorded**: no subject trial records running out of tokens or turns; the harness limits are fuel and trip caps
  inside A0 runs, and none stopped a recorded subject trial.
- **No reply** (315 first attempts) and **no failure text recorded** (81) are in `other`: the subject returned nothing the harness could
  read, or the report predates the failure field. They say nothing about the language.

## The table: first-attempt failures by root cause class

Each cell is first-attempt failures; "repaired" is accepted after the one repair; "still" is not accepted after it.

All arms (1447 trials):

| class | trials | repaired | still failed | Haiku (n / repaired) | Sonnet (n / repaired) |
|---|---|---|---|---|---|
| syntax slip | 411 | 173 | 238 | 350 / 137 | 61 / 36 |
| ordering (callee after its caller) | 43 | 17 | 26 | 37 / 13 | 6 / 4 |
| id reuse (A0503 sequence rule, A0303) | 41 | 31 | 10 | 28 / 20 | 13 / 11 |
| type/width mismatch | 157 | 100 | 57 | 141 / 85 | 16 / 15 |
| misunderstood semantics | 300 | 151 | 149 | 267 / 128 | 33 / 23 |
| protocol misuse (handle, revision, edit syntax) | 78 | 36 | 42 | 69 / 33 | 9 / 3 |
| view gap | 0 | 0 | 0 | | |
| budget exhaustion | 0 | 0 | 0 | | |
| other (no reply 315, no failure text 81, spec example limit 19) | 417 | 75 | 342 | 191 / 28 | 204 / 47 |

Current arms only (465 trials):

| class | trials | repaired | still failed | Haiku (n / repaired) | Sonnet (n / repaired) |
|---|---|---|---|---|---|
| syntax slip | 117 | 62 | 55 | 97 / 47 | 20 / 15 |
| ordering | 11 | 6 | 5 | 7 / 3 | 4 / 3 |
| id reuse | 25 | 23 | 2 | 15 / 13 | 10 / 10 |
| type/width mismatch | 46 | 27 | 19 | 41 / 22 | 5 / 5 |
| misunderstood semantics | 149 | 79 | 70 | 128 / 68 | 21 / 11 |
| protocol misuse | 38 | 19 | 19 | 37 / 19 | 1 / 0 |
| other | 79 | 59 | 20 | 33 / 23 | 46 / 36 |

## What the harness said, and whether the repair worked (diagnostics with 8 or more trials, all arms)

The message the subject saw is the diagnostic's message plus its `fix:` text from `src/diagnostics.ts` (the static template, or a fix computed
from the failing input). Repair rate is repaired / trials; the Haiku and Sonnet split is in the JSON.

| class | id | message and fix text (as recorded) | trials | repaired | in current arms |
|---|---|---|---|---|---|
| type/width | A0201 | `{0}: expected {1}, got {2}`; fix: replace the operand with a value of type {1}; for a returned bool, `select c 1 0`, or change the declared result in the header | 89 | 71 | 26 |
| type/width | A0105 | `parameter p{1} out of range`; fix (later wording): f has N parameters, use one of them or send a `fn f ...` block | 37 | 14 | 10 |
| type/width | A0209 | `get expects an array, got {1}` | 16 | 6 | 1 |
| syntax slip | A0010 | `nested operand: A0 has one op per line`; fix: write the inner op on its own line above (exact edit) | 54 | 39 | 28 |
| syntax slip | A0102 | `unknown callee '{1}' (callees must be defined earlier; recursion is unsupported)`; fix: did you mean / neither an op nor a function | 39 | 27 | 25 |
| syntax slip | A0018 | `expected 'fn', got '{0}'` (13 of the 28 are a markdown fence line); fix: instruction lines belong inside a function | 28 | 5 | 0 |
| syntax slip | A0009 | `expected id op operands` (no fix text) | 27 | 3 | 1 |
| syntax slip | A0215 | `{1} expects {2} extra arguments, got {3}`; fix (later wording): each step runs state = f(state, i, extras...) | 23 | 12 | 5 |
| syntax slip | A0014 | `{0} expects {1} operands, got {2}`; fix: write exactly {1} operands | 21 | 9 | 7 |
| syntax slip | A0011 | `unknown operation '{0}'`; fix: use one of the ops, or call a function | 18 | 11 | 1 |
| syntax slip | A0101 | `reference to undefined or later node`; fix: define it on an earlier line | 16 | 10 | 8 |
| syntax slip | A0026 | `unexpected 'end' before ret`; fix: write `ret X` before `end` | 16 | 10 | 7 |
| syntax slip | A0025 | `expected 'end' after ret`; fix: close with `end` (exact edit) | 14 | 0 | 6 |
| syntax slip | A0005, A0023, A0704, A0220 | invalid node id, header form, spec shape, array op on a record | 13, 13, 12, 11 | 1, 3, 2, 6 | 3, 3, 0, 6 |
| ordering | A0103 | `unknown fold body '{2}' (must be defined earlier)`; fix: define it above / did you mean | 20 | 9 | 5 |
| ordering | A0102 | unknown callee (a helper that is not defined above the caller) | 15 | 8 | 6 |
| ordering | A0604 | `unknown function '{0}'` in a patch; fix: a callee must be defined above its caller | 8 | 0 | 0 |
| id reuse | A0503 | `duplicate edit for '{0}'`; fix: keep the one line you mean, or give the other node its own id (exact for the sequence case) | 27 | 23 | 21 |
| id reuse | A0303 | `duplicate definition` | 11 | 8 | 4 |
| protocol | A0504 | `invalid delete target '{0}'` (no fix text at the time) | 45 | 23 | 30 |
| protocol | A0508 | `new node '{1}' is not used by any node or by ret`; fix: add `ret {1}` or use it | 15 | 10 | 7 |
| protocol | A0513 | `line edit '{0}': {1} has lines 1..{2}`; fix: use the line numbers shown in the view | 7 | 0 | |

`misunderstood semantics` has no diagnostic: the edit was accepted by the checker and the program computed the wrong result (292 of 300 are a
wrong value on a checked input, 8 a type error the harness reported as a failed test). The repair message is the list of failing inputs; 151 of 300 were repaired.

## The top 5 classes by trials unlocked

"Unlocked" is the trials still failing after the repair (all arms; the current-arm count is in brackets). `other` (no reply) is left out: no change to the language
or the tooling can answer a subject that did not answer.

| rank | class | still failed | cause | language/tooling or model capability |
|---|---|---|---|---|
| 1 | syntax slip | 238 (55) | wrong operand counts, case, commas and nested operands, a function frame without `ret`/`end`, a markdown fence round the reply, op spellings that are not A0 ops (`sel`, `lte`) | mostly **language/tooling**: 13 trials were a fence the protocol could have ignored, 93 an unknown word in op position (a typo or an op written under another name such as `sel`, `mod`, `ult`), 85 a function frame error (header, `ret`, `end`) whose message did not name the line to write; the operand-count and extra-argument slips are **model capability** with a better message |
| 2 | misunderstood semantics | 149 (70) | the edit was valid and wrong: the compiler-edit tasks (`fat-arrow`, `param-limit`, `number-leading-zero`) and unsigned arithmetic | **model capability** (the checker has nothing to say; a view gap would show here, none is recorded) |
| 3 | type/width mismatch | 57 (19) | a bool returned where u32 is declared (A0201, the largest single id), a parameter out of range in a function whose callee the view shows as a signature (A0105), u32 wraparound | split: A0105 is a **tooling** gap (`stubHint` in `src/edit.ts` already gives the signature block; 14 of 37 repaired); the bool/u32 header mismatch has a computed fix text and is repaired 80% of the time; wraparound is **model capability** |
| 4 | protocol misuse | 42 (19) | `-id` followed by the old node text with no replacement (A0504, 45 trials, 30 in the current arms), `ret` forgotten (A0508), line numbers | **tooling**: the one action that resolves A0504 is mechanical, and was not offered as an exact edit |
| 5 | ordering | 26 (5) | a helper defined after its caller, or a replaced function that calls a later one | **language design** (callees must precede callers) and **tooling**: the edit tool already ordered the functions of one reply (`orderFunctionsByCalls`); a function that calls a later function already in the program was rejected |

Smaller classes: id reuse (10 still failed; the A0503 sequence fix is exact and 23 of 27 were repaired), budget exhaustion and view gap (none recorded).

## What was changed for the tooling-fixable classes (2026-10-07, `docs/history/2026-10-07-failure-fixes-preregistration.md`)

All general (no task named), all keep the canonical text, revisions and `compiler/*.a0` unchanged:

1. **Markdown fences** (`stripCodeFences` in `src/edit.ts`): a line that is only ` ``` ` or ` ```lang ` in an edit reply is dropped. No A0 line starts with a backtick.
2. **Exact delete** (A0504, rule `delete-text`): `-id <old node text>` without a replacement carries the exact edit `-id`; `fix all` applies it.
3. **Op spellings** (A0102, rule `alias`): a callee that is `sel`, `lte`, `gte`, `ule`, `uge`, `ult`, `ugt`, `neq` or `equ`, with the operand count of the op it
   names, carries the exact rename (the same mechanism as the existing `mod` to `rem`). They are not accepted as ops: the grammar keeps one spelling.
4. **Callee below the caller** (`validateOrdered` in `src/edit.ts`): an edit that makes a function call one defined below it is accepted with that callee moved
   to just above its first caller (callees first, each in the order written; nothing else moves; a cycle or any other error keeps the original diagnostic).
5. **Function frame** (A0026): the fix text names the line to write (`ret <last node>`), as a suggestion, not an exact fix.

Each has a unit test (`test/failure-fixes.test.ts`) and, where it is a fix, a reject-corpus case (`corpus/reject/op-sel.a0`, `corpus/reject/edit-delete-text.edit`).
The measurement of these changes on the previously failed application-scale tasks is `docs/history/2026-10-07-failure-fixes-preregistration.md` and `results/app-edit-fixes.json`.
