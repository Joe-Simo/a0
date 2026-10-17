# Full-word A0 Java service

This experimental service consumes original checked schema1 through ctx16/A0BCv1. Every
source grammar, ordered spec, type, naming, Java ABI and target-text decision
executes in A0. TypeScript is the explicit initial bootstrap and test oracle.
There is no target fallback, host target plan, public route or performance claim.
The private proof retains the complete source/dependency snapshots.

## Emitter

```
java_emit(io, context16, descriptor128) -> (status, bytesV, io)
java_emit_options(io, context16, descriptor128, inputCapacity, outputCapacity)
    -> (status, bytesV, io)
```

Default capacities are256/1024. Capacities0 are supported. Values beyond Java's
nonnegative int array length domain are refused before output. `bytesV` is a
growing arena `(handle,length,capacity)` vector of UTF8 bytes, not publication.
Call generic `ew_emit`, then FINISH and check completion. The original context,
descriptor, every preexisting allocation including unused capacity, and source
bytes remain unchanged. Failure returns a zero public vector. First failure
wins:1..5 are generic transport/resource codes,6 invalid metadata/dependencies,
7 a declared target refusal or coordinate limit. Generic EMIT can independently
fail4 when the caller's publication budget is too small.

Semantic checking and completed ordered verification are preconditions of the
direct interface; A0BC is not a cryptographic authentication of foreign tables.
The emitter checks original D/ctx identity/count/profile headers and original
function/global/local IDs, and scans all function nodes before output. A0BO
optimized contexts are not accepted by this candidate. Original function and
node spellings come from the immutable context pool selected by the adapter.

Public Java ABI is `A0Module`, exact public static source method names, `int`
u32 bit patterns, `boolean`, `A0Io`, Java arrays, and `R_<structural-mangle>`
immutable records with `f0()` accessors. Helpers use `__a0_`, excluded by source
identifier grammar. Every call/body/predicate is class-qualified, allowing
contextual `yield`. Java keywords/literals and the zero-argument declarations
`wait`, `notify`, `clone`, `finalize` are atomic target refusals. Lower-case
getclass/tostring and record/var/sealed/permits are valid positive cases.

Array updates shallow-clone the outer array on every set. Record updates build
a fresh record and retain unchanged references. Array literals allocate their
declared Java array and assign each nonzero literal/nonliteral operand in order;
zero scalar stores are omitted. No legacy page,8192-character mangle,16384-entry
stack, or function/node/operand address cap is used. Type mangling uses a growing
arena stack. Java array dimensions are limited to255 contiguous arrays, static
method parameter slots to255 and record constructor component slots to254.
These are JVM constraints; a record resets contiguous dimension counting.
An arena cache computes saturated mangle/Java descriptor/dimension lengths in
type-DAG order and checks every emitted user/helper/record-constructor/accessor
descriptor and ASCII name against the classfile65535-byte UTF8 bound.65536 is
the explicit over-bound sentinel; it is unrelated to the old8192 name cap.
The cache's capped addition relies on bounded callers: cached lengths are at
most65536, two-descriptor terms at most131072 and record component counts at
most254 before success. No successful-path sum can wrap u32. The cache does not
claim a general saturating-u32 arithmetic primitive.

Checked32..37 are total in both profiles. Ordinary strict get/set/div/rem/read
perform the language checks. Every strict function keeps a frame and every
strict fold/loop marks its original name/trip before the predicate. Safe frames
cannot enter a trapping call chain, so this conservative framing preserves
observable fn/at/trip/chain. Successful returns pop; traps copy the chain and
reset depth. Exact public A0Trap id/kind/fn/at/trip/chain/fix/message/line and
earlier IO writes are tested. Strict proof-based check elision and concurrent
Java calls are not claimed.

## Original-source continuation

```
arena_java_begin(io, sourceHandle, sourceBytes) -> J
arena_java_begin_options(io, sourceHandle, sourceBytes, inCap, outCap) -> J
arena_java_resume(J, schedulingQuantum) -> J
arena_java_result(J) -> (status, bytesV, io)
```

`J=(E128,Q,ctx16,D128,L128)`, where Q is the existing ordered verifier tuple.
E0 is selected status; E1 phases0 verification,1 adaptation,2 emission,3 terminal.
E2 is service version1; E3/4 original source; E5 stage, E8 linked flag, E9/10
IO capacities, E16..18 result V. Pending is exactly E0==0 and E1!=3. Querying a
pending result returns7 and zero output. Terminal7 is a refusal, not pending.
Zero scheduling quantum preserves the opaque continuation. Unit imports are
explicitly refused; use the ordered-linked controller for a source graph.

## Ordered-linked continuation

Consume `fs_hello` before uploading paths. OS calls/raw bytes are the generic
FSv1 protocol; all path, graph, profile, parse, check and spec choices remain A0.

```
arena_java_link_begin(io,entryH,en,rootH,rn,explicitRoot,override,dense,work) -> K
arena_java_link_begin_options(...,inputCapacity,outputCapacity) -> K
arena_java_link_resume(K, schedulingQuantum) -> K
arena_java_link_result(K) -> (status,bytesV,io)
```

`K=(E128,R,ctx16,D128)` and R is the frozen linked-verifier tuple containing Q
and LS2. Its successful ordered-verification marker18 is required before the
adapter receives Q1+LS2. The controller retains all selected original facts and
source snapshots. E phases/status/result slots match the source controller.
The frozen linker explicitly refuses dense and malformed UTF8; this candidate
does not promote those terminal7 states or substitute host parsing.

## Proof status and limits

The frozen verified-seed-native proof passed130 requests on each of O0/O2
ASan+UBSan builds:260 requests with identical130 paired packet outputs and target
bytes. The1221-function/481995-byte closure emitted12 successful seed chunks.
The existing536667-byte verified seed executable was reused read-only. C/API,
driver, tools, binaries, requests and outputs are hash-bound in
[results/arena-java-provenance.json](../../results/arena-java-provenance.json) and
[results/arena-java-native.json](../../results/arena-java-native.json).

Independent target checks cover3596 canonical and2356 strict checked values per
source/direct boundary,97 canonical and174 strict direct ABI assertions, and
large arrays/functions/dimensions/capacities. JVM execution covers selected
linked targets, including180 strict two-file assertions. Other linked successes
are emission/metadata checks. Generated-Java clone/checked-flag mutations are
expected failures; they are not A0 source mutants. Only existing allocations at
retained emission seams are compared. This adds no full-linker buffer-immutability
claim. Generic EMIT is atomic per request; no post-EMIT rollback is claimed.
Fresh-seed permanent tests must be run after repository integration.

The T12 record-tree boundary proves successful emission above the old8192 name
cap; it makes no filesystem/javac success claim. T13/T14 refusals can select the
earlier T13 helper descriptor overflow and do not isolate the final T14 name
guard. Necessary guard coverage and complete artifact acceptance are distinct.

This is not yet a complete classfile/artifact planner. Method-code lengths,
constant-pool/member counts and javac-generated record members can still
constrain otherwise valid A0 programs. Long structural
record class names can exceed a filesystem filename-component limit before a
JVM limit. Emission success alone does not establish javac/JVM success for
unexecuted shapes. These are explicit remaining target/artifact limits, not
legacy compiler storage limits or a hidden fallback. Public routing, BO,
DenseOrigin3, malformed raw-byte decoding, Windows paths and runtime performance
remain separate milestones.
