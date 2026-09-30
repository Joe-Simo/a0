# A0 status ledger

Updated 2026-09-29. Durable state for the next session: scope, evidence, blockers, next action.
Every claim below is either reproduced by a command in this repo or labelled as not run.

## Provenance

The starter archive `A0-Research-Starter.zip` was not present on the workstation, in
iCloud, or on GitHub (full-disk search, both GitHub accounts). This implementation was
rebuilt from `DESIGN.md` and the handoff spec (`HANDOFF.txt`). It follows the documented
package map and semantics but is not byte-identical to the original package; the
original report is kept as `results/verification-handoff-2026-09-29.json` and is *not*
reproduced evidence (different corpus generator, different case count). If the archive
turns up, reconcile against this tree rather than overwrite either.

## Design decisions recorded from the user (2026-09-29)

- Human readability is not a constraint. The representation is optimized for AI read/write
  cost and correctness; audit views may be derived, never the primary form.
- Any change must be rejected before commit if it fails parsing, typing, or revision
  matching; well-typed wrong behavior is caught by acceptance tests, not by syntax.
- Execution performance across targets is a goal with a ledger, not a claim; ties and
  losses stay visible.

## Implemented scope (v0.8.0)

- Types `u32`, `bool`; ops `mov add sub mul and or xor shl shr eq lt select` with exact
  wrapping/logical/unsigned semantics; positional params; one result; straight-line.
- **`call f a...`** (new): applies a function defined *earlier* in the program (acyclic,
  no recursion); typed against the callee; evaluated by interpreter and BigInt oracle;
  constant-folded and CSE'd; emitted as a call in JS/C/Java and as a module instance
  in SystemVerilog.
- **`fold f n s a...`** (new): bounded iteration `state = f(state, i, a...)` for `i` in
  `0..n-1`; u32 trip count guarantees termination. Interpreter, oracle, compile-time
  evaluation up to 4096 trips, zero-trip identity, counted loops in JS/C/Java (Java uses an
  unsigned bound), literal-count unrolling (≤256) in SystemVerilog with a precise
  diagnostic for variable counts.
- **`loop p f n s a...`** (new, Gate 1): `fold` with early exit; predicate `p` shares the
  body's parameters and returns bool; the u32 cap guarantees termination. Same coverage as
  fold (interpreter, oracle, compile-time evaluation, loops with `break` in JS/C/Java,
  literal-cap unrolling with a done-latch chain in SystemVerilog, generator coverage).
- **Arrays and records** (new, Gate 2): types `TxN` and `(T0,…,Tk)`, nestable; ops `arr rec
  get set at put`. Value semantics everywhere (no aliasing, copies on update); `get`/`set`
  reduce the index modulo N so they are total. Interpreter, oracle, optimizer (literal
  `get`/`at` of a built aggregate folds to the element), JS (copy-on-write + shape guards),
  C (structs by value, also C++), Java (arrays clone-on-write, records), SystemVerilog
  (packed vectors, part-selects, `always_comb` for updates). Public functions with
  aggregate signatures are emitted with the documented ABI but the differential drivers
  only call scalar-signature functions; aggregate functions are covered through `call`.
- **Effects** (new, Gate 3): type `io` is a linear capability token; `read t -> (u32,io)`,
  `write t v -> io`. Consumed at most once, one io parameter per function, no tokens in
  arrays or `select`; token dependencies define effect order, so no separate sequencing
  exists. Optimizer anchors effectful nodes (read/write/calls/iterations carrying tokens)
  and still drops pure extractions. Runtimes: JS stream object, C `a0_io` fixed-capacity
  struct (freestanding, also used in Wasm through linear memory at `__heap_base`), Java
  `A0Io`.
- **Sequential hardware** (new, Gate 4, `src/hw.ts`): functions that iterate with variable
  counts, perform io, or call such functions become clocked SystemVerilog modules
  (clk/rst/start/done, in/out word handshakes). Stages of a linear FSM in program order;
  stage results are registers; bodies instantiated once and stepped per clock; sequential
  callees via nested handshakes; loop predicates must be combinational (diagnosed).
  Pure functions stay combinational; literal-count folds in pure functions stay unrolled.
  Not implemented: general regions, pipelining/scheduling beyond one stage per clock,
  timing closure.
- **Application** (Gate 5): `examples/life.a0`, Conway's Life on a 32×32 torus written
  entirely in A0 (17 functions: arrays, folds over 1024 cells, calls, popcount, and an io
  session protocol: 32 rows + command + x + y in, 32 rows out, population as result).
  Acceptance: `bun run app` runs 134 cases (named patterns over 6 generations, toggles with
  wrapping coordinates, clears, 40 seeded random grids) whose expected values come from an
  independent TypeScript Life implementation, through interpreter, optimizer, JS, C (clang
  + UBSan), C++, Wasm, and JVM. Browser: `bun run site` builds `site/dist` (life.wasm, a
  DOM adapter `site/app.ts` that only draws and forwards clicks, index.html); verified in
  the in-app browser: a glider advances by (1,1) after four generations. Not deployed.
- **The page itself in A0** (`site/page.a0`, v0.8.0): the a0lang.com page is an A0 io
  program speaking a small UI protocol over the word stream (OPEN tag, TEXT bytes,
  CLOSE, ATTR, ONCLICK event, STATE word, COMPONENT id); every heading, paragraph,
  button label, click handler, and the counter's decimal rendering (div/rem) come from
  A0. The browser adapter (`site/app.ts`) only interprets the stream, builds DOM, feeds
  clicks back with the persisted state word, and mounts Life as component 1. Verified in
  the in-app browser: three clicks show "Clicked 3 times" with state 3 kept by the A0
  program; Life glider still correct. The remaining non-A0 parts are the adapter and
  the CSS shell (a runtime, like a browser), and the wasm loader.
- **Resource bounds** (user requirement 2026-09-29, compute-bomb protection): the reference
  interpreter takes a fuel budget (default 10^8 node evaluations, shared across nested
  calls) and aborts with a diagnostic; compile-time evaluation in the optimizer is
  fuel-bounded and gives up instead of stalling; the validator computes a static iteration
  bound per function (variable counts count as 2^32, reported in `staticIterations`) and
  rejects programs whose *literal* nested trip counts exceed 2^24; parser input, function
  and node counts, aggregate bit width, array length, edit sessions, emission cache, and
  toolchain process time (120 s) were already bounded; recursion is impossible by
  construction. A 3000-mutation fuzz test asserts every malformed input fails with a clean
  A0Error. Not done: a runtime fuel counter in compiled targets (costs speed; measure
  before adding), memory/time limits per compiled process, sandboxing of toolchains.
- **GPU** (Gate 8, `src/metal.ts`, `bun run gpu`): the io-free corpus mapped to Metal
  Shading Language through an explicit type layer over the C output, elementwise kernels
  per function, executed on the local GPU via a generated Swift host: 4995 oracle cases
  across 31 kernels pass on Apple M3. Exact semantics only; no GPU performance claim,
  no memory-space or scheduling model beyond elementwise dispatch.
- **.NET** (Gate 8, `src/dotnet.ts`, `bun run dotnet`): C# emission (native `uint`,
  clone-on-write arrays, `readonly record struct`s, `A0Io` stream runtime), built Release
  with warnings as errors on .NET SDK 10.0.401 (installed user-locally under ~/.dotnet
  from the official pkg; the Homebrew cask needs an interactive sudo), executed through
  the stdin driver: 5603 cases incl. io streams pass.
- **MLIR/LLVM decision** (Gate 8): not integrated. Evidence: every kernel of the execution
  ledger ties hand-written C and Rust at clang/rustc -O2 (both LLVM); the native path
  already reaches LLVM through C. Integration would add build complexity without a
  measured win; revisit when a workload needs vectorization or fusion the C path cannot
  express.
