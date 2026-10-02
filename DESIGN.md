# A0 — AI-native universal language research

Version 0.8.0 · September 29, 2026

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

The function computes `(p0 * p1 + p2) modulo 2^32`. Here the interface meaning is x, scale, offset. Positional references minimize repeated names in the experiment. Production interfaces must retain names, units, constraints, and intent where useful; v0.1 has no separate intent store. Source `#` comments are kept on the line they belong to (leading whole-line comments and the trailing comment of each `use`, `fn`, instruction, `ret`, and `end` line; comments after the last `end` travel with the last function) so `a0 lsp` formatting, `a0 patch`, and MCP saves print them back in place (`formatSource`); they carry no meaning, so the canonical form (`formatFunction`/`formatProgram`), every revision and hash, views, and emitted code exclude them, and the self-hosted parser keeps ignoring them. A replaced instruction keeps its comments unless the edit line brings its own.

### Grammar

```text
file        = profile? use* function+
profile     = "profile" "strict" NEWLINE          (first line; absent = canonical)
use         = "use" quoted_relative_path NEWLINE
program     = function+            (a file with its uses linked, dependency order, one namespace)
function    = "fn" name type* "->" type NEWLINE
              specline* instruction* "ret" operand NEWLINE "end"
specline    = "ex" literal* "->" literal NEWLINE        (at most three; opt-in, see below)
            | "pre" operation operand* NEWLINE
            | "post" operation operand* NEWLINE
instruction = id operation operand{operation_arity} NEWLINE
            | id "call" function_name operand* NEWLINE
            | id function_name operand* NEWLINE      (direct call: function_name is not an op)
            | id "fold" function_name count init operand* NEWLINE
            | id "loop" predicate_name function_name count init operand* NEWLINE
operand     = earlier_id | parameter | u32_literal | "true" | "false"
parameter   = "p" decimal_index
type        = "u32" | "bool" | "io" | type "x" length | "(" type ("," type)* ")"
```

Each function has one result. Node identifiers are lowercase letters followed by lowercase letters, digits, or underscores, at most 64 characters. `p<number>`, `fn`, `ret`, `end`, `patch`, `true`, and `false` are reserved node identifiers. Node IDs are unique within a function; function names are unique within a program, including across every file linked by `use` (the linker names both files on a clash and maps diagnostics back to `file:line`). Parameters are indexed from zero. `call` may only name a function defined earlier in the same program, so the call graph is acyclic; recursion, loops, heap, strings, arrays, and I/O are not accepted. Unsupported constructs are errors.

**Decision, nested expressions (2026-09-30):** `r select c (sub p1 p0) (sub p0 p1)` is not accepted. One operation per line with an id is what makes every value addressable by the edit protocol (replace, insert-after, delete by id) and what keeps the diagnostics, the revision hashes, and the hardware stage mapping one-to-one with lines. Measured need: 2 replies out of 312 cells across four collections used parentheses; `ret OP ARGS` covers the common case of one temporary before the result. Revisit only if a collection shows nested forms in more than 5 % of replies. **Measured and refused (2026-09-30, item B):** a prototype behind a parser option desugared one level of parenthesized operands (`ID OP (OP ARGS) ARGS` to fresh nodes `ID_1`… placed before the line, in source and in edits, typing unchanged; 8 tests). Fresh subjects, one shot, sets B and D, A0 conventional and structured, current min primer versus the same primer plus one line documenting the option (+31 o200k tokens per call). Haiku accepted 47/50 with either primer (B conventional 12/12 vs 12/12, B structured 10/12 vs 11/12, D conventional 13/13 vs 12/13, D structured 12/13 vs 12/13); Sonnet 50/50 with either. Parenthesized replies: Haiku 1 of 50 without the line and 2 of 50 with it (one of them then failed type checking), Sonnet 0 of 100. One-task cache-adjusted tokens rose in all eight cells (e.g. Haiku D structured 168 to 176, Sonnet B structured 184 to 192). Acceptance did not improve on either model and cost rose, so the option was removed; results `results/ai-edit-experiment.{b,d}.{haiku,sonnet}-min-itemb-{control,nested}.json`.

