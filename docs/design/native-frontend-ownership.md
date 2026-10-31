# Native frontend copy and lifetime design boundary

The current owned reply fold already updates a page in place. Batching scalar writes did not
remove the remaining ownership boundaries and regressed small-input cost; those experiments
were rejected. No change described here is implemented or measured as an improvement.

## Attribute copies before changing representation

Instrument the existing six unchanged inputs by frontend phase. Count arena requests,
payload words, live/cumulative allocation words, and copied bytes at each generated call site.
Distinguish protocol snapshots, vector growth, immutable parameter copies and return-value
copies. The existing sampled `memcpy` total cannot make this distinction. Diagnostic counters
must not be included in the timed artifact, and executable-section equivalence must be checked
when symbolized profiling artifacts are used.

## Internal C call ABI

A candidate change is a private borrowed-parameter/caller-result ABI for read-only aggregate
arguments and single-consumer aggregate results. Preserve public by-value entry wrappers.
The compiler must prove that each borrow cannot escape, that result storage does not alias a
still-live input, and that mutations copy before writing shared storage. Calls, returns,
record projections, selects and loop state must share the same liveness/alias analysis.
This may remove copies; it does not automatically remove heap allocations because many of
these values live on the stack or in an embedded session buffer. Attribute that distinction
before predicting an allocation reduction.

## Arena view lifetime

An internal read-view operation would need an opaque descriptor containing the handle,
offset, length and a session generation, with a borrow tied to the linear I/O token.
Validate handle/span/generation on creation and use. Writes, reset and storage relocation must
invalidate the view, or be statically forbidden while it remains live. A raw host pointer or an
unchecked cached view is not equivalent to today's snapshot reply. Every arena adapter and
the independent reference model need the same failure ordering and invalidation behavior.

## Vector growth

Resizing an existing handle changes what aliases can observe. A movable resize operation
therefore requires an explicit uniquely owned handle capability and proof that no observable
alias survives. Otherwise allocate a new handle and preserve the old one; a host-side checked
copy could reduce transport traffic but cannot claim to eliminate the necessary old/new
storage. Allocation failure must leave the original vector usable and unchanged.

## Acceptance before retention

Preserve ordinary/strict behavior, first errors, source and revision identity, and target
outputs. Cover aliasing, wraparound, empty spans, resource exhaustion, stale views and reset.
Compare paired unchanged inputs on one quiet host, including cold process wall time, frontend
CPU, peak RSS, emitted size and compiler-build cost. Report mixed results and uncertainty.
No public frontend cutover follows from a diagnostic profile or an unmeasured design.
