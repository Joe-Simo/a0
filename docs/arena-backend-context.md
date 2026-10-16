# Experimental Full-word checked arena to generic backend context v1

This module performs structural lowering in A0. The frontend owns source parsing, type validity, IO linearity, source-order/name/call validity and completed spec verification. It does not revalidate source or choose a backend. All tables, counts, IDs and byte coordinates are full u32; arena vectors grow without a legacy page/table/chunk ceiling. Runtime budget and unrepresentable-u32 arithmetic failures remain explicit.

## API

```
arena_backend_context(io, checkedM128)
    -> (status, context16, descriptor128, io)
arena_backend_context_linked(io, checkedM128, successfulLinkState128)
    -> same
arena_backend_attach_link(io, context16, descriptor128, successfulLinkState128)
    -> same
```

The lowering consumes successful parser schema1/checker schema1 state. It propagates a nonzero input status, checks the structural schema/table geometry needed for translation, and otherwise trusts checked semantic invariants. The ordered frontend service must establish spec completion before calling this adapter; checker marker96 alone does not authenticate verifier completion. The adapter preserves raw spec metadata through its immutable checked-state snapshot. It does not strip specs, emit code or select a fallback.

On failure public context16 and descriptor table views are zero; descriptor0 retains status and descriptor1/2 retain magic/version. Session-lived allocations remain until FINISH. Handles are invocation-local. Successful source tables and source bytes remain unchanged. New backend consumers require status0 before inspecting directories.

## Existing backend context16 (unchanged SV contract)

Slots0..5 are allocation handles;11..13 are counts. Slots6..10 and14..15 are **target-owned scratch**, supplied zero by this adapter. Original IDs/origins never occupy target scratch.

| Slot | Value |
| --- | --- |
|0|Type triples handle|
|1|Type-list words handle|
|2|Function rows10 handle|
|3|Node rows8 handle, including harmless dummy0|
|4|Operand pairs handle, including dummy/padding|
|5|Identifier UTF8 byte pool handle|
|11|Function count|
|12|Type count|
|13|Node count **including dummy0**|

Primitive type IDs remain0=u32,1=bool,2=io. Type triples are `[tag,a,b]`: tags1u32/2bool/3io; tag4array `[4,length,elementTypeID]`; tag5record `[5,firstTypeListChild,fieldCount]`. Types retain the checked arena type IDs and topological child ordering. Target byte/bit widths, field offsets, ABI classifications and contains-IO geometry remain backend decisions. The source frontend's cached width is saturating semantic metadata, not a target ABI width.

The type-list begins with harmless type0. It then copies all checked record children; record starts shift by1. Function parameter lists are appended in function order, each with harmless trailing type0, including zero-parameter functions. This is structural padding. No type is reinterned or semantically rewritten.

Function rows10: `[nameOffset,nameLength,paramCount,firstParamType,resultType,firstNode,nodeCount,returnKind,returnValue,profileFlags]`. Function IDs are unchanged checked global function indexes. Node rows8: `[opcode,argumentCount,firstArgument,calleeFunction,predicateFunction,resultType,nameOffset,nameLength]`. Actual nodes use checked global node index+1; node0 is the harmless sentinel. Absent callee/predicate is0 in this baseline, as in existing SV. Presence is determined by the checked opcode; the checked snapshot retains exact UINT_MAX absence values.

Operand pairs: `[kind,value]`;1=node global context ID,2=parameter index,3=u32 literal,4=bool literal0/1. Dummy node0 owns three harmless u32-zero pairs at indexes0..2. Every actual node stores max(actualArgumentCount,3) pairs; only argumentCount is semantic. Return operands remain inline in function rows. Name keys are copied once from the source symbol interner into one byte pool; exact original/generated names and byte lengths are retained. Pool order is symbol order, not the old TS test serializer's repeated-name order. Consumers depend on spans, never a particular pool layout.

