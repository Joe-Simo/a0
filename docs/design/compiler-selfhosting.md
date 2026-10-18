# Entire compiler in A0

The intended compiler is written in A0, including its frontend, optimizer, code generators and
semantic command handling. The shipped compiler has not reached that state. A native executable
containing the TypeScript compiler does not satisfy this requirement. Neither does an A0 checker
that sends rejected or unsupported input back to TypeScript.

TypeScript can remain an independent test oracle and a documented initial bootstrap. It must not
decide compilation results in the completed release. Host code may provide file access, allocation,
process invocation and byte transport. Parsing, module policy, typing, interpretation, diagnostics,
optimization, target ABI decisions and code emission belong in A0.

## Existing implementation and remaining work

| Stage | A0 implementation | Work before dependency removal |
| --- | --- | --- |
| Canonical frontend | `compiler/lex.a0`, `parse.a0`, `check.a0`, `suggest.a0`; full-word arena parser/checker, spec grammar/binder/ordered verifier and a partial diagnostic formatter | Complete diagnostic coverage and original diagnostic mapping, generic chunk planning and authoritative routing. The experimental linked verifier now checks multifile specs with source origins. Ordinary loads still use `src/link.ts` and `src/core.ts`. |
| Website build | `compiler/boot.a0` and its frontend closure; `tools/site-build.ts:wasmTool` and `buildProgram` | The build still links source with the historical TypeScript frontend and builds the A0 optimizer/emitter through the verified seed. Replace those frontend/bootstrap dependencies through the same A0 compiler interface. The playground has been removed; the deployed browser runtime executes precompiled page programs and exposes no source parser. |
| Dense frontend | `compiler/dense.a0` | Complete the documented syntax gaps and execute it without the TypeScript interpreter or a subsequent TypeScript parse. |
| Evaluation | `compiler/evalrun.a0`, experimental `eval_arena.a0` with full-word frames and continuations | Connect command/spec evaluation and full diagnostics; address allocation retention and production resource/performance behavior. The native driver's C evaluator is also compiler logic that must migrate. |
| Optimization | `compiler/optimize.a0`, `shape.a0`, including canonical checked operations | Preserve reference behavior, support strict metadata and existing input sizes, and use these stages for every target. Checked bodies conservatively decline fusion. Ordinary emits still use `src/optimize.ts`. |
| C | `compiler/emit_c.a0`, experimental arena-table `emit_c_arena.a0` | Full strict metadata; current aggregate ABI, arena, ownership, parallel and option behavior. |
| Darwin arm64 | `compiler/emit_arm64.a0`, experimental `emit_arm64_arena.a0` and source/linked services | Arena strict traps and original metadata are tested in an independent instruction model. Complete current ownership, optimizer and option behavior, hardware execution and public routing. |
| Direct Wasm | `compiler/emit_wasm.a0`, `wasm_code.a0`, experimental `emit_wasm_arena.a0` and source service | Arena canonical/strict modules execute in the Wasm runtime. Complete optimizer, SIMD/unroll/packing and linked frontend parity, and authoritative command routing. |
| Other code generators | Legacy JS/Java/SystemVerilog/x86/RISC-V/ARM32 ports; experimental AVR/C#/Metal modules and arena JS/x86/C#/RISC-V/Java services | Complete their documented option and optimizer interfaces, original ownership/resource behavior and production routing. Arena RISC-V uses an independent instruction model; Java has selected JVM execution. AVR and the legacy source ports retain fixed frontend limits; target execution evidence differs by platform. `compiler/asm_x86_64.a0` assembles instructions; it does not generate a program from A0 IR. |
| Assembly and executable writing | `compiler/asm_arm64.a0`, `asm_x86_64.a0`, `macho.a0` | Connect arena-based ELF/PE writers and existing ports to the full A0 pipeline; preserve platform and ABI validation. |
| Formatting and revisions | Arena canonical formatter, semantic revisions, SHA-256, UTF-8 decoding/provenance and unsigned-decimal binary64/shortest-text components | Connect the experimental formatter/revision APIs to production, complete dense formatting and arbitrary interior UTF-16 mappings, and migrate edit/session policy. Ordinary formatting and edits still use TypeScript. |
| Production entrypoints | A0 plain-check acceleration and the website's A0 optimizer/Wasm emitter | Route CLI, MCP and editor semantic operations through the complete A0 service. Replace semantic parts of `tools/native/a0.c`; update release packaging and smoke tests. |
| Authoring/bootstrap | Checked-in self-reproducing C seed | Retain seed verification, port semantic source/chunk planning, and remove TypeScript generation dependencies from normal compiler builds. A0S/A0M generators also need an explicit bootstrap/authoring boundary. |

