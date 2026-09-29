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

## Implemented scope (v0.6.0)

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
  the in-app browser: a glider advances by (1,1) after four generations. The page shell
  is HTML/TS because A0 has no strings or DOM capability yet; that is the remaining gap
  for "the whole site in A0". Not deployed.
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
| Focused tests | `bun run test` | 17/17 pass (incl. fuel, static cap, 3000-mutation fuzz) |
| Life acceptance (134 cases, independent reference) | `bun run app` | pass on interpreter, optimizer, JS, C, C++, Wasm, JVM |
| Life in the browser (Wasm + DOM adapter) | `bun run site`, in-app browser | glider moves (1,1) in 4 steps, population 5 |
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

| Kernel | C emitted vs hand-written | JS emitted vs hand-written |
|---|---|---|
| affine, rotl, clamp, mix (scalar) | tie | tie |
| ident (tiny call) | tie (1.61 vs 1.62 ns) | tie |
| noop (add 0, mul 1, xor 0; optimizer must remove) | tie | tie |
| chain3 (three nested tiny calls) | tie | tie |
| branchy (select chains) | tie | tie |
| arrfill (8 value-semantics `set`s then reads) | tie (struct copies elided) | **loss** 2.6× (802 vs 309 ns): copy-on-write arrays |
| loop64 (64 dependent body calls) | tie (82 vs 89 ns) | tie after boundary-only guards (was 4× loss) |
| startup (spawn + one iteration) | 2.2–2.5 ms both sides | n/a |
| binary size | 33.6 kB both sides (runtime dominated) | n/a |

Verdict band: 8 % or observed sample spread, capped at 25 %. Level: micro-kernels; not
energy, memory at scale, or applications. The JS array loss is a real cost of value
semantics without escape analysis and stays on the ledger.

### Cost target stated by the user (2026-09-29): 200–400× cheaper and faster for AI

Measured baseline: whole-function payloads ≈1× hand-written C (30 vs 29 tokens), session
edits ≈2× smaller than the best conventional edit, A0 setup ≈877 tokens of overhead.
Syntax cannot reach the target; the candidate mechanisms are structural and unmeasured:
(1) a library of verified named operations so a model writes one line instead of an
implementation, (2) dependency-scoped views so it reads only what an edit touches,
(3) delta-only edits, (4) validation that removes retries. Gate 6 measures whole-task
cost; the target is recorded as an ambition, not a result.

### Gate A / Gate 6: 2×2 AI-edit experiment (`bun run experiment`)

Harness implemented and self-checked (reference solutions pass, originals fail, in all
four cells: A0/TS × conventional/structured). Whole-task accounting: setup, view, output,
provider usage, calls, validation failures, repairs, wall time; reasoning tokens recorded
as null. **Status: unrun.** Requires `A0_ALLOW_PAID_MODEL_CALLS=1` plus Anthropic
credentials (none configured on this machine); default model `claude-opus-5-5`, 3 trials
per cell. Twelve held-out tasks (targeted, multi-node, multi-function, comprehension,
iteration, records) with independent acceptance tests; the self-check passes (references
accepted, originals rejected in all four cells). Measured setup cost per cell (o200k):
A0 conventional 877 tokens (MODEL_GUIDE.txt), TypeScript 48; view sizes 24–45.

## Reference

- Domain a0lang.com is registered on the user's Vercel account (2026-09-29) for the future
  landing/docs site; it is the Gate 5 application target.

## Repository

Private GitHub repo `Joe-Simo/a0` (verified `isPrivate: true`), branch `main`, project
at repo root, `bun.lock` committed, `dist/` and `node_modules/` ignored. Commits are
listed by `git log`; the push is verified against `origin/main` after each commit.

## Blockers / not done

- `A0-Research-Starter.zip` absent (see Provenance).
- Paid model runs not authorized; Gate A unrun.
- No Claude-tokenizer counts (needs `count_tokens` with credentials; free but blocked).
- Not implemented: loops/regions, memory/arrays, effects, .NET, GPU, mobile packaging,
  library import/FFI, persistent artifact cache, network edit service, fuzzing.

## Next concrete action

1. Gates 1–5 done; Gate 6 harness complete with 12 tasks but **unrun** (needs explicit
   spend authorization and credentials); Gate 7 ledger populated. Next: Gate 8 only when a
   measured requirement justifies MLIR/LLVM, GPU, or .NET; until then, the measured JS
   array loss (copy-on-write) is the next concrete engineering target: in-place update when
   the source value is provably dead (single use), keeping value semantics.
2. Gate 5 target decided: the a0lang.com site (domain owned by the user on Vercel) is the
   cross-target application, authored in A0 with a browser DOM adapter; no deployment
   without explicit approval in that session.
2. Expand the Gate A task set (≥10 held-out tasks incl. multi-function edits) and run it
   when authorized; report per-cell accepted-change cost with uncertainty.
