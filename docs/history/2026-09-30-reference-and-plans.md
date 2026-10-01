# A0 history, 2026-09-30: Related work, repository notes, blockers and plans as of 2026-09-30

claim-check: archive. This is a dated record of work on the date above, kept for the evidence trail. Figures are
as measured at the time; some were taken on a loaded benchmark host and are not publishable timings. The current
state and the current numbers are in [STATUS.md](../../STATUS.md) and in results/.

## Related work (studied 2026-09-29, from public repos/docs only; nothing built or reproduced)

A list of 20 repositories was supplied. The eight closest were read via their READMEs,
ADRs, specs and evaluation files. Summary of what each measured, and what A0 takes from it:

| Project | What it is | Measured evidence it publishes | Relevance to A0 |
|---|---|---|---|
| Tacit (weetster/tacit) | AST-authoritative language for models; BLAKE3 content-addressed nodes, De Bruijn variables, names as sidecar metadata; authoring vs inspection views; LLVM native | One-shot 29/47 tasks (61.7 %), repair loop 40/47 (85.1 %), 1.53 calls/task; primer 15.5k tokens per call, 755k tokens for the Tacit run vs 4.6k for Python; every recorded run fails its own token gate | Closest architecture. Confirms A0's measured problem: primer/setup cost dominates whole-task tokens. Its four separate token buckets, hole nodes for malformed edits, structured diagnostics (expected/actual/fix/related), and sealed held-out task manifests are worth adopting |
| AILANG (sunholo-data/ailang) | Effect-typed functional language with agent tools (prompt/check/run/eval); tree-walking interpreter | 528–980 run evals: AILANG 53–72 % vs Python 58–76 % on its own suite, repair success 24–30 %; more tokens than Python | Error-code taxonomy with repair hints, per-release baselines, language-neutral prompts with exact-output oracles. Its own numbers show a new language losing to Python on cost and pass rate |
| SLOP (slop-lang/slop) | S-expression language with mandatory intent/pre/post, range types, Z3-checked postconditions, typed holes filled by tiered models; C target | None published | Typed holes as the unit of model work; range-typed integers. Contract overhead is unmeasured |
| Isu / Sui (TakatoHonda/sui-lang) | Structured pseudocode → canonical JSON IR; hierarchical stable step ids; single-verb `REPLACE <StepID>` patch protocol; interpreter only | Proposed metrics only (byte-level determinism, patches-to-pass) | Step ids shared by edits, diagnostics and runtime traces; canonical round-trip. Directly comparable to A0's handle protocol |
| Vera (aallan/vera) | No variable names (typed De Bruijn slots), effect rows, requires/ensures with Z3 tier vs runtime tier vs disclosed-unsupported; Wasm | VeraBench 60 problems, 9 models, six reach 100 %; beat a name-based twin on all five compared models (confounded by compiler changes) | Proved / runtime-checked / unsupported disclosure per contract; stable numbered error codes with JSON and fix snippet; controlled name-based twin comparison |
| Almide (almide/almide) | Statically typed, one syntax per concept, diagnostics emit the exact missing code; native via Rust and direct Wasm | 38-task dojo at temp 0: Llama 3.3 70B 65 % pass / 39 % one-shot; language rule: reject a feature if median retry-success drops ≥3 points | Governance of language design by benchmark regression; one-shot vs after-retry split |
| Unison | Hash-identified definitions, names as metadata, per-hash compile and test cache | Production language | A0 already keys emission by semantic revision; extend the key to validation verdicts and per-function test outcomes once the 39 ms cached floor is profiled |
| XLS (google/xls) | DSLX → IR → scheduled pipelines → Verilog; interpreter / JIT / RTL cross-checked by fuzzer; delay models | Google-scale HLS toolchain | A0 already differential-tests SV against the oracle. Next bounded step: Yosys logic-depth per op before any scheduler; multipliers as library cells |
| egg, Alive2, MultiPL-E, XGrammar | Equality saturation; translation validation; benchmark translation; grammar-constrained decoding | Established tools | No measured need yet for egg or XGrammar (5946/5946 oracle agreement, zero repairs in the scripted run). Alive2-style bounded equivalence over 32-bit bitvectors is feasible for pure A0 functions; MultiPL-E's status taxonomy (OK/Timeout/SyntaxError/Exception) should replace A0's failure count |

