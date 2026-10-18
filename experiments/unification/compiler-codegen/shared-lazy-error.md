# Shared checker lazy-error comparison

The measured candidate is **not adopted as a default**. Its frontend and pipeline medians are
lower than the unchanged native C control on all six frozen inputs, but process CPU, live RSS
and fresh-child wall losses remain. It also remains slower than the historical Canonical and
Dense controls. The original run, every observed loss and the exact source history are retained:

- `results/source-cost-shared-lazy-error.json`: full provenance, build manifests and medians.
- `results/source-cost-shared-lazy-error-samples.json`: all 240 original cells, including warmup.
- `results/source-cost-shared-lazy-error-analysis.json`: every median field and paired frontend
  ratio against all four controls, including increases.
- `results/source-cost-shared-lazy-error-decision.json`: scope, losses and adoption decision.
- `results/source-cost-shared-lazy-error-source-bundle.json`: exact experimental Git history.

`results/source-cost-shared-lazy-error-preparation.json` records strict preparation for the
shared lazy-error A0 algorithm from `0f9b4d34` against the unchanged `1b1fc66` frontend closure.
Both owned checkouts use the reviewed common builder/host from `b9c35ca`, the same C emitter,
compiler version, runtime, build options and toolchain. No C projection change is included.

The baseline's complete consumed raw A0 closure matches `1b1fc66`. The candidate changes only
`arena_shared.a0`, `check_arena_shared.a0`, `verify_arena_shared.a0` and the legacy entry hook in
`check_arena.a0`; the last file is outside the measured frontend closure. The report records
the normalized source hashes, counts and every changed consumed module. The consumed structural
API signatures match exactly.

Preparation re-emits each exact C artifact through its own freshly built compiler and reproduces
its complete Wasm and build record through its own native builder. Every representative frozen
input produces the expected historical C output, and both source/artifact inventories stay
unchanged. Independent correctness/request evidence is `2dace596`; the six output workloads
do not replace those controls. Preparation contains no timing samples. The later formal run
repeated all preparation and native reproduction checks before measuring.

The formal phase ran from `2026-10-18T11:07:54.577Z` to `2026-10-18T11:10:02.961Z` at maximum
recorded load 1.59. It used five rotated fresh-process arms, one discarded warmup and seven
measured rounds: 240 total cells, 210 accepted cells. Every emitted C hash and final immutable
inventory check passed. The frontend Wasm changed from 358233 to 346838 bytes; retained Wasm
linear memory was equal for every input. These observations establish neither historical parity
nor a no-regression result.

| Input | Frontend ms, candidate/control | Pipeline ms, candidate/control | Process frontend CPU ms, candidate/control | Live frontend RSS MiB, candidate/control |
| --- | --- | --- | --- | --- |
| life | 18.876 / 20.148 | 37.526 / 39.120 | 43.024 / 40.040 | 56.191 / 52.824 |
| frame | 23.242 / 23.415 | 49.640 / 50.248 | 71.719 / 71.568 | 60.172 / 62.219 |
| page | 188.150 / 201.307 | 280.217 / 296.982 | 363.399 / 366.054 | 81.305 / 76.289 |
| docs | 93.550 / 99.637 | 149.760 / 154.295 | 225.527 / 195.276 | 70.773 / 57.246 |
| boot | 1218.842 / 1368.575 | 2365.121 / 2499.237 | 1468.744 / 1629.504 | 141.953 / 141.238 |
| parser | 168.302 / 175.290 | 360.530 / 376.129 | 353.210 / 359.814 | 62.590 / 61.578 |

Fresh-child wall medians increased for life and frame. CPU medians increased for life, frame
and docs; live frontend RSS increased for every input except frame. The full analysis also keeps
initial memory, post-emission memory, peak RSS and all historical-control losses. Initial peak
RSS has a common launch/preload floor on smaller inputs. The process CPU counter includes all
process threads during the frontend phase; it is not function self-time. No significance test,
shipping CLI, graph loading, AI editing/inference or generated-target execution is claimed.

## Recover the exact sources

| Subject | Commit | Tree |
| --- | --- | --- |
| Common control | `b3c21472c52e3fc0dac88e9cc3ddb625829652b8` | `54976d27ee46ef82c1de133473f0db1a3fc824ce` |
| Lazy-error candidate | `85ac150d1915a2546a6533d7c63000b1c5f5725e` | `345bdc6b9924ed9cd7af520631680e5ed704362c` |

