# Shared whole-function edit transactions

`editNativeProgram(program, reply, frontend, keepSpecs?)` is an internal construction seam for
whole-function/program edits. It borrows an explicit frontend; it adds no command option, source
dialect, automatic artifact selection or default route. Parsing uses that frontend's existing A0
`parseUnit`, and acceptance uses its complete A0 `checkProgram`. Annotated function removals use
the same native formatter's full `signature` fragment through format-only Program activation.
That fragment is metadata, not a complete parsed or checked function.

The transaction algorithm lives once in `editProgramWithLanguage`. The existing `editProgram`
wrapper supplies its original parser/checker/printer dependencies and retains its default behavior.
Both entries share optional block closing, function removal/replacement, replacement placement,
profile edits, hidden-spec retention, stable call ordering and complete-result validation. Ordered
validation also shares one `validateOrderedWith` implementation. Its internal failure service reads
genuine semantic rejection identity: an existing A0Error, or the native frontend's schema1 status6/8
and catalog-validated numeric diagnostic facts. Only A0102/3/4 enter the existing callee-hoisting
policy. The optional renderer enriches errors but does not decide which valid edits are accepted.
No fake A0Error, message matching, host recheck or semantic fallback is used for a raw native error.
The original error object/facts remain intact. Resource/transport statuses do not enter the policy.
Source-less structured IR has no original word-token table. The A0 renderer recognizes its checked
synthetic-line geometry, including comment-owned rows, and renders call/fold/loop errors from retained
IR symbols and operands. It does not infer source presence from the symbol/comment byte pool, invent
callee spans, or treat malformed source/token vectors as synthetic IR. Both diagnostic entry points
reuse this policy; the original source-backed token-range checks remain authoritative.
The shared ordered checker propagates an unclassified refusal from the hoisted retry instead of
masking it with the first ordering error. A second genuine semantic rejection still preserves that
original diagnostic. This narrow unexpected-exception change also applies to the legacy wrapper.

Source payload lines reach the native parser with their comments intact. The native checker returns
the accepted typed program and preserves its structured function/node/spec authoring metadata.
The existing transaction policy rebuilds the composed function list and profile; this seam does not
add source-unit/import ownership or preserve discarded Program-level metadata through a new policy.
The input program is never committed or mutated on either success or failure. The borrowed frontend's
live arena can reset during an attempted edit, so previously current native results are subject to the
usual generation rules. The adapter never closes the caller's frontend.

This is not a native edit session. Node patches, anchored/numbered edits, signed spec edits, handles,
`fix all`, views, CLI patching and MCP continue through their existing routes. Their eventual migration
must reuse the same protocol transaction engine and native language services; adding a native checker
alone does not remove those parsers. In particular, contextual node edits must preserve the existing
declared parameter/result IR when reparsing an inferred header, and native repair locations must map
back to actual reply bytes before an exact fix can be offered. Ordinary user-facing Dense/Canonical
selection has not been removed by this seam.

`test/source-native-edit.controls.ts` requires current `A0_EDIT_FRONTEND`, `A0_EDIT_DIRECT`,
`A0_EDIT_JS`, `A0_EDIT_FORMAT` and `A0_EDIT_DIAGNOSTIC` artifacts. Its C-derived/direct-Wasm/JS
controls cover whole-function add/replace/remove, native signature metadata, profiles and hidden specs,
callee ordering/cycles, comments, allocation/encoding/capability refusals, unchanged inputs and borrowed
lifetime. Independent host parsing/checking is used only as a test oracle, together with all registered
backend output comparisons. These controls must actually run before their outcomes are claimed.

Whole-program checking, repeated parsing, signature uploads and formatting may cost more than the
existing cached function checks. No compilation, editing latency, memory, AI accuracy or accepted-edit
token improvement is claimed. Current frontend performance and bootstrap package limits, complete
authoring-route migration, source-bound release assets and the repository's applicable gates remain
prerequisites to changing the production default.
