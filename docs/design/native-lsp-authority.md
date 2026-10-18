# Injected A0 language service authority

The production CLI still starts the existing LSP implementation. This staged construction seam
accepts an explicitly supplied frontend through `startServer(connection, launch, { frontend })`.
There is no command flag, environment variable, source-mode negotiation or automatic artifact
selection. The eventual replacement must supply the complete packaged A0 frontend and its optional
formatter/diagnostic capabilities; this change does not promote that replacement.

When the dependency is supplied, diagnostics load the complete graph through `linkNativeSource`
and the same A0 parser/checker. Formatting parses the document as an authentic source unit and
calls that frontend's existing A0 formatter. Formatting is a syntax operation: it does not issue a
typed program or accept unresolved imports. Bool/record/array signatures remain the explicit types
in the unit IR; no imported result type is guessed by a host parser. Per-file imports, profile
spelling, comments and specs remain local. Formatting can run while a graph has a type error.
Graph acceptance and checked semantic revisions still require the complete native check.

Both operations accept migrated `.a0` source. Historical `.a0d` documents are refused by this
injected authority and must pass the explicit historical migration path first. Neither operation
tries a historical reader or a TypeScript semantic fallback after refusal. The default constructor
continues its existing routes until the production cutover is authorized and verified.

The server borrows the frontend. Native module linking is loaded only for the injected dependency;
no compiler artifact or formatter is loaded by the unchanged default construction. Shutdown drains
pending diagnostic publications and leaves the frontend owned by its caller. Shared frontend
resets retain the existing private unit ownership and generation rules; the LSP exposes only
protocol diagnostics and detached text edits.

Diagnostics snapshot all open-buffer strings before asynchronous graph IO. Confined physical paths
identify those buffers, and the requesting document supplies its own captured entry text. Closed
files use the existing fatal UTF8 decoder rather than lossy file decoding. The existing server
confinement function also canonicalizes native graph paths, so an escaped alias is rejected before
its outside physical target can enter a linker message. Buffer epochs, document identity and document versions prevent stale graph results from being
published, including close/reopen of one URI with the same numeric version. Identity is checked
before beginning diagnostic work and again after asynchronous reads; late path-map writes from a
closed document are discarded. Native formatting captures its text/version before an
asynchronous path lookup and returns the protocol's content-modified response if that document
changes or is closed/reopened while resolving it. The authorized root directory is canonicalized
separately from source files, without relaxing the source extension or physical confinement policy.

Semantic diagnostic details come from the genuine A0-rendered diagnostic. The server preserves the
existing protocol coarse code, fix/edit/spec data and file-origin display. If a renderer is missing,
unsupported or fails, the server reports a service refusal with raw status/diagnostic facts in
structured data. It does not classify native diagnostic IDs through a second semantic table.
Missing formatter, resource and source-format failures return explicit failed formatting requests.
Host paths and implementation names are excluded from these service messages.

Hover, definition lookup, symbols, completion and code-action transport retain the existing lexical
host features. This seam does not port those services, the edit-reply protocol or session policy to
A0, and does not remove historical readers or source flags.

## Remaining route and release work

| Route | Current authority outside the injected LSP seam |
| --- | --- |
| CLI check/run/emit | `cli-main.ts` uses historical `link`; patch/view/revision still use the reference edit and revision operations. |
| MCP open/apply/save | `mcp.ts` opens `EditSession` from the historical linker and retains historical Dense/Canonical view/reply/save policy. |
| Edit sessions | `edit.ts` parses node/patch/function replies, handles Dense translation, validates/hoists changes and prints/hashes views in TypeScript. A checker swap alone would leave that grammar split. |
| Default LSP launch | `serveLsp` still calls the existing constructor without an injected frontend. |
| Source migration | The separate native migrator prints through the same A0 formatter and checks staged whole graphs; historical readers remain explicit import-only dependencies there. |

The documented native frontend compilation/memory losses and aggregate-copy costs remain
production blockers. This API work includes no new timing or memory-improvement claim. Detached
aggregate-return experiments do not authorize graph-wide substitution under fuel/trap/export
contracts. Release packaging must provide source-bound frontend, runtime, formatter and diagnostic
assets on supported hosts, with clear failure for absent/stale assets and no TypeScript semantic
execution. Existing bootstrap/build dependencies, native diagnostic coverage and production
performance gates remain explicit prerequisites to changing defaults.

`test/source-native-lsp.controls.ts` is the explicit actual-C protocol control entry. It requires
`A0_LSP_FRONTEND`, `A0_LSP_FORMAT` and `A0_LSP_DIAGNOSTIC`, and tests the real JSON-RPC/LSP connection
with live imported buffers, file formatting/fixed points, structured diagnostics, complete graph
revision/backend equivalence, resource/capability/encoding/confinement refusals and buffer lifetime.
The verified diagnostic companion also supplies direct and imported A0714/A0715/A0716/A0719
controls. Their existing LSP data, message, spec ownership and physical line are compared with an
independent graph oracle, including an unrelated function named `spec` and existing quick fixes.
A separately labelled handler-scheduling control invokes the actual registered TextDocuments and
formatting callbacks in one JS stack around real asynchronous file lookup, then closes/reopens the
URI at the same version. This deterministically exercises document identity without sleeps,
production test hooks or a mock grammar.
The current implementation slice must run those controls and the existing LSP tests before it can
be treated as verified; the final integrated artifact and repository gates remain separate.