Aether (GoogleCloudPlatform) is archived (2026-05-07); Souper is archived (2025-10-30);
Marsha compiles with an LLM in the loop, the opposite of A0's deterministic compiler.

Assessment. "A language designed for AI" is explored prior art; none of the projects that
publish numbers shows a token or pass-rate win over Python on whole-task accounting, and
the two with the closest architecture (Tacit, AILANG) report losses on tokens. A0's own
scripted run shows the same shape (setup cost dominates, small output win on structured
edits). A0's distinguishing claims must therefore be evidence-based on total outcome:
accepted edits per token including setup, repair count, cache hit cost, and cross-target
execution, against Python/TypeScript/Rust baselines with sealed held-out tasks.

Adopted into the next-actions list (each bounded, with a measurement that decides it),
with status as of 2026-09-29:

1. **Done.** Separate token buckets (language primer, workflow primer, tool context,
   output), per-attempt failure status, one-shot vs after-repair acceptance in
   `results/ai-edit-experiment.json` (see the Gate 6 table above).
2. **Done (unmeasured effect).** Structured diagnostics: every `A0Error` now carries a
   stable `code` (parse / type / structure / limit / edit / patch / revision / handle /
   runtime / cli), `expected`, `actual`, `fix`, and `toJSON()`; the highest-value sites
   (type mismatch, undefined reference, unknown op, arity, stale or consumed handle,
   revision mismatch) state the one action that resolves them. The harness and CLI
   report `code: message fix: …`. Whether this removes repair rounds needs live runs;
   the scripted run had zero repairs, so there is no before/after number yet.
3. **Done.** `taskSetSha256` in the experiment report attests the exact held-out task set
   (sources, instructions, tests). Sealing against the in-session subject is impossible
   (the subject wrote the tasks); the hash protects future runs against silent task edits.
4. **Measured and fixed.** Warm `compileCached` on Life (14 functions, all hits): cache
   lookup was 90 % of the time (js 15.7 of 17.4 ms; c 28.7 of 32.2 ms), parse+validate
   ~1 ms, hashing <1 ms. The cost was per-file latency of serial `await readFile`, not
   bytes (10 KB total) and not validation, so validation-verdict caching was rejected.
   Fix: all lookups issued concurrently (`Promise.all`). Interleaved A/B in one process
   (Life, target c, all hits, 40 runs × 3): sequential 5.7–12.1 ms vs concurrent
   1.8–3.8 ms, a 3–4× faster warm path. `results/benchmark.json` wall-clock numbers
   from this session are unreliable: the machine's load average was 50–160 from other
   applications, and back-to-back runs of identical code varied up to 25×.
5. **Measured, then implemented.** Yosys `synth -noabc; ltp -noff` over the 48 corpus
   modules showed bimodal depth: every module without a surviving `div`/`rem` had longest
   path ≤ 56 gates (median 22.5 among combinational modules); every module with one was
   ≥ 347, up to 1751, because Yosys lowered `/` and `%` to a single-cycle restoring 32-bit
   divider (~500–600 gate levels each, stacked when dependent). Multipliers were cheap in
   depth (two 32-bit `mul`, no div: 47). The earlier note blaming multipliers for the ABC
   stall was wrong. Change (v0.8.7, `src/hw.ts`, compiler version a0c-0.1.1 so cached SV bodies are invalidated): `div`/`rem` are now stages that call a
   shared 32-cycle iterative divider (`a0_udiv`, start/done handshake, division by zero
   per the language in one cycle); any function containing one, or calling one, becomes
   clocked, and loop predicates may now be clocked (predicate handshake before each body
   step; io-carrying clocked predicates are rejected). Measured on the corpus
   (`results/hardware.json`):

   | | before | after |
   |---|---|---|
   | clocked modules | 10 of 48 | 48 of 48 |
   | Icarus cases | 5946 pass | 5946 pass |
   | simulation time | 10.7 s | 54 s (32 cycles per divide) |
   | Yosys `synth -noabc` time | 168 s | 7.6 s |
   | total generic cells | 260 146 | 78 835 (−70 %) |
   | largest module (g44) | 104 460 cells | 1 175 cells |
   | full `synth` with ABC | stalled > 5 min | 44.5 s, whole corpus |

   Losses recorded: every module with division now needs a clock and 32+ cycles per
   divide, and 38 previously combinational modules became clocked; no pipelining or
   scheduling beyond this, and no timing/area on a real library.

