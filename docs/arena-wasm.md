# Experimental direct Wasm arena service

This is an experimental scalar, unoptimized milestone. The current public compiler
route remains unchanged. Input-dependent compiler decisions and all output
bytes are computed in A0.

`compiler/emit_wasm_arena.a0` imports the shared `executable_bytes.a0` and its
canonical arena-vector dependency. It accepts immutable ctx16 plus the A0BCv1
descriptor from `backend_context_arena.a0`. Do not substitute packed legacy
tables or an optimized context without an appropriate origin adapter.

## Entry points

`arena_wasm_options() -> u32x128` returns schema1 defaults. Cells0..6 are
`[1, IN256, OUT1024, simd0, unroll1, optimize0, exportsPresent0]`.
Cells7..9 describe the raw UTF-8 export-name byte vector;10..12 describe the
u32 span vector containing `[offset,length]` per name. A vector is
`[handle,length,capacity]`, and all handles belong to the supplied arena session.
Absent roots export all functions. Present empty roots export no userfunctions.
Names match exactly and duplicate roots form a union. A0 computes reachability
and userfunction/type/code pruning; runtime helpers remain conservative.

`arena_wasm_emit_options(io,ctx16,D128,options128)` returns
`(status,outVector,info128,io)` without publishing. Nonzero status returns the
zero output vector. `info[110]` identifies the failed export-root ordinal when
name resolution fails. `arena_wasm_emit(io,ctx,D,IN,OUT)` is the scalar,
unoptimized, unroll1, all-exports convenience entry.

`compiler/wasm_service_arena.a0` composes the ordered source frontend/verifier/lowerer.
Its state is `J=(E128,backendState,options128)`; backendState is the shared
`(V128,ctx16,D128,Q)` state. Its public entry points are:

- `arena_wasm_source_begin(io,sourceHandle,byteLength,options128) -> J`
- `arena_wasm_source_resume(J,schedulingQuantum) -> J`
- `arena_wasm_source_done(E128) -> bool`
- `arena_wasm_source_status(E128) -> u32`
- `arena_wasm_source_result(J) -> (status,outVector,io)`
- `arena_wasm_source_publish(J) -> (status,io)`

The host repeats opaque resumptions until done. Scheduling quantum is distinct
from source-language fuel; there is no outer semantic step ceiling. Status7
can be pending or terminal, so the done predicate is authoritative. Unit imports
produce terminal7. Source result consumes the IO token; publish is an explicit
convenience wrapper over result followed by `ew_emit` on success only. Original
source bytes and ctx/D remain immutable. FINISH releases session allocations.

Statuses1..5 preserve generic transport errors.6 is malformed options/unsupported
IR or descriptor.7 is arithmetic/target geometry refusal in the emitter, and
also preserves frontend terminal7 where applicable.8 explicitly refuses the
currently unported SIMD, optimizer or unroll2/4 option combinations. Source
frontend diagnostics remain in the embedded backend state.

## Target ABI and lifetime

Wasm exports `a0_<name>`, `memory`, and immutable `__heap_base`. No imports are
required. Scalars, booleans and IO tokens use i32. Aggregates contain contiguous
32-bit words, including bools; arguments are readonly addresses. An aggregate
result adds a first sret-address argument and has no Wasm return value.
Overlapping sret/source storage is safe because callee results are formed in a
private frame before the final copy. The compiler never uses memory at or
above `__heap_base` except through explicit caller addresses/IO.

IO storage is `[input[IN],ninput,position,output[OUT],noutput]`. Canonical exhausted
read returns0 without advancing. Output overflow drops writes. Puts writes the
length followed by elements, each subject to the output capacity. Strict reads
trap on exhaustion. Checked operations remain total in strict profile.

Strict exports the current decoder's six immutable trap-address globals. Names
come from the original descriptor byte pool, with original function/node IDs
used for chains and iteration sites. Bounds/divzero/input traps retain the
innermost marked original fold/loop trip. A trapped Wasm instance is discarded.

Compiler values/vectors are session retained and FINISH frees them. Failure to
allocate produces an explicit resource status. Target frames restore the
shadow stack on normal return. Wasm32 address/section arithmetic is checked;
engine memory/module limits remain separate target constraints.

## Remaining parity work

SIMD/default optimize:true/unroll2/4 are explicit refusals; no public route may
be switched using these defaults. The emitter uses conservative aggregate
copying and per-node locals/private slots. Owned variants, inline calls/bodies,
lazy arms, loop rotation, pointer walks, constant pooling/deduplication,
stackification/local packing and TypeScript byte/code-generation parity are
unfinished. Runtime helper pruning and strict mayTrap/site elision remain
conservative. Linked-source/import composition and optimized A0BO origin
overlays remain unimplemented. The language's4096 nodes/function,65536functions
and value-width limits remain intentional; the legacy packed/paged compiler
ceilings are not carried into this representation.

Permanent tests build a fresh current verified seed in caller-owned scratch through
`test/helpers/native-arena-compiler.ts`, then that A0 seed compiles the source
service before actual WebAssembly runtime checks. The host provides only generic
source/options transport and opaque continuation scheduling. No retained private
binary, target assembler or host source-compiler fallback is used. Clang/POSIX
availability is the only permanent test skip; no external Wasm SDK is needed.
