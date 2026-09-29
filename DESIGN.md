# A0 — AI-native universal language research

Version 0.8.0 · September 29, 2026 · Working codename, not a cleared brand

## 1. Product definition

A0 is intended to let an AI change precisely defined behavior with as little model work as possible while compilers produce implementations specialized for their destinations. The human's primary interface is intent, constraints, examples, visual review, and acceptance—not obligatory source-code reading. A source view remains available for auditing and debugging.

The research ambition is universal superiority: AI read/write cost and latency, caching, builds, execution, memory, energy, and platform coverage. No available prototype or benchmark establishes that ambition. Every loss is a retained research case; ties and unmeasured dimensions remain visible. No arithmetic average is allowed to hide a catastrophic regression or missing capability.

The product is **not** English interpreted at runtime, a universal virtual machine forced onto every target, obfuscated existing source, or an AI call masquerading as every build step. Human-facing interface quality and native platform behavior must not be weakened to make compilation convenient.

## 2. Fundamental design decision

Separate these representations:

1. **AI view:** compact, task-relevant operations, meaningful contracts, short scoped references, and edits.
2. **Semantic program:** typed operations, dependencies, effects, ownership, versioned interfaces, platform requirements, and separately retrievable intent metadata.
3. **Execution implementation:** target-specific layouts, instructions, libraries, schedules, and generated artifacts.

These are three views/layers of one defined computation—not three programs the model must keep rewriting. Binary storage does not imply that an LLM should emit textual binary or Base64. Compression outside a context window is not inherently model-token compression. More words can be cheaper overall when they prevent costly mistakes.

MLIR is a useful eventual foundation: its language reference explicitly distinguishes textual, in-memory, and compact serialized forms, and it supports extensible operations at several abstraction levels. A0 v0.1 uses a small independent TypeScript representation to make the first experiment executable; it does **not** already integrate MLIR. [S1, S2]

## 3. Architecture to grow into

```text
Human goal / constraints / examples / product review
                          |
                AI agent + relevant views
                          |
              revision-bound structured edits
                          |
          validated, versioned semantic program
                          |
        reusable transformations and target selection
                          |
     +-----------+-----------+-----------+-----------+
     |           |           |           |           |
 Browser/Node  Native ABI   Managed VM    GPU      Hardware
 JS + Wasm    LLVM/native   JVM/.NET    kernels   RTL/netlist
```

The target architecture is extensible, not a closed list of today's processors. A new backend must declare its supported operations, interface contracts, capability requirements, semantic restrictions, and validation evidence.

A target's operating system, runtime, external devices, and SDK remain real dependencies. A compiler cannot silently replace a missing capability with a no-op or weaker behavior. When a requirement has no valid implementation on the selected destination, the compiler must report it precisely. Universal authoring does not mean every physical platform has identical I/O, resource limits, permissions, or timing.

## 4. v0.1: implemented language

The current core is intentionally small enough to test end to end. It is not yet a general-purpose or Turing-complete language.

```text
fn affine u32 u32 u32 -> u32
a mul p0 p1
b add a p2
ret b
end
```

The function computes `(p0 * p1 + p2) modulo 2^32`. Here the interface meaning is x, scale, offset. Positional references minimize repeated names in the experiment. Production interfaces must retain names, units, constraints, and intent where useful; v0.1 has no separate intent store and discards source comments during parsing.

### Grammar

```text
program     = function+
function    = "fn" name type* "->" type NEWLINE
              instruction* "ret" operand NEWLINE "end"
instruction = id operation operand{operation_arity} NEWLINE
            | id "call" function_name operand* NEWLINE
            | id "fold" function_name count init operand* NEWLINE
            | id "loop" predicate_name function_name count init operand* NEWLINE
operand     = earlier_id | parameter | u32_literal | "true" | "false"
parameter   = "p" decimal_index
type        = "u32" | "bool" | "io" | type "x" length | "(" type ("," type)* ")"
```

Each function has one result. Node identifiers are lowercase letters followed by lowercase letters, digits, or underscores, at most 64 characters. `p<number>`, `fn`, `ret`, `end`, `patch`, `true`, and `false` are reserved node identifiers. Node IDs are unique within a function; function names are unique within a program. Parameters are indexed from zero. `call` may only name a function defined earlier in the same program, so the call graph is acyclic; recursion, loops, heap, strings, arrays, and I/O are not accepted. Unsupported constructs are errors.

