# Generated-JS frontend target experiment

This experiment compiles the existing `compiler/source_frontend.a0` closure through the JS
backend. It changes no A0 grammar, parser, checker, specification evaluator or source file.
Public source routing remains unchanged. There are no timing results or performance claims.

The generic `jsIo: 'host'` compilation option replaces only the JS module's IO runtime. Function
bodies and their cache keys are shared with buffered emission. The default runtime is unchanged.
`a0_make_host_io(read, write)` creates a module-owned opaque token. `read()` returns a u32 or
`undefined` for EOF; zero and `4294967295` are ordinary words. Canonical reads map EOF to zero;
strict reads raise the existing input trap. Writes and `puts` synchronously invoke `write(word)`
in source order, including the `puts` length prefix, and retain token identity. Callback and
invalid-read exceptions propagate unchanged and unwind strict trap frames. Callbacks must not
reenter the module. The host module also provides its own buffered `a0_make_io` helper; tokens
from a different generated module are not interchangeable with its private callback tokens.

`src/source-js.ts` translates only the declared typed entry ABI: u32 pages, positional records
and the IO token. Wasm reads are normalized to unsigned u32. The JS and direct-Wasm targets use
one `src/source-compiled.ts` adapter for session creation, word upload, IR construction, reset,
read-only views and the existing `NativeApi` ABI 3. The native IR decoders, graph ownership and
composition, structured-program encoder and lazy A0 diagnostic renderer are reused. No emitted
JS is rewritten and no A0 helper name selects a faster implementation.

Arena storage remains the existing import-free generic `arena.wasm`. The builder copies an
explicit direct-target arena artifact, verifies its runtime source hashes and recomputes the
linked stack proof. It does not implement an arena in JS or rebuild an unrecorded transport.
State scratch pages use that arena's memory. Views are reacquired after memory growth; returned
unit, failure and diagnostic snapshots detach from the session before its next reset.

## Build and run explicit controls

Use a clean committed compiler checkout, locked dependencies and a fresh Node process. Keep the
compiler checkout and loaded SDK fixed during preparation and sessions; updating either requires
a fresh process. Parsed application source can change normally. The direct artifact must be built from
the current compiler inputs for the four-engine controls. A previously built arena can be reused
for the JS-only build when the recorded generic runtime inputs and stack proof match.

```sh
bun install --frozen-lockfile
bun run build
node dist/tools/source-direct-build.js --out=.a0-tmp/js-direct-control \
  --sysroot="$WASI_SYSROOT" --builtins="$WASI_BUILTINS"
node dist/tools/source-js-build.js --out=.a0-tmp/js-frontend \
  --arena-artifact=.a0-tmp/js-direct-control
node dist/tools/source-diagnostic-build.js --out=.a0-tmp/js-diagnostic
node --test dist/test/js-host-io.test.js
A0_JS_DEFAULT_CONTROL="$PRE_HOST_COMPILER_68_CHECKOUT" \
  node --test dist/test/source-js-default.controls.js
A0_JS_SOURCE_ARTIFACT=.a0-tmp/js-frontend \
  A0_JS_SOURCE_DIRECT_ARTIFACT=.a0-tmp/js-direct-control \
  A0_JS_SOURCE_RENDERER=.a0-tmp/js-diagnostic \
  node --test dist/test/source-js.controls.js
A0_DIRECT_SOURCE_ARTIFACT=.a0-tmp/js-direct-control \
  node --test dist/test/source-direct.controls.js
```

Set `WASI_SYSROOT` and `WASI_BUILTINS` to the WASI paths and `A0_WASM_CLANG` and `A0_WASM_LD`
to the chosen toolchain, and retain the direct build record.
The JS artifact contains `frontend.mjs`, the copied `arena.wasm` and `build.json`. Its record
distinguishes JS text bytes from Wasm bytes, includes the complete source/compiler inventory,
typed function ABI, compiler options and the reused arena's original provenance and proof.
The builder and loader freshly compile TypeScript and run emission/verification in a separate
cold Node process. Recorded compiled-module hashes and on-disk SDK stability checks refuse
stale ignored `dist` output, including when a caller already imported compiler modules. This
preparation is outside target execution; a preparation failure is explicit. The loader imports
the exact verified bytes and provides no fallback or public frontend mode.

