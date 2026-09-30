# A0 status ledger

Updated 2026-09-30. Durable state for the next session: scope, evidence, blockers, next action.
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
  A0Error. Literal iteration counts are bounded statically; variable counts are bounded
  by fuel in the interpreter and are not bounded on compiled targets (compiled code has no
  execution budget). Not done: a runtime fuel counter in compiled targets (costs speed;
  measure before adding), memory/time limits per compiled process, sandboxing of toolchains.
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
## Session 2026-09-30 (large arrays, in-place C)

Step 1 of self-hosting the compiler in A0: make large arrays practical on the native C path. Compiler version a0c-0.1.6 -> a0c-0.1.7 (every emission change bumps it; results regenerated by the gate).

- Limits (`src/core.ts` LIMITS): `maxArrayLength` 1024 -> 65536 per dimension; `maxAggregateBits` 2^16 -> 2^21 (65536 words per value, so nested arrays stay bounded). New `maxVectorArrayLength` = 1024: the SystemVerilog and Metal backends refuse any function whose parameters, result, or nodes use a longer array with `A0Error` code `limit` and a fix line (`assertVectorSized`), instead of emitting multi-megabit vectors. Native targets (C, C++, Wasm, JVM, .NET, arm64) accept the full size. Test: `u32x65536` compiles to C (`uint32_t e[65536]`) and Java (`int[]`); `sv` and Metal throw `limit`; `u32x65537` and `u32x65536x2` are rejected at parse time.
- Target notes on 65536 arrays: C holds them in structs by value (16 KiB at 4096 elements, 256 KiB at 65536; clang's `___chkstk_darwin` probes large frames, as the arm64 backend already does). Java arrays are heap objects, C# arrays are heap objects, JS uses typed arrays: no change needed. Literals: an all-zero scalar-array literal is now a plain zero allocation on C (`a0zero_T()`, `= {0}`), Java (`new int[N]`), and JS (already); a non-zero literal is still one operand per element, which C compilers accept but a 65536-element Java literal would exceed the JVM's 64 KiB method limit (recorded, not hit by any program in the repo).
- C backend in-place updates (`src/backends.ts`, `mutableHere` generalized over an owned-parameter predicate, shared with JS): the public by-value ABI is unchanged. Inside a function every by-value aggregate parameter and every fresh local (`arr`/`rec`/`set`/`put` result) is private, so a `set`/`put` whose old value is provably dead (only `get`/`at` reads before it, never read after, not returned) is emitted as an assignment statement and the node becomes an alias of that storage (no local of its own, `const` dropped on the root). Iteration-shaped functions (`p0` aggregate state, `p1` u32) additionally get `static inline void a0o_f(T *p0, ...)` (body: updates the loop state through the pointer, stores a non-aliased result once) and, when they return bool, `static inline bool a0r_f(const T *p0, ...)` (predicate). `fold`/`loop` over aggregate state call these with `&state`; when the initial value is itself unshared the loop runs in its storage (no copy), otherwise one copy per fold as before. Values still observable are copied exactly as before (`a0set_`/`a0put_`). Metal maps the new pointers to the `thread` address space. Verified: unit test on the emitted text; differential drivers (5262 cases per path) and Life (134 cases) unchanged; a sanity program with chained sets, a copy-then-update, a record `put` of a `set` result, and a loop predicate matched the interpreter on clang C/C++ with UBSan.
- Benchmark (`tools/exec-bench.ts`): new kernel `arrfill4k` (fold of 4096 `set`s over `u32x4096`, then two reads) with the hand-written C, JS, Python, and Rust baselines; kernels may carry `iterScale` (this one 128: 156k native calls per sample) and `noArm64` (the direct arm64 backend copies the 16 KiB state into and out of every trip and would take hours; reported as blocked with that reason). `node dist/tools/exec-bench.js <kernel>` runs one kernel A/B and prints it without rewriting the ledger. Single-kernel numbers, this machine under load (1-minute load 10-23, so absolute values are inflated; ratios are from interleaved runs):
  - a0c-0.1.6 shape (copy per trip, reconstructed by hand from the same program) vs a0c-0.1.7 in place, interleaved, identical checksums: median 2,782,564 ns vs 848 ns per call, min 2,370,582 vs 738 ns: about 3,300x.
  - a0c-0.1.7 vs hand-written C (`uint32_t a[4096]` left uninitialized): 770 vs 520 ns (run 1), 580 vs 425 ns (run 2): recorded as a loss (1.4x). vs Rust (`[0u32; 4096]`): 770 vs 748 and 580 vs 564: tie. Against a hand-written C baseline that zero-initializes (`uint32_t a[4096] = {0}`, one-off measurement, not committed): 559 vs 671 ns, tie. The residual is the 16 KiB zero-fill that A0's `arr` literal semantics require; the update path itself is at parity. JS: tie (5,771 vs 5,515 ns).
  - The full `bun run exec-bench` was not rerun (machine under load; the instruction was a single-kernel A/B). `results/exec-benchmark.json` therefore still lacks `arrfill4k`; rerun on an idle machine.
- Gate (this worktree, all exit 0): lint pass; typecheck pass; test 36/36; verify all paths pass with identical case counts (interpreter, optimizer, JS, C clang, C gcc, C++ clang, Wasm, JVM 5262 each; arm64 4297 with the same 965 io cases skipped); app pass (134 cases on interpreter, optimizer, JS, C, C++, Wasm, JVM); equiv 48/48 proved, 0 counterexamples; hw RTL simulation and Yosys synthesis passed; dotnet passed (5262 cases, .NET SDK 10.0.401); gpu passed (4297 cases, 30 kernels, Apple M3). `results/{verification,app,equivalence,hardware,dotnet,gpu}.json` regenerated under a0c-0.1.7.
- Not done: `site/docs.a0` still says "arrays up to 1024 elements" (site/ is owned by another agent; needs "65,536 elements; 1,024 on hardware and GPU"). `src/arm64.ts` still copies aggregate state per trip (another agent owns it; the same `mutableHere`/owned-variant scheme applies). Self-hosting still needs byte strings and larger io buffers.

## Session 2026-09-30 (self-hosting: parser)

- `compiler/parse.a0` (`use "lex.a0"`, 39 functions): the A0 parser written in A0, stage 2 of the self-hosting plan. It consumes the lexer's `kind start length` triples and produces the word IR of DESIGN.md 7a: `pool`/`sym` (interned identifiers and strings; sym 0 is `retval`, the id of a `ret OP ARGS` node), `types`/`tlist` (u32 bool io seeded at 0 1 2; every `u32xN` and record type interned once, so a type index is a type identity), `fns` (7 words), `nodes` (6 words), `args` (kind value pairs), and `uses` (the syms of `use "..."` lines). Every branch is selected; the passes are `loop`s over the tokens that stop at the first error.
- Covered: `fn NAME T... -> T`, instruction lines, `ret ARG` and `ret OP ARGS`, `end`, comments, `use` lines (before the first fn), types `u32 bool io u32xN` and records nested to any depth, operands (earlier id, `pN`, decimal literal, `true`, `false`), all 31 ops, `text "..."` decoded into byte literals (escapes `\n \t \" \\`), callee and predicate names of `call`/`fold`/`loop` resolved to indices of earlier functions. Errors as (code, token index): 1 parse (unknown op, bad header, `end` before `ret`, unterminated function at the token count, duplicate function name, `use` after a fn), 2 structure (unknown callee or predicate, duplicate id, reference to an undefined or later node).
- Not yet: type checking and arity (stage 2b), linking (`use` is recorded, not resolved: parsing `compiler/parse.a0` alone reports its first call into lex.a0 as an unknown callee, as it should), `limit` codes (a literal over 2^32 wraps), array element types other than u32 (the IR has none), sources over 512 bytes (the tables are `u32x512`; the pass states are records of at most four tables because a record is capped at 65536 bits; every size is a textual change once the cap rises).
- Design notes: keywords, ops and type words are recognized by an exact base-37 packing of up to six bytes (one `eq` per word, no byte strings); the stack of a record type under construction lives in a `u32x256` beside the tables; state that would not fit one record is split across passes (intern: pool sym tsym; uses; headers: types tlist fns stack; bodies: fns nodes args), and each pass seeds its error from the previous one so the first error wins in pass order, exactly as the reference.
- Verified two ways. (1) `tools/ref-parse.ts`: `refParse(src)`, an independent token-driven TypeScript reference producing the same word tables (src/core.ts is not used); `bun run app` runs `parseio` through interpreter, optimizer, JavaScript, native C, wasm32 and JVM on 15 sources (small programs, error cases, examples/*.a0 and compiler/lex.a0 cut at 500 bytes both at a line and at a function boundary). (2) `test/core.test.ts`: for each function of each example the IR (reference on the whole file, A0 parser on the well-formed prefix, the two equal word for word) agrees with `parse()` on names, parameter counts, node counts, ops, operands, callees, predicates and the ret operand.
- Sizes: examples/life.a0 (4129 bytes, 1198 tokens) parses to pool 555 bytes, 183 syms, 5 types, 31 tlist entries, 14 functions, 175 nodes, 420 operands (2965 words with lengths); compiler/lex.a0 to 11 functions, 158 nodes, 875 operands.
- Blocker (toolchain, not this parser): the wasm32 target fails on every parser case with `memory access out of bounds`. Measured with `-fstack-usage`: `parseio` needs 87 KB of shadow stack (every table lives in its frame) and the lexer chain already used 58 KB; wasm-ld's default stack is 64 KB. With `-Wl,-z,stack-size=1048576` added to `WASM_FLAGS` all 15 cases pass on wasm (checked by running the harness with the flag). That flag lives in `src/toolchain.ts`, which this session was told not to touch, so `bun run app` reports the parser's wasm target as failed until it is added. Gate otherwise: lint, typecheck, test 37/37, app: Life 7/7 targets, lexer 6/6, parser 5/6.

## Session 2026-09-30 (task set C, project scale)

- `tools/ai-edit-tasks-c.ts`: set C = the twelve set-B tasks (same instructions, tests, reference edits; ids `c-*`) with every target embedded in one deterministic 40-function program, identical for all twelve tasks and across the three representations (same names, same order, callees before callers): the set-A and set-B task functions, six from `examples/life.a0` (nb, count, bitstep, popcount, rowpop, population), `is_even` from `examples/kernels.a0`, and hand translations to TypeScript and Rust of every A0 fold helper the set-B sources had inlined (addi, addel, minmax, mixel, dstep, pstep, inc, below). Filler precedence B > A > hand translations; the file is assembled from per-function texts (`splitFunctions`, `assemble`), so a reference edit replaces its functions in place and new functions (norm2, pctof, hamming) append. `A0_EXPERIMENT_TASKSET=c`; `taskSetSha256` covers the assembled sources: `8c125465573d3387dbd88f6c8e7e4dc3d54c3a126823255c7ff04a77c7ef0a80`.
- Protocols for C (recorded in the report's `method` field and in the module comment): `conventional` sends the whole file in every representation; `structured` sends for A0 the dependency-scoped view of the target (`open(name, {scope: 'deps'})`: body plus one signature line per callee) and the program handle (one signature line per function), and for TypeScript and Rust the whole numbered file with the line-edit protocol. Locating the function in the file is part of the job for TS/Rust, as it is for an agent editing a real file; the asymmetry is what set C measures.
- Harness: self-check ok for all 12 tasks x 3 representations (originals compile and fail, references pass) in scripted mode with an empty replies file; scripted replies, repair loop, dump, and token buckets exercised on two tasks across all six cells. The report now carries `contextTokensByCell` (mean view and mean first-attempt tool context per cell) and prints it.
- Context cost per cell before any model runs (o200k, mean over 12 tasks; toolContext = task text + view): a0/conventional 1411, a0/structured 590, ts/conventional 1786, ts/structured 1966, rust/conventional 1888, rust/structured 2075. The scoped A0 view is 2.4x smaller than the A0 file and 3.0-3.5x smaller than the TS/Rust files; of the 590, about 480 is the 40-line program handle, the scoped function itself is 50-120 tokens. Against that, the A0 language primer (min, 405 tokens per call) is now smaller than the context saving (about 1200 tokens versus TypeScript), so at this program size A0 structured should cost less per task than any other cell even with the primer travelling; the measurement is the next step.
- Not done: no model has been run on set C. Prompts: `A0_EXPERIMENT_TASKSET=c A0_EXPERIMENT_REPLIES=<empty {} file> A0_EXPERIMENT_DUMP=<path>.json node dist/tools/ai-edit-experiment.js` (the harness rewrites `results/ai-edit-experiment.json`; run from a scratch copy or restore it). The Rust file needs rustc; the TypeScript acceptance needs `node_modules/.bin/tsc` under the working directory (a fresh worktree needs `bun install`).

## Session 2026-09-30 (set C collected: project scale)

- Fresh subjects (Haiku and Sonnet), all six cells, one shot, min primer (scratchpad g12). Results `results/ai-edit-experiment.c.{haiku,sonnet}-min.json`.
- Sonnet, cache-adjusted tokens per task (one task): A0 structured 670 at 12/12 vs TypeScript 2007 at 12/12 vs Rust 2115 at 12/12: **A0 3.0x cheaper** (a win). Conventional: A0 2834 vs TS 3549 vs Rust 3754 (1.25x). Haiku: A0 structured 672 at 11/12 vs TS 2041 at 9/12 vs Rust 2135 at 11/12.
- Haiku's two A0 misses: `select (lt a b) ...` (nested expression, third sighting, all from Haiku on the bounds task; Sonnet never; the diagnostic names the fix) and a callee defined after its caller in the whole-file cell (a model error against the stated rule). Item B decision: refusal documented, not added; 3 occurrences in ~150 Haiku structured replies, 0 in Sonnet.
- Site: the Edits card and the Cost section now lead with set C and keep the single-function loss (0.68x/0.71x vs TypeScript) in the same chart.

## Session 2026-09-30 (repair round, Haiku)

- One repair round after the one-shot pass (rule 1), Haiku, min primer, all sets, fresh subject contexts seeing the original prompt, their first reply, and the rejection (scratchpad g13). Results `results/ai-edit-experiment.{,b.,c.}haiku-min-repair.json`.
- After one repair: set A all six cells 13/13; set B all six 12/12; set C A0 conventional 12/12, A0 structured 11/12, TypeScript structured 10/12, Rust structured 11/12, the rest 12/12. The one A0 miss is the bounds task: first a nested `select (lt ...)`, then the body of the callee written under the caller's handle (model error). Sonnet had no first-attempt failures to repair.

## Session 2026-09-30 (playground)

- `site/play.a0` (goal item E): a live playground at `/play/`, the third page program, built and prerendered like the others (`site/play.html` shell, `data-program="/play.wasm"`, 138,944 bytes of wasm). It `use`s `../compiler/parse.a0` (and through it `lex.a0`): the source in the text area is lexed and parsed by the self-hosted A0 compiler stages in the browser, and the page shows the token count, a token table (index, kind, text), the word IR of DESIGN.md 7a (per function: name, parameter count, result type, node count; each node as `id op args` and the `ret` operand, symbols read back from the pool), and the first diagnostic (parse or structure error with its token, or "at the end of the input"). `analyze` runs the four parser passes exactly as `parseio` does, without io; op, kind and type names are fixed-width byte tables indexed by code (no strings in select). Default source: the home page's clamp function. Event 0 renders the state's source (or the default), event 1 runs the submitted text; the STATE is the source (n then n bytes), so the text survives a re-render. Sources are capped at 480 bytes (the compiler tables are u32x512).
- Runtime (`site/app.ts`, still generic): tag 27 `textarea` (also in `tools/site-render.ts` and the ui.a0 comment); `TEXT_CAP` 64 -> 480 and `IN_CAP` 512 -> 1024 (3 + 1 + 480 + 1 + 481 state words), with `tools/site-build.ts` giving the C io struct the same `ioInputCapacity` 1024; an event now sends the bytes of the page's `input` or `textarea`; ONSUBMIT on a textarea fires on Ctrl/Cmd+Enter and leaves the field's content to the program's TEXT (an input keeps Enter and its typed value as before). Fuel and output caps unchanged.
- Shared chrome: the identical `sec_nav`/`sec_foot` blocks of the generated `page.a0` and `docs.a0` moved to `site/ui.a0` as `nav` and `foot` (the generated files now call them; a "Play" link was added to the nav once, for all three pages). `/play/` is in the sitemap.
- Verified: `bun run site` builds three programs; new test (39/39) runs the play session through the interpreter on a submitted source and checks the token count, the node lines, the ret, the diagnostic, the echoed state and the state-driven re-render; lint and typecheck clean; served `site/dist` locally and drove `/play/` with Playwright (typed a program, Run, 22 tokens and the IR rendered by the wasm, no console errors); screenshot `.playwright-mcp/play.jpg` (gitignored).
- Checker in the playground: `site/play.a0` now `use`s `../compiler/check.a0` (play.wasm 138,944 -> 172,207 bytes). After `lex` and the pure `parse`, the parser's tables are widened as `checkio` does (u32x768/1024/4096/8192 copies, zero on a parse error) and `check` runs on them; every node line of the IR panel carries the node's type from `ntys` as a muted span, rendered like the source from the checker's extended tables (u32, bool, io, u32xN, `(u32,io)`, `(u32x2,u32x4)`; three levels of nesting, `ty0..ty3`), and the function's result type comes from the same renderer. An ill-typed program shows the checker's diagnostic (type/structure/limit error, `in fn NAME`, `at node ID` from `nodes[6i]`, `at ret`, or `in the header`, then a one-line meaning per code); the nodes before the error stay typed, the ones after are untyped. Both passes give a green `valid: parsed and type-checked` line. Names that clash with check.a0 were renamed (`irfn`, `irnode`). Test extended (40/40): typed node lines, the type error at node b, the ret structure error, and body-built types rendering; `bun run site` builds; served `site/dist` and drove `/play/` with Playwright (ill-typed program, Run, the diagnostic from the wasm, no console errors); screenshot `.playwright-mcp/play2.jpg`.
## Session 2026-09-30 (self-hosting: checker)

- `compiler/check.a0` (`use "parse.a0"`, 34 functions, 85 linked): the A0 type checker and validator written in A0, stage 3 of DESIGN.md 7a. Input: the word IR of the parser (types tlist fns nodes args). Output: the type index of every node (`ntys`), the type tables extended by the types bodies build (arrays of any element type as `(4 length elem)`, records, the `(u32,io)` of `read`, interned so a type index stays a type identity), a saturated iteration bound per function (`fstat`), and the first diagnostic as (code, function index, node index): 3 type, 2 structure, 4 limit, the categories of `src/core.ts validate`, in its order. Node index: the node's position in its function, the node count for the `ret` operand, 4294967295 for a header error. `check` validates functions [from, to) given the bounds of the earlier ones, so a program larger than the tables (types u32x768, tlist u32x1024, fns u32x1024, nodes u32x4096, args u32x8192, 1024 node types) is checked in chunks; `checkio` runs lex, parse and check on up to 512 source bytes and writes ok, code, fn, node (fn 4294967295 and the token index for a parse error), then types, tlist and the node types with their word counts. `parse.a0` gained a pure `parse` (source bytes to the IR record) that `parseio` now writes out, byte for byte as before.
- Rules covered (each one `validateFunction` applies, in its order): parameter limit 64 and node limit 4096 (limit), at most one io parameter (structure); per node: arity of every fixed-arity op and at least one operand for `arr`/`rec`/`text` (structure), a parameter out of range (type), io linearity over all operands before the op is typed (a token consumed twice is a structure error; `at` does not consume its record), then `mov`; `add sub mul shl shr div rem` on u32; `and or xor eq ne` on two u32 or two bool, never mixed; `lt le gt ge`; `select` (bool guard, equal branches, no tokens); `get`/`set` (array, u32 index, element type); `at`/`put` (a record, a literal field index in range as structure errors, then the field value as a type error); `read write puts`; `arr`/`text` (every element of the first element's type, no tokens, aggregate width, limit code over 2^21 bits); `rec` (at most one token, width); `call` (callee arity as structure, each argument as type); `fold`/`loop` (count and state present, u32 count, body shape (state, index, extra...), state and result types, extra count and types, the predicate's bool result and identical parameters, and the literal-iteration bound 2^24 with the reference's exact bookkeeping: `call` raises the literal bound too, a variable count saturates the total bound); after the nodes the `ret` operand (type, then a consumed token). Bounds and widths are kept saturated (2^24+1, 2^21+1) since only the comparison with the limit matters.
- Not covered: everything the parser already decides (unknown op, unknown callee or node, duplicate ids and names are parse-stage codes with a token index; the TypeScript parser also rejects arity and an empty `text` at parse time where the A0 front reports the checker's structure code), literals over 2^32 (the parser wraps them; TypeScript says limit), header array types other than `u32xN` (`boolx4`, `(u32,bool)x2` in the corpus are parse errors in `parse.a0`; the checker itself handles them, so the differential test feeds them through a TypeScript encoder of the IR), the invalid-identifier and callee-presence checks (impossible in the IR), and `too many functions` beyond 1024 (unreachable with a u32x1024 fns table, kept as a check).
- The reference's literal-iteration rule bit the front itself: `checkio` originally widened the parser's tables with literal-count folds after calling `parse`, whose bound is saturated by its variable-count loops, so the literal folds were `structure` errors at 2^96 iterations; the copies now run over the actual word counts (variable, and cheaper). The checker reproduces exactly this rule.
- Verified two ways. (1) `tools/ref-check.ts`: `refCheck(ir, from, fstat, to)`, an independent TypeScript checker over the word IR of `refParse` (no use of src/core.ts) with the same (code fn node) and tables, and `refCheckWords` for the io front; `bun run app` runs `checkio` through interpreter, optimizer, JavaScript, native C (clang, UBSan), wasm32 and JVM on 39 sources: the parser's 15 (small programs, error cases, examples and lex.a0 cut at 500 bytes) plus 24 hand-written ill-typed programs, one per rule (`ILL_TYPED` in ref-check.ts: operand type, mixed bool/u32, eq mixed, arity, parameter range, fold state, fold count, loop predicate, iteration bound, call arity, io twice, consumed token returned, two io params, io in array, select on tokens, record with two tokens, ret type, unknown node, array index type, get on a scalar, field out of range, put field type, puts on a scalar, aggregate limit). (2) `test/core.test.ts`: every function of results/corpus.a0 (48 functions, 2444 nodes, 5400 operands, in chunks of the tables), examples/kernels.a0 and examples/life.a0, and the linked compiler/lex.a0, compiler/parse.a0 and compiler/check.a0 (the checker on itself, all but `zeros8192`, whose 8192-operand literal cannot fit an 8192-word args table) is encoded into the IR from the TypeScript `Program`, run through `check` in the interpreter, and must be accepted with every node's type equal (`typeEquals`) to `validate()`'s and the per-function iteration bounds equal to the reference's; the 24 ill-typed programs go through `checkio` and must report `validate()`'s category at its function and node (category only where the TypeScript parser rejects the program first). Node's `run` validates every array argument on every call, so the interpreter pays for the 8192-word tables: about 2.3 ms per checked node, 21.7 s for the test; the native targets do not.
- Sizes: examples/life.a0 (14 functions, 175 nodes, 420 operands) checks to 6 types (the parser's 5 plus `(u32,io)`), 33 tlist entries (31 plus the two fields), 175 node types, iteration bounds up to 1024 (`step` folds 1024 cells), 0.5 s in the interpreter. compiler/check.a0 is 48.7 KB, 34 functions, 4 zero tables of 768/1024/4096/8192 words.
- Gate (this worktree, all exit 0): lint pass; typecheck pass; test 39/39 (checker test 21.7 s); app: Life 7/7 targets 134 cases, lexer 6/6 (7 cases), parser 6/6 (15 cases), checker 6/6 (39 cases); `results/app.json` regenerated with the checker rows. DESIGN.md 7a: stages renumbered (checker is stage 3), the array type triple generalized to `(4 length elem)`, `ntys`/`fstat` and the diagnostic locations recorded.
- Not done: the parser still accepts only `u32xN` header types and sources up to 512 bytes, so `checkio` cannot take the corpus or the compiler whole (the test goes through the IR encoder instead); the checker does not yet resolve `use` (a linked program is checked as one IR); node ids are not in the diagnostic (the node index is; the id is `nodes[6i]` for a caller that wants it).

## Session 2026-09-30 (more baselines)

- `bun run exec-bench` now runs 45 hand-written baseline languages next to C, Rust, the direct arm64 backend, and JavaScript, from one data table (`tools/exec-bench-languages.ts`, `tools/exec-bench-languages-more.ts`: per-kernel source, driver template, toolchain finder, build and run commands). Every kernel in every language is checksum-verified against the A0 result for the same iteration count before it is timed (mismatch = `skipped-checksum-mismatch`, never a number); runs are interleaved across languages sample by sample; medians of 7; process-launch latency per language. `results/exec-benchmark.json` keeps its old keys and adds per-language rows (`family`, `toolchain`, `status`, timing, `startupMs`), `startupCompiledMs`, a top-level `languages` block, `skipped`, and `geomeans` (baseline ns / A0 emitted-C ns, geometric mean over the 10 kernels; 1.0 = parity). Options: `--langs`, `--kernels`, `--samples`, `--scale`, `--out`, `--help`.
- Run of 2026-09-30 05:34 UTC, 45/45 languages ran on 10/10 kernels, nothing skipped. Load average at start 11.6 (8 cores; the 10-minute quiet wait expired, so the run went ahead under load as instructed), 6.4 at the end. C-path A0 tied hand-written C and Rust on all 10 kernels; arm64 1.80x geomean (chain3 1.34x, arrfill 29.5x, loop64 8.3x losses unchanged).
- Geomean ratios vs native A0 (higher = A0 faster per call): Zig 1.00, C 1.00, Rust 1.00, Odin 1.00, C++ 1.01, D 1.01, Crystal 1.02, V 1.03, Nim 1.04, Objective-C 1.12, Fortran 1.12, Julia 1.14, Vala 1.18, Swift 1.34, Java 1.41, Kotlin 1.45, Scala 1.45, F# 1.47, TypeScript 1.52, Go 1.66, C# 1.71, Visual Basic 1.75, Pascal 1.77, Dart 1.97, Groovy 2.55, Clojure 2.61, Common Lisp 2.92, OCaml 3.07, Haskell 3.46, Racket 4.62, Gleam 5.24, Erlang 7.04, JavaScript 7.95 (emitted JS 7.69), Elixir 8.48, Forth 16.7, PHP 20.8, Lua 20.9, CHICKEN 29.0, Haxe (eval) 75.5, Ruby 78.1, COBOL 95.6, Perl 145, Python 174, Guile 278, Smalltalk 304, Tcl 475, Prolog 869, R 3524.
- Read the numbers with their tiers: the JVM/.NET rows are in-process warm JIT (20M or 5M iterations after a warm-up pass), interpreters run 100k (R and Smalltalk 10k) iterations; Lua, CHICKEN, Pascal, COBOL, and Smalltalk report CPU-time or millisecond clocks (`timer` field). R emulates u32 on doubles with 16-bit bitwise halves, PHP splits products into 16-bit halves (signed 64-bit ints overflow to float), Haxe eval uses 32-bit signed ints with a sign-flip unsigned compare; all verified by checksum.
- Startup (one process, one iteration, median ms; native A0 2.3): Odin 1.6, Nim 1.7, Swift 1.8, C++ 1.9, Zig 2.0, Lua 2.5, Go 2.7, OCaml 2.7, Crystal 3.1, D 3.4, Perl 5.3, Tcl 7.2, Dart 11.1, SBCL 16.3, Haskell 18.6, Python 20.7, C# 22.0, Node/TypeScript 23.0, Kotlin 31.3, Java 36.5, Ruby 48.1, PHP 49.7, Racket 62.8, Scala 75.2, R 113, Julia 131, Erlang 156, Elixir 238, Clojure 342, Groovy 734.
- Bugs found while verifying: GnuCOBOL 3.2 evaluates `B-XOR`/`B-SHIFT-R` wrongly for values above 2^31 when nested inside a `FUNCTION MOD` argument (kernels keep boolean and arithmetic steps in separate `COMPUTE`s); gforth 0.7.3 has no `umin`/`umax`; Homebrew gfortran needs the macOS SDK library path passed to `ld`; Zig 0.16 moved argv to `std.process.Init.Minimal`.

## Session 2026-09-30 (merged: 45 languages, checker, playground, arm64 re-measured)

- Merged this session: arm64 register allocation and inlining (a0c-0.1.7), 65536-element arrays with in-place C updates, both under COMPILER_VERSION a0c-0.1.8 with results regenerated; A0 lexer, parser, and type checker written in A0 (`compiler/`), each differentially verified against an independent TypeScript reference and run on every target by `bun run app`; the /play/ page (a third A0 program running the self-hosted front end in the browser); task set C; the tiny primer; the Haiku repair round; 45 language baselines in exec-bench (table-driven, every kernel checksum-verified, 0 skipped).
- exec-bench ledger: the 45-language run was taken under load (1-minute load 11.6 at start, recorded in the JSON); A0 via C still ties C and Rust on all ten kernels. The arm64 rows were re-measured afterwards with the new backend (load ~7): ties clang on 6 of 10 (within 10%), behind on loop64 1.36x, arrfill 1.30x, mix 1.12x, rotl 1.11x; geomean 1.10x (was 1.80x with the old backend, 30x and 8.4x on the two loop kernels). A quiet-machine rerun of the whole ledger is still owed.
- Site: 48-language chart (log scale) on the home page; native paragraph and limits computed from the ledger; README table from the ledger.
- Open: quiet-machine exec-bench; stage 4 of self-hosting (optimizer and AArch64 emitter in A0); bootstrap fixed point; x86-64 and other targets; release note when the ledger reads parity or better on every axis except the single-function primer cost.

## Session 2026-09-30 (set D: independent author, primer only)

- `tools/ai-edit-tasks-d.ts`: 13 tasks written by an agent that saw only MODEL_GUIDE.min.txt and the task-file shape, sealed in `tools/ai-edit-tasks-d.sha256` (a0bafeeb…3651); the harness self-check verified every original and reference in all three representations. Harness set `d`.
- Fresh subjects, one shot, min primer (scratchpad g14). Results `results/ai-edit-experiment.d.{haiku,sonnet}-min.json`.
  - Acceptance: A0 13/13 on both protocols for both models. TypeScript: Haiku 13/13 conventional, 12/13 structured; Sonnet 13/13 both. Rust: 13/13 conventional, 12/13 structured for both models.
  - Cost (cache-adjusted, one task): Sonnet A0 structured 154 vs TypeScript 118 vs Rust 136; single-function tasks, so the primer is the gap again (loss, published).
## Session 2026-09-30 (x86-64 backend)

- **Direct x86-64 backend (a0c-0.1.9, `src/x86_64.ts`, target `x86_64`, `a0 emit x86_64`)**: the
  AArch64 backend's design on the System V AMD64 ABI, AT&T syntax as clang and GNU as accept it.
  Same scope: u32/bool scalars, fixed-size arrays and records by the same in-place scheme
  (`mutableHere`: fresh or owned, read only by `get`/`at` before the update, not returned),
  `call`/`fold`/`loop` with callees of at most 48 nodes inlined, larger ones called out of
  line; io functions refused with the same `structure` diagnostic. Same exact semantics:
  wrapping `addl`/`subl`/`imull`, shifts masked to five bits (literal at compile time,
  variable through `cl`), `div`/`rem` branch around the trapping `divl` so a zero divisor
  gives all ones and the dividend, unsigned `setb`/`setbe`/`seta`/`setae`, branch-free
  `cmov` select, index modulo N by mask or `divl`.
  - Register allocation: linear scan over definition order into the callee-saved ebx,
    r12d-r15d; a leaf (no residual call) also uses edi, esi, r8d, r9d and keeps a parameter
    in its arrival register when it arrives in one of those. edx and ecx are never homes
    (division and shift counts). Parameters arriving in edx/ecx and any displaced ones move to
    their homes by a parallel move sequentialized through eax; a parameter nobody reads is
    left where it arrived.
  - Calling convention: System V for scalar signatures, so the C driver calls `a0_<name>`
    directly; aggregate parameters as pointers to caller-owned slots, copied on entry; an
    aggregate result through the sret pointer in rdi (returned in rax), written after all
    parameters are copied so it may alias an argument slot. Stack parameters one eightbyte
    each. Frames are 16-byte aligned at every call; frames above 4 KiB are probed one page at
    a time.
  - Platform switch (`X86Platform`, host default): macOS `_a0_` symbols, `L` labels,
    `__TEXT,__text` and `.subsections_via_symbols`; Linux `a0_` symbols, `.L` labels,
    `.type`/`.size`, and a `.note.GNU-stack` section. Only the macOS emission is executed
    here; the Linux emission is exercised by the unit test as text only.
- **Verification on this Apple Silicon machine**: `native_x86_64` in `bun run verify`
  assembles with `clang -arch x86_64 -x assembler`, links with the C driver built
  `-arch x86_64`, and runs under Rosetta 2 (`arch -x86_64`); blocked with the reason when
  the host is neither x86-64 nor Apple silicon with Rosetta and a working x86_64 SDK slice.
  Result: **4297/4297** cases at both optimization levels, the same 10 io functions
  (965 cases) skipped as arm64. All other paths unchanged: interpreter, optimizer, JS,
  C clang, C gcc, C++ clang, Wasm, JVM 5262 each; arm64 4297.
- Unit tests (`test/core.test.ts`): io refusal; emitted sequences (leaf parameter homes and
  `imull $3, %edi, %edi`, macOS/Linux symbol forms, the `divl` zero-divisor branch for
  `div` and `rem`, literal and `cl` shifts, `setb` plus `cmov` select, mask and `divl`
  index modulo, sret through rdi/rax, the parked rcx parameter, page probing); and the
  arm64 execution test's program (12-parameter call with stack scalars, aggregate result,
  fold over an array state, loop with a predicate, 4 KiB array) assembled, linked, and run
  under Rosetta at both optimization levels against the interpreter.
- Gate (this worktree): lint pass; typecheck pass; test 43/43; verify all paths pass
  (counts above); app pass (134 cases on interpreter, optimizer, JS, C, C++, Wasm, JVM); equiv 48/48 proved; hw RTL simulation and Yosys synthesis
  passed; dotnet 5262; gpu 4297 (30 kernels, Apple M3).
  `results/{verification,app,equivalence,hardware,dotnet,gpu}.json` regenerated under
  a0c-0.1.9. `bun run bench` skips `x86_64` as it skips `arm64` (io in the corpus).
- Not done: no x86-64 performance numbers (Rosetta would measure the translator, not the
  code; `tools/exec-bench` has no x86_64 row); no native Linux run of the Linux emission;
  the same leaves as arm64 (rbp save in leaves, loop-invariant literals rematerialized per
  trip, aggregates never in registers, callees above 48 nodes copy aggregate arguments on
  entry); the `.a0-cache` key does not carry the platform, so a cache shared between a
  macOS and a Linux checkout would need clearing (the cache is per checkout).

## Session 2026-09-30 (RISC-V backend)

- **Direct RISC-V backend (a0c-0.1.10, `src/riscv64.ts`, target `riscv64`, `a0 emit riscv64`)**:
  RV64GC assembly for the LP64 psABI (Linux symbol form: `a0_` symbols, `.L` labels,
  `.type`/`.size`, `.note.GNU-stack`). Same scope and semantics as arm64/x86_64: u32/bool
  scalars, fixed-size arrays and records with the same in-place scheme, `call`/`fold`/`loop`
  with callees of at most 48 nodes inlined, io functions refused with the same `structure`
  diagnostic. Scalars live sign-extended in registers (RV64's canonical 32-bit form), so the
  W-form ops (`addw`, `subw`, `mulw`, `sllw`, `srlw`) wrap exactly, `sltu` is A0's unsigned
  comparison, and `divuw`/`remuw` already give all ones and the dividend for a zero divisor
  (no branch). Homes: s1-s11, plus a0-a7 in a leaf; t6 reserved for out-of-range offsets.
  Aggregates by pointer; an aggregate result through a pointer in a0.
- **Verification on this Mac**: Homebrew's `qemu` ships no user-mode `qemu-riscv64` on macOS
  and Homebrew's `riscv64-elf-gcc` 16.2.0 has no newlib, so `native_riscv64` builds the same
  C test driver freestanding (`-march=rv64gc -mabi=lp64 -mcmodel=medany -nostdlib`) against a
  minimal libc shim in `tools/verify.ts` (fgets over the case input embedded with `.incbin`,
  printf over the virt NS16550 UART, strtok/strtoul/atoi/mem*, exit through the SiFive test
  device), and runs it under `qemu-system-riscv64 -machine virt -bios none` (QEMU 11.1.2).
  Blocked with the reason when either tool is missing (`A0_RISCV64_GCC`, `A0_QEMU_RISCV64`
  override discovery). Result: **4297/4297** at both optimization levels, the same 10 io
  functions (965 cases) skipped. Other paths unchanged (5262 each; arm64, x86_64 4297).
- Unit tests: io refusal; emitted sequences (`mulw`/`addw` leaf, branch-free
  `divuw`/`remuw`, literal `slliw` masked to 1 and variable `srlw`, `sltu` select, mask
  index, aggregate result pointer in a0 with the parameter shifted to a1).
- Gate: lint, typecheck, test 45/45, verify, app, equiv 48/48, hw, dotnet 5262, gpu 4297 all
  pass; `results/{verification,app,equivalence,hardware,dotnet,gpu}.json` regenerated under
  a0c-0.1.10. `bun run bench` skips `riscv64` as it skips the other direct backends.
- Not done: no run under Linux (user-mode QEMU or hardware); no execution unit test in
  `test/core.test.ts` (the verify path covers execution); no performance numbers; select
  still emits a redundant `mv` when the chosen value is already in the destination; the same
  leaves as arm64/x86_64 (aggregates never in registers, literals rematerialized per trip).
## Session 2026-09-30 (AVR backend)

- **Direct AVR backend (a0c-0.1.10, `src/avr.ts`, target `avr`, `a0 emit avr`)**: GNU as
  assembly for the ATmega328P (Arduino Uno) on the avr-gcc calling convention, so an
  avr-gcc C program calls `a0_<name>` directly. Scope: u32/bool scalars, small fixed-size
  arrays and records, `call`/`fold`/`loop` (callees always out of line); io refused
  (`structure`); one aggregate above 255 bytes, a frame above 1,024 bytes, or parameters
  needing more than the 18 argument registers r8-r25 refused (`limit`, stack arguments not
  implemented).
  - Exact u32 from 8-bit operations: add/sub/and/or/xor/compare as inline byte sequences on
    the carry chain (gt/le swap operands; unsigned `brlo`/`brsh`), constant shifts masked to
    five bits at compile time as byte moves plus bit steps; helper routines emitted once
    per module and only when referenced: `__a0_mul32` (shift and add, low 32 bits),
    `__a0_udivmod32` (restoring division with the 33rd bit handled; a zero divisor gives
    quotient all ones and remainder the dividend with no special case), `__a0_shl32` and
    `__a0_shr32` (count masked to five bits), `__a0_copy`.
  - Code shape: every value in a frame slot off Y (`ldd`/`std` to Y+63, Z beyond), operands
    loaded into r22-r25 and r18-r21 per node. Values are immutable, so `mov`, `at`, and a
    literal-index `get` are slot aliases with no code; `set`/`put` copy. No register
    allocation and no inlining yet: this is the simple, correct first version.
  - Calling convention: parameters downward from r25 by even-rounded size (u32 four
    registers, bool the low register of a pair, aggregates as 16-bit pointers to
    caller-owned copies, copied on entry); u32 result in r22-r25, bool in r24; an aggregate
    result through a hidden first pointer in r24:r25, written last so it may alias an
    argument (fold state). r1 zero at every call and return; argument registers below r18
    that a function loads for its own calls are pushed in its prologue. One
    `.text.a0_<name>` section per function and helper, so `--gc-sections` keeps only what a
    firmware reaches.
  - Size: `clamp_max` (examples/kernels.a0) is 144 bytes of flash; avr-gcc 9.5 `-Os` on the
    equivalent C is 82 bytes.
- **Verification**: `native_avr` in `bun run verify` assembles the io-free subset once per
  optimization level with `avr-gcc -mmcu=atmega328p -x assembler`, then per driver-callable
  function links an avr-gcc C driver (its cases as a PROGMEM table, each result printed
  as a decimal line on UART0 at UBRR 0 with U2X) with `--gc-sections`, and runs it in a small
  libsimavr host built with clang (`AVR_HOST` in tools/verify.ts: loads the ELF, captures
  UART0 output bytes through the UART output IRQ into a file, runs until the firmware
  sleeps with interrupts off). Before linking, `avrStackBytes` gives a static stack bound
  (frames, pushes, return addresses, helper calls, through every callee) that must fit the
  SRAM left beside a 128-byte driver reserve; a function over it, or one whose link
  overflows flash, is skipped with the reason. Result: **4297/4297** cases at both
  optimization levels; the same 10 io functions (965 cases) skipped as arm64/x86_64; no
  function skipped for SRAM or flash. Blocked with the install command when avr-gcc or
  libsimavr is missing. Toolchain: Homebrew avr-gcc 9.5.0, avr-binutils 2.46.0, simavr
  1.7_1.
- Unit tests (`test/core.test.ts`): refusals (io, 256-byte aggregate, 1,200-byte frame,
  five u32 parameters); emitted sequences (register arrival, carry chains, swapped compare,
  literal shift masking, helpers emitted once and only when used, sret through r24:r25,
  Z-addressed far slots); and an execution test (fold over an array state, loop with a
  predicate, aggregate result, a call using r8-r17 arguments, non-power-of-two index
  modulo, bool array, frame past Y+63) run under simavr at both optimization levels
  against the interpreter (skipped when the toolchain is absent).
- Gate (this worktree): lint pass; typecheck pass; test 46/46; verify all paths pass
  (interpreter, optimizer, JS, C clang, C gcc, C++ clang, Wasm, JVM 5262 each; arm64,
  x86_64, avr 4297 each); app pass; equiv 48/48 proved; hw RTL simulation and Yosys
  synthesis passed; dotnet 5262; gpu 4297.
  `results/{verification,app,equivalence,hardware,dotnet,gpu}.json` regenerated under
  a0c-0.1.10. `bun run bench` skips `avr` as it skips `arm64` and `x86_64`.
- Not done: no register allocation or inlining (every node is load, compute, store, so code
  is about twice avr-gcc's size and slower); no stack arguments; io (a UART-backed io
  runtime would be the natural adapter); no cycle counts or real-board run (simavr only);
  mul does not use the hardware `mul` instruction.
## Session 2026-09-30 (self-hosting: AArch64 emitter)

- **Stage 4a, `compiler/emit_arm64.a0`** (3235 lines, 32 functions, `use "check.a0"`): the
  AArch64 emitter in A0 over the checked word IR of parse.a0 + check.a0. `emitio`: source
  bytes in; ok, code, fn, node, byte count and the Darwin arm64 assembly bytes out (the
  module shape of `src/arm64.ts`: `_a0_<name>` symbols, the C-compatible scalar convention,
  w0-w7 then Darwin-packed stack parameters, result in w0).
  - Covered: u32/bool parameters and results; `mov`, `add sub mul and or xor shl shr`,
    `div` (`udiv`, then `cmp`/`csinv` for all ones on a zero divisor), `rem` (`msub`, the
    dividend on a zero divisor),
    `eq ne lt le gt ge` (`cmp`/`cset`), `select` (`csel`), literals (`movz`/`movk`),
    `call` (real `bl`, stack arguments placed), `fold` and `loop` with scalar state (a
    counted loop around `bl`, the loop's predicate by `cbz`), frames above 4095 bytes.
  - Refused: any function whose parameter, result or node is an array, record or io:
    diagnostic code 5 (fn, node; node 4294967295 for a header type). Parse/check errors pass
    through with their codes; code 4 when a line exceeds the 512-byte line buffer or the
    module the 4096-byte output buffer.
  - Scheme: every value in a stack slot, operands through w9-w11, result w12. The header
    comment marks where stage 4b goes (linear-scan allocation over w19-w28 replacing
    `lload` and the node stores, callee inlining, in-place aggregates).
  - Buffers are 4096 output bytes and a 512-byte line: at 8192/1024 the wasm32 build of
    the emitter overflowed wasm-ld's 1 MiB stack (by-value aggregates in C frames).
- **Verification by execution** (`tools/selfhost-verify.ts`, `bun run selfhost`,
  `results/selfhost.json`): per scalar-only function, the function plus its callees as one
  source; `emitio` through the reference interpreter; `clang -x assembler`, linked with the
  C test driver of `native_arm64` (`checkArm64Assembly`, factored out of `checkArm64` in
  tools/verify.ts); every oracle case compared with the BigInt oracle. Scalar corpus
  (`generateCorpus(0xa05ca1a, 48, { scalar: true })`: no aggregate/io, 3-12 nodes, a
  comparison appended when a bool result has no bool): 45 passed, 3 skipped over the
  front end's 512-byte source limit, 0 failed, 6135 cases; examples/kernels.a0 scalar
  functions 5/5, 763 cases. Total **50 programs, 6898 cases, 0 failures**. clamp_max:
  66 source bytes to 479 assembly bytes.
- **`bun run app` emitter rows** (12 cases: 5 kernels, call, fold, loop, array/io/record
  refusals, ill-typed): assembly bytes identical on interpreter, optimizer, JS, C clang,
  Wasm (12/12); JVM 11/11, the loop module's 1214 output words are over the JVM backend's
  1024-word io output (src/backends.ts) and are counted as not run.
- Gate (this worktree): lint pass; typecheck pass; test 43/43; app pass (lexer 7, parser
  15, checker 39, emitter 12, Life 134); selfhost 50 passed, 0 failed, 3 skipped.
- Not done: stage 4b (registers, inlining, aggregates, io); sources over 512 bytes; the
  JVM io capacity.
## Session 2026-09-30 (direct wasm32 backend)

- **Direct wasm32 backend (a0c-0.1.10, `src/wasm.ts`, target `wasm`, `a0 emit wasm <file> out.wasm`)**:
  A0 to a binary WebAssembly module with no C, Clang, or wasm-ld. The compiled text is the
  module in base64 (`wasmModuleBytes` decodes it); `a0 emit wasm` writes the bytes. `a0 wasm`
  is unchanged: it still builds the C-derived module (C backend, Clang, wasm-ld), which is
  what the site ships.
  - Scope: every scalar op with the exact semantics (wrapping i32 arithmetic, shifts masked by
    wasm itself, unsigned comparisons, 0/1 booleans, `div`/`rem` made total by substituting a
    divisor of 1 and selecting all ones / the dividend when the divisor is zero), arrays and
    records in linear memory with value semantics, `call`, `fold`, `loop`, and io
    (`read`, `write`, `puts`). Unlike arm64 and x86_64, io functions are in scope.
  - Host-visible shape equal to the C-derived module: exports `a0_<fn>`, `memory`, and the
    immutable global `__heap_base`; an io token is the address of
    `{ input[IN]; ninput; position; output[OUT]; noutput }` with the `ioInputCapacity` /
    `ioOutputCapacity` options (defaults 256/1024), placed at `__heap_base` by the host, so
    `site/app.ts` and the `webassembly` harness of `tools/verify.ts` drive it unchanged.
  - Representation: scalars and tokens are i32 locals; aggregates live on a shadow stack
    (`__stack_pointer`) with static per-function frames; the stack region is the longest
    frame chain of the acyclic call graph, so it cannot overflow. Aggregate parameters are
    addresses of caller-owned storage the callee never writes; aggregate results go through
    an sret parameter. Iteration bodies get an owned variant `a0o_<fn>` that updates the fold
    state in place; `set`/`put` on a provably unshared value (`mutableHere`) store one
    element; aggregate `get`/`at`/`mov`/`select` alias instead of copying. Literal scalar
    arrays of four or more elements are copied from a deduplicated data segment (all-zero
    ones filled). One refinement over the C analysis: an iteration whose extra argument names
    its own initial value does not run in that value's storage (unit test).
  - Per-function emission is a JSON record (code bytes plus symbolic call and constant
    references), so the function cache and the disk cache hold one function's work;
    `assembleWasm` resolves indices, the data segment, and the memory layout.
- **Verification**: new `webassembly_direct` path in `bun run verify`: **5262/5262** cases at
  both optimization levels through the same harness as `webassembly` (now shared as
  `runWasmCases`). All other paths unchanged: interpreter, optimizer, JS, C clang, C gcc,
  C++ clang, Wasm (via C), JVM 5262 each; arm64 and x86_64 4297.
- Unit tests: `site/page.a0`, `site/docs.a0`, `site/play.a0` (first render; play also with a
  submitted valid and an ill-typed source) run through the direct module with the site's
  1024/65536 capacities at both optimization levels; result and every output word equal the
  interpreter's. A value-semantics test (fold state named by its own extra argument, a chain
  of in-place `set`s next to a later read of the original) at both levels.
- Module sizes, direct vs C-derived (Clang -O2 + wasm-ld), bytes: affine 119 vs 725, rotl
  130 vs 717, clamp 136 vs 735, mix 161 vs 736, ident 100 vs 715, noop 99 vs 713, chain3 183
  vs 787, branchy 174 vs 752, arrfill 294 vs 915, arrfill4k 312 vs 945, loop64 212 vs 906;
  site/page.a0 192,857 vs 694,396 (0.28x), docs 132,551 vs 279,894, play 90,333 vs 174,585. The direct
  module has no name or producers section; the reasons for the rest of the gap were not
  broken down.
- Gate (this worktree): lint pass; typecheck pass; test 45/45; verify all paths pass (counts above); app pass; equiv 48/48 proved; hw RTL simulation and Yosys synthesis passed; dotnet 5262; gpu 4297 (30 kernels, Apple M3).
  `results/{verification,app,equivalence,hardware,dotnet,gpu}.json` regenerated under
  a0c-0.1.10.
- Not done: no execution-time comparison against the C-derived module (the direct code has no
  register allocation beyond wasm locals, no inlining, and calls the body per trip; the
  engine's tiers do the rest); the site still ships the C-derived build; no name section or
  source map; `bun run app` does not yet run the direct module.

## Session 2026-09-30 (self-hosting: C emitter)

- `compiler/emit_c.a0` (`use "check.a0"`, 37 functions, 138 linked, 25.5 KB): the C emitter written in A0, stage 4b of self-hosting (DESIGN.md 7a stage 5). Input: the parser's word IR (pool sym fns nodes args) and the checker's types, tlist and `ntys`. Output: C source bytes, one per io word. Scalars are `uint32_t`/`bool`; arrays and records are structs by value (`a0t<type index>` with `e[N]` / `f<k>`, typedefs in type-index order, which is dependency order); io is `a0_io *` with the TypeScript emitter's layout (input[256] ninput position output[1024] noutput) and `a0_write`/`a0_puts`, so the standard driver of tools/verify.ts links against it unchanged. Functions `a0_<name>`, parameters `p<k>`, nodes `n<index>` (one local each, then `(void)n<i>;`); `fold`/`loop` are counted `for` loops calling the body by value (loop tests the predicate first); `call`, `arr`/`text` (an all-zero scalar literal is a zeroing loop), `rec`, `get`/`set` (index mod N), `at`/`put`, `read` (both fields as statements), `write`, `puts`. Every u32 operation and comparison is a `static inline` prelude function (`a0_add` ... `a0_ge`, `a0_div`/`a0_rem` with A0's zero-divisor values, shifts by the low five bits): the first build under `-Werror` failed on `(p0 != p0)` (-Wtautological-compare) and `(2u ^ 1u)` (-Wxor-used-as-pow) in the unoptimized corpus, and calls draw neither. No in-place updates, no owned/ref variants: byte equality with src/backends.ts is not the goal, observable results are.
- Style as in the front end: no control flow; every piece of text is a fold whose count is 0 or 1 (a conditional write), and no fold has a literal count (the checker's rule saturates a function's bound under a variable fold, and a literal fold over it would be a structure error, also in the optimizer's re-validation). Strings are packed little-endian four bytes per u32 literal, six words per `cws6` write; a template `cwt` interleaves six such strings with five operand slots (A B C, the node's own name, the two array lengths, the literal of B, the operand count); the text of every packed write is kept in the comment above it. `emitc` emits types [tfrom, ntypes) and functions [from, to), plus the prelude when `head` is 1, so a large program is emitted in the checker's chunks with type indices threaded across chunks; `emitcio` runs lex, parse, check and emit on up to 512 source bytes and writes the C (nothing on a front-end error), result the diagnostic code.
- `bun run selfhost:c` (`tools/selfhost-c.ts`): for the verification corpus (48 functions, 4 chunks) and both examples, the IR is encoded from the TypeScript Program per chunk (the checker test's chunking; header types interned once, body types interned by the A0 checker and carried to the next chunk), `check` types the chunk and `emitc` writes its C, both in the reference interpreter; the concatenated C is compiled by clang with the standard driver (`checkNative` takes the source as an optional argument now; -std=c11 -O1 -Wall -Wextra -Werror, UBSan) and compared with the independent BigInt oracle of tools/corpus.ts. Result: corpus 5262/5262 cases, kernels.a0 763/763, life.a0 346/346, 6371/6371; C sizes 116,771 / 2,513 / 10,335 bytes (TypeScript emitter 26,398 / 924 / 12,797); emission 31 s / 0.2 s / 2.5 s in the interpreter (Node's `run` re-validates the 8192-word tables on every call). `results/selfhost-c.json`.
- `bun run app`, C emitter rows: `emitcio` on 20 sources (clamp, the parser's 15, 4 ill-typed) must write exactly the bytes `emitc` writes in the interpreter over the tables of the independent `refParse`/`refCheck`: interpreter, optimizer, JavaScript, native C (clang, UBSan), wasm32 all pass 20/20; JVM is `blocked`: the Java runtime's A0Io output array is fixed at 1024 words in src/backends.ts (outside this task), and every emitcio output is 1820 to 2513 words. C size for clamp (`fn clamp u32 u32 u32 -> u32`, two compares, two selects): 1965 bytes, of which 1732 are the prelude and 233 the function.
- Gate (this worktree, all exit 0): lint pass; typecheck pass; test 43/43; app: Life 7/7 targets, lexer 6/6, parser 6/6, checker 6/6, C emitter 5 passed + JVM blocked (20 cases); selfhost:c 6371/6371.
- Not done: the ret operand keeps the parser's 28-bit packing, so `ret` of a literal of 2^28 or more cannot be emitted (the driver refuses such a program; none in the corpus or examples); the JVM row needs a sized A0Io output (src/); the emitter itself is not yet run through the A0 checker test or emitted by itself; the C has no in-place updates, so large arrays copy on every `set` (fine for the corpus, not for the compiler's own 8192-word tables).
## Session 2026-09-30 (token scaling: 400 and 4000 functions)

- Task sets `c400` and `c1000` (`A0_EXPERIMENT_TASKSET`): the twelve set-C tasks in one deterministic program of 400 / 1000 functions, identical names, semantics and order in A0, TypeScript and Rust. Filler: `generateFiller` in `tools/ai-edit-tasks-c.ts`, six fixed templates (affine, xor-shift, cap, pair, sum of two earlier unary helpers, mix of one), constants from a fixed LCG, names with a four-digit index; interleaved in 40 runs before the 40 project functions (`scaledOrder`), callees before callers; the tests never call filler. Test: all 960 generated helpers agree between the A0 interpreter and the TypeScript text (8 inputs each) and form a valid program. Self-check ok for c400 and c1000 (all originals fail, all references pass, tsc and rustc). Set C is unchanged (`taskSetSha256` still `8c1254…`); c400 `ad0f14cd…`, c1000 `88aadc11…`.
- **4000 is not a legal A0 program**: `LIMITS.maxFunctions` is 1024 (also for linked programs, the documented static cap, and the size of the self-hosted checker's `fns` table). I did not raise the cap (a language decision; site/ and compiler/ depend on it); c1000 is the largest scaled set. At 4000 the generated filler alone is 118,762 o200k tokens in TypeScript and 118,256 in Rust (124,702 in A0), so the TS/Rust whole-file cells would be about 120k (conventional) and 141k (numbered) tokens per task.
- `src/edit.ts`: `openProgram({ scope: 'deps', target })` — a program handle whose view is a comment line (`# N functions; shown: T, its callees, its callers`) and the signatures of the target, its transitive callees (calls, folds, loops), and its direct callers (`programNeighbourhood`, `scopedProgramView`); it still edits the whole program, `view()` follows edits, and a removed target falls back to the full listing. The full handle remains the default. Tested. Harness: `A0_EXPERIMENT_PROGRAM_VIEW=deps|all` (recorded as `programView` and in `method`); TS/Rust structured and conventional cells get the whole file (in `method`).
- Context tokens per cell (`contextTokensByCell`, mean toolContext o200k, task text + view; A0 structured shown with full / scoped handle):

| cell | 40 fns (c) | 400 fns | 1000 fns |
|---|---|---|---|
| A0 conventional | 1411 | 12749 | 31644 |
| A0 structured, full g0 | 590 | 4850 | 11950 |
| A0 structured, scoped g0 | 122 | 122 | 123 |
| TS conventional | 1786 | 12584 | 30579 |
| TS structured | 1966 | 14102 | 35697 |
| Rust conventional | 1888 | 12637 | 30551 |
| Rust structured | 2075 | 14169 | 35683 |

  TS structured / A0 structured: full handle 3.3x / 2.9x / 3.0x (the handle grows linearly with the program); scoped handle 16x / 116x / 290x (constant A0 context). Conventional A0 / TS: 0.79 / 1.01 / 1.03 (the generated A0 filler is slightly more token-dense than its TS translation).
- Collected on c400, structured cells only, fresh subjects, min primer, one shot (scratchpad g15; group files per representation x protocol, 12 tasks each; the TS and Rust group files print the whole numbered file once as a shared view, since it is identical for all 12 tasks and 12 copies would be 170k tokens). Results `results/ai-edit-experiment.c400.{haiku,sonnet}-min.json` (scoped handle, with TS and Rust) and `…c400.{haiku,sonnet}-min-fullhandle.json` (A0 full handle). Cost per task cache-adjusted as before (primer once at 1.25x over the 12 tasks, context and output 1x):

| subject | cell | accepted | cost/task |
|---|---|---|---|
| Sonnet | A0 structured, scoped g0 | 12/12 | 202 |
| Sonnet | A0 structured, full g0 | 12/12 | 4930 |
| Sonnet | TS structured | 12/12 | 14143 |
| Sonnet | Rust structured | 12/12 | 14210 |
| Haiku | A0 structured, scoped g0 | 10/12 (1 protocol, 1 wrong output) | 217 |
| Haiku | A0 structured, full g0 | 8/12 (1 protocol, 1 wrong output, 2 tasks skipped by the subject) | 5347 |
| Haiku | TS structured | 8/12 (4 compile) | 14202 |
| Haiku | Rust structured | 7/12 (5 compile) | 14294 |

  Decision by measurement: the scoped handle loses no acceptance against the full one (Sonnet 12/12 both; Haiku 10/12 vs 8/12) at 1/40 of the context, so it is the handle to use for large programs. At 400 functions A0 structured costs 70x less per task than TypeScript (Sonnet, 202 vs 14143) with the scoped handle, 2.9x with the full one.
- Not collected: the conventional cells at 400 (each reply is the whole 12.6k-token file; 12 per subject). Caveat: the scoped A0 view is protocol-supplied, while TS/Rust get no comparable per-function tool; that asymmetry is what this measures.

## Session 2026-09-30 (ARM32 backend)

- **Direct 32-bit ARM backend (a0c-0.1.12, `src/arm32.ts`, target `arm32`, `a0 emit arm32`)**:
  the AArch64 backend's design for ARMv7-A, A32 (ARM mode) instructions, AAPCS hard-float
  GNU/Linux ELF (arm-linux-gnueabihf: Raspberry Pi 2/3 32-bit userland). Same scope: u32/bool
  scalars, fixed-size arrays and records by the same in-place scheme (`mutableHere`),
  `call`/`fold`/`loop` with callees of at most 48 nodes inlined, larger ones called out of
  line; io functions refused with the same `structure` diagnostic. u32 maps directly onto a
  32-bit register, so arithmetic needs no masking; shifts are masked to five bits (literal at
  compile time, variable by `and #31`, since a register shift uses the whole low byte);
  unsigned `movlo`/`movls`/`movhi`/`movhs` compares; predicated `movne`/`moveq` select.
  - Division, the ISA choice: UDIV is optional on ARMv7-A (Cortex-A7/A15 have it as ARMv7VE,
    Cortex-A8/A9 do not), so the baseline is ARMv7-A and `div`, `rem`, and index modulo a
    non-power-of-two length call `.La0_udivmod`, a 32-step shift-subtract routine emitted once
    per module only when used; a zero divisor returns all ones and the dividend (A0's rule).
    Power-of-two lengths use `ubfx`. ARM mode rather than Thumb-2 avoids IT blocks; the module
    interworks with Thumb C code through `.type %function` symbols, `bx lr`, and `pop {pc}`.
  - Registers: linear scan into the callee-saved r4-r10; r0-r3, r12, lr are scratch in every
    function (calls and the divide routine clobber r0-r3), r11 is the frame pointer. Register
    arguments leave r0-r3 before anything else runs.
  - Calling convention: AAPCS for scalar signatures (the C driver calls `a0_<name>`); an
    aggregate result through a hidden pointer in r0 (parameters then start at r1), aggregate
    parameters as pointers to caller-owned slots copied on entry, stack parameters one word
    each; sp 8-byte aligned at every call; frames above 4 KiB probed page by page. Immediates
    as A32 modified immediates, `mvn`, or `movw`/`movt`. No VFP/NEON instruction is emitted;
    the module carries `Tag_ABI_VFP_args` so it links with gnueabihf objects.
- **Toolchain and verification on this Apple Silicon machine**: Homebrew's qemu on macOS has
  no user-mode `qemu-arm` (system emulators only) and Apple silicon has no AArch32, so the
  run is bare metal: the Arm GNU Toolchain 15.3.Rel1 (`arm-none-eabi-gcc` with newlib and
  librdimon; the cask's .pkg needs sudo, so its payload was extracted with `pkgutil
  --expand-full` to `~/.local/share/arm-gnu-toolchain`, which `findArmGcc` searches along
  with `A0_ARM_GCC`, PATH, and `/Applications/ArmGNUToolchain`) builds the module, the same C
  test driver (hard float, `-march=armv7-a+fp`), and a boot shim into one image;
  `qemu-system-arm -M virt -cpu cortex-a7` (qemu 11.1.2) runs it with semihosting. The shim
  identity-maps memory with the MMU (with the MMU off every access is strongly ordered and
  newlib's unaligned loads fault) and enables VFP for the hard-float newlib; the driver reads
  its cases from a host file over semihosting (a constructor `freopen`s stdin; the
  semihosting console gives no stdin EOF). `native_arm32` in `bun run verify`: **4297/4297**
  cases at both optimization levels, the same 10 io functions (965 cases) skipped as arm64
  and x86_64; blocked with the reason when the toolchain or qemu is missing. All other paths
  unchanged: interpreter, optimizer, JS, C clang, C gcc, C++ clang, Wasm, JVM 5262 each;
  arm64 and x86_64 4297.
- Unit tests (`test/core.test.ts`): io refusal; emitted sequences (A32 immediate encoding,
  register homes and the push/pop frame, the divide routine and its zero-divisor entry, the
  routine emitted only when used, literal and masked register shifts, `movlo` compare and
  predicated select, `ubfx` and routine index modulo, sret in r0, movw/movt constants, page
  probing); and the x86_64 execution test's program plus a division function at and above
  2^31, built and run on the emulated Cortex-A7 at both optimization levels against the
  interpreter (skipped with the reason when the toolchain is absent).
- Gate (this worktree): lint pass; typecheck pass; test 46/46; verify all paths pass (counts
  above); app pass on every path; equiv 48/48 proved; hw RTL simulation and Yosys
  synthesis passed; dotnet 5262; gpu 4297. `results/{verification,app,equivalence,hardware,dotnet,gpu}.json`
  regenerated under a0c-0.1.12. `bun run bench` skips `arm32` as it skips arm64/x86_64.
- Not done: no run on real ARM Linux (a Raspberry Pi) or under Linux user-mode qemu; the
  emission targets arm-linux-gnueabihf, but here it is linked with newlib bare metal, whose
  integer AAPCS is the same. No ARMv7VE `udiv` option and no Thumb-2 emission; no
  performance numbers (emulated time says nothing; `tools/exec-bench` has no arm32 row); the
  same leaves as arm64 (loop-invariant literals rematerialized, aggregates never in
  registers); with seven homes, register pressure spills sooner than on arm64/x86_64.
## Session 2026-09-30 (edit-loop validation latency)

`bun run edit-loop-bench` (tools/edit-loop-bench.ts, results/edit-loop.json): wall-clock time from "model reply received" to "edit applied and the whole 40-function program known to type-check", per accepted set-C edit, using the actual accepted replies of the set-C collections (reply texts committed as results/ai-edit-experiment.c.{sonnet,haiku}-min.replies.json; every accepted trial was one-shot, so the timed reply is the first one). TS/Rust samples use the structured line-edit replies applied to the 40-function file. Go has no collected replies: hand translations of the reference edits (tools/edit-loop-go.ts), checked against the same acceptance tests before timing. Python/mypy not measured: mypy is not installed on this machine. 7 reps after one discarded warm-up round, path order rotated per (rep, task); per-task median of the reps, then median / p90 / sum over the tasks. Warm paths are reset to the original program (untimed) before every sample. TASKS_A moved to tools/ai-edit-tasks-a.ts and the TS/Rust line-edit applier to tools/ai-edit-apply.ts so the benchmark can import them.

Load: this 8-core machine was shared with other sessions; 1-minute load average 127.28 at the start, falling to 13.66 at the end (per-rep `uptime` in the JSON). Absolute numbers are inflated by that load; ratios come from interleaved runs and are less affected.

Sonnet replies (12 edits per path; Haiku: 9 to 11 accepted edits per path, full rows in the JSON):

| path | median ms | p90 ms | total ms | median vs A0 structured | Haiku median ms | derived end-to-end median ms (reply tokens) |
|---|---:|---:|---:|---:|---:|---:|
| a0.structured | 0.51 | 0.725 | 6.643 | x1 | 0.443 | 369.4 (29.5) |
| a0.conventional | 0.533 | 0.603 | 6.4 | x1 | 0.475 | 17169.4 (1373.5) |
| ts.cold | 637.454 | 719.447 | 7784.674 | x1249.9 | 594.71 | 1003 (25.5) |
| ts.warm | 15.142 | 15.877 | 183.206 | x29.7 | 13.64 | 335 (25.5) |
| rust.cold | 116.404 | 127.172 | 1401.5 | x228.2 | 106.285 | 396.7 (22.5) |
| rust.warm | 163.567 | 172.745 | 1934.77 | x320.7 | 151.874 | 451.2 (22.5) |
| go.build.cold | 161.728 | 164.851 | 1916.245 | x317.1 | n/a | n/a |
| go.build.warm | 97.416 | 104.421 | 1155.1 | x191 | n/a | n/a |
| go.vet.warm | 162.817 | 171.841 | 1955.912 | x319.2 | n/a | n/a |

Paths: a0.structured = EditSession.apply in-process (parse edit, type-check, commit); a0.conventional = parseAndValidate of the whole replied file; ts.cold = `tsc --noEmit -p` in a new process; ts.warm = a TypeScript LanguageService kept alive in-process (new file version, syntactic + semantic diagnostics), the fair best case for TS; rust.cold = `rustc --emit=metadata --crate-type lib`; rust.warm = `cargo check` in a crate already checked once; go.build.cold = `go build` with an empty GOCACHE; go.build.warm / go.vet.warm = warm GOCACHE with a unique trailing comment per sample so the content cache never replays. No gopls or rust-analyzer daemon was measured.

Findings: validating an A0 edit costs about half a millisecond, about 30x under the warm TypeScript language service and roughly 190x to 1250x under the process-based checkers. The end-to-end column is DERIVED, not measured: local o200k output tokens of the reply at an assumed 80 tokens/s plus the measured validation median. On that basis validation is small next to generation for every in-process or warm checker: warm TS (335 ms) is slightly ahead of A0 structured (369 ms) because the TS line-edit replies were shorter (25.5 vs 29.5 tokens median), and a whole-file conventional A0 reply costs about 17 s of generation. A0's validation advantage decides the inner loop only against cold, process-per-edit checking (tsc: about 1.0 s per edit end-to-end).
## Session 2026-09-30 (faster emitted JavaScript)

- Starting point: the JS emitter already had the ideas on the list. Unguarded `a0i_`
  internals called between A0 functions with guards only at exports, single-comparison
  `(v >>> 0) !== v` scalar guards, typed arrays with in-place `set`/`put` on owned state
  (`mutableHere`, `a0o_` owned iteration bodies), plain counted `for` loops for fold/loop,
  `Math.imul(...) >>> 0` / `>>> 0` on every u32 result, no closures.
- Change (a0c-0.1.10, `src/backends.ts` JS emitter only): a scalar-signature export now
  carries its body after the guards instead of calling `a0i_`, one frame fewer at the
  boundary. Aggregate-signature exports keep the call (their guards rebind parameters).
  Internal calls still target `a0i_`/`a0o_`.
- Not done, and why: cross-function inlining of small callees in the JS text would make a
  caller's emitted text depend on its callee, which the per-function emit cache
  (`FunctionCache.key` = version|target|opt|semanticRevision(fn)) does not key on; V8 inlines
  these callees itself. Removing guards is out (public boundary).
- Measured (`exec-bench --langs=`, emitted/hand-written JS median ns, 7 interleaved samples):

  | kernel | before (0.1.9) | after (0.1.10) |
  |---|---|---|
  | affine | 0.85 | 1.07 |
  | rotl | 1.02 | 1.01 |
  | clamp | 1.02 | 1.05 |
  | mix | 1.01 | 1.01 |
  | ident | 1.09 | 1.07 |
  | noop | 1.11 | 1.09 |
  | chain3 | 1.01 | 1.01 |
  | branchy | 1.04 | 1.03 |
  | arrfill | 0.51 | 0.45 |
  | arrfill4k | 1.03 | 1.05 |
  | loop64 | 1.07 | 0.68 |

  Load average: before 15.5/25.4/19.9, after 32.0/35.0/40.2 (other agents running; waited
  10 min, load never held under 4). At this load the rows are noise: in a scratch run of the
  same harness loop, two byte-identical hand-written `ident` modules differed by 1.09-1.30x,
  and a standalone check of the guard (`(x >>> 0) !== x` vs none) put its cost within noise.
  So the residual 1.01-1.11 gaps are not shown to be emitted-code cost, and the 0.1.10
  change is not shown to help; it is kept because it is sound and verified. The loop64 0.68
  and affine 0.85 values are the same noise, not wins. The JS rows of
  `results/exec-benchmark.json` are replaced from the after run (`jsRemeasured`); arrfill4k
  is not in that file's kernel set, so it is recorded here only.
- Gate: lint, typecheck, test 43/43, verify (javascript 5262/5262), app (javascript 39/39),
  equiv 48/48 proved.
- Next: re-measure on an idle machine; the harness always runs emitted first in each sample
  on a shared polymorphic call site, so alternating the order would remove one bias.

## Session 2026-09-30 (automatic parallel folds)

- **`src/parallel.ts` (a0c-0.1.13, C target, opt-in `a0 emit c --parallel[=auto|gpu]`,
  `compile(p, 'c', { cParallel: parallelC({ mode }) })`; off by default, so every existing
  output is unchanged).** Two fold shapes are proven syntactically on the optimized body, no
  heuristics: a reduction `fold B n s x...` where B returns `state OP g(i, x...)`, g independent
  of the state and the state read nowhere else, OP one of wrapping add/mul, and/or/xor, or
  min/max written as `select (lt|le|gt|ge state g) ...` (all associative and commutative on u32,
  so any grouping is exact); and an element-wise map `set state i h(i, x...)` with h independent
  of the state and n <= array length (distinct indices; the owned C variant writes element i in
  place by the emitter's own `mutableHere` rule, exported as `ownedUpdateInPlace`). Purity (no
  io anywhere in the body or callees) and no aliasing are what make this legal without the
  alias/effect analysis a C compiler would need. Each chunk calls B(identity, ...) accumulation
  itself, since B(acc, i) is exactly acc OP g(i), so no code is synthesized for g.
- **Strategies and cost model** (work = n x static body cost in simple operations; literal
  counts decided at compile time, variable counts by the same test at run time): serial below
  2^20 (the unchanged loop, which Clang vectorizes: the SIMD path on C), pthreads at or above
  2^20 (8 dynamic chunks per thread over an atomic counter, so P and E cores balance; partials
  combined in chunk order; calls nested inside a chunk run sequentially through a thread-local
  depth; `A0_THREADS` overrides the worker count), and in `gpu` mode Metal at or above 2^25
  for reductions whose body signature is all scalars: the site embeds MSL from `emitMetal` of
  the body's subprogram plus a strided-partials kernel `a0gr` (65536 threads), and a small
  Objective-C runtime in the same file (active only when built with `-x objective-c
  -fobjc-arc`, otherwise a stub) dispatches it and combines partials on the CPU; no device or a
  failed compile falls back to threads.
- **C backend fixes found by the benchmark** (both shared-file changes, both value-semantics
  preserving): (1) scalar-state fold bodies that read aggregate extras get a `view` variant
  `a0v_f(p0, p1, const T *p2...)` and the fold calls it, instead of copying every array extra
  into every trip (dot64k serial went from ~66 ms to ~70 us per call); (2) arrays longer than
  4096 elements get a pointer constructor (a 65536-parameter constructor exceeded Clang's
  parameter limit). A0 arrays stay capped at 65536 elements (`LIMITS.maxArrayLength`), so the
  "1M-element array" kernels are generated streams, and the two array kernels use 64K.
- **Verification**: small sizes (4099 trips; 67 for the array kernels, not a multiple of the
  chunking) of every benchmark kernel, off / threads forced / GPU forced, equal the reference
  interpreter on 5 seeds (`results/parallel.json` `verification`); unit tests (all seven ops,
  gt/le/ge min/max forms, variable counts, a map with variable count, nested parallel folds,
  a reduction over an array extra) against the interpreter at `A0_THREADS` 1, 3, 8; negative
  shapes (sub, state used twice, state feeding g, non-commuting select, map over the wrong
  index or reading the state); a new `native_c_parallel` leg in `bun run verify` (threads
  forced, UBSan, 5262/5262; note the corpus has 4 folds and none has a reduction shape, so that
  leg exercises the emitter unchanged, not the parallel path). At full size every baseline's
  checksum equals the A0 serial checksum before timing.
- **Benchmark `bun run par-bench`** (`tools/par-bench.ts`, table-driven, interleaved, median
  of 7, one warm-up call per process; A0 C and C at `clang -O3 -mcpu=native`, Rust
  opt-level=3 target-cpu=native, Zig ReleaseFast, Go 1.27, Java 27, Python 3.14, Node 24;
  hand-parallel C = OpenMP `parallel for simd reduction` with libomp). **Load: the machine
  never got quiet: 1-minute load 23 at start, 30 (5-min 54) when timing began after the full
  15-minute wait, 16 at the end, on 8 cores (4P+4E); every multicore number below is
  depressed and noisy** (in a smoke run at load ~10-30, sum24 was a0_serial 5.5 ms, threads
  1.4-1.6 ms, GPU 1.4 ms, OpenMP 1.7-1.9 ms). ns per call (us):

  | kernel | A0 serial | A0 auto (strategy) | A0 threads forced | A0 GPU | C | C OpenMP | Rust | Zig | Go | Java | Python | JS |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|
  | sum24 (2^24) | 17530 | 6194 (threads) | 3587 | 5556 | 20262 | 7519 | 16890 | 52450 | 62823 | 35302 | 25.0 s | 340279 |
  | xor24 (2^24) | 9640 | 3054 (threads) | 3251 | 2240 | 10226 | 4083 | 10949 | 29740 | 37441 | 20277 | 15.3 s | 32426 |
  | count20 (2^20) | 650 | 470 (threads) | 308 | - | 591 | 366 | 1470 | 2054 | 2599 | 2812 | 0.86 s | 5086 |
  | mr22 (2^22, two gens) | 4768 | 3681 (threads) | 3294 | 2984 | 4326 | 1796 | 4257 | 11850 | 15819 | 12680 | 6.9 s | 15683 |
  | dot64k (3 folds) | 81.6 | 81.5 (serial) | 650 | - | 69.3 | 335 | 72.3 | 229 | 360 | 231 | 109 ms | 231 |
  | max64k (2 folds) | 47.3 | 48.8 (serial) | 718 | - | 40.8 | 314 | 40.7 | 208 | 262 | 135 | 54 ms | 181 |

  "A0 auto" is `--parallel` (threads or serial by the cost model); "A0 GPU" is `--parallel=gpu`,
  where the cost model picks Metal for sum24, xor24, mr22 (count20 is below 2^25).
- **Wins, ties, losses (ratios = baseline / A0 best of auto and GPU, this loaded run)**:
  vs idiomatic single-threaded C: wins sum24 3.6x, xor24 4.6x, mr22 1.4x, count20 1.3x; ties
  on the arrays (dot64k 0.85x, max64k 0.84x are 15% losses, within this run's noise; serial
  A0 output is the same vectorized loop). vs Rust: same picture (3.0x, 4.9x, 1.4x, 3.1x; 0.89x,
  0.83x). vs Zig ReleaseFast 2.8-13x (Zig 0.16's LLVM did not vectorize these loops in either
  `while` or `for` form), Go 4.4-17x, Java 2.8-9x, JS 2.8-61x, Python 1100-6800x. **vs
  hand-parallel C (OpenMP): wins sum24 1.35x (GPU and threads), xor24 1.8x (GPU); ties/loss
  count20 0.78x (threads-forced 308 us beats OpenMP 366, auto 470 is noise between two identical
  thread builds); loss mr22 0.60x (OpenMP 1.8 ms vs GPU 3.0 ms; threads here were not faster
  than serial under this load); on the 64K arrays OpenMP pays its fork/join (314-335 us) where
  A0's cost model stays serial, so A0 is 4-6x faster than the hand-parallel C there, while
  A0 threads forced (650-718 us: thread creation per fold, no pool) would lose to OpenMP.**
- Not done: no persistent thread pool (pthread create/join per parallel fold, roughly
  50-100 us per region here; OpenMP's pool is cheaper, which is why forced threads lose on
  small folds and why the threshold is 2^20); no GPU path for maps or array extras (Metal
  targets hold arrays in thread storage; buffers would be needed); the direct arm64 backend
  does not call the runtime (the arm64 code-quality work is concurrent, so the hook stayed on
  the C path) and no explicit NEON beyond Clang's vectorizer; thresholds were chosen from the
  smoke run's spawn overhead, not tuned on a quiet machine; the numbers must be re-measured at
  load < 6 before any page claim. `loop` (early exit) and bool-state reductions are not
  parallelized; Linux needs `-pthread`.
- Gate (this worktree, after merging main): lint pass; typecheck pass; test 59/59; verify all
  paths pass (interpreter, optimizer, JS, C clang, C gcc, C++, C parallel, Wasm, Wasm direct,
  JVM 5262 each; arm64, x86_64, riscv64, avr, arm32 4297 each); app pass (jvm row blocked as on
  main: the Java io buffer); equiv 48/48 proved; hw RTL simulation and Yosys synthesis passed;
  dotnet 5262; gpu 4297 on Apple M3. `results/{verification,app,equivalence,hardware,dotnet,gpu,parallel}.json`
  regenerated under a0c-0.1.13.
## Session 2026-09-30 (self-hosting: whole programs)

- **Source limit 512 -> 16384 bytes** for the self-hosted front end (`lexio`, `parseio`, `checkio` clamp n to 16384). Every table is sized from that limit so that no source within it can overflow (no capacity diagnostic): tokens 16384 (49152 words; at most one token per byte), pool 16512 bytes, 8192 symbols (a 16384-byte source has at most ~5600 distinct words), 8320 types (the header types plus one per node the checker adds), tlist 8320, 820 functions (5760 words), 2730 nodes (16384 words), 16384 operands (32768 words; a text literal is one operand per byte), 4096 uses, 3072 node types. Recorded in DESIGN.md 7a; the IR contract is otherwise unchanged, except that the parser now also writes nested array types (below).
- **Why the tables are paged (`u32x128xN`, element i at page i>>7)**: a flat u32x16384 needs a 16384-operand zero literal, 32 KiB of source, so `lex.a0` could not lex itself within the limit; with pages a zero table is one 128-zero page and an `arr` of page references. Pages also bound an update to a page plus the page list in the interpreter and on the JVM. `types` uses 384-word pages (128 triples).
- **Why the passes were restructured, not just resized**: Node's `run` validates every argument of every call element by element (src/core.ts `checkArgument`), and the C and wasm paths copy by-value aggregates, so a per-byte or per-token step that receives a 16K-word table pays for all of it (a resized old lexer would have validated the 49152-word token table four times per source byte: the step's state and three `emit` calls). Measured with a counting copy of `checkArgument`: examples/life.a0 through `checkio` validates 118.7M elements in 1.8M node evaluations (lex 5.1M, pass 1 44.4M, pool 6.5M, headers 15.1M, bodies 22.6M, checker ~24M); compiler/lex.a0 243M in 3.5M. Per-element steps now get pages and scalars:
  - `lex.a0` (18 functions, 8380 bytes, lexes itself; entry `lexsrc`): a token is pending until the byte after it, so a byte emits at most one triple; the source is scanned a page at a time and a page's tokens go to a four-page window copied back after it (~1.2K validated elements per byte). The arrow now needs `-` and `>` adjacent, as `refLex` always required (the old lexer also joined `- >`).
  - `parse.a0` (65 functions, 56 KB): five passes. (1) Per token, in 128-token pages: its bytes scanned once (key, hash, value, digit flags, decoded text length), classified into `ta` (kind, keyword, op, param, digits, type word, array word, punctuation, sym) and `tv` (value), interned exactly in an 8192-slot hash table (18 hash bits and the first occurrence's source start, then length and sym; a candidate is compared byte by byte), plus the `use` lines and the header-line chunks; symbol ranges, uses and chunks go to page windows. (2) The pool, symbol by symbol from the source. (3) Header chunks only: types, tlist and a header list (name token, name, nparams, first, result); the record stack's sentinels link to the previous sentinel, records are found by a field hash (`tsig`) and compared exactly. (4) Functions: fns and a name map (function above bit 12, node below), duplicate names at their token. (5) Bodies in segments ending at a page end or a string: nodes and args go to 5- and 3-page windows (the current node is kept in scalars and written at its newline), operands and callees are O(1) name-map lookups, and a text literal's bytes are decoded into args between segments, 64 source bytes at a time. `parseio` calls the passes in turn; no single value can hold the whole IR under the 2^21-bit cap.
  - `check.a0` (18 functions, 26 KB; entry `checkir`): the parser's paged tables as they are (no widening copies), `tinfo` (io*2^31 + bits) and `tsig` per type, node types and consumed-token flags per node, parameter consumption by function stamp; a node's operands are checked 64 at a time (the first 64 inline) with pages of args and tlist; `fold` with a frozen error instead of `loop`, so a step's state is not validated twice (predicate and body).
  - Nested array types: `u32xAxB...` is the array of B of (the array of A of u32), interned inner first (the lexer's own tables need them); `refParse` does the same. Both now report a number token with a non-digit byte (`12ab`) as a parse error at the token (the old A0 parser wrapped it, `refParse` produced `undefined`).
  - `compiler/front512.a0`: the previous 512-byte front end, verbatim with internal names prefixed `v1`, used by `check.a0` so that site/play.a0 (not changed here) keeps linking `lex parse check readbyte wstep tokat cp* zeros*` from `../compiler/check.a0`. The playground runs in the browser as wasm32 with a 1 MiB stack, which those tables fit and the paged ones do not (below); the module goes once the playground moves to the paged interface. The new entry points are therefore `lexsrc` and `checkir`; the io fronts keep their names.
- **Whole programs** (bytes / tokens / nodes / operands): examples/kernels.a0 386/124/11/24, examples/life.a0 4129/1198/175/420, site/ui.a0 5216/1195/187/628 (text literals, UTF-8 in strings), compiler/lex.a0 8380/2347/259/1221. All four are lexed, parsed and checked whole, equal to `refLex`, `refParse`/`irWords` and `refCheckWords`, on every target that can run them; they are the app's and the tests' whole-file cases (no more 500-byte cuts). results/corpus.a0 (41.8 KB, 48 functions, 2444 nodes) is over the source limit and still goes through the test's IR encoder into `checkir`, now in one chunk, as do the examples and the linked lex.a0; the linked parse.a0 and check.a0 (larger than any 16 KB source) stay chunked.
- **Size walls (measured; both walls are in src/, out of scope here)**:
  - wasm32: `compileWasm` links with a 1 MiB stack (src/toolchain.ts WASM_FLAGS) and the C backend keeps aggregates as structs by value on it. Rebuilding the same emitted C with larger `-z stack-size`: the lexer needs 2 MiB (fails at 1), the parser and the checker 8 MiB (fail at 4). The need follows the capacities, not the input, so every case fails at 1 MiB, the small ones too. The app reports these three wasm rows as `blocked` with the measurement instead of `failed`.
  - JVM: the generated Java io runtime keeps 1024 output words (`A0Io.output`, src/backends.ts) and drops the rest, so a case that writes more cannot be compared there. The JVM rows run the cases that fit and list the others: the lexer and the parser skip the three whole files that write more (life 3595/2965 words, ui 3586/3971, lex.a0 7042/5356); the checker writes at most 377 words and runs all of its cases, whole files included, so the computation itself is fine on the JVM.
- Gate (this worktree): lint pass; typecheck pass; test 43/43 (340 s); app exit 0 (297 s, was 126 s): Life 7/7 targets on 134 cases; lexer, parser and checker 5 rows passed and wasm32 blocked by the stack wall on 8, 13 and 37 cases (JVM 5, 10 and 37 of them); results/app.json regenerated.
- Timings (machine load average 12-40 from other sessions, so several times an idle run; the element counts above are exact): app rows (interpreter / optimizer / JS / C / JVM): lexer 3.3 / 3.4 / 0.1 / 3.1 / 1.4 s, parser 42.7 / 38.3 / 0.2 / 6.7 / 5.7 s, checker 77.0 / 56.4 / 0.4 / 8.0 / 3.5 s (before, on the 500-byte cuts: lexer 3.0 / 1.6 / 0.1 / 0.9 / 5.2, parser 25.3 / 14.0 / 0.1 / 1.4 / 2.8, checker 16.0 / 21.5 / 0.2 / 2.1 / 1.6). Self-hosted tests: lexer 8.7 s, parser 75.5 s, checker 241 s (before: 0.4 s, 2.9 s, 46 s with 500-byte cuts and chunked tables).
- Not done: header types with bases other than u32 (`boolx4`, `(u32,bool)x2`) are parse errors, as before; a source over 16384 bytes is clamped (the rest of the input is not read), not diagnosed; the linked compiler is larger than the limit, so compiling the compiler whole needs a larger limit (the 2^21-bit cap on one pass's state bounds the tables now, not the array length) or per-file compilation with `use` resolution; the interpreter pays ~37K validated elements per token in pass 1 (hash table and source), the next thing to cut.

## Session 2026-09-30 (JVM io capacity)

- The Java and C# io runtimes (src/backends.ts `javaIoRuntime`, src/dotnet.ts `csIoRuntime`)
  now take the C backend's `ioInputCapacity`/`ioOutputCapacity` options with the same defaults
  (256/1024) and the same bounds: input is held in a fixed array of that many words (longer
  input is truncated; reads past `ninput` return 0) and writes past the output capacity are
  dropped, as in `a0_write`. `checkJvm` and `bun run dotnet` size both from the cases via
  `ioCaps(cases)`. The `tools/app.ts` JVM filter (emit_arm64) and blocked row (emit_c) are
  removed: JVM now runs 12/12 emitio and 20/20 emitcio cases. COMPILER_VERSION a0c-0.1.14.
- Gate: lint, typecheck, test 55/55, verify (all paths passed; jvm 5262/5262), app (jvm
  134/7/15/39/12/20 all passed), equiv 48/48 proved, hw passed, dotnet passed, gpu 4297 passed.

## Session 2026-09-30 (bootstrap: stage 1 native)

- `bun run bootstrap` (`tools/bootstrap.ts`, `results/bootstrap.json`), DESIGN.md 7a stage 6, step 1. Stage 1: `compiler/emit_c.a0` linked with check/parse/lex (119 functions) goes through the TypeScript C backend (`compile(program, 'c', { ioInputCapacity: 520, ioOutputCapacity: 2^20 })`, 746,839 C bytes) plus a small stdin/stdout `main` and clang -O2 (7.2 s) into `dist/bootstrap/a0c-stage1`: A0 source bytes on stdin become the `emitcio` io stream (length word, then bytes), the C bytes go to stdout, the exit status is the front end's diagnostic code (64 for a source over 512 bytes). No stack or runtime flags were needed.
- Stage 2: 216 sources: 4 small programs (clamp, sq, retop, calls), the 24 ill-typed programs of tools/ref-check.ts, the callee closure of every corpus function (48), kernels.a0 whole plus its 5 closures, life.a0's 15 closures, and the closures of all 119 functions of the linked emitter itself. 112 fit the 512 bytes and were fed: 27 accepted programs with driver-callable functions pass the independent oracle on 5,419 cases with the stage 1 C (clang -std=c11 -O1 -Wall -Wextra -Werror, UBSan, the standard driver of tools/verify.ts) and with the TypeScript emitter's C on the same cases (observable agreement); 60 accepted programs without a driver-callable function (array or record signatures, e.g. `readbyte`, `cws`) compile warning-free under -Werror from both emitters; 25 are rejected with no C written: all 24 ill-typed ones with the reference checker's code (2, 3 or 4) and corpus g23 (418 bytes) with parse code 1, as the reference front end gives. 0 failures. 104 sources are over 512 bytes (44 of 48 corpus closures, 537 to 7,961 bytes; 5 of life.a0; 55 of the emitter's own closures, 519 to 89,943 bytes).
- Native vs interpreter: on the 14 sources run both ways (small, kernels, 4 ill-typed) stage 1 output equals `emitcio` in the reference interpreter byte for byte and code for code; stage 1 took 316 ms including one process spawn per source, the interpreter 14.9 s (47x). A first run that compared all 112 fed sources in the interpreter (all identical) took 4.0 s native against 513 s interpreted (128x); the gate now interprets only the 14 to stay under two minutes.
- Fixed point, within the current front end: 64 of the emitter's own 119 function closures (the ones of at most 512 bytes: the io writers, decimal and name writers, the lexer's steps, 10 with driver-callable functions and 1,524 cases) are compiled by stage 1 and agree with the TypeScript emitter (oracle cases, or -Werror compilation). A small A0 program compiled by stage 1, its C compiled and run, gives the oracle result (the 27 programs above).
- What blocks the full fixed point (stage 1 compiling emit_c.a0 itself), exact limits hit by the linked emitter (formatted, comments stripped: 93,053 bytes; files emit_c 30,049 + check 48,907 + parse 25,581 + lex 5,718 bytes): source 93,053 bytes against the lexer's 512 (u32x512 source array, and a u32x512 token array); nodes 2,378 = 14,268 words against the 4,096-word node table; operands 45,962 words against 8,192; distinct names 6,307 bytes against the 512-word pool, and 1,530 names = 3,060 sym words against 512; functions 119 = 833 of 1,024 fns words (fits). `emitcio` has no `use` resolution, so the input must be pre-linked. Beyond the front end, stage 1's own C would need `emitc` run in chunks (as tools/selfhost-c.ts does) and in-place array updates in the A0 C emitter (it copies the 8,192-word tables on every `set`). The other agent's raise of the front end limit is the next unblock; the script measures the limits from the linked program, so the numbers update with it.
- Gate (this worktree): lint pass; typecheck pass; test 55/55; bootstrap 0 failures.

## Session 2026-09-30 (4000-function programs)

- **Function cap raised (a0c-0.1.14)**: `LIMITS.maxFunctions` 1024 -> 65536 in `src/core.ts`, enforced by the parser and by `validate` (so also for linked programs, `src/link.ts` validates the merged program). Every other bound is unchanged (1 MiB source, 4096 nodes and 64 params per function, 65536-element arrays, 2^21-bit aggregates, 1024-element vectors on hardware/GPU); the 1 MiB source bound is the binding one for tiny functions (about 45k one-line functions). Hardware and GPU needed no per-module function limit. COMPILER_VERSION a0c-0.1.13 -> a0c-0.1.14 (semantics-visible: programs of 1025..65536 functions were rejected before). DESIGN.md security bounds sentence updated. Test: a 4000-function call chain validates and emits JS; 65537 functions are rejected by `validate` with `too many functions`.
- **Not updated: `compiler/check.a0` still enforces 1024 functions** (its `fns` table is u32x1024) until the self-hosted checker is updated; the TypeScript front end and the self-hosted checker therefore disagree for 1025..65536 functions. The site docs generator (site/) is not touched; the new cap for the docs is 65,536 functions per program.
- Task set `c4000` (`A0_EXPERIMENT_TASKSET=c4000`, same `generateFiller`/`scaledOrder`, 3960 filler functions): 12 tasks, harness self-check ok (all originals fail, all references pass, tsc and rustc); `taskSetSha256` `fc835b07…`.
- Context tokens per cell at 4000 functions (mean toolContext o200k, task text + view, scoped A0 handle): A0 conventional 126,113; A0 structured (scoped g0) 123-125; TS conventional 120,548; TS structured 143,666-143,671; Rust conventional 120,144; Rust structured 143,276-143,307 (ranges: the two scored runs differ only in reply-dependent repairs). TS structured / A0 structured context 1168x, Rust 1165x (290x at 1000 functions, 116x at 400).
- Collected on c4000, structured cells only, fresh Haiku and Sonnet subagents, min primer, one shot, scoped A0 handle (scratchpad g4k). One group file per representation, 12 tasks each; the TS and Rust group files print the whole numbered file once as a shared view (identical for all 12 tasks, as in the c400 collection), and since that view is about 143k tokens (420 KB for TS) it is split across two files (`group-{ts,rust}-structured.txt` with the tasks and the first half of the view, `…-part2.txt` with the rest, no line omitted); subjects read both in chunks. Results `results/ai-edit-experiment.c4000.{haiku,sonnet}-min.json`. Cost per task cache-adjusted as before (primer once at 1.25x over the 12 tasks, context and output 1x):

| subject | cell | accepted | cost/task |
|---|---|---|---|
| Sonnet | A0 structured, scoped g0 | 12/12 | 202 |
| Sonnet | TS structured | 12/12 | 143708 |
| Sonnet | Rust structured | 12/12 | 143317 |
| Haiku | A0 structured, scoped g0 | 11/12 (1 protocol: select with 5 operands) | 205 |
| Haiku | TS structured | 11/12 (1 wrong output, avgfloor signed) | 143715 |
| Haiku | Rust structured | 10/12 (2 compile) | 143348 |

  Cost ratio TS / A0: 711x (Sonnet), 701x (Haiku); Rust / A0: 709x (Sonnet), 699x (Haiku). A0 cost per task is flat from 400 to 4000 functions (Sonnet 202 both) while TS/Rust grow linearly with the file. Caveat as at c400: the scoped A0 view is protocol-supplied; TS/Rust get the whole numbered file.
- Gate (this worktree, all exit 0): lint, typecheck, test 56/56, verify, app (JVM emitter row still blocked as before), equiv 48/48 proved, hw, dotnet, gpu.

## Session 2026-09-30 (security fixes)

Nine findings from a security review, each fixed minimally with a regression test in
`test/security.test.ts`. COMPILER_VERSION a0c-0.1.15 -> a0c-0.1.16 (fuel and io semantics).

1. HIGH, fuel bypass (`src/core.ts` `run`): a zero-node body (`ret p0`) folded 2^32 times
   charged no fuel. Now every function entry costs one unit and every fold/loop iteration
   one more before the body runs. Test: that body folded 30,000,000 times under fuel 1000
   throws a `limit` fuel error in milliseconds (fold and loop).
2. Aggregate cost: `arr`/`rec`/`text` and `set`/`put` now charge max(1, length) for the copy
   they make; argument checking runs once at the `run` entry and internal calls (`exec`) no
   longer re-walk validator-typed arguments. Test: a `u32x65536` `set` folded 100 times
   exhausts fuel 10^6; 4 iterations finish.
3. C `a0_read` (`src/backends.ts`): the read also compares the position with the input
   capacity, so a host that sets `ninput` above it reads 0, not the words after `input[]`.
   Test: capacity 2, ninput 3, three reads sum to 12.
4. Direct wasm `a0_read` (`src/wasm.ts` `ioRead`): the same capacity comparison. Same test
   on the wasm module.
5. Linker (`src/link.ts`): `link(entry, read, { root })`; root defaults to the nearest
   ancestor of the entry directory containing package.json, else the entry directory.
   Every `use` target is realpath'd and rejected with a `structure` error unless it is an
   `.a0` file inside the root. `tools/site-build.ts` and `tools/app.ts` pass the repository
   root. Tests: `/etc/passwd`, `../../x.a0`, a non-.a0 file, a symlink escaping the root,
   and a narrower explicit root are refused; an in-root use links.
6. Parallel worker stack (`src/parallel.ts`): threads are created with a pthread attribute
   whose stack is max(8 MiB, the soft RLIMIT_STACK). Test: a forced-threads fold whose body
   holds two `u32x65536` arrays matches the interpreter (it crashed with the 512 KiB default
   secondary-thread stack).
7. `site/app.ts`: byte strings are read by `readBytes` (`site/wire.ts`), which clamps the
   length to the words that remain; ATTR drops an `href` not matching
   `/^(https?:|\/|#|mailto:)/i` (`safeHref`). Test: unit tests of both helpers.
8. `tools/verify.ts` C driver: `ninput` is clamped to the io capacity and to the tokens on
   the line, and a line with too few tokens prints `?`. Test: the driver under
   AddressSanitizer with ninput 1000000 and a truncated line.
9. Docs: STATUS/DESIGN now say literal iteration counts are bounded statically and variable
   counts by fuel in the interpreter only; compiled code has no execution budget.

- `tools/selfhost-verify.ts` runs `emitio` on the explicit 10^12 budget `tools/selfhost-c.ts`
  already uses: with aggregate copies charged by length the emitter exceeds the 10^8 default.
  `site/wire.ts` is emitted next to app.js by the site build (the page imports it).
- Gate: lint, typecheck, test 67/67, verify (all paths passed; 5262 cases each), app passed,
  equiv 48/48 proved, hw passed, dotnet passed, gpu passed, selfhost 50 passed / 3 skipped
  (6898 cases), selfhost:c 6371/6371.

## Session 2026-09-30 (AI edits: seven languages)

- Five more representations in the AI-edit harness: Python, Go, Java, C#, C++ (`tools/ai-edit-langs.ts`). Hand translations of every function in set B (originals and references) and in the set-C / c400 program (set-A originals, the fold-helper and examples/ extras, and the six generated filler templates, emitted from a `spec` now recorded on each `generateFiller` entry), same names and u32 semantics: Python `& 0xFFFFFFFF`, Go `uint32`, Java `int` with `Integer.compareUnsigned` / `divideUnsigned` / `remainderUnsigned`, C# `uint`, C++ `uint32_t`; shift counts masked to 5 bits; `pctof` divides with the A0 rule (b = 0 gives 4294967295). Records: tuples (Python, C# value tuples), `U32U32` / `U32Bool` (Go structs, Java records), `std::pair` (C++).
- Acceptance follows acceptTs/acceptRust: write the file, build (`python3 -m py_compile`, `go build`, `javac`, `dotnet build -c Release`, `clang++ -std=c++20`), run a generated driver that prints each result in one canonical form, compare. Protocols: conventional (whole file) and structured (numbered whole file + line edits, the TS/Rust protocol) for each language. Harness: `A0_EXPERIMENT_REPS=python,go,java,csharp,cpp` (default `a0,ts,rust`), `A0_EXPERIMENT_PROTOCOLS`; reports carry `representations`, `protocols`, and `langTaskSetSha256` (b `bc76a963…`, c400 `58a27fdf…`); `taskSetSha256` unchanged (b `21de5a34…`, c400 `ad0f14cd…`).
- Self-check ok on b and c400 in all five languages: every reference passes, every original fails.
- Collected with fresh subjects (one Haiku and one Sonnet subagent per group file, one shot, scratchpad g16): set b, 10 group files (5 languages x 2 protocols, 12 tasks each); c400, 5 group files (structured only), each printing the shared numbered 400-function file once, as the earlier c400 collection did. c400 conventional not collected (each reply is the whole ~11.5k-token file, 12 per subject; same reason as before). Results `results/ai-edit-experiment.{b,c400}.{haiku,sonnet}-langs.json`. A0 rows are the earlier collections on the same prompts (`b.*-min`, `c400.*-min`, scoped g0); A0 was not re-collected. Cost per task cache-adjusted as before (primer 1.25x per call, context and output 1x); ratio = language cost / A0 cost, same protocol.

Set b (single-function files):

| subject | cell | Python | Go | Java | C# | C++ | A0 |
|---|---|---|---|---|---|---|---|
| Sonnet | conventional accepted | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet | conventional cost/task | 140 (0.71x) | 152 (0.77x) | 171 (0.86x) | 166 (0.84x) | 185 (0.93x) | 198 |
| Sonnet | structured accepted | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet | structured cost/task | 126 (0.68x) | 142 (0.77x) | 148 (0.80x) | 144 (0.78x) | 159 (0.86x) | 184 |
| Haiku | conventional accepted | 11/12 | 11/12 | 10/12 | 12/12 | 12/12 | 12/12 |
| Haiku | conventional cost/task | 144 (0.73x) | 160 (0.81x) | 175 (0.88x) | 165 (0.83x) | 186 (0.94x) | 198 |
| Haiku | structured accepted | 3/12 | 12/12 | 8/12 | 9/12 | 11/12 | 12/12 |
| Haiku | structured cost/task | 150 (0.77x) | 143 (0.73x) | 202 (1.03x) | 199 (1.02x) | 163 (0.83x) | 196 |

  On single functions A0 is the most expensive representation (its primer dominates), as it was against TS and Rust (TS/Rust 139–162). Every language ties or beats A0's acceptance with Sonnet; with Haiku, A0 structured (12/12) beats Python (3/12: 9 replies dropped the indentation of the replaced line, so the line-edit protocol breaks significant whitespace), Java (8/12: 3 compile, 1 wrong output) and C# (9/12: 3 compile, two of them edits placed outside the class).

Set c400 (one 400-function program, structured):

| subject | Python | Go | Java | C# | C++ | A0 (scoped g0) |
|---|---|---|---|---|---|---|
| Sonnet accepted | 12/12 | 11/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet cost/task | 12502 (62x) | 13203 (65x) | 13114 (65x) | 13761 (68x) | 13011 (64x) | 202 |
| Haiku accepted | 1/12 | 5/12 | 8/12 | 7/12 | 9/12 | 10/12 |
| Haiku cost/task | 12534 (58x) | 13266 (61x) | 13151 (61x) | 13788 (64x) | 13042 (60x) | 217 |

  With TS (14143 / 14202) and Rust (14210 / 14294) from the earlier collection, A0 structured is 58x–70x cheaper per task than every one of the seven languages at 400 functions; the whole numbered file is 12.4k–13.7k tokens in each of them (Python smallest, C# largest). Haiku's misses: Python indentation again (11), Go (6 compile, e.g. a line number taken from the file position rather than the view number; 1 divide-by-zero panic in `pctof`), C# replies without the handle line (3). Sonnet's one miss: a Go insert inside `popcnt`.
- Caveat as before: the scoped A0 view is protocol-supplied; the other languages get no per-function tool.

## Session 2026-09-30 (grammar item B: nested expressions)

- Prototype (not kept): `ParseOptions.nested` in `src/core.ts` `parse`/`parseAndValidate` and `SessionOptions.nested` in `src/edit.ts` (edit lines, `ret OP …`, and `fn` blocks), desugaring one level of `ID OP (OP ARGS) ARGS` into fresh nodes `ID_1, ID_2…` left to right just before the line (ids renamed if taken in the function or the edit), typing unchanged; off by default; 1 test with 8 cases (equivalence to the explicit program, collisions, `ret` form, `@` placement, depth/unmatched/empty errors, the option off rejects). Harness switch `A0_EXPERIMENT_NESTED=1`.
- Collection (no rescore of old replies): fresh Agent-tool subjects (Haiku, Sonnet), each reading only its group file, sets B and D, A0 conventional and structured, current `MODEL_GUIDE.min.txt` (control) versus the same primer plus one line, "Nested: one level of parentheses is accepted, e.g. `r select (lt a b) a b` (each group becomes a fresh line)." (option on for scoring). 16 groups, scratchpad gB-nested. Results `results/ai-edit-experiment.{b,d}.{haiku,sonnet}-min-itemb-{control,nested}.json`.
- One shot, control vs option: Haiku B conv 12/12 vs 12/12, B struct 10/12 vs 11/12, D conv 13/13 vs 12/13, D struct 12/13 vs 12/13 (47/50 both); Sonnet 50/50 both. Nested replies: Haiku 1/50 control (bounds task, the parse diagnostic) and 2/50 with the line (bounds, which then failed with a type error; isdiv, accepted); Sonnet 0/100. Primer 405/440 -> 436/471 tokens per call; one-task cache-adjusted tokens up in all 8 cells (Haiku 198->201, 195->196, 152->159, 168->176; Sonnet 198->201, 184->192, 152->155, 154->157).
- Decision: refused (no acceptance gain on either model, cost up). Prototype removed; DESIGN.md records the numbers. COMPILER_VERSION unchanged.

## Session 2026-09-30 (MCP server)

- `src/mcp.ts`: MCP server on the official `@modelcontextprotocol/sdk` (stdio transport, zod
  input schemas), launched by `a0 mcp <file-or-dir>`. Tools over `EditSession`: `a0_open`,
  `a0_program`, `a0_apply`, `a0_check`, `a0_run`, `a0_emit`, `a0_save`. Failures return
  `isError` with the A0Error JSON (code/message/line/expected/actual/fix).
- Security: no shell; every path (and every `use` dependency) resolved inside the launch root
  with realpath, symlink and dangling-symlink escapes rejected, `.a0` only; `a0_run` fuel capped
  at `LIMITS.defaultFuel`; tool output capped at 1 MiB; edits capped at `maxSourceBytes`;
  `a0_save` refuses without an applied edit and refuses to flatten a multi-file program over
  its entry file (save to a new path instead).
- `test/mcp.test.ts`: in-memory client/server transport covering every tool, diagnostics,
  fuel exhaustion, and confinement (`..`, absolute, symlink, dangling symlink, `use` escape).
- Gate: lint, typecheck, test.

## Session 2026-09-30 (C backend: large aggregates off the stack)

COMPILER_VERSION a0c-0.1.15 -> a0c-0.1.16. Change confined to the C emitter's aggregate handling
in src/backends.ts (plus one comment in src/toolchain.ts); the design is documented at
`C_LARGE_BYTES` there.

- **Large aggregates** (C struct over 4096 bytes, `isLargeC`) no longer live on the C stack.
  ABI: a large parameter is `const T *pK` (read-only borrow); a large result goes to
  caller-owned storage passed first, `void a0_f(T *out, ...)`; the same in the `a0o_`/`a0r_`/`a0v_`
  variants. Functions with no large parameter or result keep the by-value ABI unchanged (all
  driver-callable functions are scalar/io, so no driver changed). Large locals are pointers into a
  per-module arena: a bump allocator in static memory (`a0arena`, `#define A0_ARENA_BYTES`); a
  function that allocates saves the top on entry and restores it before returning. The node that
  is the result's root is built in `out` directly; `mov`/`select` alias; `get`/`at` of a large
  element copy. Large types get only a typedef and a pointer zero-fill (no by-value
  `a0mk_`/`a0set_`/`a0put_`); the old >4096-element compound-literal constructor is gone (every
  such array is large).
- **Bound, not malloc**: the call graph is acyclic, so `cArenaBytes(fn)` = the function's large
  nodes (8-byte slots, pointers counted as 8 bytes) + the largest callee need is a static upper
  bound (the optimizer only removes nodes). The arena is exactly the largest need of any
  function, so no run can overflow it; a need over `C_ARENA_LIMIT` (256 MiB) is an `A0Error` with
  code `limit` at compile time. Arena sizes: lexer 3,276,880 bytes, parser 6,818,064, checker
  7,010,856 (bss; the wasm file does not grow).
- **Value semantics**: a borrowed large parameter is not owned, so its first `set`/`put` copies
  once (the copy the by-value ABI made at the call); fresh locals and the owned loop state still
  update in place under `mutableHere`. The arena is single-threaded: an automatic parallel fold
  whose state or body (transitively) touches a large value keeps the sequential loop.
- **Fold state passed again as an extra** (bug reported by two other agents; the direct wasm
  backend already copied): C and JS ran an owned fold in the initial value's storage even when
  that value was also an extra argument of the same fold, so later trips read the mutated state.
  Both now copy in that case. Regression test (fails before: JS 7 vs 1): a fold writing
  `state[i] = extra[i-1] + 1` with `extra` = the initial value, at u32x8 (by value) and u32x2048
  (arena), on the interpreter, JS and C/wasm32. The hand-written assembly backends
  (src/arm64.ts, x86_64.ts, riscv64.ts, arm32.ts) have their own `mutableHere` for fold init and
  were not checked here.
- **Stack use, measured** (wasm32, same emitted-C build with `-z stack-size` at powers of two,
  smallest size whose run on compiler/lex.a0 (8380 bytes, whole file) equals the 16 MiB run;
  ioInput 16500 / ioOutput 60000 words):

  | module | a0c-0.1.15 | a0c-0.1.16 |
  |---|---|---|
  | lexer (`lexio`) | 2 MiB | 16 KiB |
  | parser (`parseio`) | 8 MiB | 64 KiB |
  | checker (`checkio`) | 8 MiB | 128 KiB |

  The remainder is aggregates at or under 4 KiB (pages, records) held by value.
- **app**: the self-hosted lexer, parser and checker rows now pass on webassembly (8, 13 and 37
  cases; were blocked by the stack wall) and on native C. The blocked-row fallback in
  tools/app.ts (`frontEndTargets`, `needMiB`) no longer triggers and its detail text is stale.
- Gate (this worktree, machine load average 200+ from other sessions; all exit 0): lint;
  typecheck; test 61/61 (site page, docs and play programs included); verify all paths passed
  (C clang/gcc/C++/parallel/wasm/JVM 5262 each; asm backends 4297); app all rows passed (Life 134
  on 7 targets; lexer 8, parser 13, checker 37, emitter 12, C emitter 15 on every target including
  webassembly); equiv 48/48 proved; hw passed; dotnet passed (5262); gpu passed (4297, Apple
  M3); selfhost 50 programs / 6898 cases; selfhost:c 6371/6371. results/*.json regenerated
  under a0c-0.1.16.

## Session 2026-09-30 (parallel folds: pool and GPU maps)

- **a0c-0.1.16, `src/parallel.ts` only (plus the version bump in `src/backends.ts`; the C emitter hook `CFoldSite`/`CParallel` is unchanged).**
- **Persistent worker pool** replaces per-region pthread create/join: helpers are created once on the first parallel region (`pthread_once`, at most 64, `A0_THREADS` or the online CPUs), wait on a generation counter (a short `yield` spin, then a condition variable), and an `atexit` handler wakes and joins them. A region entered while another host thread holds the pool (atomic flag) or from inside a chunk (thread-local depth) runs sequentially, so there is never oversubscription or a deadlock.
- **Scheduling**: static contiguous chunks, one per thread, each a multiple of 128 bytes (32 words; the Apple M line), so map chunks never share a line of the state array; each thread's partial sits in its own 128-byte `_Alignas` slot (no false sharing); partials combined in thread order (exact for every op anyway). The caller runs chunk 0.
- **GPU (Metal) for maps and array-input reductions**: the body becomes a scalar *element function* by a syntactic, exact rewrite (`elementFunction`): each u32-array extra read only as `get x p1` becomes a scalar parameter (x[i % length]) and its `get` a `mov`; for a map, parameter 0 becomes an unused u32 and the final `set p0 p1 v` is dropped, returning v. That function goes through `emitMetal` (so no second emitter, and callees with arrays over Metal's 1024 limit simply make the fold ineligible), plus kernel `a0gk` over device buffers (prm, out, one buffer per array). Reductions: 65536 strided partials combined on the CPU; maps: one thread per index, result copied into the state. Reads at any other index, bool arrays, or records stay on threads. Cost model: GPU when n x cost >= 2^25 + 64 x (words copied: array inputs + map output); `A0_GPU_LOG=1` reports each dispatch (ran / fallback), and tests and the bench require "ran".
- **Thresholds**: THREAD_WORK stays 2^20 (a smoke run at load ~250 with 2^18 moved the 64K fills to threads and lost 8x; not re-tuned at low load), GPU_WORK 2^25.
- **Exactness**: `test/parallel.test.ts` runs the all-ops/maps/nesting/variable-count program (now plus an array-input reduction and a read at a fixed index, which must stay off the GPU) forced on threads (C) and forced on the GPU (Objective-C + Metal), 8 calls per input so the pool serves many regions and exits cleanly, at `A0_THREADS` 1, 3, 8, against the interpreter; new unit test for element-function shapes and the GPU cost model. par-bench small-size verification: all 7 kernels off / threads / GPU forced exact on 5 seeds, GPU dispatch confirmed. At full size every baseline checksum equals A0 serial; the a0_gpu rows logged 2-4 dispatches and 0 fallbacks.
- **New kernel hash64k**: sum of a 65536-element array whose element i is 64 chained gen rounds (a heavy map; the cost model picks the GPU for the map and serial for the 64K sum).
- **Measurements (`bun run par-bench`, median of 7, interleaved; load NOT quiet: the 15-minute wait expired at 1-minute load 194 (5-min 212), 77 at the end, on 8 cores; many other agents were running. Every multicore number is depressed and noisy)**, us per call:

  | kernel | A0 serial | A0 auto | A0 threads forced | A0 GPU | C | OpenMP C | Rust | Zig | Go | Java | Python | JS |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|
  | sum24 | 6110 | 2591 | 2681 | 2169 | 6197 | 2858 | 6270 | 19645 | 26566 | 16587 | 10.8 s | 178921 |
  | xor24 | 7274 | 3783 | 3233 | 1865 | 6860 | 2938 | 7148 | 21896 | 28346 | 20156 | 13.0 s | 26540 |
  | count20 | 464 | 310 | 381 | - | 458 | 429 | 1171 | 1503 | 1870 | 2322 | 0.73 s | 4011 |
  | mr22 | 3043 | 3065 | 2443 | 2543 | 2905 | 1521 | 2810 | 8597 | 12343 | 10770 | 6.1 s | 14554 |
  | dot64k | 51.4 | 48.8 | 283 | - | 41.1 | 192 | 43.8 | 144 | 192 | 141 | 68 ms | 139 |
  | max64k | 29.4 | 29.1 | 379 | - | 23.3 | 189 | 22.8 | 129 | 171 | 74.2 | 31 ms | 112 |
  | hash64k | 20353 | 6200 | 5494 | 1306 | 22562 | 5898 | 23755 | 23997 | 21187 | 21864 | 2.9 s | 47663 |

- **Wins / ties / losses** (baseline / best of A0 auto and A0 GPU; above 1 means A0 is faster):
  - vs C -O3: wins sum24 2.9x, xor24 3.7x, count20 1.5x, mr22 1.14x, hash64k 17x; losses dot64k 0.84x and max64k 0.80x (both serial; the fill fold goes through the owned variant and is slower than C's plain loop).
  - vs Rust: wins 2.9x, 3.8x, 3.8x, 1.10x, 18x; losses 0.90x (dot64k), 0.78x (max64k).
  - vs Zig ReleaseFast: wins everywhere, 3.0-18x. vs Go: 3.9-16x. vs Java: 2.5-17x. vs JS: 2.8-82x. vs Python: 1000-5000x.
  - **vs OpenMP C: wins sum24 1.32x (GPU), xor24 1.58x (GPU), count20 1.38x (was a 0.78x loss), hash64k 4.5x (GPU map), dot64k 3.9x and max64k 6.5x (A0 stays serial where OpenMP pays its fork/join); loss mr22 0.60x unchanged (OpenMP 1.5 ms vs A0 threads forced 2.4 ms / GPU 2.5 ms; auto did not beat serial at this load).**
  - Forced threads on the 64K folds went from 650-718 us (create/join per region) to 283-379 us with the pool, still slower than OpenMP's 189-192 us, so the cost model keeps them serial.
- Not done: mr22 still loses to OpenMP (the two-generator body is not vectorized per chunk as `omp simd` does, and the static split does not balance P and E cores); no GPU form for bool arrays, records or reads at other indices; the arm64 direct backend still does not call the runtime; thresholds not re-tuned on a quiet machine (load never fell below 77 during this session); page claims need a run at load < 6.
- Gate (this worktree): lint pass; typecheck pass; test 60/60; verify all paths pass (incl. native_c_parallel 5262); gpu pass (4297 on Apple M3); par-bench exit 0. `results/{verification,gpu,parallel}.json` regenerated under a0c-0.1.16.

## Session 2026-09-30 (fold state passed again as an extra: A0's own backends)

COMPILER_VERSION a0c-0.1.16 -> a0c-0.1.17. Follow-up to the C/JS fix of the same bug (commit
1916986 on worktree-agent-ac1281cf5c7e55f6b; not merged here).

- Affected: arm64, x86_64, riscv64, arm32. Their `mutableHere` skipped the updating node's own
  operands, so a fold whose initial value was also an extra argument ran in that value's storage
  and later trips read the mutated state (chain(5,1): 7 instead of 1). Fixed as in src/wasm.ts:
  `mutableHere` takes the operand position and the updating node may name `o` only there.
- Not affected: wasm (already had the position check), avr (the fold state is always a fresh copy).
- Regression test (test/core.test.ts): the step/chain program at u32x8 and u32x1024 through
  checkWasmDirect, checkArm64, checkX86_64, checkRiscv64, checkArm32 and (u32x8) checkAvr; fails
  before the fix on the four affected backends at both sizes.

## Session 2026-09-30 (RISC-V code quality)

- **`src/riscv64.ts` code quality (a0c-0.1.16)**, plain RV64GC by default:
  - Frameless functions: no frame pointer (s0 never used; all slots from sp). A function with
    no residual call saves no ra; a leaf with no slots and no callee-saved homes emits only its
    body and `ret`. A non-leaf keeps ra in the top 8 bytes of its frame.
  - Select: one conditional-move sequence; when the chosen value already sits in the
    destination it is `bnez/beqz` + one `mv` (the redundant `mv` from the earlier session is gone).
  - Loop-invariant literals read in a fold/loop trip (trip counts, multipliers, compare
    operands) are hoisted into registers at loop entry when a register is free across the
    loop (allocated after all real values, so they never displace them); literal 0 reads `zero`.
  - Values stay in registers across trips: an inlined body whose result is computed after its
    last read of the state writes the state register directly (no per-trip copy).
    Copies (`mov`, inlined results, fold state init) prefer the source's register, a call
    result and the returned value prefer a0; values live across no residual call may live in
    a0-a7 in non-leaf functions too (register arguments set up as one parallel move, cycles
    broken through t0). The allocator is now interval-based.
  - Zbb option: `emitRiscv64Function(fn, { zbb: true })` (`Riscv64Options`) turns
    `or(shl x k, shr x (32-k))` into `roriw` and the variable forms (`sub 32 n`) into
    `rolw`/`rorw`; such a block is wrapped in `.option push` / `.option arch, +zbb` /
    `.option pop`, so it assembles in an rv64gc module (checked with riscv64-elf-gcc 16.2.0
    and objdump). Default output contains no Zbb instruction. Not plumbed into
    `CompileOptions`/CLI (outside this session's files); Zbb code not executed (the corpus has
    no rotates and verify builds rv64gc).
- **Static instruction counts** (no RISC-V hardware for timing; counts exclude directives
  and labels). Exec-bench kernels, optimized, before -> after (Zbb in brackets where
  different): affine 11 -> 3, rotl 14 -> 6 [2], clamp 19 -> 7, mix 18 -> 10 [8], ident 9 -> 1,
  noop 9 -> 1 (O0 13 -> 5), chain3 13 -> 5, branchy 30 -> 15, arrfill 36 -> 29,
  loop64 21 -> 12 (trip 11 -> 7 instructions), arrfill4k 11301 -> 11295. Corpus (38 io-free
  functions): optimized total 1135 -> 830, unoptimized 6888 -> 6025; no function grew at
  either level (per function, optimized: g0 9->1, g2 21->14, g4 14->6, g5 36->28, g6 26->16,
  g8 24->17, g9 10->2, g11 47->42, g12 27->20, g13 38->34, g14 13->5, g15 15->7, g16 10->2,
  g19 16->9, g20 14->6, g21 21->11, g22 23->16, g23 33->24, g24 12->4, g25 18->9, g27 42->35,
  g28 12->4, g29 98->88, g31 34->27, g32 22->15, g33 10->2, g34 291->270, g35 18->10,
  g36 11->3, g37 10->2, g38 19->12, g40 25->18, g41 23->15, g42 22->15, g44 17->10,
  g45 10->2, g46 10->2, g47 34->27).
- `native_riscv64` **4297/4297** at both optimization levels (same 10 io functions skipped).
- Unit tests updated/added: frameless leaf, select without redundant move, hoisted fold
  literals and direct state write, ra-only frame for a caller, parallel-move argument swap
  through t0, rotates absent by default and `rolw`/`roriw` with Zbb.
- Not done: aggregates still never in registers; loops still test at the top (`bgeu` + `j`
  per trip, no rotation); no Zbb execution run; no CLI flag for Zbb.

## Session 2026-09-30 (ARM32 code quality)

- **`src/arm32.ts` code generation (a0c-0.1.16)**, same scope and calling convention:
  - No frame pointer: slots are addressed from sp, the epilogue is `add sp` + `pop {..., pc}`,
    and r11 is an eighth callee-saved home (r4-r11). Leaves (no out-of-line call, no divide
    routine) also use lr as a home once anything is pushed; leaves without aggregates also use
    r0/r1 (the first two parameters stay where they arrive; scratch is then r12, r3, r2, with
    parameters placed by one parallel move) and have no prologue at all when nothing else is
    needed (`bx lr`). lr and the r0/r1 pool are used only when every sp offset fits the 12-bit
    immediate (lr is the large-offset scratch); otherwise the old pool is used.
  - Spilling: when all homes are taken, the live value with the smallest use weight (uses x 8
    per loop level) goes to a slot, not simply the newest one.
  - Rotates: `or (shl x a) (shr x b)` with literal distances summing to 0 mod 32 is `ror #b`,
    with `b = sub 32k a` (either side) `ror x, b` by register (ROR by register uses the low
    byte mod 32, which equals b mod 32; a = 0 gives x on both sides); single-use shift nodes
    are not emitted. `sub lit x` is `rsb`; literal-first commutative ops and compares swap.
  - Loops: rotated (test at the bottom; no entry branch for a positive literal trip count);
    literals read inside a loop (movw/movt constants, register operands, literal trip
    counts) are materialized once before the outermost loop when a register is free over it
    (never forcing a new push in a leaf); the inlined body's scalar result takes the fold
    state's register when the state is not read after the result is defined, so no `mov`
    ends the iteration.
  - Memory: `get`/`set` with a variable index use scaled register offsets (`[sp, r0, lsl
    #2]`, `ubfx` straight from the index's home); an `arr`/`rec` literal reuses a constant
    already in r3 and stores past 4 KiB through r12 advanced a page at a time instead of
    `movw lr` per element.
  - Opt-in ARMv7VE (`emitArm32Function(fn, { udiv: true })`, `assembleArm32(bodies, v, {
    udiv: true })`, module `.arch armv7ve`): `div` is `cmp b, #0; udiv; mvneq #0`, `rem` is
    `udiv; mls` (ARMv7-A defines a zero divisor to give quotient 0 without a trap, so `mls`
    already gives the dividend), index modulo a non-power-of-two length the same; no
    routine, so dividing functions become leaves. Predicated instead of a branch (the
    comparison is made before the divide, so a divisor register reused as the result is
    safe). Not reachable from `compile()`/the CLI (the option lives in src/arm32.ts only; no
    CompileOptions field was added in this session).
- **Static instruction counts** (instructions per function, directives excluded; `before` =
  a0c-0.1.15; no ARM32 hardware, so no timing; qemu time is not a performance claim):
  - exec-bench kernels (optimized; VE equal, no kernel divides): affine 10 -> 5, rotl 14 -> 3
    (`rsb; ror; bx lr`), clamp 20 -> 13, mix 17 -> 9, ident 6 -> 1, noop 6 -> 1, chain3 11
    -> 5, branchy 29 -> 21, arrfill 43 -> 27, loop64 20 -> 13 (12 -> 8 instructions per
    iteration: constant hoisted, state kept in r0, one branch), arrfill4k 11296 -> 4123;
    total 11472 -> 4221.
  - corpus (the 38 io-free functions of results/corpus.a0): optimized 1381 -> 1097 (VE 1040),
    unoptimized 8784 -> 7859 (VE 7568); fewer instructions in 38/38 functions at both levels,
    more in none. Largest: g34 480 -> 385 (VE 362), g29 135 -> 120 (VE 110), g0 7 -> 1.
- **Verification**: `native_arm32` 4297/4297 at both optimization levels (default ARMv7-A,
  Cortex-A7). VE: the same 4297 cases at both levels, emitted with `{ udiv: true }`, built
  with `-march=armv7ve+fp` and run on `qemu-system-arm -M virt -cpu cortex-a15`: 4297/4297
  (a one-off harness outside the repo; verify itself runs only the default mode). Unit tests
  (`test/core.test.ts`): frameless scalar leaf, callee-saved push without r11, shift mask via
  r2, select without redundant move, scaled index, VE div/rem/index sequences and `.arch
  armv7ve`, literal and variable ror, the rotated loop with its hoisted constant and state in
  r0, leaf stack parameters; the execution test gained rotates, a hoisted-constant fold and a
  six-parameter leaf, and now also builds and runs the VE emission (Cortex-A7 has UDIV) at
  both levels.
- Gate (this worktree): lint pass; typecheck pass; test 59/59; verify all paths passed (native_arm32 4297/4297 both levels; arm64, x86_64, riscv64, avr 4297; interpreter, optimizer, JS, C, C++, wasm, JVM 5262). results/verification.json not committed (only arm32.ts, tests, STATUS, COMPILER_VERSION edited).
- Not done: no Thumb-2; aggregates still never in registers; r12 is never a home (it is the
  address scratch, and calls may clobber it); compare+select is still a materialized bool
  (`cmp; mov; movcc; cmp; movne`); the VE option is not exposed through `compile`/CLI/verify.


## Session 2026-09-30 (AVR code quality)

- **`src/avr.ts` code generation rewritten (a0c-0.1.16)**; the target, calling convention and
  helper-per-section module shape are unchanged, so avr-gcc C still calls `a0_<name>` directly.
  - Register allocation: every scalar (u32, bool, hidden result pointer, aggregate-parameter
    pointer, fold/loop counter) is a virtual register with a live interval over the node order;
    a linear scan gives it a home in r2-r25 (a u32 an even group of four, a pointer an even
    pair, a bool one register) or a spill slot. Values live across a call or helper avoid
    r18-r27, r30, r31 and the callee's argument registers, so they land in the callee-saved
    r2-r17, which the prologue saves only when written (a parameter left where it arrived is
    not saved). Hints put a result in its dying operand's registers (only when that costs no
    push), parameters where they arrive, call results in r22/r24. An operand dying at a u32
    result shares its registers or slot exactly or not at all (the byte sequences read byte k
    after writing byte j < k). r0, r26, r27, r30, r31 are never homes: they are the byte
    temporaries and the X/Z pointers. A leaf with no spill has no frame and no Y setup.
  - Spills past Y+63 (the corpus's unoptimized functions reach 152-byte frames): a reload area
    at Y+1 stages a node's far operands and result through Z, so every operation addresses its
    scalars from Y and carry chains are never broken by pointer arithmetic.
  - Hardware multiply: `__a0_mul32` is the ten 8x8 `mul`s whose weight is below 2^32,
    accumulated by column (32 instructions, about 40 cycles; was a 32-step shift-and-add).
    mul/div/rem by a power-of-two literal become shl/shr/and.
  - 8-bit peepholes: immediate forms on r16-r31 (`subi/sbci` for add and sub, `andi/ori`,
    `cpi`), the zero register r1 for zero bytes, identity bytes skipped (and 0xff, or/xor 0),
    `com` for xor 0xff, `c - x` as `com` plus an add, `movw` for aligned pairs in every
    (parallel) move, constant shifts as one parallel byte move plus bit steps over the live
    bytes only (`swap`/`andi` for a nibble), variable shifts as an inline counted loop (no
    helper), branch-free booleans from the carry (`mov/rol`, `sbc/inc`), a compare fused into
    the select that consumes it, and `and x 2^k` tested against zero as `bst` plus `brts/brtc`.
    Known-zero bytes are tracked per value (and with a mask, shifts by whole bytes, or/xor/
    select of such values): they are read as r1, never written, compares skip bytes zero on
    both sides, and a u32 whose high bytes are zero keeps only its low bytes in registers.
  - fold/loop: state and counter stay in their homes (callee-saved registers) for the whole
    loop, the test is at the bottom (`brlo` back when the body is short), the counter steps
    with `subi/sbci 255` or `sec`/`adc r1`; the predicate result is tested in r24 directly.
  - Stack arguments (avr-gcc's rule): the first parameter that does not fit above r8, and
    every one after it, is passed on the stack in order at unpadded sizes; the caller pushes
    the last byte first and pops after the call (`pop r0` up to 6 bytes, else SP arithmetic);
    the callee reads them at Y + frame + saved + 3. `avrStackBytes` counts the outgoing
    bytes. The "more than the 18 argument registers" refusal is gone.
  - Aggregate parameters are read in place through their pointer (values are immutable and
    the result is written last, so `out` may still alias an argument); nothing is copied on
    entry. Frame aggregates are copied inline (unrolled up to 8 bytes, else a counted loop on
    r1); `__a0_copy`, `__a0_shl32` and `__a0_shr32` are gone.
- **Measured per kernel** (ATmega328P; flash = growth of the firmware `.text` over the same
  driver linked with an empty `ret` stub, so the function, its A0 callees and every helper or
  libgcc routine it pulls in; cycles = simavr cycles between two `GPIOR0` writes around one
  call, minus the stub's; simavr counts are deterministic). A0 now vs A0 a0c-0.1.15 vs
  avr-gcc 9.5.0 `-Os` / `-O2` on the equivalent C (natural C: static helpers such as fnv's step
  may be inlined by gcc; A0 calls its callees out of line). Inputs fixed per kernel; the A0
  source was 13 kernels in one module (5 from examples/kernels.a0 plus xorshift, sum of
  squares to 100, popcount, one bitwise CRC-32 byte, ten-step decimal digit strip, 8-element
  dot product over two `u32x8`, FNV-1a over four words, two calls of a six-argument mixer).

  | kernel | bytes A0 | bytes 0.1.15 | bytes -Os | bytes -O2 | cycles A0 | cycles 0.1.15 | cycles -Os | cycles -O2 |
  |---|---|---|---|---|---|---|---|---|
  | affine (mul, add) | 78 | 184 | 178 | 178 | 53 | 586 | 139 | 139 |
  | clamp_max | 16 | 144 | 82 | 82 | 6 | 96 | 65 | 65 |
  | rotl (variable shifts) | 82 | 210 | 108 | 108 | 258 | 378 | 291 | 291 |
  | is_even | 12 | 118 | 40 | 40 | 5 | 80 | 31 | 31 |
  | parity_select | 14 | 114 | 30 | 30 | 5 | 74 | 16 | 16 |
  | xorshift32 | 106 | 306 | 136 | 162 | 52 | 224 | 315 | 300 |
  | sum_squares (fold, mul) | 214 | 344 | 238 | 236 | 9867 | 65032 | 11082 | 9286 |
  | popcount (fold) | 168 | 370 | 132 | 88 | 4742 | 10482 | 4718 | 4176 |
  | crc32_byte (fold, bit test) | 136 | 440 | 110 | 110 | 400 | 1988 | 249 | 249 |
  | digits (loop, div) | 192 | 444 | 200 | 200 | 6648 | 8534 | 6386 | 6386 |
  | dot8 (fold over two arrays) | 460 | 894 | 498 | 514 | 1313 | 10768 | 1370 | 1361 |
  | fnv4 (calls, mul) | 148 | 370 | 278 | 278 | 290 | 2496 | 410 | 410 |
  | mix6_call (stack arguments) | 276 | refused | 158 | 158 | 304 | refused | 102 | 102 |

  Totals without mix6_call (which 0.1.15 refused): A0 1626 bytes / 23639 cycles, 0.1.15 3938
  / 100738, `-Os` 2030 / 25072, `-O2` 2026 / 22710. With it: A0 1902 / 23943, `-Os`
  2188 / 25174, `-O2` 2184 / 22812. So flash is 2.4x smaller than before and 20% under
  avr-gcc `-Os` (13% with mix6_call); cycles are 4.3x fewer than before, 6% under `-Os` and 4%
  over `-O2`. Where A0 loses it is the out-of-line body or callee (crc32_byte, popcount,
  mix6_call: gcc inlines the loop body or the static helper; A0 pays a call, argument
  marshalling into r18-r25 and the callee's saves per iteration). Caveat: avr-gcc 9.5 keeps 32-bit values in a stack frame
  in several of these small functions even at `-Os` (clamp_max: 4-byte frame, 82 bytes), so
  the leaf-kernel wins partly reflect that compiler version.
- **Verification**: `native_avr` 4297/4297 at both optimization levels, no function skipped
  for SRAM or flash. Beyond the gate, 68 further generated corpora (other seeds, 30 inputs
  per function, 133,432 cases, both levels) and the 13 kernels above (40 inputs each) plus a
  stress module (stack arguments both ways, in-place aggregates at offsets and on the stack,
  loops with predicates, 20 live values) ran equal to the interpreter under simavr; these
  runs found and fixed two bugs before the gate (a known-zero mask computed from the operands
  before power-of-two lowering; a spill slot partially shared with a dying operand). The
  measurement and fuzz harnesses were scratch scripts and are not in the repository.
- Unit tests (`test/core.test.ts`): the refusal test now expects five u32 parameters to
  compile; the sequence test pins the leaf `add` to five instructions, the carry-derived bool,
  the fused compare with `cpi`/r1, shift masking with known-zero bytes, `bst`/`brts`, the
  hardware multiplier, inline variable shift, in-place aggregate parameter, sret copy, stack
  argument pushes/pops/reads, fold state in registers, and reload staging past Y+63; the
  simavr execution test adds stack arguments both ways, in-place aggregates (on the stack and
  at an offset inside a record), a fold with stack-argument extras, and bit tests.
- Gate (this worktree): lint pass; typecheck pass; test 59/59; verify all paths passed
  (interpreter, optimizer, JS, C clang, C gcc, C++ clang, C parallel, Wasm, Wasm direct, JVM
  5262 each; arm64, x86_64, riscv64, avr, arm32 4297 each).
- Not done: inlining (the remaining gap to gcc on call-heavy kernels); live-range splitting
  (a spilled value stays spilled for its whole interval); X and Z are never allocated; io; a
  real board (simavr only).


## Session 2026-09-30 (AVR inlining, a0c-0.1.17)

- Started from the AVR rewrite branch (merged; STATUS conflict resolved by keeping both
  sections). COMPILER_VERSION a0c-0.1.16 -> a0c-0.1.17.
- **Call inlining** (`inlineCalls` in `src/avr.ts`): before planning, a `call` whose callee
  (its own calls inlined first) costs at most `AVR_INLINE_CALL_WORDS` = 24 estimated words is
  spliced into the caller, or at most `AVR_INLINE_ONCE_WORDS` = 48 when the caller calls it
  once. Nodes are renamed, parameters substituted, `mov` folded away, and the result is
  revalidated (`validateFunction`); on any failure the function is emitted as before. The
  estimate (`costWords`) is per op: u32 bytewise 4, compare 5, literal shift 4, variable
  shift 12, mul/div/rem 10 (marshalling plus helper call), call 12, and so on. The callee's
  own `a0_<name>` is still emitted (C may call it); `--gc-sections` drops it when nothing
  else references it.
- **fold/loop body inlining**: a fold/loop with scalar state whose body plus predicate cost
  at most `AVR_INLINE_BODY_WORDS` = 64 words and contain no fold/loop is planned in place:
  the predicate's nodes and a branch on its result (a compare as the predicate's last node is
  fused into that branch), then the body's nodes, then the state update, counter step and
  bottom test. State, counter, count and extras are live across the whole loop (the back
  edge); body values live within one iteration, so the linear scan reuses their registers.
  The body result takes the state's registers exactly when the state is not read after the
  result is defined (crc/popcount/sum update in place; no latch move). If an inlined loop
  meets spills past Y+63 the function is emitted again without loop inlining (the far-slot
  staging is per node).
- **Counters**: a literal trip count below 2^8 (2^16) keeps the counter in one (two) bytes
  (known-zero high bytes: `inc`, `cpi`); a literal count of at least one skips the first
  test. The loop's branch reach now counts real words (`wordsOf`) instead of 2 per line, so
  more loops close with a single `brlo`.
- `emitAvrFunction(fn, { inline: false })` gives the out-of-line emission (unit tests keep
  the stack-argument and fold-call sequences covered through it). `avrStackBytes` walks only
  the callees an emission still calls.
- **X/Z as homes: not done.** A u32 home is four consecutive registers (the byte sequences
  address r+k); X (r26:r27) and Z (r30:r31) are not adjacent (Y sits between) and are the
  byte temporaries, literal scratch and pointers of nearly every emitted sequence, so they
  can only host 1-2 byte values, and only after auditing every sequence. In the 13 kernels
  below the values that could move there are the one-byte loop counters of popcount, crc32
  and digits (in r16: one push/pop, 4 cycles and 4 bytes each; digits' counter lives across
  `__a0_udivmod32`, which writes X and Z, so it could not move at all). The remaining pushes
  are u32 values beyond the two caller-saved groups r18-r21/r22-r25, which X/Z cannot hold.
  Judged not worth the risk for at most about 8 cycles and 8 bytes over the kernel set.
- **Measured** with the previous session's harness, unchanged (copied to this session's
  scratchpad; same 13 kernels and inputs, same driver, flash = `.text` growth over an empty
  `ret` stub with `--gc-sections`, cycles = simavr cycles between two `GPIOR0` writes minus
  the stub's; avr-gcc 9.5.0 on the same C). Every result equal to the interpreter.

  | kernel | bytes A0 | bytes 0.1.16 | bytes -Os | bytes -O2 | cycles A0 | cycles 0.1.16 | cycles -Os | cycles -O2 |
  |---|---|---|---|---|---|---|---|---|
  | affine | 78 | 78 | 178 | 178 | 53 | 53 | 139 | 139 |
  | clamp_max | 16 | 16 | 82 | 82 | 6 | 6 | 65 | 65 |
  | rotl | 82 | 82 | 108 | 108 | 258 | 258 | 291 | 291 |
  | is_even | 12 | 12 | 40 | 40 | 5 | 5 | 31 | 31 |
  | parity_select | 14 | 14 | 30 | 30 | 5 | 5 | 16 | 16 |
  | xorshift32 | 106 | 106 | 136 | 162 | 52 | 52 | 315 | 300 |
  | sum_squares (fold, mul) | 180 | 214 | 238 | 236 | 6867 | 9867 | 11082 | 9286 |
  | popcount (fold) | 76 | 168 | 132 | 88 | 3948 | 4742 | 4718 | 4176 |
  | crc32_byte (fold, bit test) | 90 | 136 | 110 | 110 | 232 | 400 | 249 | 249 |
  | digits (loop, div) | 124 | 192 | 200 | 200 | 6284 | 6648 | 6386 | 6386 |
  | dot8 (fold over two arrays) | 362 | 460 | 498 | 514 | 905 | 1313 | 1370 | 1361 |
  | fnv4 (calls, mul) | 174 | 148 | 278 | 278 | 250 | 290 | 410 | 410 |
  | mix6_call (stack arguments) | 126 | 276 | 158 | 158 | 78 | 304 | 102 | 102 |
  | total | 1440 | 1902 | 2188 | 2184 | 18943 | 23943 | 25174 | 22812 |

  Flash is 34% under `-Os` in total (was 13%) and under `-Os` on every kernel; cycles are 17%
  under `-O2` in total (were 4% over) and at or under `-O2` on every kernel. The three losses
  of the previous session are now wins: crc32_byte 232 vs 249 cycles, 90 vs 110 bytes;
  popcount 3948 vs 4176 cycles, 76 vs 88 bytes; mix6_call 78 vs 102 cycles, 126 vs 158 bytes.
  The six leaf kernels are unchanged (no calls or loops). Losses and caveats: fnv4 grew 26
  bytes (148 -> 174, four inlined multiplies each marshalling into r18-r25; still 104 under
  `-Os`) for 40 fewer cycles; the budgets were chosen with these kernels in view, so the
  kernel set is also the tuning set; the earlier caveat stands (avr-gcc 9.5 keeps 32-bit
  values in a stack frame in some small functions even at `-Os`); the "unoptimized" emission
  also inlines (inlining is a code generation choice, the IR optimizer is not rerun on the
  inlined body, so no cross-call constant folding or CSE happens yet).
- **Verification**: `native_avr` 4297/4297 at both levels in the gate. The generated corpora
  exercise no inlining (their callees and bodies exceed the budgets; checked: 0 of 432
  functions over 10 seeds change), so they were rerun only for regressions (seeds 1-70, both
  levels, all passed) and a scratch fuzzer was written for the new paths: random small
  helpers, fold/loop bodies and predicates (bit tests, selects, compares, mul/div/rem,
  literal and masked variable counts, extras) under entries that call and loop over them,
  12 entries x 8 inputs per seed, both levels, run under simavr against the interpreter;
  3014 of 3564 entries (85%) inline a call or a loop body. Seeds 1-300: 28,800 cases, all passed. The unit sequence test adds an inlined
  fold updating its state in place, a one-byte counter with `inc`/`cpi`/`brlo` and no first
  test, and a small callee spliced while a larger twice-called one stays a call; the simavr
  test adds a function with an inlined bit-test body, a compare predicate fused into the
  branch, a masked variable-count fold with an extra, and inlined calls. The harnesses are
  scratch scripts, not in the repository.
- Gate (this worktree): lint pass; typecheck pass; test 70/70; verify all paths passed
  (interpreter, optimizer, JS, C clang, C gcc, C++ clang, C parallel, Wasm, Wasm direct, JVM
  5262 each; arm64, x86_64, riscv64, avr, arm32 4297 each).
- Not done: rerunning the IR optimizer after inlining; inlining loops nested in inlined
  bodies or with aggregate state; X/Z homes (above); live-range splitting.

## Session 2026-09-30 (self-hosted checker: function cap)

- src/core.ts `LIMITS.maxFunctions` is now 65536; the A0 checker (`checkir` in
  compiler/check.a0) compared the function count with the old 1024 and tools/ref-check.ts
  `MAX_FUNCTIONS` was 1024. Both now use 65536, so the `limit` (code 4) diagnostic fires exactly
  when `validate` would. No table changes were needed: the fns table already holds 820 functions,
  and a 16384-byte source holds at most 713 (the shortest function, `fn a -> u32` / `ret 0` /
  `end`, is 22 bytes with a one-letter name and 23 with two letters), so the diagnostic cannot fire
  within the front end's source limit. The parser has no function cap beyond its tables.
  compiler/front512.a0 (512-byte sources, at most ~23 functions) still has 1024 and cannot reach it.
- New case `fns713` (tools/app.ts `manyFunctions`): 713 one-line functions filling 16373 bytes,
  used in the parse and check rows on every target. test/core.test.ts checks that `validate`
  accepts it, `checkio` reports ok, and the output equals `refCheckWords`.
- Gate: lint, typecheck, test 59/59, app (every row that passed before still passes; wasm is
  still blocked on the front-end size wall, as before), selfhost 50 passed / 3 skipped, selfhost:c
  6371/6371.

## Session 2026-09-30 (A0 C emitter: in-place updates)

- `compiler/emit_c.a0` now applies the TypeScript C emitter's in-place rule (src/backends.ts `mutableHere`), written in A0 in the same style (no control flow, folds, tables). Per function, `cusn`/`cusa` build use statistics in one pass over the operands (word v for node v, 2048 + v for parameter v: 2^16 x uses other than a get/at operand 0, plus last user + 1). Per variant, `crt` computes a root per node: a `set`/`put` (target operand 0) or a `fold`/`loop` with array or record state (target the initial state) whose target is fresh (arr text rec set put) or an owned parameter (every parameter, except p0 of the ref variant), is not returned, and has no other use but earlier get/at of it, updates it in place and aliases the target's root; otherwise the node is its own storage `n<j>`. `cres` resolves every emitted operand to its storage (p0 of the owned/ref variant is `(*p0)`); an aliasing node declares no local and no `(void)`.
- Variants as in the TypeScript emitter: every function with p0 an array or record, p1 u32 and result p0's type also gets `static inline void a0o_f(T *p0, ...)` (the state updated through the pointer; `*p0 = x;` only when the result is not p0's storage), and with result bool `static inline bool a0r_f(const T *p0, ...)`. A fold/loop over aggregate state runs `a0o_F(&S, a0i, ...)` (guard `a0r_P(&S, ...)`), where S is the initial value's own storage when it is dead afterwards, else one copy. The `view` variant (aggregate extras by const pointer for scalar-state folds) is not implemented.
- Measured (`bun run selfhost:c` path, clang -O2 no sanitizer, 200 repetitions of every case, CPU time user+sys, median of 7 alternating runs; machine load average 100-240 from other sessions, so wall times are not usable): corpus C 116,771 -> 114,442 bytes, run 1380 -> 1380 ms (its arrays are small; the time is the driver's input parsing); examples/life.a0 C 10,335 -> 10,896 bytes (owned `a0o_cell` added, `step` no longer copies the 32-word grid per cell), run 1130 -> 890 ms (-21%). Output identical. Emission in the reference interpreter is slower: corpus 54 -> 187-222 s, life 3.6 -> 19-28 s (same load), because every use-statistics and root step validates the 8192-word args table (Node's `run` checks every argument).
- Stage-1 bootstrap speed: tools/bootstrap.ts is not in this base, not measured.
- Gate (this worktree): lint pass; typecheck pass; app exit 0 (C emitter rows: interpreter, optimizer, JavaScript, native C, wasm32, JVM all 15/15); test 59/59; selfhost 50 programs passed, 3 skipped, 6898 cases; selfhost:c 6371/6371 (corpus 5262, kernels 763, life 346; -Werror, UBSan).

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
