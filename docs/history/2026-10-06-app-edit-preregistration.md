# Pre-registration: application-scale edits, A0 against TypeScript (written before any subject saw the set)

Date: 2026-10-06. Written and committed before any model subject was run on this set. No model was called while the
harness, the tasks or this note were written; the only runs were the harness self-checks with scripted reference and
wrong replies (`results/app-edit/self-check.json`).

## The question

The small-function sets (a to w) measure edits of one short function. Here the question is the edit an AI author makes
inside an application: hundreds of lines across many functions, where the change has to be found and made in the right
places. How many tokens per accepted edit, and how many accepted edits, does a realistic maintenance change cost in A0
(the structured, revision-checked edit protocol of `src/edit.ts`: views, handles, edit lines) and in TypeScript (the
reference implementation of the same program, edited by a unified diff)?

## The application and the two sides

The application is the A0 front end, lexer and parser. A0 side: `compiler/parse.a0` linked with `compiler/lex.a0` (the
`link()` of `src/link.ts`, 106 functions, the program `parseio` and `lexsrc` run in the interpreter of `src/core.ts`).
TypeScript side: its reference `tools/ref-parse.ts` up to the suggestions section (`refLex`, `refParse`; the same token
grammar and the same word IR, which `test/core.test.ts` checks against the A0 program on every example). The file is
shown to the subject as `front.ts`. Both start programs are fixed by SHA-256 in `START_SHA256` of
`tools/app-edit-tasks.ts`; the harness refuses to run when either has changed.

## The set

14 tasks, `tools/app-edit-tasks.ts`, sealed by `tools/app-edit-tasks.sha256` (SHA-256 of the file,
`d6de17379984b7e87ada47194d9d7bc12a7d2ef4d306e99cc7c474f71a4282fb`), never altered after this note; an error found later
goes in an errata file next to it, as for sets e and f. Each task has the plain-language instruction (the same text on both
sides), the A0 functions its view opens, hidden tests, a reference reply per side, and a wrong-but-plausible reply per side.

| id | change request |
|---|---|
| semicolon-comment | a semicolon also starts a comment that runs to the end of the line |
| tab-is-error | a tab is no longer whitespace but a one-byte error token |
| fat-arrow | `=>` is accepted as a second spelling of the arrow token |
| op-alias-mod | `mod` is accepted as a spelling of the `rem` operation |
| drop-unsigned-aliases | the `udiv` and `urem` spellings are withdrawn |
| text-escape-r | the text-literal escape `\r` decodes to a carriage return |
| text-escape-zero | the text-literal escape `\0` decodes to a zero byte |
| profile-canonical | a first line `profile canonical` is accepted as the explicit default profile |
| array-length-limit | array lengths in type words are limited (at most 4096) |
| param-limit | a function header may declare at most 8 parameters |
| duplicate-fn-structure | a second function with an existing name becomes a structure error, not a parse error |
| number-leading-zero | a number literal with a leading zero (other than `0`) is a parse error |
| unreserve-patch | the word `patch` is no longer reserved |
| use-alias-import | `import "file.a0"` is accepted as a second spelling of a `use` line |

Hidden tests run the edited program: `lex` tests compare the token triples of `lexsrc` (A0) and `refLex` (TypeScript);
`parse` tests compare the listed fields of the word IR of `parseio` and `refParse`; `same` tests require the whole word IR
of the unedited reference on three regression programs. Both sides are compared to the same expected values. The expected
values were computed once from the TypeScript reference reply and are confirmed by the A0 reference reply, which was
written independently in A0.

Harness validation (`bun tools/app-edit-bench.ts self-check`, recorded in `results/app-edit/self-check.json`): on both
sides every reference reply passes, every start program fails at least one test, and every wrong reply applies and fails.

## What each subject sees (the primers)

- A0: the shipped `MODEL_GUIDE.min.txt`, then the structured protocol paragraph of `tools/ai-edit-experiment.ts`, whose
  last clause (no handle line) is replaced by the rule for several e handles, which three tasks open
  (`A0_PROTOCOL` in `tools/app-edit-bench.ts`). The request is the instruction, then the view: each target function under
  an e handle (dependency scope: the body and one signature line per callee), then the program handle with one signature
  line per function.
