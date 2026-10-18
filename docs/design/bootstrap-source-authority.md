# Bootstrap source authority

The explicit `bootstrapNativeCStage` route loads the compiler with the shared A0
source frontend, selects its reachable checked functions, and sends that IR
directly to the existing TypeScript C backend. The shared A0 formatter writes the
flat source frozen for later C stages. It does not format Canonical source for
the old bootstrap parser, or parse source again in the host.

This is an integration step. The public compiler, checked-in C seed,
`bootstrap.ts`, AArch64 bootstrap and site build retain their existing routes.
The source-bound native frontend and formatter artifacts are injected by the
caller; this function does not silently construct them through another reader.

`bootstrapProgramClosure` retains the original typed function objects, resolved
runtime callee identities, function order, iteration facts and semantic profile.
It follows pre/post dependencies separately because those helpers are not
runtime calls. Missing entries or inconsistent call graphs are refused. Native
formatting is required, including when source parsing and checking succeeded;
an unavailable formatter has no host fallback. The caller still owns the
frontend and may use it after the operation.

The stage-1 setup uses the existing TypeScript backend and a C compiler. Later
stages consume the same frozen flat compiler source as raw bytes, through the
existing A0 C service and generic arena runtime. Stage output is published only
after successful FINISH. The comparison path remains the independently verified
checked-in C seed. Neither the new route nor its focused controls replace the
repository's full platform gate.

The reproduction controls require explicit current artifacts:

```sh
A0_BOOTSTRAP_FRONTEND=PATH_TO_FRONTEND \
A0_BOOTSTRAP_FORMAT=PATH_TO_FORMATTER \
node --test --test-concurrency=1 dist/test/bootstrap-source.controls.js
```

The remaining dependency order is:

1. Establish this native source-to-IR stage-1 handoff and C fixed point, retaining
   the old seed as an independent comparison.
2. Migrate C seed preparation and its C-only package to the raw-source arena
   service. Preserve source provenance, atomic failure, supported C compilers,
   and stages 2–4 equivalence before changing the default seed.
3. Migrate AArch64 bootstrap to the existing arena source/link service and its
   emitter. Prove Darwin ABI, strict traps, runtime behavior and executable and
   assembly fixed points on Apple silicon. Linux instruction-model checks do
   not establish those platform facts.
4. Move Wasm self-hosting and the site's `wasmTool` setup to authentic native
   checked IR and the existing table-emission path. Their source-mode path still
   depends on the historical parser; calling that source a private IR would not
   remove the dependency.
5. After capability, behavior, performance and platform gates pass, remove the
   old production grammar consumers and alternate user-facing modes. Keep
   explicit historical input conversion outside the authoritative frontend.

The current resource budgets remain explicit: native source checking and
formatting use the frontend's allocation budget; the C service has its own arena,
output, resume and stack limits in `C_STAGE_RESOURCES`. No unbounded-capacity,
compilation-speed or memory improvement is claimed by introducing this route.
