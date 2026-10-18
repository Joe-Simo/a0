# Pure ordinary readonly C-call comparison

The candidate is rejected as a default. Four of six frontend medians increase against the
unchanged native C control, and both artifacts are 358233 bytes. Pipeline, CPU, memory and
fresh-child wall increases also remain. Every candidate frontend and pipeline median exceeds
the historical Canonical and Dense controls. These observations do not clear the cost requirement
for an official syntax or frontend cutover.

The complete evidence is retained:

- `results/source-cost-readonly-call.json`: original provenance, output checks and medians.
- `results/source-cost-readonly-call-samples.json`: all 240 original cells, including warmup.
- `results/source-cost-readonly-call-analysis.json`: independently recomputed medians, CPU and
  every increased field against all four controls.
- `results/source-cost-readonly-call-preparation.json`: strict preparation without timing.
- `results/source-cost-readonly-call-correctness.json`: retained correctness logs and reduced
  host-mutation counterexample, with an independent sanitizer replay.
- `results/source-cost-readonly-call-decision.json`: rejection, scope and evidence hashes.
- `results/source-cost-readonly-call-source-bundle.json` and
  `results/source-cost-readonly-call-source.bundle`: exact experimental Git history.

## What changed

Experimental compiler 69 reuses existing readonly C variants for ordinary scalar-result calls
whose signatures recursively contain no `io`. It does not introduce another body variant, alter
the public value ABI, change owned iteration calls or change the 4096-byte storage boundary.
Only `src/backends.ts` and `src/targets.ts` differ in the consumed compiler input inventory.
The experimental source commit also updates self-hosted version literals and supplies independent
C/C++ alias, ABI, storage-boundary, effect-order, host-mutation and cache controls. That feature
is archived; the production compiler remains 68.

The `io` restriction is necessary. The initial unguarded prototype let an external host callback
mutate an aggregate borrowed from the caller while a callee was reading it. Genuine compiler 68
copies the small aggregate for that ordinary call and returns `1`; the unguarded prototype returns
`0`. The exact reduced source and both C files are in `readonly-call/host-mutation*`. An independent
Clang 19.1.7 C11 `-O0` AddressSanitizer/UndefinedBehaviorSanitizer replay reproduces those outputs.
The final candidate keeps effectful calls on the original value route, and its focused C/C++
controls include a forced incorrect-route negative control. This counterexample is correctness
evidence, not a timing result.

## Recorded comparison

| Subject | Commit | Tree |
| --- | --- | --- |
| Common control | `04962213098a07bd25d7afa81c748e17e9f1ea6e` | `a383635bbbb0893a4c1789713b8e7b8d31c21989` |
| Measured candidate | `38e2c1ab219bd105ef388e92344011ef4ef52274` | `c66c909d73eb1a3483cadc4790a99c7ef7703cc9` |
| Original guarded feature | `448508d7509c0b1f56166b8a883d7efdf24f4bb8` | `f3174e5e563a2835b3d7f2d5486e305b9d89fac9` |

The measured candidate is the common control plus the isolated guarded feature. Both artifacts
consume the same 612 functions in 23 A0 modules, normalized source SHA-256
`0166c16c5b04432f53766f275ed10975693df7a3504f3217cb3fdceaa446fcb0`, and the same eight structural
API signatures. Native runtime, toolchain, actual include closure, complete flags and libraries
match. Strict preparation freshly rebuilds all three TypeScript compilers, re-emits each exact C
artifact and reproduces each complete Wasm/build record before checking all six frozen outputs.
The formal run repeats those checks and final immutable inventories.

The five rotated fresh-process arms ran from `2026-10-18T11:47:47.380Z` to
`2026-10-18T11:49:55.730Z`, with one discarded warmup and seven measured rounds: 240 total cells,
210 accepted cells, maximum recorded load 1.67. Every emitted C hash matches the historical
reference through one fixed historical C emitter. The archived analysis independently checks
all 450 reported median fields, derives 30 process CPU medians and checks every cell's output
and preloaded artifact identity.

| Input | Frontend ms, candidate/control | Pipeline ms, candidate/control | Child wall ms, candidate/control | Frontend process CPU ms, candidate/control | Live frontend RSS MiB, candidate/control |
| --- | --- | --- | --- | --- | --- |
| life | 18.273 / 18.118 | 36.576 / 36.845 | 143.724 / 143.348 | 38.939 / 40.191 | 49.879 / 50.242 |
| frame | 23.841 / 22.988 | 50.401 / 52.462 | 167.994 / 165.633 | 73.904 / 75.292 | 61.352 / 60.227 |
| page | 211.664 / 204.301 | 306.099 / 297.989 | 417.210 / 402.864 | 393.481 / 363.456 | 77.141 / 75.203 |
| docs | 96.077 / 96.888 | 151.278 / 152.018 | 261.394 / 261.541 | 195.945 / 195.883 | 57.000 / 57.031 |
| boot | 1333.261 / 1314.183 | 2468.068 / 2463.909 | 2611.752 / 2610.179 | 1578.273 / 1564.825 | 141.012 / 141.984 |
| parser | 179.359 / 179.552 | 379.950 / 377.264 | 489.197 / 485.619 | 357.657 / 369.729 | 60.785 / 61.418 |

