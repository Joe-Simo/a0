# Session 2026-10-02: do spec lines pay for their tokens?

The question: `ex` lines (and `pre`/`post`, see DESIGN.md "Decision, spec lines") cost tokens in every view and a clause in the primer; do they buy accepted edits? Nothing in the language changed. Every number below comes from `results/spec-tokens.json` (the token table), `results/spec-lines.json` (the experiment) or the per-cell reports `results/ai-edit-experiment.g.<model>-<cell>.json` (each with its `.replies.json`).

## 1. What a spec line costs in tokens (no model involved)

`results/spec-tokens.json` (`tools/spec-tokens.ts`; o200k_base and cl100k_base, local counts): the examples of each function are its own results on small deterministic inputs, the counted programs validate. Programs: `examples/kernels.a0`, `examples/life.a0`, the twelve set-B programs; the 40-function view is the set-C project program.

| per function (30 functions that can carry examples) | canonical o200k | dense o200k |
|---|---|---|
| no `ex` | 41.3 | 16.2 |
| 1 `ex` | 67.9 (+26.5) | 46.8 (+30.6) |
| 3 `ex` (2.93 lines carried) | 116.3 (+74.9) | 95.2 (+79.0) |

| 40-function view (39 functions carry examples) | canonical o200k / cl100k | dense o200k / cl100k |
|---|---|---|
| 0 `ex` per function | 1368 / 1366 | 534 / 534 |
| 1 `ex` per function | 2000 / 1998 (+632) | 1313 / 1313 (+779) |
| 3 `ex` per function | 3262 / 3260 (+1894) | 2575 / 2575 (+2041) |

An example line is cheaper in the dense view than in the canonical one only because the rest of the function is; added to a dense view it raises it more (+779 against +632 for one line per function), and three lines per function make the dense view 4.8 times its spec-free size while the canonical one grows 2.4 times.

Primer text (`experiments/primers/MODEL_GUIDE.{rules-merged,dense}-spec.txt`, one added sentence, the `MODEL_GUIDE*.txt` files are untouched): system text 118 o200k tokens canonical and 209 with the spec text, 145 dense and 235 with it (`results/spec-lines.json`, `cells.*.system`). The sentence costs about 90 tokens per cold call in both views.

## 2. The experiment

Method (the rules of CONTRIBUTING.md: fresh subjects, nothing written by the author, sealed held-out set):