Experimental interfaces and current limits are documented in [Arena frontend](arena-frontend.md) and [Compiler ports](compiler-ports.md). The public CLI still uses the reference frontend/backends. The arena source services share [full-word checked tables](../arena-backend-context.md); [linked verification](../arena-linked-verifier.md), [JavaScript](../arena-js.md), [C#](../arena-csharp.md), [number conversion](compiler-numbers.md) and [hashing](compiler-revisions.md) have separate native tests and explicit integration limits.

Additional experimental APIs and their limits are documented for [arm64](../arena-arm64.md),
[Wasm](../arena-wasm.md), [formatting](arena-format.md) and [UTF-8](../arena-utf8.md).
[Java](arena-java.md) retains explicit JVM artifact-planning limits and selected target execution.
[RISC-V](../arena-riscv64.md) retains explicit option limits and source/table/platform distinctions.
Native fixtures establish the tested behavior; they do not establish
whole-compiler parity or a runtime, compile-time or token-cost advantage.

## Migration rules

Implement missing behavior before making an A0 stage authoritative for that behavior. Preserve all
advertised targets and options. Refuse unsupported experimental requests explicitly; never strip
specs, reinterpret strict input as canonical, or select a TypeScript fallback after an A0 failure.

Keep source and table paths separate in evidence. An A0 emitter receiving TypeScript-checked tables
proves that emitter works; it does not prove that the A0 frontend compiled the original source.
Likewise, a fixed point proves reproduction of the compiler source, not parity for every user
program. Code that resolves modules or plans typed chunks is semantic compiler work even if it runs
in a build tool.

The website uses the bytes from the A0 optimizer and Wasm emitter, checking them against the
TypeScript oracle. Its frontend, chunk planner and prerendering still depend on TypeScript.
The Wasm tool's bootstrap now builds the verified A0-generated C seed directly; it must fail if that
seed is missing or stale. This removes a TypeScript code-generation step, not the remaining frontend
or driver dependencies.

## Frontend storage

`compiler/arena.a0` implements the compiler's internal storage protocol; `arena_vector.a0`,
`lex_arena.a0` and `symbol_arena.a0` implement growth, lexical decisions and symbol interning in A0.
Token spans, symbol IDs, source offsets and vector fields retain full u32 words. The lexer accepts
up to the existing source-byte limit and reports allocation errors explicitly. This storage is
available for the frontend migration; the shipped parser has not yet switched to it.

`tools/native/arena_runtime.c` supplies generic word allocation, bounded transfers and output.
It contains no grammar, typing, module policy or chunk planning. Generated C opts into this
transport with explicit read/write macros; ordinary programs keep their buffered IO behavior.
Each invocation owns a session and must check both its entry status and `a0_arena_is_complete()`
before publishing output. Handles live only for that invocation. A concurrent wrapper must map
each invocation to its own session. The runtime ABI and adapter bytes must be recorded in
provenance before it becomes part of a packaged compiler.

`test/arena-frontend.test.ts` builds the verified native A0 seed and uses it to emit the storage,
lexer and symbol code. Its independent host model, byte scanner and symbol map check capacity
boundaries, collisions, resource rollback, cleanup and both IO transports. These checks establish
the storage layer; they do not establish complete parser, checker or diagnostic parity.

## Completion evidence

- The shipped CLI, MCP and editor compilation paths consume original sources through A0 compiler
  logic, with TypeScript compiler modules unavailable. Missing A0 assets and A0 errors fail clearly.
- Canonical/dense, multifile, specs, strict/checked, IO, diagnostic and limit cases preserve existing
  observable behavior on every supported target and release platform.
- Optimizer, ownership and backend changes retain independent semantic checks and measured
  performance evidence. A migration cannot discard current optimizations without measuring and
  resolving the resulting losses.
- Bootstrap stages reproduce their outputs. Changes to `compiler/*.a0` regenerate and verify
  `seed/` with `bun run seed`; additional promoted compiler closures carry their own provenance.
- Release packaging contains the A0 compiler and the documented host/bootstrap dependencies. The
  TypeScript implementation remains outside shipped semantic execution.