- TypeScript: one neutral sentence of the reply format and nothing else (`TS_PROTOCOL`: reply with only a unified diff of
  `front.ts`, hunks whose context and removed lines match the file exactly, no code fence). The request is the
  instruction, then the whole file. A unified diff is chosen over replacing whole named functions because `refParse` is one
  function of about 430 lines: replacing it for a one-line change would charge the TypeScript side for re-emitting the
  function, which no agent does with a large file. The harness applies hunks by their old text (the `@@` line numbers only
  break ties between several matches), as `patch` does with fuzz.

`bun tools/app-edit-bench.ts dump` writes these exact prompts; they are what the subjects receive.

## Method

Fresh Haiku and Sonnet subagents, one subagent per prompt (task, side, model: 56 first replies), no group files, because
each request carries a whole application view. One shot, then one repair: a rejected reply (refused by the edit session
or the diff applier, a type error from `tsc` on the TypeScript side, or a failing hidden test) is rolled back on both
sides and answered with the harness's own rejection message (the first six failures, then "Nothing was applied", then
"Try again"); the repair prompt is built by `tools/ai-edit-subjects.ts repair` (system, request, the subject's own reply
and the rejection), one fresh subagent each. A subject refused by an API safeguard gets the identical request once more,
never reworded; a second refusal or a missing reply is a failure. Controls and variants are collected in the same session.

## Metrics

From `tools/app-edit-summary.ts` (`results/app-edit.json`), per model and side, n = 14:

- one-shot acceptance and repaired acceptance, counts with Wilson 95% intervals;
- tokens per accepted edit (o200k_base, local counts) at the horizons of `tools/set-h-summary.ts`: system tokens weighted
  1.25 then 0.05 per further call (cold task), 0.17 then 0.05 (10-task session), 0.05 per call (unbounded), plus the
  request (instruction and view), each rejection sent, and every reply, summed over the trials and divided by the
  accepted count.

## The rule

Primary: repaired acceptance and tokens per accepted edit at the 10-task horizon, per model, raw numbers. For each model:
A0 wins when its repaired acceptance count is not lower than TypeScript's and its 10-task cost is lower; TypeScript wins
the same way round; a tie is equal acceptance counts with costs within 5 percent of the lower (claim-ok: a decision band
fixed in advance, not a measured value); anything else is mixed. One-shot acceptance and the other two horizons are
secondary and reported for every cell. Wins, ties and losses are all reported, whatever the outcome, in a result note next
to this one; nothing is shipped or claimed in STATUS.md from this set beyond what that note records.

## How to run (exact commands)

```
bun tools/app-edit-bench.ts self-check                    # must print: self-check ok
bun tools/app-edit-bench.ts dump results/app-edit/dump.a0.json a0
bun tools/app-edit-bench.ts dump results/app-edit/dump.ts.json ts
bun tools/ai-edit-subjects.ts prompts results/app-edit/dump.a0.json <scratch>/<model>/a0/prompts
#   one fresh subagent per prompt file writes <key>.reply.txt (the bare reply) into <scratch>/<model>/a0/replies
bun tools/ai-edit-subjects.ts collect results/app-edit/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/replies.json
bun tools/app-edit-bench.ts run <scratch>/<model>/a0/replies.json results/app-edit/report.<model>.a0.json a0 <model>
bun tools/ai-edit-subjects.ts repair results/app-edit/report.<model>.a0.json results/app-edit/dump.a0.json <scratch>/<model>/a0/replies <scratch>/<model>/a0/repair-prompts
#   one fresh subagent per repair prompt writes <key>.repair.txt into <scratch>/<model>/a0/replies; then collect and run again
bun tools/app-edit-summary.ts                             # after both models and both sides
```

The same with `ts` for the TypeScript side, and `haiku` and `sonnet` for `<model>`.
