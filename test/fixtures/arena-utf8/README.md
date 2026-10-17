# UTF8 native fixture transport

These fixtures implement file-backed full-u32 transport, storage snapshots,
fault injection and independent expected-output assertions. All decoding and
vector growth decisions run in A0. `cases.mjs` retains the frozen 645-case plan;
formatting and repository-relative loading do not change any input or oracle.
The `.d.mts` files supply types without requiring tsc to copy MJS fixtures.
The compiled test loads MJS files explicitly from the repository fixture path.

The fixed three compiler roots are `arena_utf8_decode`, `arena_hello` and
`arena_finish`. The fresh verified seed compiles that closure, and Clang builds
O0/O2 with ASan+UBSan/Werror. `driver.c` includes `arena_runtime.c` for access to
all original allocation capacities; it must be compiled alone with the runtime
include directory, never linked with a second runtime translation unit.

Each request is a little-endian file of 15 header words followed by full-u32
source cells. The header is:

```
[0x55384e50, mode, budget, sourceWords, logicalLength, paddingHandles,
 badHandle, faultOp, faultNth, faultStatus, faultKind, lifecycle,
 slot, forgedLength, appendCount]
```

Modes are public decode0, internal append geometry1 and pure unit2. Geometry
controls use forged vector lengths to test overflow, not physical full-u32
allocation. The default 32M-word budget is a test-host allocation budget.
Fault kind1 replaces a selected completed generic reply with a status; kind2
shortens a LOAD count. The underlying reply is drained first. Padding handles
come from real generic allocations; the handle65,537 control does not forge the
allocation directory.

The reply has nine header words, 128 metadata words, decoded byte words and
relation words:

```
[0x55384e50, mode, status, cleanupPolicy, flags,
 allocatedBeforeCleanup, allocatedAfterFinish, decodedLength, relationWords]
```

Flags1/2 mean original source/allocation snapshots match after decoding;4 means
IO matches;8 hello passed;16 selected fault fired;32 FINISH/session completion;
64 real sticky error;128 real already-finished state;256 original allocations
matched before the earlier FINISH. For ordinary requests, cleanupPolicy0
requires drained/finished sessions with zero allocated words. Synthetic status1
or5 does not change this policy. Real sticky protocol failure uses policy1:
all original live storage is checked, then host destroy; allocatedAfterFinish
is the UINT_MAX not-applicable sentinel. Real already-finished policy2 checks
storage before FINISH, then requires decoder status5 and zero retained storage;
no post-free source comparison is claimed. All other cases compare every full
old allocation, including unused capacity and the source sentinel, plus IO.

Success checks Node Buffer UTF8 bytes, whole UTF16 totals, contiguous seven-word
relation coverage, byte-identical valid copy runs and one maximal-subpart to
U+FFFD relation per replacement. Literal valid U+FFFD must remain a copy. Public
errors expose no decoded/origin vector or decoded/UTF16 total. These assertions
do not interpolate arbitrary interior UTF16 positions. The subprocess timeout
is an external harness abort, never a returned decoder status or fallback.