6. **Done.** `bun run equiv` (`tools/equiv-verify.ts`, Z3 via the `z3-solver` package,
   QF_BV 32-bit): for every corpus function whose values carry no io, the optimized
   function is proved equal to the source function on all inputs (arrays and records
   element-wise, `get`/`set` as `index mod N`, calls inlined, `fold`/`loop` with literal
   counts ≤ 64 unrolled with the loop predicate gating each step). Result
   (`results/equivalence.json`): 38 of 48 proved, 0 counterexamples, 0 unknown, 10 out of
   scope (io in signature). Self-check: swapping one arithmetic op in a proved function
   yields a counterexample. Scope statement as Alive2's: intra-procedural, io-free,
   literal-bounded iteration; io functions remain covered only by the sampled corpus.

## Reference

- a0lang.com is deployed (2026-09-29, approved by the maintainer): Vercel project `a0lang`, domain verified on Vercel DNS. **The whole site is one A0 program** (v0.8.8):
  `site/page.a0` linked with `examples/life.a0` by whole-program concatenation, compiled to
  wasm32. The program emits the stylesheet (STYLE), every element and string, the buttons,
  the Life grid (GRID, drawn on a canvas by the runtime), the run timer (TIMER), and its
  own 35-word persisted state (counter, generation, running, 32 grid rows). The browser
  runtime `site/app.ts` is generic: it feeds events in, builds DOM from the stream, and has
  no page-specific markup, style, or logic. Verified live in the browser: hero, benchmark
  tiles and bar charts (percentages, ratios, and bar widths computed by the A0 program from
  the numbers in results/*.json via a SIZE command; wins and losses both shown, JS emitted
  code and whole-task tokens as losses), Life glider stepping under the A0 timer, counter
  and echo. The io buffers for the
  page are widened through the new `ioInputCapacity`/`ioOutputCapacity` compile options
  (C prelude only). Life's entry function was renamed `life` (acceptance tool updated).
  Redeploy: `bun run site`, then `vercel deploy --prod` from a directory holding
  `site/dist/{index.html,app.js,page.wasm}` (CLI login).

## Repository

**Public since 2026-09-30 under the MIT license** (maintainer decision, superseding the earlier
"private during research" rule): https://github.com/Joe-Simo/a0. Tracked files were scanned
for secrets before the change (none; `results/tokens.json` and `tools/token-bench.ts` are
token counts).


GitHub repo `Joe-Simo/a0` (public, MIT), branch `main`, project
at repo root, `bun.lock` committed, `dist/` and `node_modules/` ignored. Commits are
listed by `git log`; the push is verified against `origin/main` after each commit.

## Blockers / not done

- GitHub Actions CI (`.github/workflows/ci.yml`) is committed but does not start: GitHub
  reports a billing/spending-limit problem on the project's GitHub account (ignored for now). Regressions are gated by the local suite: `lint`, `typecheck`, `test`,
  `verify`, `hw`, `app`, `equiv`, `bench`, `tokens`, `exec-bench`.
- `A0-Research-Starter.zip` absent (see Provenance).
- Gate 6 live runs: spend was authorized by the maintainer on 2026-09-29, but no API key was configured on the benchmark host, so the run is unrun.
  With a key: `ANTHROPIC_API_KEY=… A0_ALLOW_PAID_MODEL_CALLS=1 bun run experiment`.
- No Claude-tokenizer counts (needs `count_tokens` with credentials).
- Not implemented: memory/regions beyond fixed arrays, FFI, network edit
  service, hardware pipelining/scheduling beyond the multi-cycle divider, timing/area on a
  real cell library, mobile packaging.
- Toolchain note: the project needs an arm64 Node 24 first on PATH; an x64 Node makes `biome` fail to load its native binary. Benchmarks taken this session were under load averages of
  50–160 from other applications and are unreliable for sub-2× comparisons.

## Next concrete action

1. **Gate 6 live run when spend is authorized**: `A0_ALLOW_PAID_MODEL_CALLS=1 bun run
   experiment` (claude-opus-5-5, 3 trials per cell, 78 cells). Report acceptance,
   one-shot vs after-repair, whole-task buckets (primer counted per call, cache-adjusted
   with provider usage), and failure taxonomy; record wins, ties, losses separately.
2. **Cut the primer**: the language primer is 72–83 % of A0's uncached whole-task spend.
   Measure acceptance against a shorter guide (target ≤ 300 tokens) on the scripted run
   before spending; keep the guide only as long as acceptance holds.
3. **View size**: A0's structured view (function handle + program handle) is the largest of
   the six cells; measure a single-handle view that still allows signature changes.
4. Site: add docs/guide pages as further A0 programs or routes once the language guide is
   stable; keep the runtime generic.
5. Hardware: clocked predicate/body handshakes cost cycles; measure per-module cycle counts
   and decide whether a single-cycle `div` by a literal (constant divisor) should stay
   combinational. Optionally run the full ABC synth in `bun run hw` behind a flag.
6. Keep MLIR/LLVM, GPU, and .NET scope unchanged unless a measured need appears
   (`results/exec-benchmark.json` ties vs C and Rust on all kernels).

### No primer and lazy primer (single-function tasks)

On single-function tasks A0 lost to TS/Rust only through the primer. Two harness options remove it (`A0_EXPERIMENT_PRIMER`, default unchanged `always`): `none` makes the A0 system text only the edit protocol (`PROTOCOL_STRUCTURED_A0_SELF`, 64 o200k tokens: the guide's EDIT rules on their own), so the model infers A0 from the view. `lazy` does the same on the first attempt and adds `MODEL_GUIDE.tiny.txt` (`A0_EXPERIMENT_LAZY_GUIDE`) to the repair message only after a protocol or compile rejection. The lazy primer is charged to the language-primer bucket. Both modes allow exactly one repair.

Method: fresh Haiku and Sonnet subagents, one shot, each reading one group file (sets a, b, d; structured cells). The first-attempt prompt is identical under none and lazy, so one set of first replies serves both. Retries: fresh subagents per model and group (A0-none, A0-lazy, TS, Rust), given system, request, the earlier reply, and the exact repair message. TS/Rust got the same one retry. TS/Rust relaxed replies for b and d are the existing ones from the relaxed-protocol collection. Set a had no relaxed TS/Rust replies, so they were collected fresh. Results: `results/ai-edit-experiment.{,b.,d.}{haiku,sonnet}-primer-{none,lazy}.json`.

How cost is counted, in o200k tokens per task: the system text is charged 1.25x on the first call of a session and 0.05x on each later call. Everything else is charged 1x each time it is sent. A retry re-sends task + view + first reply + repair (including the lazy primer). A 10-task session amortizes the cache write over 10 tasks. Unbounded means the system text costs 0.05x on every call.

Pooled over a+b+d, 76 trials per cell (Haiku 38 + Sonnet 38):

| cell | one-shot | after 1 retry | calls/task | system | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|---|
| A0 no primer | 65/76 | 72/76 | 1.14 | 64 | 235 | 166 | 158 |
| A0 lazy primer | 65/76 | 75/76 | 1.14 | 64 | 262 | 193 | 185 |
| TS relaxed | 67/76 | 76/76 | 1.12 | 126 | 284 | 148 | 133 |
| Rust relaxed | 68/76 | 74/76 | 1.11 | 141 | 312 | 160 | 143 |
| A0 min primer (existing, one shot, b+d only, 50 trials) | 50/50 | - | 1.00 | 443 | 674 | 195 | 142 |

By model: Haiku A0 none 30/38 -> 35/38, lazy 30/38 -> 38/38, TS 34 -> 38, Rust 32 -> 36. Sonnet A0 none 35/38 -> 37/38, lazy 35 -> 37, TS 33 -> 38, Rust 36 -> 38. Haiku set b is the weak spot for A0: 7/12 one shot. With no primer, the retry brings it to 10/12, and 10-task-session cost is 275 vs TS 159.

Findings:
- **Single task (the cold case): A0 now wins.** No primer costs 235 vs TS 284 and Rust 312. Lazy costs 262. The primer was the whole gap, and TS/Rust still carry their semantics notes (126/141 tokens) against A0's 64-token protocol.
- **10-task session and unbounded: loss.** Once cached, the system text is almost free for every language. What remains is A0's extra retries and larger replies: none 166 vs TS 148 vs Rust 160; unbounded 158 vs 133 vs 143. Lazy is worse still (193 / 185), because the tiny primer travels uncached inside the repair.
- **Acceptance: loss for no primer, parity for lazy.** A0 one-shot acceptance without a primer is 65/76, against 50/50 with the min primer on b+d. No primer ends at 72/76 after one retry, below TS 76/76 and Rust 74/76. Lazy recovers to 75/76. The error message alone repaired 7 of 11 first-attempt failures. Error plus primer repaired 10 of 11.
- The default stays `always` (MODEL_GUIDE.min.txt). `lazy` is the candidate for cold single-task use, and it pays about 45 tokens per task in a session.

A0 syntax that models guessed wrong without a primer (first attempts, both models). These are candidates for making the syntax more guessable. The language was not changed in this task.
1. Calling a function by its name as the op (`r dot p0 p0`, `popcnt`, `limit`, `extract`), not `call F ...`. 4 of Haiku's 5 set-b parse failures.
2. Nested operands (`(sub ...)`), the same shape as grammar item B.
3. Guessed op names: `udiv` for `div`.
4. `get` used on a record (record vs array access, `at` vs `get`).
5. fold callee arity: extra arguments passed to a fold step that takes none.
6. Instruction lines sent under the program handle without a `fn` header (`expected 'fn', got 'a'`).
7. Retries that attempted recursion, called a function defined later (definition order), or used an uppercase id (`A1`).
One remaining failure is a type error (a bool returned where u32 was declared). A second is a wrong-output model error on b-checksum-poly (Haiku).

### Guessable spellings (no primer, re-measured)

The no-primer failures above were turned into language decisions (DESIGN.md, "Decision, guessable spellings"). Accepted as other spellings of exactly one canonical form, in `src/core.ts`, `src/edit.ts`, `compiler/parse.a0`, `compiler/front512.a0` and `tools/ref-parse.ts`: `ID F ARGS` and `ret F ARGS` for `call F` (F a function name that is not an op; ops win; checked exactly like `call`), and `udiv`/`urem` for `div`/`rem`. In edits, instruction lines after a block's explicit `end` edit the handled function, and a function added in the same reply that the handled function calls is placed before it (the d-calc-inc-first reply shape). Rejected with a one-line fix: parenthesised operands (the fix names the node to add and the rewritten line; `ret (a, b)` gets `ret rec a b`), `get`/`set` on a record and `at`/`put` on an array, instruction lines outside a `fn` block, and a misspelt op (now an unknown callee whose fix lists the ops). Canonical output, revisions and emitted code are unchanged (COMPILER_VERSION not bumped). The primers were not changed.

Method: identical to the subsection above. The A0 prompts are byte-identical to that collection (checked against its dump), so the parser is the only change. Fresh Haiku and Sonnet subagents, one shot, one group file each (sets a, b, d), then one retry per failed trial by a fresh subagent per model, given the reply and the checker's message. TS/Rust are the numbers of the subsection above (their prompts do not depend on A0). Results: `results/ai-edit-experiment.{,b.,d.}{haiku,sonnet}-primer-none-guessable.json`.

Pooled over a+b+d, 76 trials per cell, cost per task in o200k tokens:

| cell | one-shot | after 1 retry | calls/task | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|
| A0 no primer, guessable spellings (fresh replies) | 64/76 | 74/76 | 1.16 | 237 | 168 | 160 |
| A0 no primer (subsection above) | 65/76 | 72/76 | 1.14 | 235 | 166 | 158 |
| TS relaxed | 67/76 | 76/76 | 1.12 | 284 | 148 | 133 |
| Rust relaxed | 68/76 | 74/76 | 1.11 | 312 | 160 | 143 |

By model: Haiku 29/38 -> 36/38 (earlier 30 -> 35), 258 / 189 / 181 tokens; Sonnet 35/38 -> 38/38 (earlier 35 -> 37), 216 / 147 / 139.

Findings:
- **The accepted spellings work where they are guessed.** The same earlier replies re-scored with the new parser: one-shot 65/76 -> 69/76 (Haiku `dot`, `popcnt`, `limit` direct calls and Sonnet `udiv` now parse). In the fresh collection Haiku again wrote `r dot p0 p0`, `r limit ...`, `r popcnt ...` on set b, and all three were accepted one shot; under the old parser they were rejections.
- **Pooled one-shot acceptance did not rise: 64/76 vs 65/76.** The fresh sample failed on other guesses: `lte`/`gte` for `le`/`ge` (2), an uppercase id (`M`), `at` on an array, `get` on a record, a fold step given an extra argument, `loop` used as `fold`, goto-style control flow, a bool returned for u32, and three wrong-output replies. Only 2 of the 12 fresh first-attempt failures were of a form this change handles (both record/array access, rejected with the new fix, both repaired on the retry). Sample-to-sample variation (about ±3 of 76) is as large as the effect.
- **Retries improved: 74/76 after one retry vs 72/76.** 10 of 12 failures were repaired from the message alone (earlier 7 of 11). The two unrepaired: Haiku absdiff (wrong output twice) and Haiku b-bounds-largest (uppercase id again).
- **Cost: single task still wins, sessions still lose.** 237 vs TS 284 and Rust 312 for one task; 168 vs 148 / 160 in a 10-task session; 160 vs 133 / 143 unbounded. The loss in sessions is the retry rate (1.16 calls/task vs 1.12 / 1.11) and longer replies, not the system text.
- Candidates for a further step, not taken here (adding spellings measured on the sample that found them would overfit): `lte`/`gte`/`neq` spellings, and a fix hint for uppercase ids.

### Rules-only primer (the rules models break without one)

Question: what is the smallest primer that keeps A0 acceptance at or above TS, given the guessable spellings above?

Ranking. The two no-primer first-attempt samples (the earlier replies re-scored with the guessable parser, plus the fresh guessable collection; 152 trials, 19 failures) were matched against the MODEL_GUIDE.min.txt rules. Violations per rule, counting replies:
- fold step contract: 4. The step is called as `F(state, i, extras...)`, and models passed extras it does not take, used `loop` as `fold`, or read `i` as the element.
- record vs array access (`get`/`set` on a record, `at` on an array): 4.
- no nested operands: 2.
- exact op names (`lte`/`gte`): 2.
- comparison result is bool (d-isdiv-bool kept `-> u32`): 2.
- lowercase ids, tuple return via `rec`, no labels or goto: 1 each.
- wrong output, not tied to any rule: 4.

Never violated: io and linear tokens, `use`, div/rem by zero, shift masking, `text`/`puts`, `loop`, parameter names, and the header syntax (the view shows it).

Primers. The harness gets a new option, `A0_EXPERIMENT_PRIMER=rules`: the guide (`A0_EXPERIMENT_GUIDE`, trailing newline trimmed), then the self-contained edit protocol of `none`, with one repair. The guide carries no EDIT line, so the protocol appears once.
- `MODEL_GUIDE.rules.txt`, 71 o200k tokens, system text 136:
  `A0: one `id op args` per line, no nesting, lowercase ids. Ops: add sub mul div rem and or xor shl shr select eq ne lt le gt ge(->bool) call arr get set(arrays) rec at put(records) fold F n s a..: s=F(s,i,a..) for i<n`
  The op list is space-separated with no separators or groups; every op is 1 o200k token except `shl` (2). `mov`, `loop`, io and all semantics notes are left out.
- `MODEL_GUIDE.rules2.txt`, system text 129: the same without `lowercase ids` and `(->bool)`, the two rules ranked lowest that cost tokens. The bool rule had not prevented d-isdiv-bool under `rules`.

Method: the same as the two subsections above. Fresh Haiku and Sonnet subagents, one shot, one group file each (sets a, b, d), then one retry per failed trial by a fresh subagent per model, given the reply and the checker's message. TS/Rust are the relaxed replies of "No primer and lazy primer". Results: `results/ai-edit-experiment.{,b.,d.}{haiku,sonnet}-primer-{rules,rules2}.json`. Self-check ok in all 12. Costs are computed as above.

Pooled over a+b+d, 76 trials per cell:

| cell | system | one-shot | after 1 retry | calls/task | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|---|
| A0 rules primer | 136 | **73/76** | **76/76** | 1.04 | 291 | **145** | **128** |
| A0 rules2 primer | 129 | 69/76 | 76/76 | 1.09 | 294 | 154 | 139 |
| A0 no primer, guessable | 64 | 64/76 | 74/76 | 1.16 | 237 | 168 | 160 |
| TS relaxed | 126 | 67/76 | 76/76 | 1.12 | 284 | 148 | 133 |
| Rust relaxed | 141 | 68/76 | 74/76 | 1.11 | 312 | 160 | 143 |

By model (rules primer):
- Haiku: 35/38 -> 38/38, costing 301 / 154 / 138, against TS 34 -> 38 at 282 / 146 / 131 and Rust 32 -> 36 at 337 / 184 / 168.
- Sonnet: 38/38 one shot, costing 282 / 135 / 118, against TS 33 -> 38 at 286 / 150 / 135 and Rust 36 -> 38 at 288 / 136 / 119.

On b+d only, the sets where the default min primer was measured (one shot, 50 trials: 50/50 at 674 / 195 / 142):
- rules: 47/50 -> 50/50 at 301 / 154 / 138.
- TS: 45/50 -> 50/50 at 290 / 154 / 139.
- Rust: 45/50 -> 48/50 at 321 / 169 / 152.

Findings:
- **Acceptance: the rules primer is above TS and Rust.** One shot it gets 73/76, against 67 and 68. After one retry it gets 76/76, against 76 and 74. Its three first-attempt failures, all Haiku, were repaired by the retry:
  - b-sumfrom-eight: an extra fold argument, although the fold rule is in the primer.
  - d-isdiv-bool: kept `-> u32`, although the bool rule is in the primer.
  - d-rename-twice: used the new name before defining it.
- **Cost against TS: a loss for one task, a win in sessions.**
  - 1 task: 291 vs 284 (+7, +2%). The system text is 10 tokens longer than TS's (136 vs 126), and the 1.25x cache write outweighs the retries saved.
  - 10-task session: 145 vs 148 (-2%).
  - Unbounded: 128 vs 133 (-4%).
  - The pooled figures hide the models. Haiku alone loses to TS at every length (301 / 154 / 138 vs 282 / 146 / 131). Sonnet alone wins at every length.
- **Cost against Rust: a win at all three lengths** (291 / 145 / 128 vs 312 / 160 / 143).
- **Against no primer**, the extra 72 tokens of system text pay for themselves once a session has more than one task (145 vs 168). For a single cold task, no primer stays cheapest (237), at 64/76 one shot.
- **rules2 (7 fewer tokens) is worse.** Haiku one shot fell from 35/38 to 31/38. It had 7 failures, none of them tied to the two dropped rules: a parameter out of range, a duplicate edit, `-fn` under a function handle, a nested operand, a fold extra argument, a wrong output, and isdiv again. This is within subject variance (about ±3 of 76), so the two dropped rules are not shown to matter. What rules2 shows is that 7 tokens of system text are cheaper than the retries that one-shot swings cause. The smallest primer measured to hold TS-level acceptance is `rules` at 136 tokens.
- **Decision: the default is unchanged** (`always`, MODEL_GUIDE.min.txt). The rules primer is far cheaper than the default (b+d: 301 / 154 / 138 vs 674 / 195 / 142), but it does not win on acceptance: it scores 47/50 one shot where min scored 50/50. It also loses to TS for a single task, and on every length for Haiku. `A0_EXPERIMENT_PRIMER=rules` with MODEL_GUIDE.rules.txt is the measured best for sessions.
- Single subjects per cell. Remaining gap to TS on single tasks: 10 tokens of system text. The one rule that still fails despite being stated is the fold step contract; a checker fix that names the step's parameters may do more than primer text.

### Merged rules primer, fold diagnostic, protocol fixes (a0c-0.1.26)

Changes:
- Checker: every fold/loop body mismatch (extra-argument count, missing index parameter, index/state/result/extra types) carries a `fix` naming the header the operands require, the body's actual header, and the operand shape that header accepts, e.g. `... need \`fn addi u32 u32 u32 -> u32\`; addi is \`fn addi u32 u32 -> u32\`; as declared, write \`fold addi N S\` with S a u32 and no extras`. Messages unchanged; mismatched types now report `code: type` with expected/actual. Test: `fold/loop body mismatch` in test/core.test.ts.
- Edit protocol (src/edit.ts, test/edit.test.ts): `-fn f` with a `fn f` block in one reply replaces f in place (was: `both removed and defined`); `-fn f` may repeat f's current signature (a different one is rejected with a fix); an `end` after the handled function's edit lines, before a new block, is dropped. Mixed edit lines + new `fn` block already applied the block first since 810bfab. Rescoring the E/F replies (diagnosis only, not reported as results) removed every protocol-ambiguity rejection; the rest are model errors.
- TS/Rust and the five other language notes state `Division by zero gives 4294967295; remainder by zero gives the dividend.` TS system text 126 -> 143, Rust 141 -> 158.
- `A0_EXPERIMENT_PRIMER=rules-merged` (structured only): the guide is the whole system text. `MODEL_GUIDE.rules-merged.txt`, 118 o200k tokens (rules primer was 136): protocol and rules in one line; the handle sentence and the duplicate `id op args` clause dropped. Every rule violated in the earlier ranking is kept (fold contract, get/set vs at/put, no nesting, op names, ->bool, lowercase ids).

Method: fresh subjects for all three cells (no old replies rescored), structured protocol, sets a, b, d, e, f. One group file per representation for each of a, b, d, and e+f together (12 files), one fresh Haiku and one fresh Sonnet subagent per file (24), one shot; then one retry per failed trial, one fresh subagent per model and representation (4), given system, request, reply and the exact rejection. Cost as in "No primer and lazy primer". Results: `results/ai-edit-experiment.{a,b,d,e,f}.{haiku,sonnet}-rules-merged.json` (+ `.replies.json`). Self-check ok in all 10.

| cell | system | one-shot | after 1 retry | calls/task | 1 task | 10-task session | unbounded |
|---|---|---|---|---|---|---|---|
| a+b+d+e+f pooled (124) A0 | 118 | 113 | 120 | 1.09 | **287** | 160 | 145 |
| TS | 143 | 115 | **123** | 1.07 | 305 | **150** | 133 |
| Rust | 158 | **118** | 121 | 1.05 | 322 | 151 | **132** |
| a+b+d (76) A0 | 118 | 72 | 75 | 1.05 | **274** | **147** | 133 |
| TS | 143 | 68 | 75 | 1.11 | 311 | 157 | 140 |
| Rust | 158 | 72 | 75 | 1.05 | 319 | 149 | **130** |
| e+f (48) A0 | 118 | 41 | 45 | 1.15 | 307 | 180 | 166 |
| TS | 143 | 47 | 48 | 1.02 | **294** | **140** | **123** |
| Rust | 158 | 46 | 46 | 1.04 | 326 | 155 | 136 |

By model (all five sets, 62 each):
- Haiku: A0 51 -> 58, 314 / 186 / 172; TS 53 -> 61, 326 / 171 / 154; Rust 58 -> 59, 337 / 167 / 148.
- Sonnet: A0 62/62 one shot, 260 / 133 / 119; TS 62/62, 283 / 129 / 112; Rust 60 -> 62, 306 / 135 / 116.

Findings:
- A0 wins the single cold task pooled (287 vs 305 / 322) and on a+b+d leads or ties everywhere except unbounded vs Rust (133 vs 130). Pooled over all five sets it loses acceptance (113/124 one shot vs 115 TS / 118 Rust; 120 vs 123 / 121 after retry) and sessions (160 vs 150 / 151; 145 vs 133 / 132).
- The loss is Haiku on the held-out sets E and F: 17/24 one shot, 21/24 after retry (TS 23 -> 24). Haiku failures: wrong output 4 (sum-squares, e-sum-range, f-sumlow-bound, twice each for the last two), fold step given an extra (e-popcount-fold, not repaired even with the new fix text), bool returned for u32 (f-addover-bool, f-countabove-gt path), pair returned without the signature change (f-divrem-pair), nested operand, undefined parameter. None are protocol ambiguities. Sonnet is level with TS on acceptance and cheaper for one task, within 4 tokens in sessions.
- Sonnet unbounded: A0 119 vs TS 112. With equal acceptance, A0's replies plus views are slightly larger than TS's; the 25-token system saving is worth only ~1 token per cached call.
- One subject per cell: Haiku swings of 2-4 tasks per set are within subject variance.

Decision: A0 does not win or tie on acceptance and cost at all three lengths pooled, so the rules-merged primer is not proposed as the default. Defaults unchanged (`always`, MODEL_GUIDE.min.txt).