Opcode numbers remain the canonical frontend1..37, including checked32..37. Text lowering is preserved exactly as supplied by checked IR (the parser's expanded arr22 with original text flag/spans, or an otherwise checked supported opcode24); no checked operation is expanded or discarded. Strict profile is function flag bit0. Bit1 is reserved for the SV target's original-clock constraint and starts zero. Input profile8 is preserved even if a target initially refuses unsafe strict.

## Separate immutable descriptor128

Descriptor magic is `0x41304243` (A0BC), version1. Backend code must keep this directory separate from context16 target scratch. Every V is `(handle,lengthWords,capacityWords)`.

| Words | Meaning |
| --- | --- |
|0|Adapter status|
|1,2|A0BC magic, version1|
|3|Source kind0 single/original source,1 linked combined source|
|4|Immutable128-word successful checked M snapshot handle|
|5|Immutable128-word link schema2 snapshot handle, or0|
|6,7|Checked source handle and original/combined byte length|
|8|Checked profile0/1|
|9,10,11|Function count,node count including dummy,type count|
|12,13|Context operand-pair count,identifier byte-pool length|
|14|Checked-schema version1|
|15|Attached link-schema version0/2|
|16..18|Type triple V|
|19..21|Type-list V|
|22..24|Function row V|
|25..27|Node row V|
|28..30|Operand-pair V|
|31..33|Identifier byte pool V|
|34..36|Symbol-span V,2 words `[poolOffset,byteLength]` per checked symbol ID|
|37..39|Function metadata V,12 words per function|
|40..42|Node metadata V,14 words per context node including dummy|
|43..45|Operand metadata V,4 words per context operand pair including dummy/padding|
|46..48|Frontend type metadata V,2 words `[containsIo,saturatingSemanticBitWidthCache]` per type|
|49..51|Reserved future immutable sidecar V|
|52..54|Private construction symbol-to-current-function-node scope V; not a backend input|
|55..63|Reserved|
|64..111|Private construction controls; not a backend contract|
|112,113|Failure phase/reason facts, zero on ordinary success|
|114..127|Reserved|

Function metadata12: `[originalFunctionIndex,nameSymbolID,headerLineIndex,returnLineIndex,endLineIndex,returnOperandIndex,literalIterations,staticIterationsIEEE754Low,staticIterationsIEEE754High,profileFlags,parserSourceIndex,parserFunctionFlags]`. Literal/static iteration words are copied exactly from checked M103. No host floating conversion is used. The three source line IDs resolve through the retained checked M32 line table. For linked input, parserSourceIndex remains the parser's original field and must not replace true link origins.

Node metadata14: `[originalGlobalNodeIndex,originalFunctionIndex,originalLocalNodeIndex,nameSymbolID,lineIndex,idStart,idLength,opStart,opLength,originFlags,textStart,textLength,consumed,takenFieldPlus1]`. It preserves strict trap/iteration identity and exact original spelling independently of target node IDs, as well as checked final IO ownership effects. Dummy0 has UINT_MAX original IDs/name/line and zero spans/effects. Actual records align with context global node index. A future optimizer must explicitly carry/transform these sidecars; this adapter makes no claim about unimplemented optimizer provenance.

Operand metadata4: `[originalOperandIndex,byteStart,byteLength,parserFlags]`, aligned with context pairs. Dummy/padding uses originalOperandIndex UINT_MAX and zero spans/flags. Original return operand index is in function metadata5. Parser flags retain synthetic/text/wide numeric spelling associations, even though semantically invalid wide parameters cannot enter a successful checked program.

The optional linked entry/attach operation requires successful link schema2, combined parse marker120==1, and exact combined source handle/length equality with descriptor6/7. It stores the link state without changing parser schema1. LinkState44 copied segments,100 projected fragments and53/56/74/77/103/106 origin refs provide A0-selected multi-file origins for functions/nodes/operands/specs/lines/uses. No host source rescan is requested. All source snapshots and names remain live until FINISH.

The public interface does not authenticate arbitrary forged foreign tables. Shape/range/arithmetic checks protect the structural translation; semantic frontend validity and spec completion are preconditions. Statuses1..5 propagate generic transport/resource failures,6 denotes malformed checked metadata,7 denotes count/coordinate overflow. An original nonzero frontend status is propagated unchanged. No nonzero result publishes a partial usable backend context.