- **Task set g** (`tools/ai-edit-tasks-g.ts`, SHA-256 in `tools/ai-edit-tasks-g.sha256`, committed before any subject ran): 16 tasks in which a plausible wrong edit exists (3 off-by-one, 3 comparison, 4 swapped argument, 4 wrapping, 2 fold bound; hidden tests, a reference edit and one or two wrong edits each). Written by an Opus subagent that had seen neither the language nor the other sets; it was given only the kind of task, the hidden-test format and a language-neutral JSON program model with the operation semantics, and wrote the starting programs, instructions, tests and wrong edits in that JSON (`experiments/spec-lines/g-tasks.neutral.json`). `tools/ai-edit-tasks-g-gen.ts` only converts the format and checks with the reference interpreter (the starting program fails a test, the reference passes all, each wrong edit fails one). Its three-line report: no author-written line was changed.
- **The examples shown to subjects** were written by a second Opus subagent that saw only the instruction and the starting program (never the tests, the reference or the wrong edits; `experiments/spec-lines/g-examples*.neutral.json`). A candidate is kept only if it is true of the starting program and of the reference and is not a hidden test (the hidden-test authors wrote the natural boundary cases, so many candidates collided and were replaced by a second batch of candidates asked for without saying which collided; task `g-grade-threshold` has no admissible stale example, so cell E has 15 tasks). The first three kept candidates in the author's order are the `ex` lines of cells B and C.
- **Cells.** A: no spec lines, the current primer. X: the primer with the spec text, no spec lines in any view (the control that separates the cost of the primer text from the lines). B: one `ex`. C: three `ex`. D: one `post` property. E: one wrong example (true of the starting program, false of the intended edit), to measure false rejections. Each canonical (primer `MODEL_GUIDE.rules-merged*`) and dense (`MODEL_GUIDE.dense*`, default dense view).
- **Subjects** (`results/spec-lines.json`, `design`): fresh Haiku and Sonnet Agent-tool subagents, one subagent per task and cell, reading only their own prompt file (system text, view, task; `tools/ai-edit-subjects.ts` builds the files and collects the replies, the replies are the subjects' own files), then every failed first reply goes to a fresh subagent given the system text, the request, its own reply and the harness's exact rejection: one shot plus one repair round. Whole-task tokens, cache-adjusted cost (system 1.25x on the first call of a 1-task session, 0.05x on later calls and in an unbounded session) and the failure taxonomy are the existing harness's; a spec-line rejection is a new status `spec`, and a shadow run of the same reply on the program without spec lines (`tools/ai-edit-experiment.ts`) says whether the tests alone would have accepted it.
- **n** (`results/spec-lines.json`, `cells.*.n`). 16 tasks per cell and model (E 15), so 16 trials per cell and model: Haiku ran A, X, B, C, D, E canonical and A, X, B, C dense; Sonnet ran A, X, B, C canonical only. Sonnet D and E and the Sonnet dense cells, and Haiku dense D and E, were not run (budget). A rate is called a win or a loss only when the Wilson 95% intervals do not overlap; at this n almost nothing separates, and **no significance is claimed**.
- **Harness failures.** About 1 launch in 13 returned a subagent that did not do the task ("no task provided"); those were relaunched (no reply was written, so they are not trials). The subjects' tool use was audited from their transcripts: only reads of their own prompt files and writes of their reply file, plus 43 `cat`/`ls` calls in the shared folder and one `find` there (file names only).
- **Known confound.** The repair message of a failed hidden-test run states the failing test and the expected value, as in every other run of this harness, so a repair in cell A is better informed than a real user's would be; the one-shot columns are the clean comparison for what spec lines do.

### Acceptance (`results/spec-lines.json`, `cells.*.oneShot`, `cells.*.accepted`; one shot > after one repair, of 16)

| cell | Haiku canon | Sonnet canon | Haiku dense |
|---|---|---|---|
| A no spec lines | 12 > 14 | 15 > 16 | 11 > 13 |
| X primer text only | 6 > 7 | 13 > 16 | 4 > 4 |
| B one `ex` | 10 > 15 | 14 > 16 | 10 > 10 |
| C three `ex` | 9 > 11 | 10 > 16 | 9 > 13 |
| D one `post` | 11 > 14 | not run | not run |
| E one wrong `ex` (15 tasks) | 7 > 10 | not run | not run |

### Whole-task cost (o200k tokens; `cells.*.costPerTask`, `cells.*.tokensPerAcceptedEdit`)

| cell | system | view | calls per task | per accepted edit, 1 cold task | per accepted edit, unbounded session |
|---|---|---|---|---|---|
| Haiku canon A | 118 | 54.1 | 1.25 | 360.8 | 199.0 |
| Haiku canon X | 209 | 54.1 | 1.63 | 1282.1 | 708.8 |
| Haiku canon B | 209 | 65.4 | 1.38 | 487.6 | 220.1 |
| Haiku canon C | 209 | 87.1 | 1.44 | 758.7 | 393.9 |
| Haiku canon D | 209 | 60.4 | 1.31 | 536.6 | 250.0 |
| Haiku canon E | 209 | 65.2 | 1.53 | 790.6 | 414.4 |
| Sonnet canon A | 118 | 54.1 | 1.06 | 269.9 | 128.3 |
| Sonnet canon X | 209 | 54.1 | 1.19 | 423.4 | 172.6 |
| Sonnet canon B | 209 | 65.4 | 1.13 | 423.6 | 172.8 |
| Sonnet canon C | 209 | 87.1 | 1.38 | 475.6 | 224.8 |
| Haiku dense A | 145 | 39.4 | 1.31 | 428.3 | 214.1 |
| Haiku dense X | 235 | 39.4 | 1.75 | 2364.0 | 1236.0 |
| Haiku dense B | 235 | 50.7 | 1.38 | 803.8 | 352.6 |
| Haiku dense C | 235 | 72.4 | 1.44 | 671.2 | 324.1 |

### What the lines did and did not do (`cells.*.specRejections`, `catchAnalysis`)

- **No spec line ever refused a subject's edit.** In B and C no rejection named a line of the view: every spec rejection (5 trials in B, 9 in C, pooled over both models) was by an `ex` line the subject wrote itself or by more `ex` lines than the limit allows (`specRejections.refusalsByAnExampleTheSubjectWrote`). The subjects' mistakes were mostly format slips, not the plausible wrong edits the set was built around (`failureTaxonomy`), and where they were semantic (wrong result, 11 attempts over all cells) the preserved examples did not cover the input.
- **The examples can catch: mechanically, against the authors' wrong edits** (`catchAnalysis`, no subject involved): one `ex` line refuses 6 of the 17 wrong edits (6 of 16 tasks), three refuse 9 (9 of 16 tasks), a `post` line 0. A reference edit is never refused (0 of 16 in every variant).
- **`post` alone does nothing at edit time.** `validate` evaluates `pre` and `post` only on the examples, so a function with a `post` and no `ex` accepts any edit (checked directly: a violated `post` with no example validates; with an example it is refused as A0716). Cell D therefore measures only what the line costs and what reading it does; `a0 check --prove` is the path that checks it.
- **False rejections caused by a wrong example (cell E, Haiku canon, 15 tasks).** The wrong example refused a correct edit (the same reply passes the hidden tests without the lines) in 4 attempts (`specRejections.staleExampleFalseRejections`); after the repair, in which subjects change or remove the example as the rejection suggests, 10 of 15 trials are accepted against 7 one shot. No false rejection arises in B and C by construction (their examples are true of the reference).

### Failure taxonomy (`failureTaxonomy.perCell`, one rule per category over the checker's first line, class and a general fix proposal in the same file)

- **protocol ambiguity, spec lines after the body.** The spec-text primer says the lines sit "under a `fn` header"; 16 of the 19 non-accepted attempts of Haiku canon X and 3 of Haiku dense X wrote `ex` lines after the nodes, where they parse as a node named `ex` or as a missing `end`. Proposal (general, not applied): accept `ex`, `pre` and `post` anywhere in a reply `fn` block and hoist them under the header (the arrow makes an `ex` line unambiguous), or say "before the first node" in the teaching text.
- **protocol ambiguity, limits not taught.** "At most three `ex`, one `post`" is not in the teaching text; refusals for more lines: 6 in Sonnet C, 3 in Haiku C canon and the others in `failureTaxonomy`. Proposal: state the limits, or keep the first three with a note instead of refusing the edit.
- **protocol ambiguity, dense nesting.** 16 of Haiku dense X's attempts and 4 of B's were "one statement per line; a value used twice needs a name" (prefix nesting is taught, a repeated value is not). Proposal: say so in the dense primer or let the dense parser name a repeated pure sub-expression.
- **model errors, recorded:** a name where a dense parameter letter belongs (14 over the dense cells), duplicate ids (9), wrong results (14), type errors of the edit.

## 3. Verdicts (`verdictsAgainstA`: each cell against the A cell of its model and view)

| axis | wins | ties | losses |
|---|---|---|---|
| one-shot acceptance | none | every cell (n=16 per cell and model; the widest gap is Haiku dense X 4/16 against 11/16, which still ties on the one-shot interval rule and is a loss after the repair) | none |
| acceptance after one repair | none | every cell except Haiku dense X | Haiku dense X (4/16 against 13/16) |
| tokens per accepted edit (1 cold task, 10 tasks, unbounded) | none | none | every cell, both models, both views (the primer text adds about 90 tokens to every call and the lines add tokens to every view) |
| calls per task | none | none | every cell |
| catching a plausible wrong edit | none measured in the subjects' edits (0 refusals by a provided line) | `post` (0 caught of 17 mechanically) | none |

Sentences the data supports, and no more:

- The spec lines did not raise acceptance (B 10 > 15 and C 9 > 11 against A 12 > 14 for Haiku canonical; Sonnet B 14 > 16 and C 10 > 16 against A 15 > 16): a tie at this n, and a loss on every cost axis.
- The control shows the primer text is not free: Haiku canonical X, which has the teaching text and no lines, fell to 6 > 7 from A's 12 > 14, because the text induced the model to write spec lines of its own in the wrong place. Putting lines in the view (B, C, D) brought the format back (10, 9 and 11 one shot), so the lines' effect on acceptance is positive against X and not against A.
- The mechanical analysis says a boundary example can catch a plausible wrong edit (6 and 9 of 17), and the model run did not exercise it: the subjects made few semantic mistakes. A harder or noisier task set, or a weaker model, is where the catch would show; this one is not evidence that the lines do not.

## 4. Files

Token table `results/spec-tokens.json`; experiment `results/spec-lines.json` and `results/ai-edit-experiment.g.{haiku,sonnet}-<cell>.json` (+ `.replies.json`); loss ledger `results/loss-ledger.json` (the spec-line cells that are behind A are recorded: spec-accepted-one-shot, spec-accepted-repaired, spec-tokens-per-accepted); task set `tools/ai-edit-tasks-g.ts` and its seal; neutral sources `experiments/spec-lines/`; primers `experiments/primers/MODEL_GUIDE.{rules-merged,dense}-spec.txt`; tools `tools/spec-tokens.ts`, `tools/ai-edit-spec-variants.ts`, `tools/ai-edit-subjects.ts`, `tools/spec-lines-summary.ts`.

Proposed general fixes, none applied (the language was not changed in this task): hoist or accept spec lines anywhere in a reply block; teach the limits or truncate with a note; name a repeated dense sub-expression; document that a `post` without an `ex` is inert at edit time (or run the solver on small functions at edit time); and, unmeasured here, a whole-function reply that omits the function's spec lines drops them silently, which turns the guard off without a message.