- **Text input in the UI protocol** (v0.8.6): tag 12 `input` and command 8 ONSUBMIT; the
  adapter sends the field's UTF-8 bytes (count + bytes, up to 64) on every run, and the
  page program reads them into a `u32x64` buffer with a fold over `read`, echoes exactly
  those bytes back through TEXT, and counts submits in its state word. Verified in the
  in-app browser ("héllo A0" → 9 bytes echoed, state advanced) and by the page test
  (interpreter and emitted JS produce identical streams).
- **Strength reduction and io memory bound** (v0.8.5): `div`/`rem` by a literal power of
  two become `shr`/`and` in the optimizer (exact for unsigned); hardware synthesis of the
  corpus fell from 30 s to 23 s (remaining dividers have non-power-of-two literal or
  variable divisors). The reference evaluator caps io output at 2^20 words so a runaway
  writer cannot exhaust memory (test).
- **Persistent artifact cache** (v0.8.4, `src/cache.ts`): on-disk, content-addressed;
  per-function emission keyed by compiler version, target, optimization level, and
  semantic revision (own text + transitive callees); wasm artifacts keyed by toolchain
  identity, flags, and the exact module text. Used by `a0 emit` and `a0 wasm`
  (`A0_NO_CACHE=1` disables, `A0_CACHE_STATS=1` reports). Measured on Life (17 functions):
  cold C emission + wasm build 491 ms, fully cached 39 ms, after editing one leaf function
  161 ms with 6 functions re-emitted (the leaf and its transitive callers) and one native
  rebuild. Correctness: a callee edit invalidates callers (tested); cache-served output is
  byte-identical to uncached output (tested).
- **Model guide compacted** (v0.8.3): every rule retained, 1010 → 610 o200k tokens; the
  A0 experiment setup cost is now 627 (conventional) / 750 (structured) versus 48/127 for
  TypeScript and 63/142 for Rust. Whether the compact wording is as effective for models
  is exactly what Gate 6 measures; both wordings are in git history.
- **Program-level edits** (v0.8.2): a program handle (`g0`) views every function
  signature and accepts whole `fn … end` blocks (replace in place or append) and
  `-fn name` removals, validated as one program and committed atomically; stale after any
  other edit. The experiment gained a `create` task (add `cube` reusing `sq`) and the
  TypeScript/Rust line protocols gained insert (`+n`) and delete (`-n`) so all
  representations can create; 13 tasks, self-check passes.
- **Structured edits and scoped views** (v0.8.1): edit lines now insert (`id op …`, or
  `… @ other` to place after a node), delete (`-id`), and change the result (`ret x`),
  in patches and sessions alike, validated as one function and committed atomically;
  the `deps` view scope shows a function plus one signature line per direct callee, which
  is everything a type-correct edit can depend on. Measured on Life: editing `session`
  needs 239 tokens of view instead of 1746 for the whole program (o200k; 7.3× less to
  read), on top of the 877-token language guide paid once per session.
- **Text, division, streaming** (v0.8.0): `text "…"` desugars to `arr` of UTF-8 byte words
  with the source form retained (quote-aware comments in parser, patches, and sessions);
  `div`/`rem` are total unsigned (zero divisor → all ones / dividend, RISC-V convention;
  a 32-bit divider in hardware, synthesis time rose from 1.6 s to 30 s); `puts t a` emits
  the length word then the elements of a u32 array. Coverage: corpus 5946 cases (94 div,
  111 rem, 8 puts) on all 8 software paths, .NET, GPU (5418 io-free cases, 33 kernels),
  and clocked hardware (puts is a streaming stage). 19 tests.
- **JS emission, aliasing-safe in-place updates**: `set`/`put` mutate in place when the
  value is provably unshared (a fresh `arr`/`rec`/`set`/`put` result whose only other uses
  are earlier `get`/`at` reads and which is not returned), iteration bodies get an
  owned-state variant (`a0o_`) whose accumulator is copied once unless the initial value
  is already unshared, and scalar-element arrays are `Uint32Array`/`Uint8Array`.
  `get`/`at` results are never mutated because they alias their container. Verified by
  the 5603-case corpus (heavy aliasing) and Life. The array kernel loss dropped from
  2.6× to ≈1.3–1.6× (run-to-run noise on this machine is of the same order).
- **JS emission**: input guards now run only at the public boundary; internal calls,
  folds, and loops target unguarded `a0i_` functions (the 64-step loop went from 4× slower
  than hand-written to a tie).
- Edits: self-contained patch (`patch name sha256 … end`) and session handle edits
  (`e0` + replaced lines). Replace-existing-nodes only. Handles are one-use and
  revision-bound. No insertion/deletion, no multi-function transactions, no network service.
- Emission cache keyed on compiler version, target, opt level, and **semantic revision**
  (own content + transitive callees); editing a callee invalidates callers (tested).
- Backends: JS (ES module with public input guards), C (also valid C++), Java, SystemVerilog.
- Safety principle (user requirement 2026-09-29): every model-authored program or edit is
  parsed, type-checked, and revision-matched *before* commit; a malformed edit is
  rejected with a diagnostic and the program is untouched. This does not stop a model
  from writing a wrong-but-well-typed program; acceptance tests do that (Gate A harness).

## Reproduced checks (this machine: macOS 27.2 arm64, Node v24.14.0, Bun 1.3.4)