**Decision, spec lines (2026-10-01):** a function may carry one-line contracts and executable examples between its `fn` header and its first node: `ex ARGS -> RESULT` (at most three; a literal is a number, `true`, `false`, an array `[1;2;3]` or a record `(1;true)`, a one-field record `(1;)`), `pre OP ARGS` and `post OP ARGS` (one operation over `p0..pN`, and `r`, the result, in `post`; the result is `bool`; a call of a helper function is the way to say more). They are neither comments nor nodes: no id, no handle, stored as `Func.spec`, part of the canonical text and so of `revision()` and `programRevision`. They are opt-in and cost nothing when absent: a function without spec lines has the Func, canonical text, dense text, hashes and emission it had before (`test/golden/spec-free-digests.json` and the emission golden pin it); `semanticRevision`, the key of the optimizer, the cache and the emission, hashes the function without its spec, so no backend, optimizer pass or cache key reads it, and no spec line costs anything at run time (nothing is compiled from them). `validate` checks them after typing, against the reference interpreter: every `ex` runs under a fuel of 10000 node evaluations and its result is compared with the written one (A0715 names the function, the example, the input, the expected and the actual; a fuel stop is A0719), and `pre` and `post` are evaluated on each example (A0716); a malformed line, a literal or operand that does not fit the signature, a `pre` that is not `bool`, or a function that takes or returns io (spec lines are not allowed there) is A0714. A wrong edit is therefore rejected whole, with the example it broke, and removing an `ex` line (`-ex ARGS -> RESULT`) is always allowed. The spelling is the same in the canonical and the dense form (the dense form writes the expression of `pre` and `post` with its own operand spelling: parameters `A`, `B`, ...); a function with spec lines is never joined onto its header line. Parsing is by place: spec lines are the lines of a function body before its first node. `pre` and `post` are spec lines there, so the first node of a function must not be called `pre` or `post` (a dense statement that is called so is written `$pre`); an `ex` line is the one with the arrow `->`, so a node called `ex` is still a node. The edit protocol has `+ex`, `-ex`, `+pre`, `-pre`, `+post`, `-post` (`f:+ex ...` under a program handle), views show the lines (`specs: 'hide'` leaves them out and keeps them through a whole-function replacement; a numbered view always shows and numbers them), and a whole `fn ... end` replacement carries its own spec lines (one without them drops them). The self-hosted front end does not implement the feature and refuses a program that has a spec line with the structure diagnostic 2 at the line's first token (`specstep` in `compiler/parse.a0`, mirrored in `tools/ref-parse.ts`), so it never reads one as a node. **Proof of a contract (2026-10-01):** `a0 check --prove` (never on an edit, in `validate` or in the MCP edit path) asks Z3 whether some input satisfies `pre` and breaks `post`, over the bitvector encoding of the optimizer proof (`src/z3enc.ts`, shared with `tools/equiv-verify.ts`; the solver is loaded only then): `pre` is asserted, the negation of `post` is checked. Scope: pure u32 and bool values, arrays and records of them with arrays up to 16 elements and at most 64 scalar values in the parameters, calls inlined, `fold` and `loop` with a literal count of at most 64 (the optimizer proof's unroll bound), no io. Outside it, over a bound or on a solver timeout (10 s per function, `--prove-timeout=MS`) the contract is unknown: A0718, a note that names the reason. A model is turned into concrete arguments and run on the reference interpreter first: only a failure it confirms is A0717 `contract disproved`, printed with the inputs as a warning (an error, exit 1, with `--deny-disproved`); a model it does not confirm is A0718, never a refutation. Proved prints `contract proved`. Under `profile strict` a trap is a failure: for every input that satisfies `pre` the function must not trap, `post` must not trap and must be true, and a `pre` that traps is itself a failure. Examples are not part of the query (the interpreter already ran them). Nothing is emitted or hashed, so spec-free programs and the goldens are untouched. Surfaces: a spec failure (A0715, A0716, A0719) carries a `spec` field in its JSON (function, ex, line, input, expected, actual) and its diagnostic points at the spec line, not the header; `a0_open` takes `specs: show|hide`; the language server reports the failure on the spec line and offers the rewrite of a wrong expected value as a quick fix that is not the preferred one (the function may be the wrong side, so `fix all` never rewrites an example); the tree-sitter and TextMate grammars treat `ex`, `pre` and `post` as keywords by place; the skill's edit protocol reference teaches the six edits. Not in this version: `law` lines and `--assert-contracts` (a `pre` or `post` is checked on the examples, and by `--prove` for all inputs).

