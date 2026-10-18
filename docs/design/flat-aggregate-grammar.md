# Aggregate literals in flat A0

The chosen flat syntax has one aggregate grammar for instruction operands and executable
examples. The native A0 scanner in `compiler/source_grammar.a0` implements it. The retained
TypeScript reader is a historical comparison control during migration; it is not a second
language authority. Historical Canonical/Dense input is read only through the explicit migration
readers before being printed as flat source.

Arrays use `[...]` and records use `(...)`. They contain at least one item. Items are separated
by whitespace or commas, and these separators may be mixed. Semicolons and adjacent items
inside an aggregate are rejected. For example, `[1 2,3]` and `(1 true)` are valid; `[1;2]` and
`[[1][2]]` are not. Instruction aggregate items are operands. Example aggregate items are
literals and may contain nested arrays and records.

A one-field record requires its trailing comma, as in `(1,)`. Arrays and records with more than
one field reject trailing commas. Whitespace is allowed around the delimiters and commas, so
`( 1 , )` is also valid. The formatter prints spaces between items and uses a comma only for a
one-field record.

An array may repeat exactly one item as `[ITEM*COUNT]`. Whitespace around `*` and the count is
allowed. The count is a positive decimal integer without leading zeroes and is bounded by the
language element budget. After the count, only whitespace and `]` may follow. Repetition is
not allowed in records or after multiple array items. Counts one and two remain accepted; the
formatter chooses repetition for three or more identical items. Nested items may repeat, as in
`[[7]*2]`.

The scanner consumes whitespace after each item, then decides in this order: repetition,
comma, matching closing delimiter, end of input, or another item separated by whitespace.
After a comma, it expects another item unless that comma closes a one-field record. This keeps
the first grammar error deterministic. In particular:

| Unfinished example result | Required refusal |
| --- | --- |
| `[` or `(` | a literal is missing |
| `[1,` or `(1,` | a literal is missing |
| `[1` or `(1` | missing the matching closing delimiter |
| `[1*` | the repeat count must be a positive decimal integer |
| `[1*2` | array repetition must end at `]` |

An incomplete aggregate on a source line is a grammar refusal, not an arena transport failure.
Source lines do not continue an aggregate onto the next physical line. A comment ends the code
on its line, so `[1 # comment` still lacks its closing delimiter. Resource or storage failures
keep their transport status independently of ordinary grammar refusals.

Aggregate separators do not govern the separate top-level example argument sequence. Adjacent
complete arguments such as `ex [1][2] -> [1]`, `ex 1[2] -> 1`, and `ex 1true -> 1` remain
accepted when they fit the function signature. Whitespace around `->` is optional. The formatter
prints a space between arguments and around the arrow.

`test/source-spec-grammar.controls.ts` contains explicit accepted and rejected spellings,
phase-sensitive incomplete input, graph locations and error-priority checks for the C-derived,
direct Wasm and generated JavaScript targets. These controls must pass on fresh authenticated
artifacts before this implementation is considered verified. No performance claim follows from
the grammar controls.
