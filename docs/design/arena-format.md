# A0 source formatting and internal revisions, schema 1

This shared component passed an isolated native proof at O0 and O2; [results](../../results/arena-format-native.json) record every output. It is not yet routed through the public CLI or editor, and has no host formatting/hash fallback. Inputs are original full-word schema1 parser/checker states, not optimized backend contexts. Source bytes are the frozen valid UTF-8 snapshot; raw malformed-byte/unpaired-surrogate decoding remains a separate boundary.

## APIs

`arena_format(io,M128,PS128,mode,functionID,skipSpecs) -> (status,V3,io)`.
`arena_format_described(io,M128,PS128,mode,functionID,skipSpecs,mapping) -> (status,V3,F128,io)`.
Modes 0/1/2 mean `formatFunction`, `formatProgram`, `formatSource`. Function ID is used only for mode0. V3 is `(handle,lengthWords,capacityWords)` containing UTF-8 bytes, one per cell. Mode0 omits final LF; program/source match reference empty/profile/comment/import/blank-line behavior. Content modes can format unchecked syntactically valid input, including out-of-range parameter decimals canonically represented through `number_integer`.

The component formatter emits the flat source spelling in every scope: `A` through `Z` then `pN` parameters, `_` scalar types, safely inferred scalar signatures, aggregate literals, quoted text, `<<`/`>>` shifts and unambiguous direct calls. Program/source formatting of an empty program is empty. These components remain outside the public CLI/editor routes until the source migration gates pass. Revision serialization uses a private entry into the same emitter and traversal; its historical full headers and spelling, including the empty-program LF, remain byte-stable. This internal hash representation is not another source mode.

`arena_revision(io,M128,PS128,mode,functionID) -> (status,hexV3,io)`.
Modes 0/1 mean SHA-256 of internal function/program serialization bytes including specs. Mode2 is the semantic revision of a checked function. It hashes the own function without specs, then hashes that hex string with an optional `profile strict|` prefix and ASCII-sorted, unique body callee/predicate entries `|name=semanticHash`. Every dependency must precede its caller. Even a leaf is double hashed. Contracts are not body dependencies. Hex is exactly 64 lowercase ASCII bytes.

Semantic revision requires successful ordered verification supplied by the caller; M96 alone is not a verifier-completion credential. It rejects parse-only/pending states and incomplete resolution-vector geometry. No helper silently strips specs or promotes pending verification. The current algorithm computes earlier functions in order and retains their scratch; a later target with many unrelated earlier functions can consume more work/storage than the reference's reachable recursion. Insertion sorting distinct dependency names is quadratic. No performance equivalence is claimed.

## Inputs and errors

M93=1. Successful M0=0 can be parser-only or checked. M0=7 is accepted for text/content only when raw specs exist, complete grammar was retained and supplied PS exactly matches the persisted128-word grammar snapshot. Schema/version, source identity, completion controls and record widths are checked. This is an internal immutable-component contract, not authentication of arbitrary host-forged graphs. Successful checked M may retain checker control values in parser scratch slots.

Status0 means success; arena runtime errors1..5 propagate, including invalid handles/ranges/resource limits. Status6 means invalid request/input schema; status7 means incomplete/unsupported internal state. Invalid requested function IDs/modes are6. Arithmetic overflow in the semantic memo extent is3. Failed public V is `(0,0,0)`; failed F has no usable events/output length. Partial scratch allocations remain invocation-local until caller FINISH. The formatter never changes M, PS, original source or any preexisting allocation; it appends separate outputs/stacks/events. Caller owns session lifetime/FINISH.

Every table ID/count/offset is full u32. Type/literal traversal uses growing explicit action stacks, not host recursion or an arbitrary depth cap. Language parser limits (including64-character identifiers and65536 array dimensions) still apply to source. There are no legacy frontend page/node/operand/name encodings in this formatter. Text output uses decoded operand bytes rather than re-decoding raw text spans, so dense and canonical frontend text retain their own exact lowering semantics.

## Optional text events (A0FT v1)

F0=status, F1=0x41304654, F2=1, F3=mapping enabled. F4..6 is a growing six-word event vector. F8 is the current parent (UINT_MAX on success), F9=output byte length, F10=mode, F11=functionID, F12=skipSpecs, F13=source handle, F14=source byte length. With mapping disabled, F4..6 remains zero and emitted bytes are identical.

