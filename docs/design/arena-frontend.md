# Experimental arena frontend

`arena_parse(io,sourceHandle,byteLength)` and `arena_parse_check` in `parse_arena.a0` and
`check_arena.a0` return `(status,state,io)`. Source storage is immutable UTF-8 with one byte per u32
cell. All scanning, grammar, interning, type and ownership decisions execute in A0. The host implements
the storage protocol documented in `tools/native/arena-runtime.md`.

The state has128 words containing a constant number of descriptors and controls. Tables grow through
arena vectors `(handle,lengthWords,capacityWords)`; source spans, IDs, counts and structural type IDs
retain full u32 fields. Runtime resource failures remain distinct from language limits. Success also
requires the invocation's FINISH/session-completion checks. Complete public compiler routing is pending.

| State words | Table or facts |
| --- | --- |
|0..5|status, diagnostic ID, one-based line, original byte start/length, reason|
|6..8|source handle/length and canonical/strict profile|
|32..40|line, whitespace-word and comment vectors|
|41..58|function, node, operand, parameter-type, import and raw-spec vectors|
|59..61|persisted spec-grammar directory|
|62..79|symbol interner and structural type/child tables|
|93,96|parser and checker schema versions|
|97..108|node type IDs, resolved callees/predicates, function iteration metadata and ownership effects|
|109..114|checker context: function/node/argument/expected type/actual type/reason|

Function rows have14 words: name, parameter first/count, result type, node first/count, return operand,
header/return/end line indexes, spec first/count, source index and flags. Node rows have14 words:
name, opcode, argument first/count, callee/predicate symbols, line, ID/op byte spans, origin flags and
text byte span. Operand rows have5 words: kind, value, byte start/length and flags. Parameter spellings
larger than u32 remain authoritative source spans with an overflow flag, rather than truncated indexes.
Type rows contain `[kind,a,b,containsIo,widthCache]` and immutable child-ID lists. Primitive IDs are
u32=0, bool=1, io=2. Width caches are derived and never replace structural identity.

Status0 is success for the requested implemented stage. Runtime statuses1..5 propagate unchanged;
status6 carries parse diagnostic facts and status8 checker facts. The parser/checker-only entry retains status7 for valid spec-bearing input. The separate ordered
verification service consumes the complete grammar directory and performs binding/evaluation. Grammar hooks validate example literals and
contract syntax in source order, preserve isolated AST/source spans, and never strip unevaluated specs
into apparent success. Whole-source parsing precedes body checking. Complete verification must check
each function body and its specs before publishing it and proceeding to the next function.

`diagnostics_arena.a0` implements a subset of complete core JSON diagnostics, including structural type
formatting, JSON escaping, fix/edit text and UTF-16 edit facts. Unsupported IDs return status7. Original
byte spans are separate from the core diagnostic line policy. Full catalog, module and spec payloads
remain work; retained facts alone are not a claim of complete public diagnostic parity.

Current source snapshots are valid UTF-8 after ordinary frontend string decoding. Malformed raw-file
replacement semantics and provenance need explicit integration. A BOM inside text/import data must
be preserved. Strict profile metadata is retained for subsequent stages; parsing/checking alone does
not establish strict runtime or backend behavior.

`eval_arena.a0` adds an experimental interpreter with immutable value blocks, full-word call frames
and A0-owned continuation/fuel/trip decisions. The host only resumes a pending continuation with a
work quantum; it does not decide language termination or fuel. Blocks currently remain allocated until
FINISH, so this component has an explicit resource/performance gap before production routing. The
source test wrapper checks the whole program and is separate from the required per-function spec
verification order. Module loading and original-byte maps are documented in [Arena linker](arena-linker.md).

`arena_parse_verify_begin` starts ordered checking and spec verification; `arena_verify_resume`
advances its opaque continuation. The service checks each unpublished body, types all that function's
examples/contracts, evaluates precondition/body/deep equality/postcondition, then publishes the function.
Each phase and example receives a fresh language fuel budget. Earlier function/spec failures precede
later body failures; whole-source parse errors precede both. The scheduling quantum does not change fuel.

The verifier's current failure word being zero is insufficient for acceptance. `arena_verify_status`
returns7 while pending and0 only after terminal success; callers must also finish the arena session.
Runtime resource failures remain distinct from example failures. Spec diagnostics retain structured
phase/example/trap/value facts, but their complete public JSON renderer remains unsupported. Contract
views and cached immutable blocks remain session-lived, with the same explicit resource-cost caveat
as the evaluator.
