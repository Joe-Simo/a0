# Internal source-to-C arena service

`compiler/c_service_arena.a0` composes the shared source grammar, ordered
verification, `arena_backend_context`, and the full-word arena C emitter.
It does not format or reparse source through the paged bootstrap frontend.
Public compiler defaults and the bootstrap route remain unchanged.

```
arena_c_source_begin(io, sourceHandle, byteLength, inputCapacity, outputCapacity, flags)
    -> state
arena_c_source_resume(state, verificationQuantum) -> state
arena_c_source_done(state.0) -> bool
arena_c_source_status(state.0) -> status
arena_c_source_result(state) -> (status, byteVector, io)
arena_c_source_publish(state) -> (status, io)
```

The host uploads source bytes to the generic arena protocol and repeatedly
resumes the opaque state until `done`. The verification quantum controls only
the existing ordered verifier. Parsing, structural lowering and C emission
retain their existing scheduling. A terminal resume leaves the state unchanged.

State is `(E128, backendServiceState, (inputCapacity, outputCapacity, flags))`.
The final tuple retains the exact compiler inputs. `E0` is the terminal status,
`E1` the terminal marker, and `E3..5` the byte vector. The status accessor returns
7 while pending. Both `result` and `publish` hide the vector while pending or
failed. Backend state retains the original checked source, verifier facts,
context and descriptor; this adapter does not reinterpret diagnostic codes or
discard catalog context.

The existing backend service finishes parsing the whole unit, then checks and
executes specifications in the defined order. Only completed successful
verification can lower the checked IR and invoke `c_emit`. This entry uses the
original context. It does not supply a shaped context or claim an optimizer
whose identity and provenance guarantees have not been established.

Source/check/spec, transport and lowering failures propagate unchanged. A unit
with unresolved imports terminates with status 7. The existing C emitter owns
backend policy: unsafe strict programs refuse with status 9; unsupported flags
refuse with status 12; other resource and representation refusals remain
explicit. The service adds no source-language mode or target fallback.
Configured capacities retain the existing buffered C ABI. Emitted C also
supports the generic host hooks described in [arena-c-host-io.md](arena-c-host-io.md).

Emission builds a private arena byte vector before `result` exposes it.
`publish` uses the existing explicit `ew_emit` protocol. A transport or output
limit failure during publication can leave a prefix in the session output
buffer; it does not roll back that transport. A host must commit output only
after publication succeeds and FINISH returns the same successful code with
`is_complete`. Session handles and all retained source and diagnostic tables
remain live until FINISH.

This is an internal single-unit service. Linking, replacing the legacy
bootstrap driver, self-hosting fixed points and public source cutover remain
separate integration work.
