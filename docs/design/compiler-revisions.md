# A0 revision hashing

`compiler/sha256_arena.a0` implements SHA-256 over immutable byte-valued words in the generic compiler arena. The A0S file is its explicit authoring/bootstrap input. FIPS180-4 constants and modulo-u32 schedule/round decisions execute in A0. Host code supplies word storage and transport.

`arena_sha256(io,handle,length)` returns `(status,digestWords8,io)`. The digest words have the standard big-endian SHA-256 numeric values. `arena_sha256_hex` returns `(status,byteVector3,io)` with64 lowercase hexadecimal bytes. Input length and offsets retain fullu32. Padding streams one64-byte block at a time; the byte-offset wrap of a final padding-only block never causes a source read. All source cells must be0..255. Generic transport/range/allocation failures propagate and public output is zero/empty on failure. Both APIs retain the caller's IO identity and leave source words unchanged. The caller owns FINISH/session completion and atomic publication.

Native regression tests build the closure with the verified A0 seed and exercise both APIs under Clang O0/O2 with UBSan/Werror. Independent oracles include published empty/abc/multiblock/million-a vectors and node:crypto over original bytes, padding boundaries, random binary payloads, UTF8, source beyond legacy capacities through2MiB, invalid byte cells/handles/ranges and insufficient output budgets.

This is a hashing component. The shipped CLI/editor revisions still use TypeScript formatting/hashing. Canonical source formatting, semantic revisions, edit sessions and public routing remain migration work; hashing an arbitrary source slice does not establish revision-format parity.
