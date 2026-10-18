# Internal C arena stage

This experiment does not select a public source reader or replace the checked-in
seed. `compiler/c_stage_arena.a0` wraps the existing raw-source C service. It
parses the original file through the shared full-word A0 grammar, completes the
ordered checker and specification verifier, lowers checked IR, and emits C.
The continuation stays inside A0.

The entry is `arena_c_stage(io, sourceHandle, byteLength, inputCapacity,
outputCapacity, flags, quantum, resumeBudget) -> io`. Its existing C ABI is one
opaque `a0_io *`, seven `uint32_t` arguments, and the same returned pointer. The
shim maps that pointer directly to its arena session through the supported host
IO hooks; it never accesses the generated buffered IO layout or aggregate names.
The façade publishes only a successful terminal result, calls `FINISH(code)`
with the compile/publication outcome, and returns the resulting IO token.
Pending work after the caller's resume budget produces resource status 4.

`tools/native/c_arena_stage.c` accepts raw source and output paths, followed by
explicit arena/output word budgets, quantum, resume-call budget, generated
buffered input/output capacities, flags, and worker stack bytes. These are caller
resources. They do not change language acceptance limits. Quantum and resume
budgets bound scheduling calls; parsing, lowering, and C emission currently run
without preemption. Transport batches are the arena protocol's 128 words, not
source chunks or fixed source/compiler table capacities.

The host requires a joined worker, the identical session pointer, complete
FINISH with code zero, released arena allocations, and byte-only output before
writing a temporary file beside the destination and renaming it. A failed
compile, exhausted budget, malformed transport reply, partial publication, or
incomplete FINISH leaves an existing output untouched. A failed worker join
exits without freeing storage that the worker could still use.

`tools/c-arena-stage.ts <artifact-directory>` uses the verified native seed to
bootstrap this fixed implementation. TypeScript only links and plans that
development bootstrap. Every subsequent stage runs with C and POSIX, consumes
the same frozen linked original A0 bytes, and uses the same generic shim. C is
passed verbatim to Clang. The proof requires stage 2, 3, and 4 C to match and
records refusal or native build failures instead of selecting a fallback.
An emitter repair requires a new frozen compiler source containing that repair;
the prior failing input and emitted C remain separate evidence.

The underlying C service's existing capability restrictions still apply:
imports need a linked service; flags are currently zero; strict operations need
the emitter's proof or checked-operation support. This stage does not alter
ARM64, native CLI graph policy, diagnostics, private revision serialization,
the public formatter, or bootstrap defaults.
