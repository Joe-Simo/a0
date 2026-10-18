# A0 source formatting and internal revisions, schema 1

The shared flat formatter and private revision serializer pass the combined native checks at O0 and O2; [current integration results](../../results/arena-format-unified.json) record the verified source inputs and checks. They are not yet routed through the public CLI or editor and have no host formatting/hash fallback. Inputs are original full-word schema1 parser/checker states, not optimized backend contexts. Source bytes are the frozen valid UTF-8 snapshot; raw malformed-byte/unpaired-surrogate decoding remains a separate boundary.

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

The earlier isolated component proof covered 544 source sessions and 4188 component requests, with 4132 exact byte/SHA checks, 3568 mapping checks and 56 expected explicit failures; see its [native results](../../results/arena-format-native.json) and [provenance](../../results/arena-format-provenance.json) for those source identities. The original-source fixture protocol is packaged in `test/fixtures/arena-format` with five permanent native test groups. They create a fresh verified seed and compile the current implementation closure under UBSan/Werror at O0/O2 in their own temporary directory. The [combined integration run](../../results/arena-format-unified.json) passes those groups with the flat formatter and the native global-diagnostic fixes. The earlier isolated proof additionally used ASan.

Nine actual A0 source mutation controls were detected under the explicit development bootstrap, as separately recorded in [development mutation results](../../results/arena-format-mutations.json). They are not nine native compiler builds. Native status/table corruption controls remain in the permanent fixture driver. The failed pre-Clang driver-manifest attempt and unchanged-emission reuse are recorded in provenance rather than relabelled as a successful build.

Optimized A0BO views, direct DenseOrigin3 composition, public-route removal and performance equivalence remain outside this milestone. Semantic dependency insertion is quadratic, and earlier unrelated functions can increase scratch/work. These costs remain explicit rather than causing a hidden fallback.

The permanent assertions also check descriptor mode/ID/spec flags, zero disabled event views and explicit event identity/spelling for a small example (body and return operand rows, spec literals, types and function name). These assertions run in the current combined native checks.

Integration renamed private revision helpers from `ar_` to `arev_` to avoid collisions with the RISC-V emitter. The recorded isolated proof retains its original source identities; permanent tests build the current renamed implementation.

## Optional native SDK capability

`nativeSource(module, diagnostics?, formatting?)` and `directSource(artifact, diagnostics?, formatting?)` accept an optional `{load: () => WebAssembly.Module}` formatter capability. `tools/source-format-build.ts --out=DIR` builds the existing `arena_format_described` and `arena_revision` roots together. `prepareSourceFormat(DIR)` validates the artifact, source inventory and ABI manifest before returning a lazy loader. The frontend artifact and its default exports do not include this companion.

The engine exposes `format(result, {scope, functionIndex, skipSpecs, mapping})` and `revision(result, {kind, functionIndex})`. Scope is `function`, `program` or `source` (default); revision kind is `function`, `program` (default) or `semantic`. These select existing component boundaries, not source dialects. Successful formatting returns detached UTF8 `bytes`, `text`, descriptor `facts`, and six-word `events`; successful revision returns detached bytes and the existing lowercase hex revision. A native refusal retains its status and publishes no partial bytes/events. Missing ports/capability and absent sessions are explicit refusals. If the frontend failed before a schema1 state existed, the SDK returns `reason: 'incomplete-ir'` and the original `sourceStatus`, without calling the A0 formatter on an invented state.

Only an object returned by the same engine's current parse/check operation can be formatted. A subsequent native parse/check or `close()` invalidates it. Parsed source units retain their separate immutable snapshots for later `checkUnits`; they do not keep an earlier live arena available for formatting. Private copies of parsed/spec pages prevent mutations to the public result arrays or decoded Program from changing the formatter input. Bytes, mappings and diagnostic packets are copied before any reset; their returned copies survive reset/close. Descriptors contain native handles for inspection only, not reusable storage access.

The companion uses the same live arena read/write/token/view ports as diagnostics. Both codecs share `src/source-component.ts` for lazy import validation, flat-word ABI calls and detached vector reads. The existing compiled-source session driver is shared with the direct frontend; this adds no arena protocol, parser, source printer or host hash fallback. Loading, companion memory and private result registration occur only when configured/used. Formatter scratch consumes the current frontend allocation budget and remains until its session ends. No compilation, memory or latency equivalence is claimed.

Source parse/check-unit results carry original native comment/line tables. Structured `checkProgram` IR currently carries synthetic locations; authoring comments are restored only on its host Program and are absent from the native tables. Formatting that IR prints the represented native program and cannot preserve metadata that was never encoded. It is not a replacement for a source-preserving public structured-edit formatter. Public CLI/editor/default syntax routes are unchanged.

[SDK integration results](../../results/native-source-format-sdk.json) record the actual native checks and artifact/source hashes. `test/source-native-format.controls.ts` requires current C-derived frontend, companion, generic arena and diagnostic artifact paths through `A0_FORMAT_FRONTEND`, `A0_FORMAT_COMPANION`, `A0_FORMAT_ARENA` and `A0_FORMAT_DIAGNOSTIC`. It checks the independent source spelling/hash/mapping corpus, deep/wide data, the complete Life application and compiler graph, owned/stale/mutated results, source units, typed IR, actual allocation exhaustion, and joint diagnostic packet lifetime. Existing native hash, semantic and malformed/resource controls remain in the component fixture.

The separate `src/source-utf8.ts` boundary refuses unpaired host surrogates before native source upload, and is reused by structured IR span/symbol encoding. Each structured span is checked before joining so adjacent invalid strings cannot combine into a different Unicode scalar. This adds a UTF16 scan to ordinary source input and also checks the assembled IR source pool; it is a correctness change independent of lazy formatter loading. `decodeSourceUtf8` provides fatal byte decoding with BOM preservation for native filesystem/transport callers. Existing public filesystem readers have not been rerouted, so lossy decoding before that boundary remains a cutover task.
