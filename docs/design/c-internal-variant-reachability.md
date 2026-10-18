# Static internal C variant reference graph

`results/c-internal-variant-reachability.json` records explicit symbol-reference
fixed points for the frozen baseline and 263-wrapper SAME-S0 C-stage modules.
`tools/c-variant-reachability.py` reads generated C without rewriting it. This
inventory introduces no pruning implementation, compiler option or default change.

Every external public definition and canonical nonvariant helper remains a root.
References through all function bodies are followed to a fixed point, including
bare function symbols and address-taking. Conditional definitions are unioned.
Both modules have 1,938 distinct definitions and 677 variants: 587 owned, 87 ref
and three view. All variant definitions are static, and neither frozen module
contains a bare or address-taken variant reference inside its own function bodies.

| Frozen artifact | Standalone stage | Known frontend/test consumers | Default library compatibility |
| --- | ---: | ---: | ---: |
| Baseline | 104 definitions / 121,363 bytes | 103 / 121,122 | 0 / 0 |
| 263-wrapper candidate | 41 / 45,599 | 41 / 45,599 | 0 / 0 |

These are existing unreachable definition bytes, not measured output savings.
The report also counts each definition's own trailing whitespace separately;
no whitespace or other source transformation was performed. Sharing makes 63
previously unreachable variants reachable in the standalone context, or 62 with
the known consumer overlay. It makes no previously reachable variant unreachable.

The consumer overlay matters. `tools/source-native-build.ts` uses
`a0o_arena_verify_resume(&state,n)` for its large-state ABI, while its normal form
calls the public by-value entry. The owned form adds a root that a public-only
baseline graph misses. The descriptor in
`experiments/unification/compiler-codegen/variant-reachability/consumed-abi-roots.json`
retains the existing eight typed public A0 APIs and records both call forms,
including the owned mutable-state pointer signature.

Static linkage alone is insufficient for general deletion. A host that includes
`module.c` can consume static symbols. `test/c-iteration-extras.test.ts` takes owned
and predicate addresses through typed function pointers. `src/parallel.ts` also
constructs owned/view calls for selected bodies. Those test-specific names are
reported absent when they are absent from these S0 artifacts; that is not a waiver
for other modules. The default open-library context deliberately roots every
variant. The frontend/test context is a conservative consumer overlay on S0, not
an inventory of a separately built native frontend artifact.

The independently reproduced S1 module provides a matching source/package bound.
Its actual source and stable C total 2,555,695 bytes. Even free omission of all 41
unreachable variant definitions and their trailing separators leaves 2,510,014
bytes before mandatory host/runtime files, retained frontend fixture and metadata.
The unchanged ceiling is 2,097,152 bytes. This optimistic arithmetic changes no C
and includes no analysis/emitter implementation cost; it cannot authorize adoption.
The earlier full-package assessment and owned-sharing experiment remain separate.

The exact feature and proof history is recoverable through
`experiments/unification/compiler-codegen/existing-owned-sharing/source.bundle`,
with prerequisite `aded1f97d0add593913fad765c7130467c8eb7d7`. Its isolated replay
regenerates the strict baseline and candidate artifacts. To repeat this inventory:

```sh
python3 tools/c-variant-reachability.py BASELINE_MODULE_C CANDIDATE_SAME_S0_MODULE_C \
  --consumed-abi=experiments/unification/compiler-codegen/variant-reachability/consumed-abi-roots.json \
  > OWN_SCRATCH_REPORT_JSON
```

Archive a results file through `tools/scrub-results.ts` `writeReport`. Any future
closed-world experiment would need an explicit consumed-ABI manifest with every
host/shim/parallel call form and function-pointer root, and would preserve default
library compatibility. No such emission change is implemented here, and no
compilation or execution performance conclusion is claimed.