### Exact operations

| Operation | Inputs | Output | Meaning |
|---|---|---|---|
| `mov` | T | T | Identity |
| `add`, `sub`, `mul` | u32, u32 | u32 | Arithmetic modulo 2^32 |
| `and`, `or`, `xor` | u32, u32 | u32 | Bitwise operation |
| `shl`, `shr` | u32, u32 | u32 | Shift by low five bits of distance; right shift is logical |
| `eq`, `lt` | u32, u32 | bool | Equality / unsigned less-than |
| `select` | bool, T, T | T | Select between already defined, same-typed values |
| `call f` | f's parameter types | f's result type | Apply an earlier-defined function; pure, total, no recursion (v0.1.1) |
| `fold f` | u32 count, T init, extra… | T | Bounded iteration: `state = f(state, i, extra…)` for `i` in `0..count-1`; `f : (T, u32, extra…) -> T` defined earlier (v0.1.2). Software backends emit a counted loop; the combinational SystemVerilog backend unrolls literal counts up to 256 and rejects variable counts with a diagnostic (sequential state is future work). |
| `loop p f` | u32 cap, T init, extra… | T | `fold` with early exit: stops before iteration `i` when `p(state, i, extra…)` is false; `p` has `f`'s parameters and returns bool (v0.1.3). Hardware unrolls literal caps with a done-latch chain. |
| `arr`, `rec` | T×N / T0…Tk | TxN / (T0,…,Tk) | Build an array or positional record from values (v0.2.0) |
| `get`, `set` | TxN, u32 [, T] | T / TxN | Element read / copy-with-element; the index is reduced modulo N, so both are total (v0.2.0) |
| `at`, `put` | (…), literal u32 [, Tk] | Tk / (…) | Field read / copy-with-field with a literal field index (v0.2.0) |
| `div`, `rem` | u32, u32 | u32 | Unsigned quotient / remainder; a zero divisor yields all ones / the dividend (total, as on RISC-V) (v0.8.0) |
| `text "…"` | — | u32xN | Source sugar for `arr` of the UTF-8 bytes (escapes `\n \t \" \\`); the source form is kept for views and edits (v0.8.0) |
| `puts` | io, u32xN | io | Consume the token, emit the length word then every element (v0.8.0) |
| `read` | io | (u32,io) | Consume the token, yield the next input word (0 when exhausted) and the next token (v0.3.0) |
| `write` | io, u32 | io | Consume the token, emit one word, yield the next token (v0.3.0) |

Effects: `io` is a linear capability token. Each token value is consumed at most once, a function takes at most one `io` parameter, arrays cannot hold tokens, and `select` cannot choose between them; the token data dependencies therefore form one chain per function, which is the effect order. Effectful nodes (`read`, `write`, and calls/iterations that carry a token) are anchored in the optimizer: never folded, merged, reordered, or removed. Software backends thread a mutable stream state (JS object, C `a0_io*` with fixed 256/1024-word capacity, Java `A0Io`); in hardware, functions that iterate with a variable count, perform io, or call such functions are emitted as clocked modules (v0.4.0): `clk`/`rst`/`start`/`done` plus `in_data`/`in_valid`/`in_ready` and `out_data`/`out_valid`/`out_ready` word handshakes; each effectful or iterating node is a stage of a linear FSM whose results are registers, iteration bodies are instantiated once and stepped per clock, and sequential callees run through nested start/done handshakes. Pure functions stay combinational. Two tiers exist for platform integration: portable capability operations (`read`, `write`, `puts`) and platform-specific adapters that interpret word protocols, such as the browser UI protocol used by the a0lang.com page (`site/page.a0` + `site/app.ts`); adapters are runtimes, not compiler guesswork. Aggregates have value semantics: no operation mutates or aliases; `set`/`put` return copies. Backends: JS arrays with copy-on-write, C structs by value, Java arrays/records with clone-on-write, SystemVerilog packed bit vectors (element 0 at the LSB) with part-selects. Integer literals are decimal 0 through 4,294,967,295. A Boolean is not implicitly a number. Invalid values, missing references, duplicate definitions, wrong arity, and inconsistent types are rejected. Every current operation is pure and total on valid input. Both `select` inputs are ordinary values; this is not lazy branching with effects.

