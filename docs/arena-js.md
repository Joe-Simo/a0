# A0 original-source JavaScript service

`compiler/js_service_arena.a0` composes the arena parser, ordered verifier,
shared checked backend context and JavaScript emitter. Input is original UTF8
source bytes in generic arena storage. All source parsing, typing, IO ownership,
spec evaluation, lowering, target names, guards and emitted text decisions run in
A0. No production CLI route is changed by these modules.

`compiler/emit_js_arena.a0` emits canonical and strict operations 1..37, including
all six total checked operations. It uses full-u32 type/node/operand/name indexes,
without the old paged frontend's table or operand encoding ceilings. Existing
source-language limits remain. `compiler/js_text_arena.a0` uses generic growing
byte vectors and target-specific `ajtext_` helper names, avoiding verifier helper
collisions. Shared `arena_vector.a0` and `executable_bytes.a0` are not duplicated.

The emitter preserves public JS type guards and IO identity, flat Uint32Array /
Uint8Array representation, bool decoding, nested plain-array representation and
copying updates. Retained caller aliases and immutable iteration extras remain
valid because every set/put copies its outer container. Flat literals use typed
array constructors from an array, avoiding spread/call argument ceilings. Prefixed
internal names plus export aliases preserve original reserved/helper-looking
names. A user function named `a0_make_io` takes the export name over the convenience
IO constructor. Strict runtime frames and iteration metadata use original
function/node spellings, including synthetic return IDs and unsigned trip counts.
Profile flag bit0 controls strict behavior; bit1 remains reserved.

## Service API

```
Q = (V128,M128,grammarP128,binderB128,aeMachine128,aeIR128,io)
J = (E128,Q,context16,descriptor128,linkState128)
arena_js_begin(io,sourceHandle,byteLength) -> J
arena_js_resume(J,quantum) -> J
arena_js_status(E128) -> u32
arena_js_result(J) -> (status,(handle,length,capacity),io)
```

E0 retains failure. E1 is stage0 verification,1 lowering,2 emission,3 terminal.
E2 is schema1; E3/4 source handle/length; E5 failure stage1 frontend,2 adapter,
3 emitter,4 unsupported unit imports,5 linker; E8 is source kind0 unit/1 linked;
E16..18 is output vector. Pending means E0==0 and E1!=3. A returned numeric7 can
also be a terminal refusal, so status 7 alone must never trigger an infinite retry.
Only completed success exposes a nonempty output view. The caller transports that
view, finishes the arena protocol and checks complete/drained FINISH before
accepting output.

The whole source is parsed before semantics. Verification then checks each body,
its complete spec types and its fresh-fuel example/pre/body/equality/post phases
before publishing the function and checking the next body. Lowering requires
V0==0 and V1==11; the checker marker alone does not establish spec completion.
Malformed source and spec grammar retain precedence over unit import refusal.
Unit imports are explicitly refused7, never stripped or silently ignored.

The auxiliary `arena_js_linked_begin(io,parsedM,successfulL)->J` retains linked
origins and selects `arena_backend_context_linked` only after ordered verification.
Its state path is included in the native-built closure, but linked entry execution
and filesystem composition remain outside this unit-source proof. The private
link wrapper is excluded from this package. Linked per-file specs/dense/UTF8
capabilities must be completed and proved before routing those inputs.

## Evidence and limits

The private native proof reused the verified 536667-byte A0 C seed and built the
989-function / 383136-byte service in 9 chunks, all code 0. Clang accepted the emitted
1605208-byte C with ASan, UBSan and warnings as errors. All input-dependent compiler
decisions were A0; TS linking/formatting/chunk planning was explicit build tooling.

The native service emitted73 modules and passed 9327 independent semantic
comparisons, 41 public ABI calls and 18 strict supplement checks. All 73 emitted
modules matched the earlier development A0 service bytes. Additional 51 requests
covered ordered spec diagnostics, parse precedence, explicit import refusal,
resource failures, pending continuations and output budgets. Seven capacity cases
covered reserved/helper exports, 65536-element u32/bool literals, 9000 functions and
types,68002 global nodes with exact original strict metadata, and exact 2 MiB input.
Every native request checked unchanged source bytes, opaque IO identity/bytes,
complete FINISH and released arena allocations. Permanent tests rebuild from the
current verified seed in isolated temporary directories.

This is bounded correctness evidence. The emitter uses copying updates and does
not run the TS optimizer or claim optimizer, byte-size or performance parity.
Strict runtime inclusion may be broader than the TS may-trap scan. The frontend
and adapter trust their documented checked/schema preconditions; arbitrary forged
foreign contexts are not authenticated. No target runtime fallback or production
routing is introduced. The complete compiler migration remains ongoing.
