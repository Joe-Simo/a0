# Experimental arena RISC-V64 emitter

`compiler/emit_riscv64_arena.a0` emits RV64 assembly from the shared checked
context and original-identity descriptor. `riscv64_service_arena.a0` composes
original-source parsing, ordered verification and emission;
`riscv64_link_service_arena.a0` adds the ordered linked verifier and original
source projections. The public compiler route remains unchanged.

`arena_riscv64_emit_context` consumes ctx16 and D128. The source and linked
`begin`/`pump` entrypoints retain verifier state until terminal success or an
explicit failure. Callers must check the terminal status, publish only successful
output, and complete the generic filesystem/arena transport session. Pending
verification is not successful emission.

Canonical and strict profiles retain checked operations, aggregates, IO, calls,
folds and loops. Strict metadata preserves original function/node identities,
iteration trips and the first trap. Existing source-language limits and caller
arena/output budgets remain separate from table IDs, offsets and counts, which
retain full u32 words.

The current component accepts IO capacity options through 16777216 words and
requires its reserved options to be zero. This is an explicit experimental option
limit, not a RISC-V architectural or source-language limit. Unsupported options
refuse before emission. Complete option, optimizer, register-allocation,
ownership/copy-elision and performance parity remain work before public routing.

`test/arena-riscv64-native.test.ts` builds the actual A0 implementation through a
fresh verified seed. Separate source and table cases crossassemble/link real
instructions and compare them with independent arithmetic, aggregate, ABI and
strict-trap models. Tests cover linked ordering/origins, large IDs and frames,
distant branches, resource failures and transport framing. Cross-toolchain
absence is an explicit skip. These instruction-model checks do not establish
execution on RISC-V hardware or a performance advantage.
