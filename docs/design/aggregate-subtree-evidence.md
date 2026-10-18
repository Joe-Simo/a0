# Selected-subtree proof boundary

The dormant return planner now retains a selected aggregate as one field of its original Type.
The real `ap_read` demand therefore produces `(u32x128,u32,io)`, with three selected fields and
130 logical leaves. The helper adds five nodes to the original eight. It retains every original
operation and parameter, and does not replace any public source call.

`results/aggregate-opaque-subtree-proof.json` records clean snapshot `2788067`, implementation
`10ff7c8`, the exact original compiler source/default C hashes and a repeated byte-identical
structural replay. All 56 helper identities validate together with the original 612 functions;
the helpers contain 1,118 nodes, of which 358 are appended projections/records.

The former scalar-expanded helper has 141 nodes. Its replacement has 13. This removes that
representation expansion, without demonstrating that a payload array allocation or copy was
eliminated. The selected helper's Wasm frame remains 1,552 bytes; the original has 512 bytes.

| Experimental closure | C bytes | JS bytes | Wasm bytes |
| --- | ---: | ---: | ---: |
| Original `ap_read` only | 16,244 | 12,188 | 1,369 |
| Original plus scalar-expanded helper | 146,420 | 25,946 | 3,565 |
| Original plus opaque-subtree helper | 17,678 | 13,532 | 1,577 |

The new helper still adds 1,434 C bytes, 1,344 JS bytes and 208 Wasm bytes against the
original-only closure. These are isolated emitted artifacts, not the production compiler package.
The earlier owned-fold package losses remain recorded separately in `7855f4a`; this proof does
not reverse that decision. No runtime, compilation, RSS, production binary-size or whole-bootstrap claim
follows from these source and instruction-byte counts.

The 78 focused tests pass without skips, including eight new C/C++ sanitizer executions at O0/O2.
Independent controls exercise original array modulus through a derived aggregate consumer,
an opaque nested IO/bool subtree, large legal aggregate selection, exact node-limit boundaries,
complete retained M, zero-trip/invalid-span behavior, protocol drains and callback exception
prefixes. Public default C remains 1,183,666 bytes with its original SHA256.

One control deliberately preserves a failure of arbitrary call substitution. A source function
returns two aliases of an array. A later host callback changes element zero from 7 to 13 before
the caller reads it. The original JS caller reads 13; the detached helper already captured 7,
while its opaque whole-array field still observes 13. The proved law is projection at helper
return, not contextual equivalence with every later consumer. No private ownership is inferred.

The real guarded three-field `ap_read` fold still refuses `unsupported-state`. Next work needs
capture-point-aware known-call/effect demand, retained opaque M, private payload provenance and
the original zero-trip initializer. A guarded zero-or-one fold can remain a fold with the same
count/index/effects rather than speculate its body. Unknown calls, intervening callbacks, whole
or dynamic payload consumers and unclosed effects must retain their demands or refuse.

Strict profiles refuse; detached fuel/resource frames differ. Every proof emission uses
`optimize:false` without trap instrumentation. Lint, typecheck, prereview and public-tree checks
pass. Hygiene has three passes and its existing optional denylist skip. Scope remains `everything`;
full gates and all-target verification remain pending. No default route, source syntax or
compiler target was changed, and no formal timing cohort was run.