The controls compare actual JS, C-derived and direct-Wasm A0 execution plus the independent TS
frontend. They cover complete failure states, resources and recovery, graph/program snapshots,
caller mutation, specifications, lazy real catalog rendering, byte/UTF16 owners, the frontend's
own source and all six frozen applications. They collect correctness evidence, not timing.
The independent default-byte control requires a clean, separately built checkout of
`2f1c1740eb8e3cb63731bd2810c7e98d7da13483` (compiler 68 before the host-IO option).
It compares default JS and C text, JS function bodies and cache keys on both optimization
settings, including strict cases, all six frozen applications and the complete frontend.

## Costs still to measure

The current JS ownership rule excludes records containing IO from deep field ownership. For
example, `arena_reply_word` updates a page projected from `(u32x128,io)`, so the JS backend copies
that page for each payload word. A full 128-word reply therefore entails 128 page copies. Reads
also create result pairs and record construction creates arrays. These are static lowering
facts; this experiment adds no ownership optimization.

Every host protocol word crosses from JS into the reused Wasm arena. ESM loading, JS parsing,
JIT compilation, typed-array allocation and garbage collection also contribute to total cost.
Whether this target improves any measured workload remains unknown. `memoryBytes` reports
retained Wasm buffers only; it excludes JS heap, generated code, JIT, GC and shared ESM module
retention. A later approved comparison must include process/engine memory and cold module
preparation, preserve every loss, and record the distinct JS and Wasm artifacts. The existing
formal source-cost harness does not accept this target; no timing protocol is expanded here.

## Recorded correctness proof

[The correctness record](../../../results/source-frontend-js-correctness.json) lists the checks and
their limits. The source frontend remains 23 A0 modules and 612 functions with the same source hash.
The generated JS artifact is 968559 bytes; its reused arena Wasm is 16422 bytes. These are artifact
sizes, with no claim about latency or total memory. Full build records, the 20 default-byte rows,
six application output hashes and the final metadata-only rebuild proof are archived alongside it.

The eight actual JS controls ran on `9fb763255cc48284ac0a732f11fba23f964081ab`. Final code commit
`a5534a7ea4d468b38a427b02d798db79a2d1c6cd` imports the existing compiler-68 C-fixture metadata
correction and its report. Fresh cold preparation proves identical generated JS, arena, compiler
outputs and source inputs after that correction; the unchanged direct-adapter suite and final
unsigned/resource/catalog/recovery smoke also pass. The initial direct-suite attempt correctly
refused stale C-banner metadata before executing any case. No guard was weakened.

Reproduce from sibling checkouts so their package/configuration roots remain independent:

```sh
git worktree add --detach ../a0-js-control 2f1c1740eb8e3cb63731bd2810c7e98d7da13483
git worktree add --detach ../a0-js-run a5534a7ea4d468b38a427b02d798db79a2d1c6cd
(cd ../a0-js-control && bun install --frozen-lockfile && bun run build)
cd ../a0-js-run
bun install --frozen-lockfile
bun run build
```

Then run the explicit build/control commands above with
`PRE_HOST_COMPILER_68_CHECKOUT=../a0-js-control` and the WASI/Clang inputs recorded in
[the direct control](../../../results/source-frontend-js-direct-control.json).
The loader intentionally requires its recorded clean code checkout; this results-only commit
does not silently retag an existing artifact. Rebuilding on a different clean checkout records
that checkout's actual identity. The conservative scope still requires the full repository and
platform gate before a shipping push; the recorded checks do not stand in for that gate.