Each event is `[kind,subjectID,fieldIndex,outputStart,outputLength,parentEventID]`. Parent is UINT_MAX or an earlier event containing the child's output range. The descriptor is separate from parser/source states and does not invent source spans. A dense-origin producer can relate whole type/literal regions to original parents and use exact matches only where bytes really match.

| Kind | Subject / field |
| --- | --- |
| 1 | function header / function ID |
| 2 | parameter type / function ID, parameter index |
| 3 | result type / function ID |
| 4 | body node / global M node ID |
| 5 | node name / node ID, 0 body or1 contract |
| 6 | opcode / node ID, 0 body or1 contract |
| 7 | callee / node ID, 0 body or1 contract |
| 8 | predicate / node ID, 0 body or1 contract |
| 9 | body operand / actual global M operand row ID, argument index |
| 10 | return line / function ID |
| 11 | return operand / actual global M operand row ID, function ID |
| 12 | example line / PS example row ID |
| 13 | literal AST node / PS literal row ID |
| 14 | contract node / PS node row ID |
| 15 | contract operand / actual global PS operand row ID, argument index |
| 16 | comment / M comment row ID |
| 17 | profile / M line row ID |
| 18 | import / M import row ID |
| 19 | complete function / function ID |
| 21 | function name / function ID |
| 22 | end keyword / function ID |

Text byte operand events9/15 cover the output byte or complete escaped spelling of that decoded byte. Generated inline-return names remain distinct name events; the printer assigns no invented exact original name span. Types are whole tokens; this API does not parse type spellings a second time. Event coordinates are canonical output byte offsets, independent of source UTF16/byte origin relations.

Flat spelling can omit a token or represent several origins with one printed value. Inferred parameter/result types retain their existing event identities as zero-length anchors after the function name, inside the header event. Implicit aggregate/text opcodes cover their opening delimiter, and an implicit direct-call opcode covers the callee token alongside the callee event. Repeated aggregate elements retain every operand/literal event identity and alias the corresponding range in the first printed element, including all nested literal origins. These ranges describe the emitted representation, not an exact source-token match. Parent IDs still precede children and contain their ranges; output starts are nondecreasing within a parent, with equal starts and overlapping ranges permitted. Consumers must not require disjoint ranges or strictly increasing starts. Mapping never changes the emitted bytes.

## Validation and integration status

The native component proof covers 544 source sessions and 4188 component requests, with 4132 exact byte/SHA checks, 3568 mapping checks and 56 expected explicit failures; see [native results](../../results/arena-format-native.json) and [provenance](../../results/arena-format-provenance.json). The same original-source fixture protocol is packaged in `test/fixtures/arena-format` with five permanent native test groups. They create a fresh verified seed and compile the current fixed implementation closure under UBSan/Werror at O0/O2 in their own temporary directory. The recorded isolated proof additionally used ASan. The permanent test package needs its normal repository run after integration; static package checks are not a new native proof.

Nine actual A0 source mutation controls were detected under the explicit development bootstrap, as separately recorded in [development mutation results](../../results/arena-format-mutations.json). They are not nine native compiler builds. Native status/table corruption controls remain in the permanent fixture driver. The failed pre-Clang driver-manifest attempt and unchanged-emission reuse are recorded in provenance rather than relabelled as a successful build.

Raw malformed UTF8/filesystem decoding, unpaired host surrogates, optimized A0BO views, direct DenseOrigin3 composition, public-route removal and performance equivalence are outside this milestone. Semantic dependency insertion is quadratic, and earlier unrelated functions can increase scratch/work. These costs remain explicit rather than causing a hidden fallback.

The permanent assertions additionally check descriptor mode/ID/spec flags, zero disabled event views and explicit event identity/spelling for a small example (body and return operand rows, spec literals, types and function name). These assertion-only additions do not alter the frozen runtime requests or byte/hash expectations; they await the normal fresh-seed repository run.

Integration renamed private revision helpers from `ar_` to `arev_` to avoid collisions with the RISC-V emitter. The recorded isolated proof retains its original source identities; permanent tests build the current renamed implementation.