| Check | Command | Result |
|---|---|---|
| Lint (Biome 2.2.4) | `bun run lint` | pass (previously blocked) |
| Typecheck (tsc 5.9.3, strict) | `bun run typecheck` | pass |
| Focused tests | `bun run test` | 24/24 pass (incl. fuel, static cap, 3000-mutation fuzz, page protocol, structured and program-level edits, persistent cache) |
| Life acceptance (134 cases, independent reference) | `bun run app` | pass on interpreter, optimizer, JS, C, C++, Wasm, JVM |
| Life in the browser (Wasm + DOM adapter) | `bun run site`, in-app browser | glider moves (1,1) in 4 steps, population 5 |
| GPU (Metal, Apple M3) | `bun run gpu` | 4995 io-free cases across 31 kernels pass |
| .NET (C#, SDK 10.0.401 Release) | `bun run dotnet` | 5603 cases incl. io streams pass |
| Interpreter vs oracle | `bun run verify` | 5603 cases pass |
| Optimizer vs oracle | `bun run verify` | 5603 pass |
| JS in Node | `bun run verify` | 5603 pass |
| C via Apple clang 21, UBSan | `bun run verify` | 5603 pass |
| C via GNU gcc-15, **no sanitizer** (macOS gcc has no libubsan) | `bun run verify` | 5603 pass |
| C-compatible source as C++17 via clang++, UBSan | `bun run verify` | 5603 pass |
| Java via Homebrew OpenJDK 27 | `bun run verify` | 5603 pass |
| WebAssembly (Homebrew clang 23 + wasm-ld, wasm32 freestanding) | `bun run verify` | 5603 pass, executed in Node's WebAssembly runtime; no browser/DOM test |
| SystemVerilog RTL simulation (Icarus 12, `-g2012`, clocked testbench) | `bun run hw` | 5603 cases pass on all 48 functions (11 clocked modules: every io function; literal-count iteration stays combinational); 0.8 s |
| SystemVerilog generic synthesis (Yosys 0.69 `synth -noabc` + `check -assert`) | `bun run hw` | pass in 1.6 s for all 48 modules incl. clocked ones; ABC optimization stalled >5 min on 32-bit multipliers, so it is off and cell counts are unoptimized |
| Not run for hardware | — | FPGA place-and-route, real cell library, timing, area, power, sequential logic |

Corpus: 48 seeded functions, seed 0xa0beef / input seed 0x12345678, 56 call, 28 fold, 19 loop, 79 arr, 69 rec, 59 get, 126 set, 24 read, 22 write sites; 11 io functions with 608 stream cases,
sha in `results/verification.json`. Deterministic generated inputs, not application evidence.

Bugs found and fixed by hardware simulation: (1) SV emitted `literal[4:0]` for shifts by a
constant (illegal); (2) the first clocked emitter initialized a stage's registers on the
same clock edge that latched the previous stage's result, so the first run of every module
used a stale register (only the first case of a function failed; later runs reused the
previous value); (3) handshakes asserted during a stage's entry cycle transferred every
word twice. Each was caught only by simulation against the oracle.

## Measurements (evidence level stated per row)

### Token probe (`bun run tokens`, js-tiktoken o200k_base / cl100k_base — OpenAI encodings, NOT Claude's tokenizer)

| Fixture | bytes | o200k tokens | Verdict vs baseline |
|---|---|---|---|
| affine in A0 | 62 | 30 | **loss** vs hand-written C (29); win vs TS (35); ~tie vs Python (32) |
| A0 session edit | 14 | 9 | win vs TS line-replace session edit (20), TS search/replace (42), unified diff (79) |
| A0 self-contained patch | 93 | 48 | loss vs TS search/replace (42); win vs unified diff |
| MODEL_GUIDE.txt (setup A0 must pay) | — | ~489 | pure overhead; TS setup note ~48 |
| 48-fn corpus A0 vs emitted JS/C/Java | 42.7 kB | 23k vs 45–52k | not fair: baselines are machine-generated, not hand-written |

Level: local payload token counts. Not an AI-task experiment. The session-edit win is
largely a protocol effect; the 2×2 harness exists to separate it from the language effect.

### Execution ledger, Gate 7 (`bun run exec-bench`, clang -O2 no sanitizer; Node JIT warm; idle machine)

| Kernel | C emitted vs hand-written C | vs hand-written Rust (rustc 1.96 -O) | JS emitted vs hand-written |
|---|---|---|---|
| affine, rotl, clamp, mix (scalar) | tie | tie | tie |
| ident (tiny call) | tie (1.61 ns) | tie | tie/loss ≤11 % across runs (13.6 vs 12.4 ns): wrapper indirection, within noise |
| noop (add 0, mul 1, xor 0) | tie | tie | tie |
| chain3 (three nested tiny calls) | tie | tie | tie |
| branchy (select chains) | tie | tie | tie |
| arrfill (8 value-semantics `set`s) | tie | tie | **loss** ≈1.3–1.6× (156 vs 97 ns best run) after in-place updates and typed arrays; was 2.6× |
| loop64 (64 dependent body calls) | tie (80 vs 82 ns) | tie (80 ns) | tie (was 4× loss before boundary-only guards) |
| build time A0 source → native binary (clang) vs rustc -O | 52–67 ms vs 104–116 ms (rustc first run 4.3 s cold) | | |
| startup (spawn + one iteration) | 2.2–2.5 ms both sides | | |
| binary size | 33.6 kB both sides (runtime dominated) | | |

Rust ties on every kernel because A0's native path and rustc both end in LLVM; a CPU
runtime advantage over Rust for the same computation is not available to any language.
Where A0 differs measurably: build latency (~2× faster than rustc here), reach (the same
source runs on GPU, .NET, JVM, Wasm, and as clocked hardware), and, unmeasured until
Gate 6 runs, AI cost per accepted change (Rust is now a baseline representation there).

Verdict band: 8 % or observed sample spread, capped at 25 %. Level: micro-kernels; not
energy, memory at scale, or applications. The JS array loss is a real cost of value
semantics without escape analysis and stays on the ledger.

### Cost target stated by the user (2026-09-29): 200–400× cheaper and faster for AI

Measured baseline: whole-function payloads ≈1× hand-written C (30 vs 29 tokens), session
edits ≈2× smaller than the best conventional edit, A0 setup ≈877 tokens of overhead
(now 610 after compaction; Rust setup 63, TypeScript 48). Runtime vs Rust: tie on every kernel (see ledger).
Syntax cannot reach the target; the candidate mechanisms are structural and unmeasured:
(1) a library of verified named operations so a model writes one line instead of an
implementation, (2) dependency-scoped views so it reads only what an edit touches,
(3) delta-only edits, (4) validation that removes retries. Gate 6 measures whole-task
cost; the target is recorded as an ambition, not a result.

### Gate A / Gate 6: AI-edit experiment (`bun run experiment`)

Harness implemented and self-checked (reference solutions pass, originals fail in all six
cells: A0/TypeScript/Rust × conventional/structured). Whole-task accounting: four
never-merged token buckets (language primer, workflow primer, tool context, output),
per-attempt failure status, one-shot vs after-repair acceptance, `taskSetSha256`.
Thirteen held-out tasks with independent acceptance tests (Rust acceptance compiles with
rustc -O). Live SDK runs (`A0_ALLOW_PAID_MODEL_CALLS=1`) remain unrun; instead the run
below used **fresh Claude subagents as subjects**: each subject started with no context
beyond the cell's system prompt (primer + protocol) and the task, did not author the
tasks, answered its 13 tasks of one cell in isolation, and got exactly one repair message
(the checker's rejection with the current view) for a failed cell. Token counts are local
o200k counts; nothing was billed beyond this session.

**Run 2026-09-30, 13 tasks × 6 cells × 2 models × 2 A0 primers** (results in
`results/ai-edit-experiment.{haiku,sonnet}-{full,min}.json`; the min primer is
`MODEL_GUIDE.min.txt`, 342 tokens; the full one 610):

| subject | cell | one-shot | after 1 repair | output tokens | whole-task uncached | cache-adjusted |
|---|---|---|---|---|---|---|
| Sonnet, min primer | A0 conventional | 12/13 | 13/13 | 725 | 6789 | 2288 |
| Sonnet, min primer | A0 structured | 12/13 | 13/13 | 406 | 8367 | 2378 |
| Sonnet, full primer | A0 conventional | 13/13 | 13/13 | 635 | 9831 | 2650 |
| Sonnet, full primer | A0 structured | 12/13 | 13/13 | 364 | 12133 | 2852 |
| Sonnet | TypeScript conventional | 13/13 | 13/13 | 586 | 2019 | 1484 |
| Sonnet | TypeScript structured | 13/13 | 13/13 | 371 | 2919 | 1503 |
| Sonnet | Rust conventional | 13/13 | 13/13 | 630 | 2289 | 1587 |
| Sonnet | Rust structured | 13/13 | 13/13 | 369 | 3143 | 1560 |
| Haiku, min primer | A0 conventional | 13/13 | 13/13 | 652 | 6312 | 2164 |
| Haiku, min primer | A0 structured | 12/13 | 13/13 | 488 | 8499 | 2510 |
| Haiku, full primer | A0 conventional | 12/13 | 13/13 | 726 | 10598 | 2806 |
| Haiku, full primer | A0 structured | 8/13 | 11/13 | 701 | 15845 | 3650 |
| Haiku | TypeScript conventional | 13/13 | 13/13 | 587 | 2020 | 1485 |
| Haiku | TypeScript structured | 13/13 | 13/13 | 382 | 2930 | 1514 |
| Haiku | Rust conventional | 13/13 | 13/13 | 620 | 2279 | 1577 |
| Haiku | Rust structured | 12/13 | 13/13 | 400 | 3329 | 1611 |

Cache-adjusted = primer and protocol charged once at 1.25× and at 0.05× per further call
(Opus 5.5 cache-read rate), context and output at 1×.

**Run 2, 2026-09-30, after boolean logic (v0.8.11), one shot, no repair round**
(same design, fresh subjects; `results/ai-edit-experiment.{haiku,sonnet}-{full,min}.json`
now hold this run; run 1 is in git history at c440aae):

| subject | cell | one-shot | output tokens | whole-task uncached | cache-adjusted |
|---|---|---|---|---|---|
| sonnet-min | a0/conventional | 13/13 | 634 | 6515 | 2178 |
| sonnet-min | a0/structured | 13/13 | 376 | 8031 | 2322 |
| sonnet-min | ts/conventional | 13/13 | 586 | 2019 | 1484 |
| sonnet-min | ts/structured | 13/13 | 371 | 2919 | 1503 |
| sonnet-min | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-min | rust/structured | 13/13 | 369 | 3143 | 1560 |
| sonnet-full | a0/conventional | 13/13 | 635 | 10078 | 2686 |
| sonnet-full | a0/structured | 13/13 | 342 | 11559 | 2795 |
| sonnet-full | ts/conventional | 13/13 | 586 | 2019 | 1484 |
| sonnet-full | ts/structured | 13/13 | 371 | 2919 | 1503 |
| sonnet-full | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-full | rust/structured | 13/13 | 369 | 3143 | 1560 |
| haiku-min | a0/conventional | 13/13 | 652 | 6533 | 2196 |
| haiku-min | a0/structured | 12/13 | 446 | 8183 | 2474 |
| haiku-min | ts/conventional | 13/13 | 587 | 2020 | 1485 |
| haiku-min | ts/structured | 13/13 | 382 | 2930 | 1514 |
| haiku-min | rust/conventional | 13/13 | 620 | 2279 | 1577 |
| haiku-min | rust/structured | 13/13 | 336 | 3110 | 1527 |
| haiku-full | a0/conventional | 13/13 | 643 | 10086 | 2694 |
| haiku-full | a0/structured | 8/13 | 479 | 11921 | 3157 |
| haiku-full | ts/conventional | 13/13 | 587 | 2020 | 1485 |
| haiku-full | ts/structured | 13/13 | 382 | 2930 | 1514 |
| haiku-full | rust/conventional | 13/13 | 620 | 2279 | 1577 |
| haiku-full | rust/structured | 13/13 | 336 | 3110 | 1527 |

**Run 5, 2026-09-30, task set B: 12 tasks written by an agent that had not seen set A
or the corpus** (`tools/ai-edit-tasks-b.ts`, `A0_EXPERIMENT_TASKSET=b`; results in
`results/ai-edit-experiment.b.*.json`), fresh subjects, one shot, no repairs:

| subject | cell | one-shot | output tokens | whole-task uncached | cache-adjusted |
|---|---|---|---|---|---|
| sonnet-min | a0/conventional | 12/12 | 753 | 6730 | 2599 |
| sonnet-min | a0/structured | 12/12 | 410 | 6942 | 2454 |
| sonnet-min | ts/conventional | 12/12 | 748 | 2397 | 1907 |
| sonnet-min | ts/structured | 12/12 | 335 | 3032 | 1737 |
| sonnet-min | rust/conventional | 12/12 | 735 | 2556 | 1913 |
| sonnet-min | rust/structured | 12/12 | 304 | 3177 | 1729 |
| sonnet-full | a0/conventional | 12/12 | 753 | 9994 | 3089 |
| sonnet-full | a0/structured | 12/12 | 458 | 10254 | 2992 |
| sonnet-full | ts/conventional | 12/12 | 748 | 2397 | 1907 |
| sonnet-full | ts/structured | 12/12 | 335 | 3032 | 1737 |
| sonnet-full | rust/conventional | 12/12 | 735 | 2556 | 1913 |
| sonnet-full | rust/structured | 12/12 | 304 | 3177 | 1729 |
| haiku-min | a0/conventional | 12/12 | 753 | 6730 | 2599 |
| haiku-min | a0/structured | 12/12 | 544 | 7076 | 2588 |
| haiku-min | ts/conventional | 12/12 | 737 | 2386 | 1896 |
| haiku-min | ts/structured | 11/12 | 362 | 3085 | 1790 |
| haiku-min | rust/conventional | 11/12 | 717 | 2624 | 1981 |
| haiku-min | rust/structured | 12/12 | 317 | 3190 | 1742 |
| haiku-full | a0/conventional | 12/12 | 753 | 9994 | 3089 |
| haiku-full | a0/structured | 9/12 | 459 | 10352 | 3090 |
| haiku-full | ts/conventional | 12/12 | 737 | 2386 | 1896 |
| haiku-full | ts/structured | 11/12 | 362 | 3085 | 1790 |
| haiku-full | rust/conventional | 11/12 | 717 | 2623 | 1980 |
| haiku-full | rust/structured | 12/12 | 317 | 3190 | 1742 |

Sonnet 72/72 with either primer. Haiku, compact primer: 70/72, with both A0 cells 12/12
and the two misses in TypeScript (a wrong average) and Rust (a panic); full primer 66/72.
Output tokens on this set: A0 structured 410 vs TypeScript 335 and Rust 304 (Sonnet), a
**loss** of 22–35 %; on set A it was a tie. Whole-task cache-adjusted, compact primer:
2454 vs 1737 = 1.41× TypeScript (loss). The Haiku A0 misses with the full primer were a
fold body defined after its use, an out-of-order reference the edit layer could not
resolve (a true forward reference to a node the reply never defined), and a `select`
with five operands. None is a new protocol class.

**Run 4, 2026-09-30, structured-protocol text cut from 140 to 52 tokens per call
(TypeScript's is 96); only the four A0 structured cells were re-collected, the rest are
run 3's replies; one shot, no repairs:**

| subject | cell | one-shot | output tokens | whole-task uncached | cache-adjusted |
|---|---|---|---|---|---|
| sonnet-min | a0/conventional | 13/13 | 629 | 6718 | 2202 |
| sonnet-min | a0/structured | 13/13 | 368 | 7087 | 2181 |
| sonnet-min | ts/conventional | 13/13 | 590 | 2023 | 1488 |
| sonnet-min | ts/structured | 13/13 | 362 | 2910 | 1494 |
| sonnet-min | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-min | rust/structured | 13/13 | 364 | 3138 | 1555 |
| sonnet-full | a0/conventional | 13/13 | 629 | 10254 | 2705 |
| sonnet-full | a0/structured | 13/13 | 368 | 10623 | 2684 |
| sonnet-full | ts/conventional | 13/13 | 590 | 2023 | 1488 |
| sonnet-full | ts/structured | 13/13 | 362 | 2910 | 1494 |
| sonnet-full | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-full | rust/structured | 13/13 | 364 | 3138 | 1555 |
| haiku-min | a0/conventional | 13/13 | 620 | 6709 | 2193 |
| haiku-min | a0/structured | 13/13 | 468 | 7187 | 2281 |
| haiku-min | ts/conventional | 13/13 | 599 | 2032 | 1497 |
| haiku-min | ts/structured | 13/13 | 341 | 2889 | 1473 |
| haiku-min | rust/conventional | 13/13 | 606 | 2265 | 1563 |
| haiku-min | rust/structured | 12/13 | 369 | 3267 | 1684 |
| haiku-full | a0/conventional | 13/13 | 632 | 10257 | 2708 |
| haiku-full | a0/structured | 11/13 | 445 | 10924 | 2985 |
| haiku-full | ts/conventional | 13/13 | 599 | 2032 | 1497 |
| haiku-full | ts/structured | 13/13 | 341 | 2889 | 1473 |
| haiku-full | rust/conventional | 13/13 | 606 | 2265 | 1563 |
| haiku-full | rust/structured | 12/13 | 369 | 3267 | 1684 |

Sonnet 78/78 with either primer; Haiku 78/78 with the compact primer and 76/78 with the
full one (two wrong algorithms). Whole-task cost, A0 structured vs TypeScript structured,
compact primer, cache-adjusted: 2181 vs 1494 = 1.46× (was 1.55×); uncached 7087 vs 2910
= 2.4×. Measured and rejected: dropping the signature list from the program-handle view
saves 15 tokens per task (999 → 804 over 13) but removes the names and types a program
edit needs, so the two-handle view stays. The remaining gap is the language primer
itself (372 tokens per call), which is the structural cost of a new language.

**Run 3, 2026-09-30, on v0.8.12 + `ret OP …` sugar (v0.8.13), one shot, no repairs:**

| subject | cell | one-shot | output tokens | whole-task uncached | cache-adjusted |
|---|---|---|---|---|---|
| sonnet-min | a0/conventional | 13/13 | 629 | 6718 | 2202 |
| sonnet-min | a0/structured | 13/13 | 368 | 8231 | 2344 |
| sonnet-min | ts/conventional | 13/13 | 590 | 2023 | 1488 |
| sonnet-min | ts/structured | 13/13 | 362 | 2910 | 1494 |
| sonnet-min | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-min | rust/structured | 13/13 | 364 | 3138 | 1555 |
| sonnet-full | a0/conventional | 13/13 | 629 | 10254 | 2705 |
| sonnet-full | a0/structured | 13/13 | 380 | 11779 | 2859 |
| sonnet-full | ts/conventional | 13/13 | 590 | 2023 | 1488 |
| sonnet-full | ts/structured | 13/13 | 362 | 2910 | 1494 |
| sonnet-full | rust/conventional | 13/13 | 630 | 2289 | 1587 |
| sonnet-full | rust/structured | 13/13 | 364 | 3138 | 1555 |
| haiku-min | a0/conventional | 13/13 | 620 | 6709 | 2193 |
| haiku-min | a0/structured | 12/13 | 445 | 8390 | 2503 |
| haiku-min | ts/conventional | 13/13 | 599 | 2032 | 1497 |
| haiku-min | ts/structured | 13/13 | 341 | 2889 | 1473 |
| haiku-min | rust/conventional | 13/13 | 606 | 2265 | 1563 |
| haiku-min | rust/structured | 12/13 | 369 | 3267 | 1684 |
| haiku-full | a0/conventional | 13/13 | 632 | 10257 | 2708 |
| haiku-full | a0/structured | 12/13 | 459 | 11888 | 2968 |
| haiku-full | ts/conventional | 13/13 | 599 | 2032 | 1497 |
| haiku-full | ts/structured | 13/13 | 341 | 2889 | 1473 |
| haiku-full | rust/conventional | 13/13 | 606 | 2265 | 1563 |
| haiku-full | rust/structured | 12/13 | 369 | 3267 | 1684 |

Sonnet 78/78 with either primer; Haiku 77/78 with either primer (run 2: 76 and 71). The
new general fixes that this run exercised: any dependency order inside an edit, callers
before new callees, multi-section replies, `ne le gt ge`, and `ret OP ARGS` as sugar for a
fresh result node (v0.8.13, both in source and in edits), after four Haiku replies used
that form. The last Haiku misses are a wrong cube algorithm and a parenthesized nested
expression, which the grammar does not have and is not being added for now.

Sonnet: 78/78 one-shot with either primer (run 1 had 76/78; the two `loop-inclusive`
failures were the missing boolean logic). Haiku with the compact primer: 76/78 one-shot;
with the full primer 71/78. The Haiku failures are model errors, not protocol gaps: a
forward reference, an invented `le` op, a wrong algorithm for cube, and one reply that
appended the program view under the function handle. No repair round was run and no
further change is aimed at them: the language is not tuned to one model. The protocol
fixes listed above are general (they also raised Sonnet from 76 to 78) and a weaker model
was only the faster way to expose them. Tokens: the A0 structured output tie with
TypeScript and Rust holds (342–376 vs 371 and 369); the whole-task loss holds
(1.5× cache-adjusted, 2.8× uncached with the compact primer).

Wins, ties, losses, stated separately:
- **Acceptance**: tie for Sonnet (every A0 cell reaches 13/13 with one repair, like
  TypeScript and Rust); for Haiku a tie with the compact primer and a **loss with the
  full primer** on structured edits (11/13). The shorter primer is better for both models,
  so it is now the default primer for the experiment.
- **Output tokens per edit**: tie. A0 structured 364–406 vs TypeScript 371–382 and Rust
  369–400 over 13 tasks. The 10–14 % reduction recorded from the author-scripted run is
  withdrawn: it was the author's own terseness, not the language.
- **Whole-task cost**: **loss**, 1.5–1.6× TypeScript cache-adjusted (2.7–2.9× uncached)
  with the compact primer, because a model editing TypeScript needs a 31-token semantics
  note where A0 needs its 342-token primer on every call, plus a longer protocol text
  (140 vs 96 tokens per call). Levers, all measurable: a primer the model already knows
  (impossible for a new language; this is the structural cost of novelty), a shorter
  structured-protocol text, prompt caching (already assumed above).
- **What the failures were, and what changed because of them**: the first collection had
  Haiku at 0/13 on A0 structured edits. Every one of those failures was a protocol
  friction that a small model hits and a large one does not: a trailing `end` after the
  edit lines, the whole function echoed back under its handle, the view's signature lines
  echoed back, a program handle named `g1` where both primers say `g0`, and handles that
  were consumed after a successful edit so the repair reply reused a dead name. Each was
  made tolerant or fixed (v0.8.10: trailing `end` accepted; a whole `fn … end` block under
  its own handle is a replacement; signature echoes are ignored; program handles are
  numbered from `g0`; handles are stable for the session and rebind after each successful
  edit; new functions written above a replaced caller are placed before it; an empty
  program is rejected). After re-collecting with fresh subjects, Haiku's structured cell
  went from 0/13 to 12/13 one-shot with the compact primer. Remaining failures are model
  errors: a bool used where u32 is required (both models, `loop-inclusive`, because A0 has
  no boolean `and`/`or`/`not` and `eq` was u32-only), an invented `le` op, a forward
  reference, and Haiku ignoring the "edit lines only" rule once.
- **Contamination and caveats**: the subjects are Claude models from the same family as
  the author, prompted in this session; tasks were written by the author; one trial per
  cell; local tokenizer; no reasoning tokens. Repair messages were delivered in a fresh
  context that contained the whole conversation, which is equivalent to a live turn.

## Session 2026-09-29 (late): primer size, JS guards

- **Direct AArch64 backend landed (v0.8.14, `src/arm64.ts`, target `arm64`)**: A0 to
  Darwin AArch64 assembly with no C generated for the program; clang is used only as the
  assembler/linker driver. Scope: u32, bool, arrays, records, every scalar op with exact
  semantics, call (AAPCS64-compatible for scalars; aggregates by pointer to caller-owned
  slots; aggregate results via x8), fold and loop with literal or variable counts. io
  functions are refused (C path covers them). Verified: `native_arm64` path in `bun run
  verify` runs the io-free corpus (4297 cases) against the same oracle driver at both
  optimization levels; unit tests cover 12-parameter calls, aggregate results, a 4 KiB
  frame, fold with array state, loop with a variable cap. Performance, first version
  (per-node stack slots, no register allocation, a real call per iteration): parity with
  the clang path on 8 of 10 kernels (0.96–1.14×, chain3 1.40×), **losses of 10.2× on
  loop64 and 28.7× on arrfill**. Next: register allocation and inlining of small bodies.
  Also fixed: the validator compared loop-predicate parameter types by reference, so a
  loop with array or record state was always rejected (now structural, with a test).
- **Baselines against the languages AI writes most** (`bun run exec-bench`, load average
  16–21 at start so ratios only): native A0 vs hand-written JavaScript on Node 9–44× faster
  per call, vs hand-written Python on CPython 3.9 200–600× (loop64 207×, affine 249×);
  startup latency of one native process 2.5–4.5 ms vs Node 35–59 ms and Python 35–71 ms.
- **Universality target (user, 2026-09-30):** every CPU and the silicon itself. Order of
  direct backends after AArch64: x86-64 (Linux, Windows, Intel Mac; verified here under
  Rosetta 2), 32-bit ARM (Cortex-M, older Raspberry Pi), RISC-V, AVR (Arduino-class
  8-bit), each verified with the corpus under QEMU/simavr where the hardware is absent;
  wasm32 emitted directly as binary. SystemVerilog already covers FPGA/ASIC. Nothing is
  listed as supported until the corpus passes on it.
- **Direction set by the user (2026-09-30): A0 must reach the machine through its own
  code generator, not through C.** Started: a direct AArch64 assembly backend (`arm64`
  target) for io-free functions, verified against the corpus and benchmarked next to the
  C path. The C path stays until the direct path reaches parity on the execution ledger;
  both numbers will be published. A0 has always been its own language (grammar, types,
  exact semantics, validator, optimizer, edit protocol, interpreter, proofs); C was one
  emission target among JavaScript, Java, C#, Metal, and SystemVerilog, used for native
  code the way Nim and GHC use it and the way Rust uses LLVM.

- **General fixes from the failure classes (v0.8.12)**, none tied to a model:
  (1) edit lines may come in any order that has a valid dependency order; the edit
  layer places each node after its last reference (a true cycle is still rejected);
  (2) a program edit may define a caller above its new callee; new functions are ordered
  by their calls; (3) a reply may carry several handle sections (`e0` … then `g0` …),
  applied in order as one atomic edit, with echo-only sections ignored;
  (4) comparisons `ne le gt ge` join `eq lt` (unsigned on u32; `ne` also on bool), in the
  validator, interpreter, optimizer identities, JavaScript, C, Java, C#, SystemVerilog,
  Metal via C, the corpus oracle and generator, and the Z3 tool. Gate on the regenerated
  corpus: 5262 cases on 8 software paths, .NET, Metal, hardware sim+synth, 48/48 proofs.
  Baseline protocol: a TypeScript/Rust line replace past the end appends.

- **Corpus regenerated (v0.8.11)**: the seeded generator now emits boolean logic, so the
  corpus hash and case count changed (5946 → 5262 cases; the generator draws a different
  sequence). Every result file was regenerated on this corpus: 8 software paths, .NET,
  Metal GPU, hardware simulation and synthesis, and 48/48 Z3 proofs all pass.
- **Boolean logic (v0.8.11)**: `and`, `or`, `xor`, and `eq` now accept two `bool`
  operands (logical; boolean equality) as well as two `u32` (bitwise; unsigned equality);
  mixing is rejected. Motivation is measured: in the Gate 6 run both Sonnet and Haiku
  failed `loop-inclusive` by writing boolean logic that the language did not have
  (`eq c false`, `or a b` on bools). Implemented in the validator, interpreter, optimizer
  (logical identities), every backend (JavaScript and C emit `&&`/`||`/`!=`; Java, C#,
  SystemVerilog, and Metal via C accept the operators on booleans), the corpus oracle and
  generator (the corpus now holds 89 boolean and/or/xor nodes and 46 boolean `eq` nodes
  across 40 of 48 functions; the corpus hash changed and every result file was
  regenerated), and the Z3 tool. Both primers document it (min 372 tokens, full 646).
  Gate 6 run 2 above was collected on this language.

- **Optimizer proofs now cover io (48/48)**: `tools/equiv-verify.ts` models an io token as
  a bounded symbolic input of 8 words (reads past the end yield 0 as in the language), an
  output buffer with one slot per static emit site and a symbolic length, and a read
  position; equivalence requires equal results, equal output length, equal words below
  it, and equal final position. Result: 48 proved, 0 counterexamples, 0 unknown, solver
  2.3 s; self-check mutates one pure and one io function and gets a counterexample for
  each. Stable across three consecutive runs. Implementation note: `z3-solver`'s async
  `check` races its finalizers on the wasm heap and crashed about half the runs; the tool
  calls the synchronous export instead (documented in the file).
- **Hardware cycles and divisors** (`results/hardware.json`): per-module mean cycles per
  case now recorded; slowest a0_g44 1581 and a0_g36 1040 (multiple dependent 32-cycle
  divides), then 137, 133, 71. Divisor census after optimization: 3 literal, 32 variable
  `div`/`rem` nodes (57/148 before), so a combinational literal-divisor path has no
  measured need; the variable ones are the cycle cost and would need a faster divider
  (radix-4 or pipelined) if hardware latency ever becomes a target.
- **JS fold-body inlining: tie, reverted.** Source-level inlining of small fold/loop bodies
  measured 0.98–1.02× on arrfill and loop64 (V8 already inlines the `a0o_` callees), so
  it was not kept. The same measurement pointed at the real costs, which were fixed
  instead: all-zero array literals now allocate (`new Uint32Array(n)`), power-of-two
  array indices mask (`i & (n-1)`, exact for u32), and owned in-place `set`/`put` emit
  `(a[i] = v, a)` with no helper. Interleaved A/B: arrfill 0.37–0.38× the previous
  emission and 0.50× the hand-written JavaScript; loop64 unchanged. Compiler version
  a0c-0.1.3.
- **Execution benchmark re-run on a quiet machine** (load average 10–16,
  `results/exec-benchmark.json`): C-path A0 vs hand-written C 0.98–1.00× on all 10
  kernels, vs Rust 0.97–1.01×; JavaScript 0.99–1.08× (ties) with arrfill 0.53× (win);
  build time A0→native 0.14–0.57× of rustc per kernel, 2.8× faster summed over the ten (the 3.9× figure from
  the loaded-machine run is withdrawn and the site tile now shows the quiet number).

- **`use` imports (v0.8.9, `src/link.ts`)**: `use "relative.a0"` lines at the head of a file
  link another file into the program. The linker loads each file once by resolved path in
  dependency order, rejects cycles and cross-file duplicate names (naming both files), and
  validates the flat result; diagnostics are mapped back to `file:line`, including
  validator errors that only name `fn.node`. The CLI (`check run emit wasm view patch`) and
  the site build go through it; `site/page.a0` now declares `use "../examples/life.a0"`
  instead of the build tool concatenating sources. Guides document the line. Test covers
  transitive use, once-only loading, cycle, duplicate, and line mapping. Still one flat
  namespace and no re-export or renaming: measured need was exactly the site; anything
  more waits for a second consumer.

- **Compact primer** `MODEL_GUIDE.min.txt`: 342 o200k tokens against 610 for `MODEL_GUIDE.txt`
  (target was ≤ 300; the worked example costs ~30 and is kept). Harness option
  `A0_EXPERIMENT_GUIDE` selects it; scripted run recorded in
  `results/ai-edit-experiment.min-guide.json`: language-primer bucket 7930 → 4446 tokens
  over 13 tasks, whole-task total 9587 → 6103 (conventional, −36 %) and 11090 → 7606
  (structured, −31 %). Acceptance stayed 13/13 in every cell, but the scripted subject
  does not read the primer, so **this run says nothing about whether a model can still
  write A0 from the shorter guide**; only a live run can decide that, and it must compare
  both guides with the same accounting.
- **JS boundary guards** now emit one inline comparison per scalar parameter
  (`(v >>> 0) !== v`) instead of a helper call. Interleaved same-process A/B on the affine
  kernel, 21 rounds: old 62.1 ns, new 62.1 ns, hand-written 49.8 ns. No measured change:
  V8 already inlined the helper. The remaining ~12 ns per call is the validation itself,
  which is the boundary's purpose; internal calls never pay it. Kept for simplicity only.
- `bun run exec-bench` was run under a load average of 115 from other applications and
  produced C ratios from 0.44× to 1.41× on unchanged code; that run was discarded and the
  committed results are unchanged. Whole-suite timing runs need a quiet machine.

## Session 2026-09-29 (site redesign, docs page, Geist)

- a0lang.com rebuilt as two A0 programs sharing `site/ui.a0` (protocol helpers): `site/page.a0` (home) and `site/docs.a0` (served at /docs/). One generic runtime `site/app.ts` reads the program URL from `data-program` on `#app`. `tools/site-build.ts` builds both wasm files and copies the Geist Sans, Geist Mono, and Geist Pixel variable fonts from the `geist` npm package into `site/dist/fonts/` (self-hosted).
- Hero: protocol command 13 SHADER (GLSL ES 3.0 fragment shader emitted by the program, in chunks like the stylesheet); the runtime supplies only a fullscreen triangle, clock, resolution, pointer, and color scheme, pauses off-screen, and honors reduced motion. The scene is a rotating neural constellation (72 nodes, three edges each, traveling pulses) computed per pixel.
- Design: full-height hero (Geist Pixel wordmark), centered thesis, three summary cards, sticky contents rail, one chart card per measurement with a caption, cost-versus-acceptance scatter (50–100 % range, nice ticks), target and FAQ grids. Light or dark follows the system. Ratios print with `putratio` (408x, 16.7x, 1.06x). Favicon added. Footer: @joesimo on X, GitHub, MIT.
- Losses stay visible: whole-task tokens vs TypeScript (set A 1.46x, set B 1.41x), emitted JS vs hand-written JS, direct AArch64 loop64 8.4x and arrfill 30x.
- README rewritten for the public repo (measured numbers, loss included); "provisional codename" wording removed everywhere; `.gitattributes` marks `.a0` sources for GitHub's language bar (the compiler is TypeScript, so the bar still says TypeScript until A0 is self-hosted).
- Tests: page test asserts an empty state and a shader; new docs program test. Gate: lint, typecheck, test 35/35, verify (all paths incl. arm64 4297), app, equiv 48/48, hw pass.
- Not done: playground page; arm64 register allocation; self-hosted compiler (needs byte strings and larger memory first).

## Session 2026-09-29 (short primer, edit checks)

- `MODEL_GUIDE.short.txt`: 304 o200k tokens (min primer 388). Collected with fresh subjects, one shot, sets A and B, Haiku and Sonnet (scratchpad g10; TS/Rust cells reused from the earlier collections since they do not depend on the primer). Results `results/ai-edit-experiment.{,b.}{haiku,sonnet}-short.json`.
  - Sonnet: 13/13 and 12/12 on both A0 cells (unchanged from the min primer). Whole-task tokens per task fell 6718 to 5626 (conventional) and 7087 to 5995 (structured) on set A.
  - Haiku structured, first collection: 11/13 and 10/12. Classified: 2 protocol shapes (a whole `fn` block for another function under a function handle, with or without edit lines), 1 nested expression `select (lt a b) ...` (grammar item B, recorded, still refused), 1 model error (sq(sq(x)) for cube).
  - General fix (v0.8.15, tests added): whole `fn ... end` blocks are program-level edits under any handle; edit lines apply to the handled function after the blocks. Re-collected structured cells with fresh subjects: Haiku 11/13 (A) and 12/12 (B), Sonnet 13/13 and 12/12. The two remaining Haiku misses inserted the new result but left `ret` on the old node.
  - Second general fix: an edit's new node that nothing reads is rejected with the fix (`add 'ret ID'`), so that shape is a diagnosed rejection instead of a silently wrong program. Regression check: every earlier collection has identical accepted counts under the new checks.
  - Loss still published: Haiku one shot on the 304-token primer is 2 tasks below the 388-token primer on set A. The default primer stays MODEL_GUIDE.min.txt until a repair-round collection shows the short one recovers.

## Session 2026-09-30 (self-hosting starts: the lexer in A0)

- Direction (user): the compiler itself must be A0. Today it is TypeScript; the published `a0` binaries embed Bun's runtime (60–115 MB). Plan, in order: (1) room for a compiler in the language (larger arrays with in-place updates on C and arm64; two agents are on it), (2) front end in A0 verified differentially against the TypeScript one, (3) AArch64 emitter in A0, (4) bootstrap fixed point. The TypeScript compiler then becomes an oracle only.
- `compiler/lex.a0`: the A0 lexer written in A0 (tokens as `kind start length` word triples; idents, numbers, strings with escapes, arrow, newline, minus, at, comments dropped; every branch selected, no control flow). Pure entry `lex u32x512 u32 -> (u32x512,u32)` and io front `lexio`. Sizes are 512 today because a record is capped at 65536 bits; the cap rises with step (1).
- Verified two ways: a differential test against an independent reference tokenizer on the repo's own A0 sources (`test/core.test.ts`), and `bun run app` now runs the lexer through interpreter, optimizer, JavaScript, native C, wasm32, and JVM on 7 sources (all pass). The verify drivers' io buffers are now sized to the cases (`ioCaps`) instead of fixed 80/256-word limits.
- Also this session: standalone `a0` binaries released (v0.8.15, five platforms) so users need no package manager; README install section; site hero performance fix (capped resolution, 30 fps, edge culling, no backdrop blur).
## Session 2026-09-30 (arm64 registers and loops)

- **Direct AArch64 backend, second version (a0c-0.1.7, `src/arm64.ts`)**: the two published
  losses against A0-via-clang came from the first version keeping every value in a stack slot
  and making a real call per iteration. Three changes, all inside the backend:
  1. **Register allocation for scalars.** A dry pass over the emission walk records each
     u32/bool value's definition position and last use (a value read inside a loop stays live
     to the loop's end); a linear scan then gives each one a home among the callee-saved
     w19-w28, spilling to a slot only when they run out. A function with no residual call is a
     leaf and also uses w0-w7, keeping parameter i in w_i, so `ident` is `ret` and `affine` is
     two instructions. Callee-saved homes survive residual calls, so nothing is saved or
     restored around a call; AAPCS64 argument and result placement is unchanged.
  2. **Inlining at `call`, `fold`, and `loop` sites.** Callees of at most 48 nodes (nested to
     6 deep) are emitted in the caller's frame with their parameters bound to the caller's
     values; the loop state and counter are ordinary scalars, so `loop64` is a ten-instruction
     register loop (compare, branch, five ops, state move, increment, branch). Larger callees
     are still called out of line.
  3. **Aggregates updated in place.** A `set`/`put` on a provably unshared value (the same
     `mutableHere` analysis the JavaScript backend uses: fresh or the owned iteration state,
     read only by `get`/`at` before the node, not returned) stores one element and its result
     aliases the container's slot; `mov` and an inlined callee's result alias likewise, and a
     fold whose init is unshared iterates in the init's own slot. `arrfill` went from two
     8-word copies plus a call per iteration to one `str`.
  Frames above 4 KiB are now probed one page at a time inline instead of through
  `___chkstk_darwin`.
- **Correctness**: `bun run verify` native_arm64 4297/4297 at both optimization levels, every
  other path unchanged (5262). Two bugs found by the corpus and fixed before this commit: a
  residual call did not record its argument reads, so a loop state could take the register of
  a parameter still needed as an argument (g13); and an inlined callee's result was bound at
  the position of the callee's last node, so a dead trailing node could share the return
  value's register (g29). Unit tests 35/35 (12-parameter call, aggregate result, 4 KiB frame,
  fold with array state, loop with variable cap all still covered); lint and typecheck clean.
- **Measured (arm64 vs A0-via-clang, same C driver, interleaved, median of 9 samples of 20 M
  calls; the machine was NOT quiet: load average 10-21 on 8 cores for both runs, so only the
  ratios are meaningful and even those carry noise of about +-0.1x on the 3-6 ns kernels)**:

  | kernel | before | after |
  |---|---|---|
  | affine | 0.95x | 1.02x |
  | rotl | 1.00x | 1.19x |
  | clamp | 1.00x | 1.08x |
  | mix | 1.06x | 1.12x |
  | ident | 1.00x | 1.01x |
  | noop | 1.01x | 1.01x |
  | chain3 | 1.39x | 1.03x |
  | branchy | 1.06x | 1.02x |
  | arrfill | **30.89x** | **1.32x** |
  | loop64 | **8.47x** | **1.12x** |

  A second "after" pass under a heavier load (14-18) gave affine 1.05x, rotl 1.19x, clamp
  1.11x, mix 1.10x, ident 1.00x, noop 0.98x, chain3 1.02x, branchy 1.23x, arrfill 1.38x,
  loop64 1.27x, with absolute times up to 2x the first pass: the spread between the two
  passes is the load, and the honest claim is "arrfill and loop64 went from 30x and 8x to
  within about 1.1-1.4x of the clang path"; the exact number needs a quiet machine.
  The arm64 kernel is still an out-of-line call from the C driver while the C path inlines
  into the driver loop, so a ratio near 1.0x on a 2-5 ns kernel is the call overhead, not
  code quality. `results/exec-benchmark.json` is not regenerated here (the full bench needs a
  quiet machine); the committed 8.4x/30x numbers there and on the site are superseded by this
  table and should be refreshed by a quiet `bun run exec-bench`.
- **What remains**: a leaf still saves and restores x29/x30 (four instructions around `rotl`'s five), loop-invariant constants (the `movz/movk` of a literal multiplier is
  materialized inside the loop), the per-iteration `mov` of the body's result into the state
  register (the body's last node could be homed on the state), no register homes for
  aggregates or their elements, callees above 48 nodes still copy aggregate arguments on
  entry, and the C driver's call boundary itself. io functions are still refused.

## Session 2026-09-30 (site: live-code hero, QA pass, agent files)

- Hero replaced by a "live code" scene built from tags, text, classes, and CSS keyframes only (no canvas, no scene shader): a model edits `clamp` through the view, the reply `e0 / hi lt p2 a` is accepted at the real revision `fe014071`, the view reorders as the edit session does, and A0's own AArch64 output appears with the measured 5.0 ns per call. The one runtime hook it needs is the existing `.reveal` → `in`. Prototype designed in plain HTML and ported into `page.a0` by the generator; protocol tags 24 h6, 25 b, 26 i added to the runtime and the prerenderer.
- Prerendering: the build runs each page program through the reference interpreter and ships the DOM as HTML (`tools/site-render.ts`), so agents and crawlers without JavaScript get the full page; the browser re-renders the identical tree. Text exports for agents: `/llms.txt`, `/llms-full.txt`, `/primer.txt`, `/docs.txt`, `/index.txt`, `/results/*.json`, `robots.txt`, `sitemap.xml`; canonical, Open Graph, and JSON-LD metadata.
- QA pass (agent, 31 findings) fixed: sections were never closed in the page program (all nested); mobile header, nav links, hero, chart columns, code wrapping, docs table, docs TOC as chips; focus-visible; balanced headline; FAQ grid; copy and number disagreements (primer 388 tokens, o200k). Home page decluttered to six charts and short copy.
- Wasm: a page program with hundreds of text literals overflowed wasm-ld's 64 KiB default stack ("memory access out of bounds"); `WASM_FLAGS` now links with a 1 MiB stack.
- Performance: no scene, content visible before JavaScript (reveal motion only for what scrolls in), fonts preloaded; measured on the deployed page: TTFB 10 ms, DOM ready ~500 ms, wasm 56 KB brotli, session compute 0 ms.
- In progress (agents): baselines for many more languages in exec-bench (Go, Java, Kotlin, C#, Swift, Zig, TypeScript, C++, Ruby, PHP, Lua, Perl, Dart, Nim, Crystal, D, OCaml, Haskell, Julia, R, Erlang/Elixir, Scala, Fortran, Pascal, Racket, Lisp, Clojure, Groovy, Tcl, COBOL as toolchains allow); A0 parser in A0; large arrays with in-place C updates.

## Session 2026-09-30 (tiny primer)

- `MODEL_GUIDE.tiny.txt`: 234 o200k tokens (min 388, short 304). Fresh subjects, one shot, sets A and B (scratchpad g11; TS/Rust cells reused). Results `results/ai-edit-experiment.{,b.}{haiku,sonnet}-tiny.json`.
  - Sonnet: 13/13 and 12/12 on both A0 cells. Haiku: A 12/13 both cells (cube = sq(sq x), a repeated model error), B structured 10/12 (fold callee arity wrong; p3 on a three-parameter function). All four classified as model errors: the primer states the fold signature and parameter rule; no general fix applies.
  - Cost, Sonnet structured, cache-adjusted tokens per task (one task / session of ten / no cache): min 147 / 127 / 545, short 139 / 123 / 461, tiny 133 / 119 / 391; TypeScript 109 / 103 / 224. The primer is the entire gap: context (77 vs 69) and output (28 vs 28) are level. On single-function tasks A0 cannot beat TypeScript while any primer travels; the default primer stays MODEL_GUIDE.min.txt (Haiku holds 100% only there) and all three are published.
  - Next measurement (set C): the same tasks embedded in realistic-size programs, where the conventional cell must read the whole file and the scoped A0 view stays small (7.3x on the 17-function Life program).

## Related work (studied 2026-09-29, from public repos/docs only; nothing built or reproduced)

The user supplied a list of 20 repositories. The eight closest were read via their READMEs,
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

- a0lang.com is deployed (2026-09-29, approved by the user): Vercel project `a0lang` in team
  `simo-js`, domain verified on Vercel DNS. **The whole site is one A0 program** (v0.8.8):
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

**Public since 2026-09-30 under the MIT license** (user decision, superseding the earlier
"private during research" rule): https://github.com/Joe-Simo/a0. Tracked files were scanned
for secrets before the change (none; `results/tokens.json` and `tools/token-bench.ts` are
token counts).


GitHub repo `Joe-Simo/a0` (public, MIT), branch `main`, project
at repo root, `bun.lock` committed, `dist/` and `node_modules/` ignored. Commits are
listed by `git log`; the push is verified against `origin/main` after each commit.

## Blockers / not done

- GitHub Actions CI (`.github/workflows/ci.yml`) is committed but does not start: GitHub
  reports a billing/spending-limit problem on the Joe-Simo account (user chose to ignore
  for now). Regressions are gated by the local suite: `lint`, `typecheck`, `test`,
  `verify`, `hw`, `app`, `equiv`, `bench`, `tokens`, `exec-bench`.
- `A0-Research-Starter.zip` absent (see Provenance).
- Gate 6 live runs: spend was authorized by the user on 2026-09-29, but no Anthropic API
  key exists on this machine (only `ANTHROPIC_BASE_URL` is set), so the run is unrun.
  With a key: `ANTHROPIC_API_KEY=… A0_ALLOW_PAID_MODEL_CALLS=1 bun run experiment`.
- No Claude-tokenizer counts (needs `count_tokens` with credentials).
- Not implemented: memory/regions beyond fixed arrays, FFI, network edit
  service, hardware pipelining/scheduling beyond the multi-cycle divider, timing/area on a
  real cell library, mobile packaging.
- This machine: shell `node` now resolves to an x64 Node 22 under nvm; the project needs
  the arm64 Node 24 (`~/.nvm/versions/node/v24.14.0/bin`) first on PATH or `biome` fails
  to load its native binary. Benchmarks taken this session were under load averages of
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
