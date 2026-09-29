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
cells: A0/TypeScript/Rust × conventional/structured). Whole-task accounting: setup, view,
output, provider usage, calls, validation failures, repairs, wall time. Thirteen held-out
tasks (targeted, multi-node, multi-function, comprehension, iteration, records, bit ops,
saturation) with independent acceptance tests (Rust acceptance compiles with rustc -O).

**Live model runs (claude-opus-5-5 via SDK): unrun**, they need `A0_ALLOW_PAID_MODEL_CALLS=1`
and Anthropic credentials, which the user declined to provision.

**Scripted run, 2026-09-29, subject: Claude Fable 5.1 in-session.** The harness has a
replies mode (`A0_EXPERIMENT_REPLIES`, `A0_EXPERIMENT_DUMP`, `A0_EXPERIMENT_SUBJECT`): all
78 cell prompts were dumped, answered once each from the prompt alone, and fed back as
model replies. Caveats, so this is evidence about the harness and the protocols, not an
unbiased model measurement: (1) the subject authored the tasks and reference solutions
(contamination); (2) tokens are local o200k counts, not provider usage; (3) one trial per
cell; (4) no reasoning-token accounting. Result file: `results/ai-edit-experiment.json`.

| cell | accepted | model calls | setup tokens | view tokens (13 tasks) | output tokens (13 tasks) |
|---|---|---|---|---|---|
| A0 conventional | 13/13 | 13 | 627 | 447 | 612 |
| A0 structured | 13/13 | 13 | 750 | 622 | 341 |
| TypeScript conventional | 13/13 | 13 | 48 | 432 | 579 |
| TypeScript structured | 13/13 | 13 | 127 | 520 | 397 |
| Rust conventional | 13/13 | 13 | 63 | 463 | 596 |
| Rust structured | 13/13 | 13 | 142 | 551 | 381 |

Whole-task token buckets (o200k, summed over 13 tasks, primers charged once per call;
harness now records these separately plus a per-attempt failure status of
protocol / compile / missing / runtime / wrong-output / no-reply and one-shot vs
after-repair acceptance):

| cell | language primer | workflow primer | tool context | output | total |
|---|---|---|---|---|---|
| A0 conventional | 7930 | 221 | 824 | 612 | 9587 |
| A0 structured | 7930 | 1820 | 999 | 341 | 11090 |
| TypeScript conventional | 403 | 221 | 809 | 579 | 2012 |
| TypeScript structured | 403 | 1248 | 897 | 397 | 2945 |
| Rust conventional | 598 | 221 | 840 | 596 | 2255 |
| Rust structured | 598 | 1248 | 928 | 381 | 3155 |

Wins / ties / losses for A0 on this run: acceptance is a six-way tie (every cell 13/13
one-shot, zero repairs). Output tokens: A0 structured wins (341 vs 397 TypeScript, 381
Rust, −14 % / −10 %); A0 conventional loses (612 vs 579 / 596). **Whole-task cost: A0
loses by 4.8× (conventional) and 3.8× (structured) against TypeScript**, because the
language primer (MODEL_GUIDE.txt, 610 tokens per call) is charged on every call while a
TypeScript or Rust model needs only a 31–46 token semantics note. At 13 small tasks the
primer is 72–83 % of A0's whole-task spend. The 200–400× ambition is contradicted by
these numbers; the only measured A0 advantage is the 10–14 % output reduction on
structured edits. Levers, in order of measured size: (1) primer amortisation through
prompt caching (provider cache-read pricing, not available in local counts), (2) a
shorter primer or a primer the model already knows, (3) the output reduction.

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
5. **Measured.** Yosys `synth -noabc; ltp -noff` over the 48 corpus modules: depth is
   bimodal. Every module without a surviving `div`/`rem` has longest path ≤ 56 gates
   (median 22.5 among combinational modules); every module with one is ≥ 347, up to
   1751 (two dependent divides ≈ 1100, three ≈ 1750), because Yosys lowers `/` and `%`
   to a single-cycle restoring 32-bit divider (~500–600 gates deep each). Multipliers
   are cheap in depth (two 32-bit `mul`, no div: depth 47). ABC re-test with a 60 s
   timeout: modules with only multipliers finish in ~18 s; the module with 2 mul + 3
   div/rem is killed at 60 s. The earlier note blaming multipliers for the ABC stall was
   wrong and has been corrected in `tools/hw-verify.ts`. Measured need for scheduling is
   therefore narrow: not a general operator scheduler, but multi-cycle `div`/`rem`
   (iterative divider behind the existing sequential handshake). 20 of 48 modules would
   change; 28 would not benefit. Not implemented yet.
6. **Not started.** Bounded solver equivalence for pure functions.

## Reference

- Domain a0lang.com is registered on the user's Vercel account (2026-09-29) for the future
  landing/docs site; it is the Gate 5 application target.

## Repository

Private GitHub repo `Joe-Simo/a0` (verified `isPrivate: true`), branch `main`, project
at repo root, `bun.lock` committed, `dist/` and `node_modules/` ignored. Commits are
listed by `git log`; the push is verified against `origin/main` after each commit.

## Blockers / not done

- GitHub Actions CI (`.github/workflows/ci.yml`: lint, typecheck, tests, corpus, hardware,
  .NET, Life on Ubuntu) is committed but the first run did not start: GitHub reports
  "recent account payments have failed or your spending limit needs to be increased" on
  the Joe-Simo account. This is an account-billing setting only the owner can change; no
  minutes were spent. Until then, regressions are gated by the local suite recorded above.

- `A0-Research-Starter.zip` absent (see Provenance).
- Paid model runs not authorized; Gate A live runs unrun (scripted in-session run recorded above).
- No Claude-tokenizer counts (needs `count_tokens` with credentials; free but blocked).
- Not implemented: loops/regions, memory/arrays, effects, .NET, GPU, mobile packaging,
  library import/FFI, persistent artifact cache, network edit service, fuzzing.

## Next concrete action

1. All eight gates have reproduced evidence except Gate 6's live model runs, which stay
   **unrun** until spend is explicitly authorized (harness, tasks, and self-check are
   complete); MLIR/LLVM is recorded as not justified by measurement. Next engineering
   targets, in order: (a) done: aliasing-safe in-place updates and typed arrays in JS
   (residual ≈1.3–1.6× on the array kernel is allocation of the initial array plus the
   body call; next step would be inlining owned bodies); (b) done: wrapper indirection is
   within noise; (c) run Gate 6 when authorized and add the whole-task numbers here;
   (d) done: text literals, div/rem, puts, and the UI protocol; the page is authored in
   A0. Next: deploy to a0lang.com only with explicit approval; richer UI protocol
   (inputs, lists) as the site needs them; Gate 6 live runs when authorized.
2. Gate 5 target decided: the a0lang.com site (domain owned by the user on Vercel) is the
   cross-target application, authored in A0 with a browser DOM adapter; no deployment
   without explicit approval in that session.
2. Expand the Gate A task set (≥10 held-out tasks incl. multi-function edits) and run it
   when authorized; report per-cell accepted-change cost with uncertainty.