The incremental bundle contains nine commits and excludes prerequisite
`12fe5c8f646f2d339e2c4cf15bd0120f77084ae5` and its reachable history. The historical emitter
`764de84ab99a156e41164518f14cc0676b6343dd` is in that prerequisite history. A shallow clone must
fetch the full prerequisite history first. The decoded bundle is 41428 bytes with SHA-256
`6228fc027869f0c7a9192844eed06853e1648d367cf3df853d78dceb633bcd07`.
Two creations were byte-identical. An isolated repository containing only prerequisite history
could not resolve the candidate before import and recovered all nine exact commits/trees after
import. This archive check did not rebuild or repeat timing.

Run from a full checkout containing the prerequisite. The following commands import experimental
refs and create sibling detached worktrees; they do not merge the candidate:

```sh
lazyRoot=$PWD
lazyReplay=$(dirname "$lazyRoot")/a0-shared-lazy-error-replay
mkdir -p "$lazyReplay"
lazyBundle=$lazyReplay/sources.bundle
node --input-type=module - \
  results/source-cost-shared-lazy-error-source-bundle.json "$lazyBundle" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [archivePath, bundlePath] = process.argv.slice(2);
const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
assert.equal(archive.format, 'git-bundle-v2');
assert.equal(archive.encoding, 'base64-lines');
const bytes = Buffer.from(archive.data.join(''), 'base64');
assert.equal(bytes.length, archive.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256);
assert.equal(archive.sha256, '6228fc027869f0c7a9192844eed06853e1648d367cf3df853d78dceb633bcd07');
writeFileSync(bundlePath, bytes, { flag: 'wx' });
JS
git cat-file -e '12fe5c8f646f2d339e2c4cf15bd0120f77084ae5^{commit}'
git bundle verify "$lazyBundle"
git fetch "$lazyBundle" \
  refs/heads/experiment/shared-lazy-error-common:refs/heads/experiment/shared-lazy-error-replay-control \
  refs/heads/experiment/shared-lazy-error-candidate:refs/heads/experiment/shared-lazy-error-replay-candidate
git worktree add --detach "$lazyReplay/control" b3c21472c52e3fc0dac88e9cc3ddb625829652b8
git worktree add --detach "$lazyReplay/candidate" 85ac150d1915a2546a6533d7c63000b1c5f5725e
git worktree add --detach "$lazyReplay/historical" 764de84ab99a156e41164518f14cc0676b6343dd
```

## Rebuild and verify preparation

The recorded environment is Node v24.19.0, TypeScript 5.9.3, Debian Clang 19.1.7 and LLD
19.1.7. Install locked dependencies in each worktree. Select matching Clang, LLD, WASI sysroot
and builtins explicitly; complete flags, library hashes, actual included headers and effective
compiler-command hashes are in the archived preparation and formal reports. External tools and
libraries are not embedded in the source bundle.

```sh
export A0_WASM_CLANG="$(command -v clang-19)"
export A0_WASM_LD="$(command -v wasm-ld-19)"
lazySysroot=/path/to/wasi/usr
lazyBuiltins=/path/to/libclang_rt.builtins-wasm32.a
mkdir -p "$lazyReplay/tmp"
export TMPDIR="$lazyReplay/tmp"
for lazySubject in control candidate historical; do
  (cd "$lazyReplay/$lazySubject" && bun install --frozen-lockfile && bun run build)
done
for lazySubject in control candidate; do
  (cd "$lazyReplay/$lazySubject" && \
    node dist/tools/source-native-build.js \
      --out=.a0-tmp/lazy-error-replay-artifact \
      --sysroot="$lazySysroot" --builtins="$lazyBuiltins" \
      --opt-level=O3 --wasm-features=mvp --symbols=strip --diagnostic-ports=disabled)
done
lazyCandidateArtifact=$lazyReplay/candidate/.a0-tmp/lazy-error-replay-artifact
lazyControlArtifact=$lazyReplay/control/.a0-tmp/lazy-error-replay-artifact
cd "$lazyReplay/candidate"
node dist/tools/source-cost-bench.js --source-algorithm \
  --baseline="$lazyReplay/historical" \
  --artifact="$lazyCandidateArtifact" --control-artifact="$lazyControlArtifact" \
  --control-checkout="$lazyReplay/control" \
  --sysroot="$lazySysroot" --builtins="$lazyBuiltins" \
  --out=.a0-tmp/lazy-error-replay-preparation --prepare-only
```

Expected Wasm SHA-256: control `48e232862ed57f335c84cf3cd46bc12bbff482ac0c75bb242763409de5298926`,
candidate `9f6e68789e1a278bc86671d3f8ff0fb5cbd9bab8f4e115acefd401f33fe0f8b5`.
The strict harness freshly builds all three TS compilers, re-emits each exact native C artifact,
rebuilds each complete Wasm/build record and checks all six frozen outputs through one historical
C emitter. A different toolchain constitutes a new experiment even if the subjects match each
other. To repeat timing on an isolated machine, use another fresh output directory and omit
`--prepare-only`; new samples remain separate from this original run.