JavaScript uses exact 32-bit multiplication and explicit unsigned normalization, and validates public inputs. C uses fixed-width unsigned types; multiplication is widened to unsigned 64-bit before truncating, avoiding signed-promotion hazards. Java uses the signed `int` bit pattern with unsigned comparison and appropriately interpreted external results. SystemVerilog maps the two-state meaning into explicit logic widths, but simulation/synthesis has not been performed.

## 5. Reading and editing protocol

The AI should request a relevant view, not receive the entire workspace by default. A future view service must preserve contracts, public names, dependencies, security constraints, and relevant intent. Important context must not be removed merely to shorten the prompt.

The initial implementation provides two edit paths.

**Self-contained patch:** function name, full SHA-256 content revision, replacement nodes, and an end marker. This can be transported independently but is inefficient for very small edits.

**Session-bound edit:** a local session retains the full revision and returns a short handle with the viewed function. The AI replies:

```text
e0
b sub a p2
```

The handle binds the edit to one exact viewed function. Existing node `b` changes; unchanged nodes are not emitted. The compiler checks the complete replacement and commits atomically. Unknown or consumed handles, mismatched content, invalid types, duplicate replacements, and forward references fail. Other function objects remain unchanged. There is a bounded session size and explicit handle closing; successful handles are one-use.

The handle is not a secret or an authorization credential. A future network service must isolate sessions by authenticated principal and apply normal access controls. No network service exists in v0.1.

**Observed lesson:** the full-revision envelope can be larger than the complete tiny function. The session reduces the model payload but does not erase the input used to open the view, language instructions, tool envelopes, or session-management work. Existing-language editors must receive the same protocol advantage in a fair experiment.

Edits replace, insert (at the end or after a named node), delete, and change the result within one function, validated as a whole and committed atomically (v0.8.1). Views can be dependency-scoped: the function plus one signature line per direct callee. Program-level handles add, replace, or remove whole functions atomically (v0.8.2). Region edits, migrations, and cross-function transactions with partial views remain future work. Current revisions are content hashes; they do not encode a global chronological transaction number.

## 6. Compiler policy

Ordinary compilation is deterministic and makes no model calls. The compiler does not guess what an operation means. v0.1 has exact constant propagation, safe algebraic identities, common-subexpression elimination, and dead-code removal. Optimizations change a derived graph, not the editable source.

A persistent on-disk cache (v0.8.4) stores per-function emissions keyed by compiler version, target, optimization level, and semantic revision, and native/wasm artifacts keyed by toolchain identity, flags, and exact module text; unchanged programs skip emission and native builds, and a callee change invalidates its callers. A bounded in-memory cache also retains function-emission results. Keys include the function's *semantic revision* (its content revision folded with the semantic revisions of every transitive callee), target, optimization setting, and prototype compiler version, so editing a callee invalidates its callers. It reuses unchanged emitted functions, but still validates/hashes the program and assembles module text. It is **not** a persistent native artifact cache or a complete incremental compiler.

Future artifact-cache keys must include all semantic dependencies, compiler/backend versions, target ABI/features, layout/precision settings, SDK/runtime versions, flags, and any profiles affecting output. Dependency changes cannot be hidden behind a convenient cache hit. Shared caches must be isolated or integrity-checked appropriately.

The mature compiler should retain several valid implementations when their tradeoffs differ. A declared target profile specifies latency, throughput, memory, energy, code size, or hardware area constraints. A single scalar score must not silently discard a requirement. Standard builds use established rules; additional optimization search has explicit budgets. This avoids paying an AI to rediscover an implementation at every build.

AI-assisted discovery is a separate future workflow: propose a transformation, validate it within a precisely scoped domain, test and measure it, then retain it if justified. Alive2 illustrates LLVM transformation verification, but has documented coverage limitations; it is not a universal proof oracle. [S5]

## 7. Universal platform plan

