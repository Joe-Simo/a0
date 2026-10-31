# Experimental private local arena contract

The normal frontend and public syntax are unchanged. The internal build tool accepts
`--local-arena=checked-experimental`; without it, the generated C and Wasm remain
byte-identical to the validated baseline. This is not a public frontend cutover.

The experiment replaces three complete, validated compiler-library operations:
allocation, bounded load and bounded store. The build binds actual typed function
objects only after verifying the entire pinned `arena_shared.a0` source and every
linked definition from that source. A changed dependency or strict semantic profile
is refused. Ordinary code is never selected merely because its function has a
matching name. The standard C emitter still handles all other functions, and the
ordinary compiler entry does not select these bindings.

A wrapper-private token maps to one local capability. A capability belongs to one
live session and gives access only to that session's handles. Handles are relative
to their session, not globally unique. No mutable storage pointer is returned by
these operations: load returns a detached 128-word page with a zero tail. Store
accepts a caller-owned page. The existing read-only frontend view API is unchanged.
A session/capability is used by one invocation/thread at a time; separate sessions
have no shared mutable state. Reentrant use of one frontend instance is unsupported,
as in the existing host contract.

Opening requires a drained, idle, healthy, unfinished v1 session and permits only
one live capability per session. Reset and destruction revoke it by clearing its
owner before freeing storage. An outstanding revoked capability safely returns a
protocol error until its owner calls close. Close frees the capability; no C call
is valid after close. The wrapper closes before resetting/destroying its session.
These are normal explicit C lifetimes, not a claim that arbitrary forged pointers
or calls after free can be made safe.

Operations preserve the complete-request v1 range/handle/budget order. Allocation
returns handle zero on failure. Load checks session state, bulk count, handle, then
range and zeroes its entire output even on failure. Source-level store rejects a
count above 128 before touching its token, then checks session/handle/range. No
operation repairs or bypasses a pending or failed wire session. An attempted local
call while a wire request is pending returns protocol failure without consuming
that frame. This is the local API's misuse refusal, not a claim that malformed
wire transcripts have identical side effects. The unchanged v1 decoder remains
the authority for malformed wire streams.

The capability adds one small metadata allocation per parse session. Payload
budgets remain word budgets; metadata is not charged against them, as with the
existing allocation table. Resource exhaustion fails closed; no hidden fallback
is selected. Source upload and other wire operations can still use v1 between
completed operations. Protocol version and ordinary IO behavior do not change.

Validation must precede performance: sanitizer contract comparison, full service
state and every live arena word, revisions and target outputs, invalid-input and
budget cases, existing v1 lifecycle tests, and broad source-coverage checks.
A separate counted runtime proves the reduction in word calls; timing uses the
uninstrumented artifacts. Performance/resource thresholds are frozen before the
fixed paired run. Real platforms and release gates remain outstanding.

## Measured bounded result

`results/local-arena.json` records the fixed 84-process, 336-call comparison against
`a143fb20` on six unchanged inputs. Later-call time ratio is 0.6078 (paired bootstrap
interval 0.5783–0.6472), first-call ratio 0.6633 and later-call CPU ratio 0.6880.
The module is 399,445 bytes versus 416,779. Linear memory size is unchanged in the
six cases. Peak runtime RSS rises up to 4.45%; paired build CPU and wall time rise
about 6.47% and 6.39%. These tradeoffs passed the saved thresholds; no samples were
replaced or added to force acceptance. This is not a comparison against all
languages or proof that the remaining native-frontend acceptance gap is closed.

The default C and Wasm are byte-identical. The final build also reproduces the
exact timed experimental Wasm after a standalone-header correction; that correction
adds only a standard C declaration include already present in the frontend driver.
The earlier failed standalone test is retained in the evidence archive.

The full-state sanitizer proof compares six 128-word service pages, allocation
counters and every live allocation word over 48 cases at O0/O2. The Wasm controls
retain all ten target output/refusal sets and failure-budget tests. The existing
broad audit passes 184 graphs, 485 legacy literals and 548 candidate literals with
all C/JS, IR and revision assertions enabled. The final available aggregate gate
is recorded separately against its exact committed tree; this document does not
claim a full-platform release gate.