**Decision, errors built for agents (2026-10-01):** a rejected reply costs a second call that re-pays the primer, so a diagnostic is made to be acted on. One table (`src/diagnostics.ts`) holds every code (A0nnnn), class, message template, fix and `a0 explain` text; the classes stay. Unknown names get a did-you-mean (TypeScript's `getSpellingSuggestion`: length difference at most max(2, 34%), distance below 40% plus one, nothing under three characters unless it differs by case). A fix has an applicability, `exact` (a mechanical rewrite the checker accepts: case, `=`, a colon, commas, hex, nested operands, a missing `end`, a signature echoed after `-fn`) or `maybe`; `fix all` applies every exact fix of the last rejected reply atomically. The explanations stay out of the primer, and their examples are executed by the tests. **Measured, not a win on these tasks:** see STATUS (Session 2026-10-01, errors built for agents).

**Decision, guessable spellings (2026-09-30):** a model shown A0 without a primer guesses some forms. Each guess seen in the no-primer collection was either accepted as another spelling of exactly one canonical form, or rejected with a one-line fix in the diagnostic. Accepted: `ID F ARGS` with F a function name that is not an op, alias, or `text` is `ID call F ARGS` (and `ret F ARGS` is `ret call F ARGS`); `udiv`/`urem` are `div`/`rem` (every integer op is unsigned, so there is one reading). Ops win over functions of the same name, `ret NAME` alone is still the operand NAME, and a direct call is checked exactly like `call` (earlier callee, arity, types; a misspelt op becomes an unknown callee whose fix lists the ops). The canonical form prints `call`, `div`, `rem`, so revisions and views do not change, and emitted code is identical. In edits, instruction lines after a block's explicit `end` edit the handled function like lines before the first block, and a function the same reply adds and the handled function calls is placed before it. Rejected with a fix: parenthesised operands (the fix spells out the node to add and the rewritten line; `ret (a, b)` suggests `ret rec a b`), `get`/`set` on a record (`at`/`put`) and `at`/`put` on an array (`get`/`set`), and instruction lines outside a `fn` block. The primers keep teaching the canonical forms only.

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

### Profiles: canonical and strict (a0c, step 2 of the strict/checked design)

A program is in one **profile**. The default, `canonical`, is everything above: every operation is total and wraps. A file whose first line (before any `use`) is `profile strict`, or any command run with `--profile strict`, is in the opt-in **strict** profile: the four places where canonical silently invents a value become traps. `--profile canonical` forces the default on a strict file. The directive is part of the canonical text, of `programRevision` and of every derived key (`semanticRevision`, so the artifact and function-emission cache keys); a canonical program prints, hashes and emits exactly as before (a golden test pins the emission of the corpus, the examples and compiler files on every target).

| Case | canonical | strict |
|---|---|---|
| `get`, `set` index `>= N` | index modulo N | trap `bounds` (A0710) |
| `at`, `put` field `>= N` | unreachable (the field is a checked literal) | trap `bounds` (A0710) |
| `div`, `rem` by zero | all ones / the dividend | trap `divzero` (A0711) |
| `read` on exhausted input | 0, position unchanged | trap `input` (A0712) |
| `add`, `sub`, `mul`, `shl`, `shr` | wrap, shift distance masked to five bits | the same: they never trap |
| `select` | evaluates both arms | the same, so a trap in the untaken arm is a trap |

A trap reuses the budget-trap mechanism: `A0Error.trap` is `{kind, fn, at, trip, chain}` (`kind` is `bounds`, `divzero` or `input`; `at` and `trip` name the innermost running fold/loop), and `formatTrap` prints `runtime: trap bounds fn=... at=... trip=... chain=... fix: ...` (the budget traps keep their `limit:` prefix).

**Checked operations**, valid in both profiles and never trapping, give a `(u32,bool)` record `(value, ok)`:

| Operation | Inputs | Output | Meaning |
|---|---|---|---|
| `cadd`, `csub`, `cmul` | u32, u32 | (u32,bool) | The wrapped result, and `ok` false when the exact result does not fit u32 (`csub`: when `a < b`) |
| `cdiv`, `crem` | u32, u32 | (u32,bool) | `(a / b, true)` / `(a mod b, true)`; `(0, false)` when `b = 0` |
| `cget` | u32xN, u32 | (u32,bool) | `(a[i], true)`; `(0, false)` when `i >= N` |

**Targets.** The reference interpreter (`run`), the **JavaScript** backend, the **C** backend (with its C++ and automatic-parallel variants, which share the emitter, and the wasm build through clang, which is the same C text), the **Java** backend, the **.NET** (C#) backend, the direct **wasm** backend (`src/wasm.ts`) the direct **wasm** backend (`src/wasm.ts`) and the direct native backends **arm64**, **x86_64**, **riscv64**, **arm32** and **avr** (`src/arm64.ts`, `src/x86_64.ts`, `src/riscv64.ts`, `src/arm32.ts`, `src/avr.ts`) implement `strict` and the six checked ops, in both profiles. Every other target (`sv`, Metal) refuses a program that uses a checked op in either profile, and a strict program with a site that can trap, with `structure` A0713 naming the target and the construct (for a strict program, the first site as `function.node: why`), so nothing silently runs canonical semantics (`STRICT_TARGETS` in `src/core.ts` is the list; the behavior table records the others in its skip ledger as `strict profile not yet implemented`). A strict program in which **every site is proved safe** (every index below its length by the analysis above, every divisor nonzero) has nothing to trap on, so it means the same under both profiles: such a target compiles it as the canonical program, with the same text (SystemVerilog and Metal today; `withoutProfile` in `src/core.ts`, tested in `test/strict-targets.test.ts`). The first unproved site is what A0713 reports, and the fix is to prove it (an `and` mask, a literal, `rem` by a literal; a divisor that is a nonzero literal or has one `or`ed in) or to use a target that checks it. Canonical programs without checked ops compile as before. The checked ops are not in `OPS` (the 30 operations the self-hosted compiler's spelling suggestions draw from, as the TypeScript ones do) but in `ALL_OPS`. The self-hosted front end (compiler/parse.a0, check.a0) parses and checks both exactly as src/core.ts does: `profile strict` is the first line (a `profile` line anywhere else at the top level, or anything but `strict` after it, is a parse error; a node or a function may still be called `profile`), the six ops are operation codes 32 to 37 of the word IR and give the record `(u32,bool)`, and the second word `parseio` writes is the profile (1 strict) when there is no diagnostic. Its emitters (`emitchunkio`, `emitachunkio`, `emitwasmio`) refuse a valid strict program or checked op with the structure diagnostic 2, the A0713 meaning, and write nothing; a diagnostic of the front end comes first. A program's files must agree on the profile (`structure` A0624, `profile mismatch`). The edit protocol has `profile strict` and `-profile` as program-level lines (under a program or function handle, canonical or dense), and views of a strict program begin with `profile strict`.

**What a compiled strict program does.** A node that can trap carries a check: a `get`/`set` index is tested against the length before anything is read or written (an in-place `set` has the test inside its subscript), a `div`/`rem` divisor against zero, a `read` against the end of the input. The trap line is the interpreter's, field for field: the C runtime keeps a shadow stack of the functions that can trap (their name, the fold or loop each is iterating, and its trip) and prints `runtime: trap bounds fn=.. at=.. trip=.. chain=.. fix: ..` to stderr and exits 3 (`A0_TRAP_EMIT` and `A0_TRAP_EXIT` may be defined before the module to take both over); the JS module throws an `A0Trap` (name `A0Error`, `code` `runtime`, `id` A0710-A0712, `.trap` the same record) and resets its stack. The Java and .NET modules throw an `A0Trap` (`id`, `kind`, `fn`, `at`, `trip`, `chain`, and `line()`/`Line()`, the interpreter's trap line) and reset the same stack. In wasm a trap is the `unreachable` instruction, which carries no data, so the module first records the line's fields in a static area and exports their addresses as the i32 globals `a0_trap_kind`, `a0_trap_n`, `a0_trap_at`, `a0_trap_trip` (words: a pointer to the NUL-terminated kind, the frame count, the frame the innermost fold or loop is in or -1, its trip) and `a0_chain`, `a0_node` (arrays of pointers to NUL-terminated names); the C-derived module and the direct backend share this layout (the C text uses it under `__wasm__`, where there is no stdio), `tools/verify.ts` decodes it into the same `{kind, fn, at, trip, chain}`, and a trapped instance is discarded (the wasm stack pointer is not unwound). A canonical wasm module has no such area or exports, so its bytes are unchanged.

**Strict on riscv64, arm32 and avr.** These backends keep the same shadow stack in memory and record the same fields, but their modules have no libc, syscalls or stdio to print with, so a failed check jumps to a module stub that records the trap and calls the host's `A0_trap`, which never returns (the uppercase `A0_` prefix cannot collide with a function symbol `a0_<name>`). **riscv64** and **arm32**: a function that can trap pushes a frame `{fn, node, trip}` (`fn` and `node` point to NUL-terminated names the function carries in `.rodata`) on `A0_frames` at entry and pops it on exit, a fold or loop whose body can trap names its node and stores each trip, the stub sets `A0_trap_kind` (a name pointer) and `A0_trap_end` (one past the innermost frame), empties the stack and branches to `A0_trap`; `nativeTrapHostC()` in `src/trap-host.ts` is the reference host (it writes the interpreter's trap line through `A0_TRAP_EMIT`, stderr by default, and exits through `A0_TRAP_EXIT`, `exit(3)` by default), and `tools/verify.ts` runs it bare-metal under qemu (the line is compared with the interpreter's). **avr** has no strings and a tight flash: the frame is seven bytes in SRAM, `{word address of the function, node ordinal, trip}`, the stub calls `A0_trap(uint8_t kind, const uint8_t *end)` (kind 0 bounds, 1 divzero), and the test firmware writes the record as decimals, which `decodeAvrTrap` turns into the same line using the function addresses and `avrTrapNodes` (the ordinals of a function's trap-naming folds). A function that cannot trap keeps no frame and a module with no trap site carries no runtime, so canonical output is unchanged. A node that can trap is checked before it runs (`set` and `put` before the copy or the write); the checked ops are straight-line code on the carry chain (avr checks `cmul` by dividing the product back); a body that can trap is called, never inlined, unrolled or reordered (`mayTrapFn`), and a literal index at or past the length is an unconditional jump to the stub. Both emissions, optimized and not, are executed on every case under qemu-system-riscv64, qemu-system-arm (Cortex-A7) and libsimavr. A `select` still evaluates both arms in the wasm emitter (a lazy arm is never one that can trap), and a body that can trap is called, never inlined, so the trap line keeps its frame. An op that provably cannot trap (an index below the length by a bounds analysis: a literal, `and` with a small mask, `rem` by a literal, `shr`; a divisor that is a nonzero literal or an `or` with one) is emitted as in the canonical profile, and a function that cannot trap keeps no frame. The strict optimizer (src/optimize.ts) keeps the value and the trap: a node that can trap is anchored like an effect (never removed, folded to a value, reordered or scheduled away), a call or fold of a body that can trap is not inlined, unrolled, fused or run in parallel (the trap names the frame and the chain), a `select` still evaluates both arms, and a zero divisor or out-of-range literal index is never folded. `tools/equiv-verify.ts` proves the strict rewrites of the corpus and of one kernel per rule with Z3 as "equal first-trap code, and equal values where neither traps".

