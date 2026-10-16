# Experimental combined link and parse schema2

`arena_link_parse io entryH entryBytes rootH rootBytes explicitRoot override dense workBudget -> (status,parsedState128,linkState128,io)` composes the original-source graph with A0 directive stripping, dependency-ordered concatenation, the combined source bound, canonical reparse and original-span projection. Call `fs_hello` once on the fresh optional FS session before uploading entry/root arguments. The invocation reads source only through OS requests chosen by A0. This API parses; it does not type-check or verify specs.

Parser state and every parser table remain schema1. The parser's function `sourceIndex` field is unchanged; it must not be interpreted as an actual multi-file ID. The separate versioned link state carries true origins. Complete parsed combined IR requires **entry status0, parsedState[0]==0, and linkState[120]==1**. If the graph fails, the returned parser state may be the last original-file parser snapshot and is not combined IR. Published original snapshots remain immutable.

All graph schema1 slots retain their meaning except the previously reserved output areas and phase controls described below. `linkState[94]==2` identifies this additive schema. All V headers are `(handle,lengthWords,capacityWords)`; all coordinates, IDs and lengths are full u32.

| LinkState slots | Added meaning |
| --- | --- |
| 41..43 | Combined source byte V, one raw UTF8 byte per word |
| 44..46 | Copied-segment V,4 words `[combinedStart,length,fileID,originalStart]` |
| 50..52 | Legacy source-line directory V,4 words `[fileID,startLine,lineCount,combinedStart]`, dependency order |
| 53..55 | Function header-code origin refs,4 words per combined function |
| 56..58 | Node origin refs,8 words per combined node: ID ref4 then operation ref4 |
| 74..76 | Operand origin refs,4 words per combined operand |
| 77..79 | Raw spec content origin refs,4 words per raw spec row; current parser excludes spec-bearing inputs with status7 |
| 80..91 | Transient strip/combine controls; no public directory |
| 95..99 | Selected parser line/start/length/reason/type-error-byte facts; combined byte coordinates when phase5 |
| 100..102 | Shared projected fragment V,4 words per fragment |
| 103..105 | Raw combined line origin refs,4 words per line row |
| 106..108 | Combined retained use-path origin refs,4 words per use row |
| 109..111 | Selected combined parse diagnostic span ref V (one ref4 when phase5 mapping succeeds) |
| 115 | Legacy selected file ID for a combined parse error, or UINT_MAX |
| 116 | Legacy selected local line for a combined parse error |
| 117..119 | Original combined diagnostic line/start/length facts |
| 120 | Whether combined parse was invoked (1) |

An origin ref is `[combinedStart,length,firstFragmentIndex,fragmentCount]`; indexes count fragments rather than words. A fragment is `[relativeToSpanStart,length,fileID,originalStart]`. The copied-segment and fragment producer preserve every boundary even if adjacent runs refer to the same original file. Concatenation LF bytes use synthetic fileID UINT_MAX and uninterpreted origin coordinate0; they never cause an original-file read. A zero-length span has zero fragments, including at EOF. Parser flags still identify generated return nodes and text-generated operands. Original perfile bytes, comments, use rows, raw spec rows, symbols and parser snapshots remain accessible through the graph file vector.

Function refs cover the header's full code span, retaining parameter/result spelling and byte provenance as well as its name. Node ID and operation spans have separate refs. Operand refs use the lossless parser spans, including wide numeric parameters; synthetic zero spans remain empty. Raw line refs also preserve fragmented comment lines when the literal linker regex removes text after a JS multiline anchor inside a comment. Any additional parser span can be projected by the A0 `lc_project` entry against linkState's copied-segment V; the host is never asked to rescan source or choose origins.

The source-line directory deliberately preserves the existing TS linker's legacy mapping: each stripped body has LF-count+1 lines and the next body starts after that many combined lines. This can differ from an original byte-derived line after the exact regex consumed blank lines. Both conventions are retained: chosen parser-error file/local line mirrors the existing public diagnostic behavior, while projected fragments retain exact original bytes. Full diagnostic messages, fixes, notes and OS exception formatting are not completed by this module.

Stripping is exactly the existing two-stage JS regex behavior, implemented in A0: first `/^\s*use\s+"[^"]*"\s*$/gm`, then `/^[ \t]*profile[ \t]+strict[ \t]*(#.*)?$/gm`. This includes JS Unicode whitespace and multiline anchors, blank-line consumption, and the fact that comment-bearing uses survive. Profile overrides mirror the existing linker's final parse behavior, including a Unicode-indented profile that survives stripping and stays strict under a canonical override. The parser's profile is forced strict only when the selected link profile is strict.

The concatenated source is checked against2097152 bytes after perfile stripping and graph profile/duplicate checks, before reparse. Since concatenation length is monotone, the implementation returns A0623 before an append would exceed the bound. Later files have already been read and parsed by the graph. No fixed file/name/node/operand/type/map capacity is introduced; vectors grow in A0 and generic storage failure is explicit status4.

Status meanings are graph schema1:0 successful slice,1..5 generic runtime/resource,6 selected language diagnostic,7 explicit unsupported/incomplete input,8 raw OS errno. Phase4 identifies combined A0623; phase5 identifies combined parser selection. Runtime failure while collecting origins remains a runtime failure rather than publishing incomplete success. Diagnostic mapping temporarily clears the selected6 status only to perform generic metadata requests, then restores it unless transport fails. Specs/dense/malformed-UTF8 normalization retain explicit status7; checker/spec evaluation and complete link diagnostics remain separate milestones.