| Family | Intended implementation strategy | v0.1 status |
|---|---|---|
| Browser / Node | ES modules, Wasm, typed host adapters | ES modules run in Node; Wasm compiled and run in Node and in a browser page through the io-stream adapter (`site/`). No general DOM/browser API bindings yet. |
| Native server / desktop / mobile / embedded | MLIR/LLVM/native artifacts and platform ABIs | C-compatible output compiled and run on Linux. No phone deployment or platform SDK adapters. |
| C++ ecosystems | Typed ABI boundary or explicit bindings | Generated C-compatible kernels compile as C++; existing C++ source is not imported. |
| JVM | Defined managed-runtime representation and bindings | Generated Java compiled and executed on a JVM. No Android packaging or Java library importer. |
| .NET | Managed backend and runtime bindings | C# emitted (native `uint`, records, clone-on-write arrays, io runtime); built and executed on .NET 10 against the oracle incl. io streams. No .NET library bindings. |
| GPU | Domain operations, memory spaces, schedules, GPU backends | Metal Shading Language emitted via a typed layer over the C output; elementwise kernels executed on Apple M3 against the oracle. No memory-space, scheduling, or performance model yet. |
| FPGA / ASIC | Bit-accurate graph, state/scheduling, RTL, synthesis/physical tools | Combinational and clocked SystemVerilog emitted; simulated with Icarus against the oracle (incl. io streams) and synthesized generically with Yosys; no FPGA/ASIC place-and-route, timing, area, or power. |

Hardware compilation requires attention to cycle boundaries, finite resources, throughput, latency, timing, and physical implementation. XLS demonstrates software-style descriptions that can target host software and hardware, and its flow includes hardware synthesis and physical measurement. Generating RTL alone is not equivalent to delivering a working chip. [S3]

Integration is part of the language product. Node packages, browser APIs, native SDKs, managed libraries, database drivers, and device interfaces need exact bindings, compatible ownership, error handling, and capability contracts. Generating the destination language alone does not supply these. WIT provides a useful existing interface-description precedent; it defines component interfaces, not implementation behavior. [S4]

## 8. Planned semantic extensions

The initial core must grow without silently changing existing meanings.

- **General computation:** calls (v0.1.1), bounded `fold` (v0.1.2), capped early-exit `loop` (v0.1.3), value-semantics arrays/records (v0.2.0), and linear io effects (v0.3.0), and clocked hardware modules for iteration and io (v0.4.0) are implemented; next are platform adapters (browser DOM) and general structured regions, and sequential hardware state, bounded iteration first, then broader recursion/control flow for suitable software profiles.
- **Data and memory:** fixed/arbitrary-width integers, strict floating-point profiles, buffers/records/arrays, explicit layout where needed, ownership/borrowing or region inference, managed adapters where appropriate. No universal boxing requirement.
- **Effects and concurrency:** typed capabilities for files/network/clock/device access, structured tasks, declared synchronization and memory-order semantics. External nondeterminism is explicit; reproducibility is not assumed across arbitrary concurrent schedules.
- **Domain operations:** high-level collection, query, numeric, graphics, UI, and hardware operations with defined semantics and optional certified lowerings. Preserve high-level information until the backend can use it.

No implicit numerical weakening. Approximate arithmetic or relaxed floating-point transformations require explicit permission and separate acceptance criteria. Side-effecting operations cannot inherit the pure core's reorder/remove rules.

The AI view can use inferred types and compact argument positions, while richer interfaces remain retrievable. Tokenizer-specific spelling, aliases, and dedicated model tokens are experiments, not predetermined winners. Existing encodings and future model vocabularies must be measured; a byte is not a model token. [S6]

## 9. Security and correctness boundaries

Execution is resource-bounded: the reference interpreter runs on a fuel budget, compile-time evaluation is fuel-bounded, and the validator rejects literal nested iteration above 2^24 while reporting a static iteration bound for variable counts. No API keys are embedded; no hosted model is required. Source cannot inject destination identifiers because identifiers and operations are validated and generated names are prefixed. Toolchain invocation uses argument arrays and a temporary directory, not generated shell commands. Input source and patch sizes and session/cache capacity are bounded.

These are initial controls, not a security audit. Production needs resource budgets, hostile-input fuzzing, process isolation for toolchains, dependency provenance, supply-chain locking, authenticated session isolation, and rigorously specified FFI boundaries. The program's type checker does not prove that human intent is satisfied. Differential tests are not a formal verification of the compiler.

## 10. Actual evidence from this package

See `results/verification.json`, `results/benchmark.json`, and test logs for machine-readable evidence, dates, seeds, environment, and caveats.

