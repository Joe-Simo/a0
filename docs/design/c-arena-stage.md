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
writing an exclusive temporary file beside the destination, flushing and
committing it, closing it, and replacing the destination. POSIX uses
`mkstemp`/`fsync`/`rename`. MinGW uses a wide `wmain` for both input and output
paths, `CreateFileW(CREATE_NEW)`, `_commit`, and
`MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`. It does not enable cross-volume
copy or truncate an existing destination as a fallback. A failed
compile, exhausted budget, malformed transport reply, partial publication, or
incomplete FINISH leaves an existing output untouched. A failed worker join
exits without freeing storage that the worker could still use.

`tools/c-arena-stage.ts <artifact-directory>` uses the verified native seed to
bootstrap this fixed implementation. TypeScript only links and plans that
development bootstrap. Every subsequent stage runs with C and pthreads, consumes
the same frozen linked original A0 bytes, and uses the same generic shim. C is
passed verbatim to the selected C compiler. `CC` selects one compiler executable;
Clang is the development helper's default. The proof requires stage 2, 3, and 4 C to match and
records refusal or native build failures instead of selecting a fallback.
An emitter repair requires a new frozen compiler source containing that repair;
the prior failing input and emitted C remain separate evidence.

For a separate C-only phase, prepare the fixed implementation once with
`node dist/tools/c-arena-stage.js --prepare <prepared-directory>`. The directory
contains the original linked source, bootstrap-generated `module.c`, the generic
shim/runtime, and bootstrap provenance. Run
`CC=gcc sh tools/c-arena-stage.sh <prepared-directory> <output-directory>`
(or `CC=clang`). The script builds its initial stage from those C bytes, compiles
the same frozen source through stages2/3/4, builds every emitted module without
rewriting it, and requires identical emitted C. It needs a C compiler, pthreads,
the POSIX shell utilities `cp`, `cmp`, `mkdir`, `uname`, `grep`, and either
`sha256sum` or macOS `shasum -a 256` (plus `cygpath` under MSYS2). Compiler-defined
target macros select the wide Windows entry; native Cygwin keeps its POSIX entry.
It invokes no JavaScript runtime. `CFLAGS` supplies native
build flags; the actual compiler version, build/run logs and SHA256 manifest stay
in the caller's output directory. Script resources are the explicitly recorded
internal proof settings in `tools/c-arena-stage.ts`, separate from language limits.

The Windows verification workflow uses MSYS2 UCRT64 GCC/winpthreads and Clang.
Its C-only step removes Node and Bun from PATH, reproduces stages2/3/4 with each
compiler, and compares their final C. Separate native controls exercise Unicode
and spaced paths, existing output replacement, write/flush/commit/close/replace
failures, directory replacement refusal and worker create/join lifetime. These
host controls use a clearly labelled fake module; source/compiler proofs always
use actual A0-emitted C. MinGW sanitizer availability differs from POSIX, so its
default controls do not request UBSan. `buildCStage` exposes explicit optimization
and sanitizer settings for comparisons. A configured CI route does not itself
establish a passing Windows result.

`test/fixtures/c-arena-stage/arena32.c` is a separate generic-runtime control
that requires real 32-bit `size_t`. It checks multiplication-overflow refusal
before allocation, then a successful small allocation and FINISH. It can run
with a native 32-bit C runtime or WASI; it does not add a WASI dependency to the
C-only stage.

The [portable proof](../../results/c-arena-stage-portable.json) records Linux
GCC/Clang stage equality, source and host controls, real 32-bit runtime coverage,
and the explicitly pending Windows CI result. These are correctness checks;
interleaved local runs do not establish comparative performance.

The underlying C service's existing capability restrictions still apply:
imports need a linked service; flags are currently zero; strict operations need
the emitter's proof or checked-operation support. This stage does not alter
ARM64, native CLI graph policy, diagnostics, private revision serialization,
the public formatter, or bootstrap defaults.

The retained [internal stage proof](../../results/c-arena-stage.json) records
exact original-input and generated-C hashes, the initial large-constructor
failure, the generic repair, and the successful repeated stages. It is a
correctness result for this bounded stage, without performance or public
cutover claims.
