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

## Optional live rendering

`nativeSource(module, diagnostics)` and `directSource(artifact, diagnostics)` can
render a failure before its arena is reset. The optional configuration supplies a
synchronous `load()` callback for the separate A0 renderer module and its existing
options value. Successful parses/checks never call that loader or instantiate the
renderer. `memoryBytes` includes the renderer's retained memory after loading it.
No public compiler route changes.

The renderer exports only `arena_diagnostic_options`, takes the failed parsed
page and uses generic arena read/write imports. The host copies its JSON vector
through an existing readonly storage view. It does not call the renderer's parse
entry or reconstruct diagnostic arguments. Parsed and specification pages are
copied before rendering; packets, JSON bytes and hydrated errors survive another
parse, memory growth and frontend closure.

The direct backend already has these generic Wasm arena ports. The import-free
C-derived frontend exposes them only when built with
`--diagnostic-ports=arena-v1`; its build record declares that optional capability.
ABI3's mandatory exports stay unchanged. Legacy artifacts still parse/check and
return an explicit `unavailable` diagnostic refusal when configured for rendering.
An absent arena reports `no-arena`; IR construction that did not reach verification
reports `incomplete-ir`. Existing A0 renderer refusal statuses remain intact, with
no parser, message or semantic fallback.

`NativeSourceError.result` retains raw failure state and any rendered packet.
Its `a0Error` retains supported catalog fields and repairs; `rendered` retains
original byte/UTF16 spans and mapped unit origins. The linker's existing unit
order supplies byte and UTF16 prefixes. Resolution and duplicate ownership errors
continue through the existing graph policy. Complete packets for unowned global
checker errors keep their global message; a refusal supplies no catalog error.

Build the optional artifacts with:

```sh
bun tools/source-native-build.ts --out=.a0-tmp/live-frontend --sysroot=WASI_SYSROOT --builtins=WASI_BUILTINS --diagnostic-ports=arena-v1
bun tools/source-diagnostic-build.ts --out=.a0-tmp/live-renderer
```

`prepareSourceDiagnostic` verifies artifact hashes and recorded inputs, returning
a lazy module loader. `prepareSourceFrontend` accepts that optional configuration.
The explicit `source-native-live-diagnostics.controls.ts` suite requires artifact
paths for the frontend, renderer and generic arena; missing artifacts fail instead
of skipping. It runs the actual A0 renderer against both frontend backends and
compares retained native packet JSON and independent linked-source errors.
The artifact byte comparison is recorded in
`results/source-native-live-diagnostics.json`; it establishes default executable
identity and optional artifact sizes, without a latency or memory-performance claim.

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

The global function-count diagnostic also renders without a selected function or
source archive. Native verifier/renderer fixtures and live controls check its
complete catalog JSON, unowned facts, empty and Unicode archives, and resource and
transport priority. The live C and direct-Wasm integration checks are recorded in
`results/source-native-global-diagnostic-integration.json`.

| Open area | Evidence and required connection |
| --- | --- |
| Default routing | The live hook is optional. Raw `state` and `specState` are not renderer facts and must not be passed directly to the packet adapter. Shipping the renderer by default requires separate artifact/performance and coverage decisions. |
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