The cross-target corpus consists of 48 seeded, generated straight-line functions with arithmetic/bitwise/selection operations. Each receives boundary and seeded random values. Expected results come from an independent BigInt oracle, not the backend's arithmetic helper. The interpreter and optimized structure are checked against it before generated executables are checked.

JavaScript, native C under Clang, native C under GCC, the generated C-compatible source compiled as C++ under Clang, Clang-produced Wasm, and JVM bytecode were actually executed. Each path passed 7,344 cases. Native test executables enabled undefined-behavior sanitizers. SystemVerilog was emitted but not simulated, synthesized, or physically evaluated.

In-process parse, emission, cached emission, and edit-validation timings are local prototype measurements. They exclude model work and native compilation/linking, and are not superiority evidence against established languages or compilers.

The byte-only affine edit fixture measured 62 bytes for the whole function, 93 bytes for a self-contained full-revision patch, and 14 bytes for the session-bound replacement. Opening its view used 65 bytes. These are not token counts or total task costs.

Type checking and focused tests passed. Biome lint was attempted but blocked by the absent package and unavailable registry access. The optional tokenizer probe was attempted but could not run without its package. These checks are not recorded as successes. No trained AI, paid model API, hidden reasoning cost, real application benchmark, GPU run, mobile deployment, or hardware physical metric was measured.

## 11. Experiments that decide whether this deserves to grow

### Gate A — distinguish language benefit from tool benefit

Use a controlled 2×2 experiment: existing language versus A0, and conventional edits versus equivalent structured/session edits. Hold the model, task, context budget, acceptance tests, available tools, and target semantics constant. Give each representation its best fair implementation—not an artificially verbose baseline.

Count grammar/interface setup, uncached input, cache writes/reads, output, observable reasoning, view retrieval, validation, repair attempts, number of calls, wall time, and dollars per accepted change. Unknown or unobservable reasoning use is missing data, not zero. Include cold and repeated-task conditions. Explicitly version model/tokenizer/tool configurations.

The optional token script is only a preliminary representation probe on small fixtures. It is not Gate A. Do not choose the syntax based on character count or this one arithmetic function.

### Gate B — execution quality without hidden costs

Compare against strong native baselines on identical targets with identical observable behavior, safety, precision, and interfaces. Measure runtime, memory, energy where available, code size, fresh/incremental builds, startup, and warm/cold effects. Collect repeated samples and uncertainty, and retain every loss. Include adversarial small programs, no-op computations, library-heavy tasks, and cases where boundary costs dominate.

### Gate C — prove broad usefulness

Add calls, state, arrays, and capabilities, then a substantive program with a browser interface, a native interface, and a reusable computational component. Preserve the intended design and accessibility instead of making a generic least-common-denominator UI. Separately grow GPU and sequential hardware coverage with their own toolchains and correctness gates.

### Gate D — specialize only when evidence supports it

Integrate production compiler infrastructure and mature target backends. Investigate a custom tokenizer or graph-action model only after a measured advantage justifies training/deployment cost. Train on validated programs and accepted edits; evaluate held-out tasks. New operations need specified meanings and implementations, not learned ambiguity.

Universal superiority is assessed with a coverage/regression ledger. Finite measurements support scoped results; they do not justify an all-programs theorem. Expanding the ledger and removing verified losses is the engineering work.

## 12. Immediate next implementation decision

Do not add ten speculative backends or freeze the syntax yet. Complete the real-tokenizer and controlled AI edit experiment, run the blocked linter, and add structured control flow/calls with exact semantics. In parallel, validate the emitted hardware using a real simulator and synthesis tool. These are acceptance gates, not calendar estimates or promises of background work.

## Primary sources consulted

[S1] MLIR Language Reference — https://mlir.llvm.org/docs/LangRef/

[S2] MLIR Bytecode Format — https://mlir.llvm.org/docs/BytecodeFormat/

[S3] Google XLS — https://google.github.io/xls/

[S4] WebAssembly Component Model, WIT Reference — https://component-model.bytecodealliance.org/design/wit.html

[S5] Alive2 — https://github.com/AliveToolkit/alive2

[S6] OpenAI tiktoken — https://github.com/openai/tiktoken

These projects are precedents and possible integration points. Their existence is not evidence that A0 is novel, universally superior, or already uses their implementation.