**Strict on the direct native backends (arm64, x86_64).** The same checks, with no runtime library and no libc. A function that can trap (`mayTrapFn`) pushes a 32-byte frame `{name, node, trip}` on a shadow stack in zero-filled data on entry (the registers of the arguments are untouched) and pops it before it returns; a fold or loop whose body or predicate can trap stores its node id before the loop, its trip counter at the top of each trip, and clears the id after the loop. A trapping site is a compare and a conditional branch (`cmp idx, #N; b.hs` / `cmpl $N, idx; jae`, `cbz`/`je` on a divisor) to one cold stub per function and kind placed after the function (it loads the kind and jumps to the module's one reporter); an in-place `set` has the test before the store, and a literal index at or past the length is an unconditional branch. The reporter reads the shadow stack and writes the interpreter's line (`runtime: trap bounds fn=.. at=.. trip=.. chain=.. fix: ..`) to stderr with the `write` system call, then exits with status 3 with the `exit` system call (Darwin and Linux numbers; the x86-64 module has the Mach-O and ELF forms of the data). A module that has no function that can trap carries none of this, and a strict function that cannot trap is emitted byte for byte as the canonical function. A body that can trap is never inlined, unrolled, fused, vectorized (NEON or SSE2 fill and reduction loops, query groups, lazy fills, the carried-element loop and the register-resident state record) or hoisted: it is a real call under a marked frame, so the trap names its fold, trip and chain exactly as the interpreter does; the analysis is the optimizer's own (`strictSite`, `mayTrapFn`, `callTraps`), so a node it proves safe keeps every canonical optimization. The two backends refuse io, so the `input` trap has no site there. The six checked ops write the `(value, ok)` record into the node's stack slot (`adds`/`subs`/`umull`/`udiv` flags on arm64, `add`/`sub`/`mul`/`div` on x86-64; `cget` takes one compare, a clamped index on arm64 and a branch around the load on x86-64).

Effects: `io` is a linear capability token. Each token value is consumed at most once, a function takes at most one `io` parameter, arrays cannot hold tokens, and `select` cannot choose between them; the token data dependencies therefore form one chain per function, which is the effect order. Effectful nodes (`read`, `write`, and calls/iterations that carry a token) are anchored in the optimizer: never folded, merged, reordered, or removed. Software backends thread a mutable stream state (JS object, C `a0_io*` with fixed 256/1024-word capacity, Java `A0Io`); in hardware, functions that iterate with a variable count, perform io, or call such functions are emitted as clocked modules (v0.4.0): `clk`/`rst`/`start`/`done` plus `in_data`/`in_valid`/`in_ready` and `out_data`/`out_valid`/`out_ready` word handshakes; each effectful or iterating node is a stage of a linear FSM whose results are registers, iteration bodies are instantiated once and stepped per clock, and sequential callees run through nested start/done handshakes. Pure functions stay combinational. Two tiers exist for platform integration: portable capability operations (`read`, `write`, `puts`) and platform-specific adapters that interpret word protocols, such as the browser UI protocol used by the a0lang.com page (`site/page.a0` + `site/app.ts`); adapters are runtimes, not compiler guesswork. Aggregates have value semantics: no operation mutates or aliases; `set`/`put` return copies. Backends: direct AArch64 assembly (v0.8.14; A0's own code generator, no C in between, io functions refused for now; since a0c-0.1.7 scalars are register-allocated by a linear scan over callee-saved registers, plus w0-w7 in leaf functions, callees of at most 48 nodes are inlined at `call`/`fold`/`loop` sites so an iteration is a branch with its state and counter in registers, and a `set`/`put` on a provably unshared aggregate, the same `mutableHere` analysis as the JS backend, writes one element in place), direct x86-64 assembly (a0c-0.1.9, `src/x86_64.ts`: the same scope, code shape, and in-place scheme on the System V AMD64 ABI with AT&T syntax, macOS `_a0_` or Linux `a0_` symbols by a platform switch, scalars homed in ebx/r12d-r15d plus edi/esi/r8d/r9d in leaves, `div`/`rem` branching around the trapping DIV to give A0's zero-divisor values, verified under Rosetta 2 on Apple silicon), direct AVR assembly for the ATmega328P (a0c-0.1.10, `src/avr.ts`: avr-gcc calling convention so a C driver calls `a0_<name>`, exact u32 built from 8-bit carry chains with shift-and-add multiply, a restoring divider whose zero-divisor result is A0's without a special case, and five-bit-masked shift helpers, every value in a Y-relative frame slot, small arrays and records up to 255 bytes, io and larger aggregates or frames refused with `structure`/`limit` diagnostics, verified under libsimavr through an avr-gcc UART driver), direct 32-bit ARM assembly (a0c-0.1.12, `src/arm32.ts`: the same scope, code shape, and in-place scheme for ARMv7-A in ARM mode on AAPCS hard-float Linux (arm-linux-gnueabihf, the Raspberry Pi 2/3 32-bit userland), u32 directly in 32-bit registers, scalars homed in r4-r10, `div`/`rem` and index reduction through a module-local shift-subtract routine because UDIV is optional on ARMv7-A, verified bare-metal on an emulated Cortex-A7 under qemu-system-arm), JS arrays with copy-on-write, C structs by value, Java arrays/records with clone-on-write, SystemVerilog packed bit vectors (element 0 at the LSB) with part-selects. Integer literals are decimal 0 through 4,294,967,295. A Boolean is not implicitly a number; `and`, `or`, `xor`, `eq`, and `ne` accept either two `u32` (bitwise, unsigned equality) or two `bool` (logical, boolean equality), never a mix (v0.8.11, added because both model subjects in the Gate 6 run reached for boolean logic and there was none). Comparisons are `eq ne lt le gt ge` on `u32`, unsigned (v0.8.12; a subject invented `le`). Invalid values, missing references, duplicate definitions, wrong arity, and inconsistent types are rejected. Every current operation is pure and total on valid input. Both `select` inputs are ordinary values; this is not lazy branching with effects.

JavaScript uses exact 32-bit multiplication and explicit unsigned normalization, and validates public inputs. C uses fixed-width unsigned types; multiplication is widened to unsigned 64-bit before truncating, avoiding signed-promotion hazards. Java uses the signed `int` bit pattern with unsigned comparison and appropriately interpreted external results. SystemVerilog maps the two-state meaning into explicit logic widths, but simulation/synthesis has not been performed.

Limits and in-place updates (a0c-0.1.7): an array dimension may be up to 65,536 elements and one aggregate up to 2^21 bits (65,536 words), so the native paths (C, JS, JVM, .NET, arm64) can hold the memory a self-hosted compiler needs; the hardware (SystemVerilog) and GPU (Metal) backends, which keep aggregates in bit vectors or thread registers, refuse any function using an array longer than 1,024 elements with a `limit` diagnostic rather than emit multi-megabit vectors. All-zero scalar-array literals are plain zero allocations on JS, C, and Java (a 65,536-element non-zero literal is still N operands, which C compilers accept but the JVM's 64 KiB method limit does not). The C backend keeps its by-value ABI but no longer copies on every update: every by-value aggregate parameter and every fresh local is private to the callee, so a `set`/`put` whose old value is provably dead (`mutableHere`: fresh or owned, read only through `get`/`at` before the update, never returned) is an in-place assignment and the node is an alias of that storage; iteration bodies (`p0` state, `p1` index, result of the state type) also get a `static inline void a0o_f(T *p0, ...)` variant that updates the loop state through a pointer, predicates get `a0r_f(const T *p0, ...)`, and a fold or loop whose initial value is unshared runs directly in that value's storage. Any value still observable is copied exactly as before; the differential oracle decides, and a 4,096-element fill went from 2.78 ms to 0.85 µs per call (ties Rust, whose `[0u32; 4096]` pays the same zero-fill).

## 5. Reading and editing protocol

The AI should request a relevant view, not receive the entire workspace by default. A future view service must preserve contracts, public names, dependencies, security constraints, and relevant intent. Important context must not be removed merely to shorten the prompt.

The initial implementation provides two edit paths.

**Self-contained patch:** function name, full SHA-256 content revision, replacement nodes, and an end marker. This can be transported independently but is inefficient for very small edits.

**Session-bound edit:** a local session retains the full revision and returns a short handle with the viewed function. The AI replies:

```text
e0
b sub a p2
```

The handle binds the edit to one exact viewed function. Existing node `b` changes; unchanged nodes are not emitted. The compiler checks the complete replacement and commits atomically. Unknown handles, edits written against text that is no longer current (revision mismatch), invalid types, duplicate replacements, and forward references fail. Other function objects remain unchanged. There is a bounded session size and explicit handle closing. Handles are stable names for the session (`e0`, `g0`, ...): after a successful edit every open handle is rebound to the new revision, so a model keeps replying with the handle it was shown (v0.8.10; the earlier one-use rule was measured to be the main failure mode of a small model, with no safety benefit inside a single-editor session).

The handle is not a secret or an authorization credential. A future network service must isolate sessions by authenticated principal and apply normal access controls. No network service exists in v0.1.

**Observed lesson:** the full-revision envelope can be larger than the complete tiny function. The session reduces the model payload but does not erase the input used to open the view, language instructions, tool envelopes, or session-management work. Existing-language editors must receive the same protocol advantage in a fair experiment.

Edits replace, insert (at the end or after a named node), delete, and change the result within one function, validated as a whole and committed atomically (v0.8.1). Views can be dependency-scoped: the function plus one signature line per direct callee. Program-level handles add, replace, or remove whole functions atomically (v0.8.2). Whole `fn ... end` blocks are program-level edits under any handle: under a function handle the handled function sent back whole replaces itself and any other block adds or replaces that function, with edit lines applied to the handled function after the blocks (v0.8.15; measured need: two of four fresh-subject failures on the 304-token primer were this shape). The handle line is optional when it is implied (exactly one function handle open, or no function handle and exactly one program handle); a function handle also takes `-fn name`; a `fn` block's `end` is optional (the block closes at the next `fn`/`-fn` line or the end of the reply; unambiguous since `fn`/`end` are reserved); replies need no code fence (2026-09-30, protocol-only: no semantics or emission change, COMPILER_VERSION unchanged; measured: A0 structured output 34.2 -> 26.4 o200k tokens per edit over sets b, c400, d on Haiku and Sonnet, acceptance held). `-fn f` together with a `fn f` block in one reply replaces `f` in place, and `-fn f` may repeat f's current signature; an `end` after the handled function's edit lines, before a new block, closes those lines (a0c-0.1.26; the E/F held-out replies rejected as `both removed and defined`, `expected 'fn', got '-fn'`, and `expected id op operands`). Line-addressed edits on numbered views (`N line`, `N-`, `N+ line`, `f:N`; opt-in `open(name, { numbered: true })`, each edited function goes through the whole-function path) exist but are not the default: measured 2026-09-30 they raised output per edit (26.2 -> 27.9) and lowered acceptance (73/74 -> 64/74), see STATUS. Region edits, migrations, and cross-function transactions with partial views remain future work. Current revisions are content hashes; they do not encode a global chronological transaction number.

## 5a. Dense view

The dense view is a second surface syntax over exactly the same programs (`src/dense.ts`). Canonical form stays the default, the hashed form and the form every backend, proof and revision sees; `parseDense(formatDense(p))` has the canonical form of `p` (every id, node order, revision) and `parse(canonical)` converts to dense text that converts back to it. It is reachable as `.a0d` files or `--dense` on any CLI command, `a0 dense FILE [--normalize] [--comments]` and `a0 canon FILE.a0d` (conversion), `dense: true` on `a0_open`/`a0_program` and `.a0d` files in the MCP server, `EditSession.open(name, { dense: true })` for the edit protocol (views and replies), and `.a0d` documents in the language server (diagnostics, formatting through the dense printer). Round trips are tested over every `.a0` in the repository (kernels, examples, compiler, site, seed), the generated corpus, 1,500 random programs with odd ids, and every printer style.

### Grammar

```text
file      = use* function*
function  = "fn" name [ header ] [ statement ] NEWLINE ( statement NEWLINE )* [ "end" ]
header    = ptype+ "->" type | "->" type          ptype = "_" | type  (canonical types)
statement = [ "ret" ] [ name | "$" name ] [ "=" ] expr
expr      = integer | "true" | "false" | PARAM | name | "$" name | string
          | "[" expr+ "]" | "[" operand ";" N "]" | "(" expr ")" | "(" expr expr+ ")" | "(" expr "," ")"
          | op expr^arity | fname expr^params(fname) | "call" fname expr^params(fname)
          | "fold" fname expr^params(fname) | "loop" pname fname expr^params(fname)
          | ("arr" | "rec") expr*  (to the end of the line or the closing bracket) | "text" string
```

- A function runs from its `fn` line to the next `fn` or `use` line, an `end` line or the end of the file; blank lines and `#` comments never end it. The last statement is the result. `ret EXPR` before the last statement is accepted and, when it creates the result node, names it `retval` exactly as canonical `ret OP ARGS` does.
- Without a header the parameters are all `u32`, as many as the highest parameter used (`A` is parameter 0 ... `Z` 25; `p26` and up, and the canonical `p0`, are accepted). A type list needs its `->` (`fn f u32 bool -> bool ...`); the result is `u32` when there is no header. `_` is an accepted spelling of `u32` in a list; the printer writes `u32`.
- Every operation takes a fixed number of operands right after it, so a nested expression needs no parentheses. Arity: `mov read` 1; `add sub mul and or xor shl shr eq ne lt le gt ge div rem get at write puts` 2; `select set put` 3; a call, fold or loop takes the callee's parameter count, so the callee must be defined above (an unknown or later name is an error that says so). `shl`/`shr` are also `<<`/`>>`, and `+ - * / % & | ^ == != < <= > >=` are accepted spellings of the ops; `udiv`/`urem` as in canonical. `(EXPR)` is EXPR; two or more expressions in parentheses, or one followed by a comma, are a record. A comma is a blank everywhere else.
- A statement names its value (the last operation it creates) with `ID EXPR`, `ID = EXPR`, `$ID EXPR`. Resolution of a statement's first word: `ret`; an op, alias, `text`, type word, `true`/`false` or function name starts the expression; a lowercase identifier followed by more tokens is the name; `$` always names. In an expression a bare word is an op, then a function, then a named value above; `$ID` is always the named value. A name that is an op, a type word or a function name must be written with `$` (the printer does).
- Nodes without a name get default ids `a b c ... z aa ab ...` in node order, skipping every name given explicitly, ops and reserved words. The printer writes an id only when something refers to the node by name or when its id is not the default one in that position, so a program whose ids are not defaults prints with more names but converts back exactly. `normalizeProgram` (`a0 dense --normalize`) is the one lossy step: it reorders nodes by data dependencies and renames to the defaults (same behavior, different revision) so that a value used once nests into its consumer.
- Printer: a value used once and defined right before its consumer is nested into it; a function with one unnamed statement keeps it on the `fn` line; `[x;N]` for three or more equal elements; `(x,)` for a one-field record; comments are kept only by the formatter (`comments: true`), which attaches them to statements.

### Measured (2026-10-01, o200k_base)

See STATUS.md, "Session 2026-10-01 (dense view)", results/dense-tokens.json, results/lang-axes.json and results/dense-experiment.json. Kernels: canonical 559 tokens for the ten lang-axes kernels, dense 202 (lossless conversion of the stored kernels 286); canonical stays rank 41 of 49 and dense, as a separate ledger subject, is rank 1 of 49, 0.63 of the best single language (Forth, 323). Fold and loop bodies may be written inline (`fold {set A B add B C} 8 [0;8] A`, `loop {lt A C} {add A 1} 10 0 A`); they are lifted to `CALLER_N` functions.

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
| Native server / desktop / mobile / embedded | MLIR/LLVM/native artifacts and platform ABIs | C-compatible output compiled and run on Linux. Direct assembly backends for io-free functions: AArch64 (Darwin, run natively), x86-64 (System V, run under Rosetta 2), and RISC-V RV64 (LP64, run bare-metal under qemu-system-riscv64). No phone deployment or platform SDK adapters. |
| C++ ecosystems | Typed ABI boundary or explicit bindings | Generated C-compatible kernels compile as C++; existing C++ source is not imported. |
| JVM | Defined managed-runtime representation and bindings | Generated Java compiled and executed on a JVM. No Android packaging or Java library importer. |
| .NET | Managed backend and runtime bindings | C# emitted (native `uint`, records, clone-on-write arrays, io runtime); built and executed on .NET 10 against the oracle incl. io streams. No .NET library bindings. |
| GPU | Domain operations, memory spaces, schedules, GPU backends | Metal Shading Language emitted via a typed layer over the C output; elementwise kernels executed on Apple M3 against the oracle. No memory-space, scheduling, or performance model yet. |
| FPGA / ASIC | Bit-accurate graph, state/scheduling, RTL, synthesis/physical tools | Combinational and clocked SystemVerilog emitted; simulated with Icarus against the oracle (incl. io streams) and synthesized generically with Yosys; no FPGA/ASIC place-and-route, timing, area, or power. |

Hardware compilation requires attention to cycle boundaries, finite resources, throughput, latency, timing, and physical implementation. XLS demonstrates software-style descriptions that can target host software and hardware, and its flow includes hardware synthesis and physical measurement. Generating RTL alone is not equivalent to delivering a working chip. [S3]

Integration is part of the language product. Node packages, browser APIs, native SDKs, managed libraries, database drivers, and device interfaces need exact bindings, compatible ownership, error handling, and capability contracts. Generating the destination language alone does not supply these. WIT provides a useful existing interface-description precedent; it defines component interfaces, not implementation behavior. [S4]

## 7a. Self-hosting: the compiler in A0

Decision (2026-09-30): the compiler is to be written in A0 and compiled by A0's own AArch64 backend, so the shipped `a0` binary is A0 machine code with no runtime. The TypeScript compiler remains as the bootstrap and the verification oracle: every stage of the A0 compiler is checked differentially against it on the corpus, and the bootstrap fixed point (stage 2 output equals stage 3 output, byte for byte) is part of the gate.

Stages: (1) lexer `compiler/lex.a0` (done; tokens as `kind start length` word triples), (2) parser `compiler/parse.a0` producing the word IR below (done), (3) checker `compiler/check.a0` (done; the type of every node and the first diagnostic; any source within the front end's limit is checked whole, a larger IR in chunks of the tables), (4) optimizer and AArch64 emitter (the emitter is done for the whole language without an optimizer: the q functions of `compiler/emit_arm64.a0`, every value in a stack cell, aggregates by pointer on the machine stack, the Darwin C convention for calls; the optimizer is not started), (5) C emitter `compiler/emit_c.a0` for the other platforms (done as stage 4b; C source bytes from the IR and `ntys`, emitted in the checker's chunks, verified by compiling it against the oracle, `bun run selfhost:c`; it reads the front end's paged tables, since a flat table of N words cannot hold the N-element zero literal that creates it), (6) bootstrap (done on the C path: `compiler/boot.a0` compiles one chunk within the front end's capacities; tools/bootstrap.ts splits a larger program at function boundaries, each chunk carrying a header prelude of every header type so that type indices agree, and the stubs of its callees; the compiler compiled by itself in chunks gives byte-identical C at stage 2 and stage 3, `bun run bootstrap`; and on the arm64 path: `emitachunkio`, seeded once through C, compiles itself to arm64 assembly, and the assembly and the linked executables of stage 2 and stage 3 are byte-identical, `bun run bootstrap:arm64`; those stages need the system assembler and linker and libSystem, no C). Prerequisites in the language: arrays beyond 1024 elements with in-place updates on the C and arm64 paths, and a record cap above 65536 bits.

Word IR (all tables are u32 arrays; indices are 0-based; a table's length travels beside it):
- `pool`: byte pool for identifiers and string literals. `sym`: (start len) pairs into `pool`; the same bytes intern to one entry.
- `types`: triples (tag a b). tag 1 u32, 2 bool, 3 io, 4 array of length a with element type b (the parser writes `u32xN`, b = 0, and nested words `u32xAxB...`, the array of B of the array of A, inner first; the checker interns the arrays `arr` builds of any element type), 5 record whose field types are `tlist[a .. a+b)`. `tlist`: type indices.
- `fns`: 7 words per function (name-sym, nparams, first param index in `tlist`, result type, first node, node count, ret operand as two words folded: kind*2^28 | value).
- `nodes`: 6 words per instruction (id-sym, op, nargs, first arg in `args`, callee fn index or 0, pred fn index or 0). `args`: operand pairs (kind value): kind 1 node index within the function, 2 param index, 3 u32 literal, 4 bool literal.
- ops: 1 mov 2 add 3 sub 4 mul 5 and 6 or 7 xor 8 shl 9 shr 10 div 11 rem 12 eq 13 ne 14 lt 15 le 16 gt 17 ge 18 select 19 call 20 fold 21 loop 22 arr 23 rec 24 text 25 get 26 set 27 at 28 put 29 read 30 write 31 puts 32 cadd 33 csub 34 cmul 35 cdiv 36 crem 37 cget (the checked ops, result `(u32,bool)`; no emitter implements them).
- `ntys`: the checker's type index per node, in `nodes` order; `fstat`: its saturated iteration bound per function.
- capacities (2026-09-30, raised a0c-0.1.32): the A0 front end reads at most 131072 source bytes, packed four a word in 2048-byte pages (lex.a0 `readsrc`; every reader takes a 128-byte page view through `srcpg`), and its tables hold 16384 tokens of at most 32767 bytes, 8192 symbols, 51200 pool bytes, 4096 uses, 820 functions, 2730 nodes, 32768 operands (u32x128x512, written in two halves by two runs of pass 5, since one pass's state of 2^21 bits cannot hold the table with anything else), and 8320 types and tlist words (the parser's types plus one per node the checker may add). A source beyond a capacity is the limit diagnostic 4 (parse.a0 `fecap`); tools/bootstrap.ts `planChunks` cuts programs so that every chunk fits (tools/ref-parse.ts `frontEndFits`). Tables are u32 arrays of 128-word pages (`u32x128xN`, element i at page i>>7; `types` in 384-word pages of 128 triples) because a flat literal would be larger than a chunk, one value of 2^21 bits must hold a pass's whole state, and every target validates or copies each table a call receives: per-token and per-operand steps get pages and scalars, not tables.
- diagnostics: the A0 front end reports the same codes as the TypeScript one (1 parse, 2 structure, 3 type, 4 limit) with the token index from the parser and (function, node) from the checker; the differential tests map both sides to the same location and require equality. For an unknown name (a type, a node, a callee, a fold or loop body, a loop predicate) `compiler/suggest.a0` (io front `suggestio`, linked with the checker in `compiler/native.a0`) also names the row of the diagnostics table (`A0001`, `A0101`..`A0104`, src/diagnostics.ts) and the spelling suggestion, by the rule of `spellingSuggestion` with distances in tenths; `tools/ref-parse.ts` `refSuggest` is its independent reference, and the native `a0 check` prints both. Every other self-hosted diagnostic keeps its class only.

## 8. Planned semantic extensions

The initial core must grow without silently changing existing meanings.

- **General computation:** calls (v0.1.1), bounded `fold` (v0.1.2), capped early-exit `loop` (v0.1.3), value-semantics arrays/records (v0.2.0), and linear io effects (v0.3.0), and clocked hardware modules for iteration and io (v0.4.0) are implemented; next are platform adapters (browser DOM) and general structured regions, and sequential hardware state, bounded iteration first, then broader recursion/control flow for suitable software profiles.
- **Data and memory:** fixed/arbitrary-width integers, strict floating-point profiles, buffers/records/arrays, explicit layout where needed, ownership/borrowing or region inference, managed adapters where appropriate. No universal boxing requirement.
- **Effects and concurrency:** typed capabilities for files/network/clock/device access, structured tasks, declared synchronization and memory-order semantics. External nondeterminism is explicit; reproducibility is not assumed across arbitrary concurrent schedules.
- **Domain operations:** high-level collection, query, numeric, graphics, UI, and hardware operations with defined semantics and optional certified lowerings. Preserve high-level information until the backend can use it.

No implicit numerical weakening. Approximate arithmetic or relaxed floating-point transformations require explicit permission and separate acceptance criteria. Side-effecting operations cannot inherit the pure core's reorder/remove rules.

The AI view can use inferred types and compact argument positions, while richer interfaces remain retrievable. Tokenizer-specific spelling, aliases, and dedicated model tokens are experiments, not predetermined winners. Existing encodings and future model vocabularies must be measured; a byte is not a model token. [S6]

## 9. Security and correctness boundaries

Execution is resource-bounded: the reference interpreter runs on a fuel budget, compile-time evaluation is fuel-bounded, and the validator rejects literal nested iteration above 2^24 while reporting a static iteration bound for variable counts. Literal iteration counts are bounded statically; variable counts are bounded by fuel in the interpreter and are not bounded on compiled targets (compiled code has no execution budget). No API keys are embedded; no hosted model is required. Source cannot inject destination identifiers because identifiers and operations are validated and generated names are prefixed. Toolchain invocation uses argument arrays and a temporary directory, not generated shell commands. Input source and patch sizes and session/cache capacity are bounded; a program (also a linked one) holds at most 65,536 functions of at most 4,096 nodes and 64 parameters each (a0c-0.1.14; 1,024 functions before), within the 1 MiB source bound.

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