Frontend medians increase for life, frame, page and boot. Pipeline medians increase for page,
boot and parser; child wall increases for all inputs except docs. Frontend process CPU increases
for page, docs and boot. Live frontend RSS increases for frame and page; post-emission RSS
increases for all six. Peak RSS increases for boot and parser. Retained Wasm linear memory is
equal for every input. All other increases, including initial memory and heap/external counters,
remain in the full analysis; no increase is dismissed as noise or assigned a cause by this run.

The candidate Wasm SHA-256 is `be3fafbf494fc1a72c2634b326d4737e0554fce3127a83a0eabf777a58da99a8`;
the control is `48e232862ed57f335c84cf3cd46bc12bbff482ac0c75bb242763409de5298926`. Both are 358233
bytes. The reduced native `-O0` lowering removes two observed by-value calls/copies, but that
local observation does not establish whole-frontend speed or memory improvement.

This is one run on one machine without uncertainty intervals or a significance conclusion.
Frontend phases include instantiation, source upload and typed-IR decoding; Wasm module
compilation and artifact validation are outside them. Child wall includes startup and artifact
preparation. CPU includes all process threads. Initial/peak RSS has a shared launch floor on
smaller inputs. Graph loading, shipping CLI startup, formatting, AI editing/inference, target
execution and total AI computation are not measured.

## Recompute the retained analysis

After building the current checkout, this checks the immutable raw report/sample hashes and
rewrites the analysis through `writeReport`:

```sh
bun run build
node experiments/unification/compiler-codegen/readonly-call/analyze.mjs
```

## Recover and rebuild the exact experiment

The binary Git bundle is 10397 bytes, SHA-256
`cd9cd26fc26d34434940ec1c1576f382dab909f1d3721f42d1f91f668c41a983`. Two deterministic creations
are byte-identical. An isolated repository containing only common-control history cannot
resolve the candidate before import and recovers both exact commits/trees afterward. Both bundle
prerequisites, `0496221` and original feature parent `1d937df`, are in common-control history;
the historical emitter `764de84` is there too. Fetch full prerequisite history in a shallow clone.
Importing these refs does not merge the feature.

```sh
readonlyRoot=$PWD
readonlyReplay=$(dirname "$readonlyRoot")/a0-readonly-call-replay
mkdir -p "$readonlyReplay"
readonlyBundle=$readonlyRoot/results/source-cost-readonly-call-source.bundle
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const archive = JSON.parse(readFileSync('results/source-cost-readonly-call-source-bundle.json', 'utf8'));
const bytes = readFileSync(archive.path);
assert.equal(archive.storage, 'binary-file');
assert.equal(bytes.length, archive.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256);
JS
git cat-file -e '04962213098a07bd25d7afa81c748e17e9f1ea6e^{commit}'
git bundle verify "$readonlyBundle"
git fetch "$readonlyBundle" \
  refs/heads/experiment/readonly-call-candidate:refs/heads/experiment/readonly-call-replay-candidate \
  refs/heads/experiment/readonly-call-feature:refs/heads/experiment/readonly-call-replay-feature
git worktree add --detach "$readonlyReplay/control" 04962213098a07bd25d7afa81c748e17e9f1ea6e
git worktree add --detach "$readonlyReplay/candidate" 38e2c1ab219bd105ef388e92344011ef4ef52274
git worktree add --detach "$readonlyReplay/historical" 764de84ab99a156e41164518f14cc0676b6343dd
```

The recorded environment is Node v24.19.0, TypeScript 5.9.3, Debian Clang 19.1.7 and LLD
19.1.7. Install locked dependencies and select the matching tools/libraries. Their hashes, full
flags, actual includes and effective compiler commands are in the archived build manifests;
external tools/libraries are not embedded in the source bundle.

```sh
export A0_WASM_CLANG="$(command -v clang-19)"
export A0_WASM_LD="$(command -v wasm-ld-19)"
readonlySysroot=/path/to/wasi/usr
readonlyBuiltins=/path/to/libclang_rt.builtins-wasm32.a
mkdir -p "$readonlyReplay/tmp"
export TMPDIR="$readonlyReplay/tmp"
for readonlySubject in control candidate historical; do
  (cd "$readonlyReplay/$readonlySubject" && bun install --frozen-lockfile && bun run build)
done
for readonlySubject in control candidate; do
  (cd "$readonlyReplay/$readonlySubject" && \
    node dist/tools/source-native-build.js \
      --out=.a0-tmp/readonly-call-replay-artifact \
      --sysroot="$readonlySysroot" --builtins="$readonlyBuiltins" \
      --opt-level=O3 --wasm-features=mvp --symbols=strip --diagnostic-ports=disabled)
done
cd "$readonlyReplay/candidate"
node --test dist/test/c-readonly-calls.test.js
node dist/tools/source-cost-bench.js --compiler-codegen \
  --baseline="$readonlyReplay/historical" \
  --artifact="$readonlyReplay/candidate/.a0-tmp/readonly-call-replay-artifact" \
  --control-artifact="$readonlyReplay/control/.a0-tmp/readonly-call-replay-artifact" \
  --control-checkout="$readonlyReplay/control" \
  --sysroot="$readonlySysroot" --builtins="$readonlyBuiltins" \
  --out=.a0-tmp/readonly-call-replay-preparation --prepare-only
```

Preparation takes no timing samples. A new coordinated quiet run uses a new output directory
and omits `--prepare-only`; its results remain separate from this original run. Different
toolchains constitute a new experiment even if both subjects match each other.
