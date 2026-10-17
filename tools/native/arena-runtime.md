# Compiler storage adapter

`arena_runtime.c` implements protocol version 1 for the A0 compiler storage modules.
It provides invocation-local word allocation, bounded load/store, output and cleanup.
It does not interpret source bytes, IR, types, compiler options or generated code.

The generated C wrapper selects `A0_COMPILER_READ(t)` and
`A0_COMPILER_WRITE(t,v)` explicitly and associates each invocation with a session.
The `a0_io` layout and its ordinary buffered behavior remain available. Distinct
sessions share no mutable state; one session must not be used concurrently. A
concurrent wrapper needs a separate session binding for each invocation/thread.

The initial reply is `[0,2,0x41304152,1]`. Requests are
`[operation,argumentCount,arguments...]`; replies are
`[status,payloadCount,payload...]`. The header documents each operation, status,
budget, error and lifetime rule. Source upload is one byte per u32 word. A0 owns
all lexical, vector-growth, hashing and collision-resolution decisions.

The wrapper must require a successful entry status **and**
`a0_arena_is_complete(session)` before publishing output. This catches unread
replies, partial requests and missing FINISH even when a generated read would
otherwise produce a zero. A failure never selects another compiler. FINISH frees
the word allocations and retains output/code; output pointers remain valid until
output growth, reset or destruction. Handles and metadata are valid only within
their originating invocation; reset starts a new handle namespace.

The adapter is currently a frontend migration component. Before packaging it in
a compiler, record the protocol version, exact adapter source hashes and wrapper
configuration alongside the compiler artifact provenance.

After `bun run build`, run `node --test dist/test/arena-frontend.test.js` for
native A0-generated integration, the independent host model, byte-token oracle
and symbol-ID oracle. The tests use isolated temporary build directories and
warnings-as-errors with undefined-behavior checks at O0 and O2.
