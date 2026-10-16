# Experimental arena Darwin ARM64 emitter

`compiler/emit_arm64_arena.a0` emits Darwin AArch64 assembly from the shared checked ctx16 tables and A0BCv1 original-identity descriptor. `arm64_service_arena.a0` composes the original-source arena parser, ordered verifier and context lowerer. `arm64_link_service_arena.a0` uses the ordered linked verifier and retains its source projections. These components do not change the public compiler route.

## Interface

`arena_arm64_emit_context(io, ctx16, D128, reservedStrict, options)` returns `(status, byteVector, io)`. The last two arguments must be zero. Function profile bit 0 selects canonical or strict behavior; the reserved argument is not a profile override. Canonical checked-table callers may supply zeroD. Strict emission requires the matching A0BCv1 descriptor, including original names and iteration identities.

`arena_arm64_source_begin(io, sourceHandle, byteLength, reservedStrict, options)` and `arena_arm64_source_pump(state, quantum)` operate on X13. Its fields are Q, ctx16, D128, output vector, three reserved zeros, reservedStrict, options, controller phase, status, LS2, and linked flag. Q retains the verifier and IO. Controller phase 0 means pending and 2 means terminal. Only verifier V0==0 with V1==11 can reach emission. Terminal unsupported 7 remains distinct from pending 7. Unit imports refuse 7 after complete grammar checking; use the linked service for imports.

`arena_arm64_link_begin(io, entryHandle, entryLength, rootHandle, rootLength, explicitRoot, profileOverride, dense, work, reservedStrict, options)` and `arena_arm64_link_pump(Y, quantum)` operate on Y=(X13, service128). The profile override follows the linked verifier:0 absent,1 canonical,2 strict. Success additionally requires service word 18==1 and completed ordered verification. Failed linked requests retain original-source diagnostic projection facts and emit no assembly. Dense, malformed UTF8 and other linked-verifier refusals are preserved.

Call the generic FS handshake before using the source/link services. Handles remain invocation-local. Publish the returned byte vector only after checking its status, the generic finish status and complete transport state.

## Supported behavior

The emitter implements all 34 IO-free operations, including six total checked operations, fresh aggregate snapshots, updates, nested records, calls, fold and loop. IO in signatures, nested aggregates or node results explicitly refuses 6, preserving the current ARM64 IO restriction. Unsupported options and missing strict metadata also refuse 6. It does not silently compile strict input as canonical.

u32 and bool aggregate fields occupy four bytes, pointers occupy eight bytes, and Darwin stack arguments retain natural packing: scalar u32=4, bool=1 and pointers=8. Scalar results use x0; aggregate results use x8. Aggregate parameters are copied on entry, including when x8 aliases an input. Functions preserve callee-saved registers, maintain 16-byte stack alignment and probe each stack page. Full-word offsets are materialized without instruction-immediate truncation. Layout/frame alignment overflow refuses 7.

Strict ordinary div/rem zero divisors and get/set bounds trap in evaluation order. Checked operations remain total. The reporter retains original function/node names, active loop/fold trip and caller chain. Large functions use a nearby inverse conditional branch followed by a wide unconditional trap branch, avoiding the conditional branch's 1MiB reach limit.

The arena frontend retains the existing 2MiB source and language function/node/parameter/aggregate bounds. This emitter adds no legacy fixed frontend function/node/16-bit operand tables. These existing semantic bounds are distinct from generic caller-selected arena/output/work budgets.

## Validation and limits

`test/arena-arm64-native.test.ts` builds this actual A0 service through a freshly verified native A0 seed. Initial linking, closure extraction and chunk planning still use host bootstrap tooling; no per-input TypeScript target emitter is used. The permanent tests distinguish source compilation from TypeScript-checked table emission.

POSIX tests crossassemble actual MachO objects and decode their real relocated instructions against independent BigInt, aggregate, alias and ABI oracles. They exercise checked totals, strict original frames/trips/first traps, deep records, distant strict branches, capacity boundaries, linked specs/origins, resource failures and complete byte framing. Arithmetic and copy faults must make independent oracles fail. The decoder has no compiler runtime-helper hooks; only generic Darwin stderr-write and exit syscalls are simulated.

A separate test runs the emitted assembly on macOS ARM64, including scalar/checked cases, natural stack arguments, x8 aggregate returns, overlapping input/output and exact strict trap text. Crossassembly/model results do not establish hardware execution; this test explicitly skips other hosts.

This remains an experimental component. Register allocation, optimizer integration, inlining, copy elision, NEON, full resource/performance parity, command diagnostics and authoritative routing are unfinished. The emitter's conservative copies preserve values, but they do not establish ownership/optimization parity. Existing advertised options and optimizations must be implemented and measured before replacing the public route. No performance or entire-compiler-completion claim follows from these component tests.
