# Contextual native node edits

`editNativeNodes(program, fn, body, frontend)` is a staged internal compiler seam. The function
must belong to the supplied typed program. The body is an unframed, unnumbered node-edit payload;
handles, Markdown fences, numbered/compact views, signed specs, session repair state and public
CLI/MCP routes remain on their existing implementation. This seam adds no source-language mode
or production default.
Session integration must preserve its Markdown fence handling and compose raw-to-cleaned-to-generated
offsets, or retain original indexes through a shared cleaner. Fence stripping and CRLF normalization
cannot silently redefine physical reply origins. That session-integration requirement remains open.

The existing `parseEditOps` loop now lives once in `parseEditOpsWithLanguage`. Its original wrapper
supplies the same parser/return/spec services. The native adapter supplies contextual A0 `parseUnit`
services. The shared loop retains duplicate/sequence repairs, delete/replacement pairs, anchors,
multiple-return refusal and the original parsing order. Native payload parsing occurs on demand:
an early protocol duplicate still precedes a later source error, while all source payloads are parsed
before a missing anchor is checked during replacement. No host node, operand, type or spec parser
accepts native source. The existing comment/anchor framing policy selects a payload; its raw source
and comments reach A0.

Each node/return payload is parsed in a complete contextual function. The native formatter renders
the original full declared header and original return once per attempted transaction. Unused
parameters and nested aggregate/IO/result types remain declared even when their last body use is
removed. Unknown old-node references and forward calls remain unresolved until final checking.
No callee declarations, substitute types or semantic stubs are manufactured. The contextual return
is generated only when a node needs a complete grammar unit; it is not an edit to the function.

`replaceNodesWithLanguage` owns the existing structural transaction once: deletion, replacement,
insertion, anchors, comment retention, fresh return IDs, dependency ordering, node bounds and unused
new-node refusal. The legacy wrapper retains its original function checker and spec parser. The
native service preserves the original function declaration/spec IR, supports structural `-pre` and
`-post`, then invokes the same complete native Program checker and shared callee-hoisting policy as
whole-function edits. Signed spec parsing is an explicit capability refusal. The accepted Program
comes only from the native checker. Input programs stay unchanged, and the borrowed engine is never
closed. Native arena generations can reset on a failed attempt.

A contextual parse failure retains its real `NativeSourceError` packet plus generated-source and
reply line/UTF8/UTF16 origin metadata. A real rendered diagnostic is mapped to its physical reply line.
Exact line repairs survive only when every target belongs to and matches the actual source payload.
Generated header/return locations, synthetic return IDs and anchor-ambiguous repairs cannot become
exact reply edits. Renderer absence retains raw native failures; it does not select another parser or
checker. Unpaired UTF16 input is refused before encoding, and native allocation/transport failures
remain failures without a host acceptance path.

The adapter performs one native parse per node/return payload, plus one signature/return rendering
and complete native Program checking. This is a correctness staging boundary, not an efficiency
claim. A future incremental instruction entry may reduce that cost by calling the same `ap_node`
and `ap_ret` implementation; eager whole-reply parsing must first preserve protocol-error priority.
Contextual headers and generated completion lines count against the native source/allocation bounds;
this staged adapter does not claim unchanged maximum editing capacity. A refusal never invokes a
different parser or checker. Capacity and total-cost measurements remain adoption requirements.
No editing latency, memory, accepted-token or AI-success improvement is asserted.

`test/source-native-node-edit.controls.ts` requires current `A0_EDIT_FRONTEND`, `A0_EDIT_DIRECT`,
`A0_EDIT_JS`, `A0_EDIT_FORMAT` and `A0_EDIT_DIAGNOSTIC` artifacts. It covers declared interfaces,
old/forward node references, dependency/anchor/return behavior, comments/specs, refusal order, real
repair application and source origins, raw renderer parity, resource/encoding failures and atomicity.
Those controls must actually run before claiming their outcomes. Public adoption still requires
the remaining editing features, source-bound artifacts, measured cost gates and repository checks.
