# Private native diagnostic transport

`src/source-native-diagnostic.ts` hydrates a complete packet from the existing
`arena_diagnostic_options` renderer into the public `A0Error` representation. It does
not inspect source grammar, validate a program, calculate suggestions or compose
catalog messages. The renderer must run against the same live arena state that
produced the failure, before another parse/check replaces that state.

The adapter preserves `message`, `detail`, `line`, `code`, `id`, `expected`, `actual`,
`fix`, `applicability`, both edit variants and optional `spec` data. It removes the
wire message's existing `line N: ` prefix before constructing `A0Error`, which adds
that prefix once. Unknown fields, malformed repairs, mismatched fact/catalog IDs,
incorrect classes, incomplete facts, invalid UTF8 and partial JSON after a refusal
fail explicitly. A nonzero renderer status returns a resource, transport, unsupported or
no-diagnostic result; it never invokes a TypeScript parser or formatter.

Native original locations stay separate from the public error's line policy:
renderer facts retain physical line, UTF8 byte start/length and UTF16 start/length.
Optional source-unit origins map the displayed path/local line and local byte
start. A retained UTF16 prefix also permits local UTF16 mapping. Absolute facts
remain available. The message mapping uses the ordinary linker's `rewrite` policy;
global checker errors with no owning function retain their unowned message;
structured edits and spec metadata remain intact. No source scan discovers an owner.

## Existing coverage and remaining integration

The ID set declared by `ad_known` in `compiler/diagnostics_arena.a0` is:

| Layer | Declared IDs |
| --- | --- |
| Parse | A0001, A0003–A0020, A0023–A0031 |
| Names | A0101–A0105 |
| Types | A0201–A0210, A0213–A0222 |
| Structure | A0303, A0309–A0316 |

This is a dispatch inventory, not a claim that every source or payload carrying an
ID has been proved. The native diagnostic test suite checks complete JSON, repair
priority, structural type formatting, decimal edge cases and UTF16 facts for its
supported cases. Other IDs and unsupported options return renderer status 7.

| Open area | Evidence and required connection |
| --- | --- |
| Candidate frontend error transport | `source-native.ts` returns failed `status`, parsed `state` and `specState`, while `source-native-link.ts` wraps them in `NativeSourceError`. They are not diagnostic-renderer packets and cannot be passed to this adapter. |
| Live renderer hook | `NativeApi` has no diagnostic entry. A transport hook must invoke the existing A0 renderer while the failed parse/check's arena and symbol/type tables are alive, then copy its complete JSON/facts. Re-parsing source to recreate that state would violate the frontend goal. |
| New structured-IR preflight errors | A0021, A0301–A0302 and A0304–A0308 are outside the renderer's declared set. The shared checker must supply the required names/arguments to A0 rendering before those cases can use the public adapter. |
| Module errors | File resolution, imports and duplicate ownership still use the existing graph policy. Source-unit origins can map renderer locations; they do not supply missing module diagnostic content. |
| Specifications | A0714–A0716 and A0719 do not have complete native public rendering. Ordered verification retains phase/example/trap/value facts, but those session-lived facts still need A0 rendering. The adapter can preserve a complete `SpecFault` payload; its synthetic transport test does not establish native spec rendering. |
| Runtime traps | Public runtime errors carry `trap` separately from `Diagnostic` JSON. This compile-diagnostic packet adapter does not synthesize or claim runtime-trap transport. |

`test/fixtures/native-diagnostics/packets.json` retains actual packets from the
seed-built A0 renderer at commit `c95daca1f6fb69f2de3a6827d7542dd7abd5f53c`, including
the original inputs and packet/JSON hashes. Independently compiled O0 and O2
binaries with UBSan produced identical packets. The adapter test compares supported
packets against public error JSON and independent source validation, checks refusal
behavior and attacks malformed transport fields. Public compiler routing remains
outside this private adapter.
