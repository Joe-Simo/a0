# Rejected scalar frontend read comparison

The scalar result algorithm remains experimental. Frontend medians improve on five inputs,
but life frontend latency, frame/parser pipeline medians, several CPU and RSS measurements,
and binary size increase. The complete decision, raw samples and every observed increase are in
`results/source-cost-scalar-ap-read{,-samples,-analysis,-decision}.json`. This archive changes
no production compiler, syntax, source route or default artifact.

The strict comparison uses identical compiler, host, runtime, flags, libraries, actual headers,
effective Clang command and eight consumed structural API signatures. Only four A0 modules
differ. No lazy-error, compact-metadata, C-projection or compiler-version change is included.

| Subject | Commit | Tree |
| --- | --- | --- |
| Common control | `b3c21472c52e3fc0dac88e9cc3ddb625829652b8` | `54976d27ee46ef82c1de133473f0db1a3fc824ce` |
| Scalar candidate | `f3799b1afc19bc601d1d21dd80406d4e7e0ed1e0` | `ff59eeae1039fb6f253c43300672a68d4c8d08b1` |

`results/source-cost-scalar-ap-read-source.bundle` preserves eight common framework commits
and the scalar change. Metadata in `results/source-cost-scalar-ap-read-source-bundle.json`
records exact commit, tree and parent IDs. It excludes prerequisite
`12fe5c8f646f2d339e2c4cf15bd0120f77084ae5` and its
reachable history. That history includes historical control `764de84ab99a156e41164518f14cc0676b6343dd`.
The bundle is 35189 bytes, SHA-256
`a8a86e5fcd67fa4020160be714edf546a494de00253ca73b948544cb0ba8698e`.
Two creations produced identical bytes. An isolated prerequisite-only repository confirmed both
experimental heads absent before import, then recovered all nine exact commit and tree IDs.
These archive checks did not rerun timing or modify any measured checkout or artifact.

## Import the frozen sources

Use a full checkout containing the prerequisite history. These commands create experimental
refs and sibling detached worktrees; they do not merge the candidate.

```sh
scalarReadRoot=$PWD
scalarReadReplay=$(dirname "$scalarReadRoot")/a0-scalar-read-replay
mkdir -p "$scalarReadReplay"
scalarReadBundle=$scalarReadReplay/sources.bundle
node --input-type=module - \
  results/source-cost-scalar-ap-read-source-bundle.json "$scalarReadBundle" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [archivePath, bundlePath] = process.argv.slice(2);
const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
assert.equal(archive.format, 'git-bundle-v2');
assert.equal(archive.encoding, 'binary');
const bytes = readFileSync(archive.path);
assert.equal(bytes.length, 35189);
assert.equal(bytes.length, archive.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256);
assert.equal(archive.sha256, 'a8a86e5fcd67fa4020160be714edf546a494de00253ca73b948544cb0ba8698e');
writeFileSync(bundlePath, bytes, { flag: 'wx' });
JS
git cat-file -e '12fe5c8f646f2d339e2c4cf15bd0120f77084ae5^{commit}'
git bundle verify "$scalarReadBundle"
git fetch "$scalarReadBundle" \
  refs/heads/experiment/scalar-read-common:refs/heads/experiment/scalar-replay-control \
  refs/heads/experiment/scalar-read-candidate:refs/heads/experiment/scalar-replay-candidate
git worktree add --detach "$scalarReadReplay/control" b3c21472c52e3fc0dac88e9cc3ddb625829652b8
git worktree add --detach "$scalarReadReplay/candidate" f3799b1afc19bc601d1d21dd80406d4e7e0ed1e0
git worktree add --detach "$scalarReadReplay/historical" 764de84ab99a156e41164518f14cc0676b6343dd
```

## Rebuild and verify preparation

The recorded environment uses Node v24.19.0, TypeScript 5.9.3, Debian Clang 19.1.7 and
Debian LLD 19.1.7. Install locked dependencies in each subject and select the matching Clang,
LLD, WASI sysroot and builtins. Full flags, library hashes, actual headers and the effective
compile-command hash are in `results/source-cost-scalar-ap-read-preparation.json`.
External toolchains and libraries are not included in the source bundle.

```sh
export A0_WASM_CLANG="$(command -v clang-19)"
export A0_WASM_LD="$(command -v wasm-ld-19)"
scalarReadSysroot=/path/to/wasi/usr
scalarReadBuiltins=/path/to/libclang_rt.builtins-wasm32.a
mkdir -p "$scalarReadReplay/tmp"
export TMPDIR="$scalarReadReplay/tmp"
for scalarReadSubject in control candidate historical; do
  (cd "$scalarReadReplay/$scalarReadSubject" && bun install --frozen-lockfile && bun run build)
done
for scalarReadSubject in control candidate; do
  (cd "$scalarReadReplay/$scalarReadSubject" && \
    node dist/tools/source-native-build.js --out=.a0-tmp/replay-frontend \
      --sysroot="$scalarReadSysroot" --builtins="$scalarReadBuiltins" \
      --opt-level=O3 --wasm-features=mvp --symbols=strip --diagnostic-ports=disabled)
done
cd "$scalarReadReplay/candidate"
node dist/tools/source-cost-bench.js --source-algorithm \
  --baseline="$scalarReadReplay/historical" \
  --artifact=.a0-tmp/replay-frontend \
  --control-artifact="$scalarReadReplay/control/.a0-tmp/replay-frontend" \
  --control-checkout="$scalarReadReplay/control" \
  --sysroot="$scalarReadSysroot" --builtins="$scalarReadBuiltins" \
  --out=.a0-tmp/replay-preparation --prepare-only
```

The control is 358233 bytes, SHA-256
`48e232862ed57f335c84cf3cd46bc12bbff482ac0c75bb242763409de5298926`; the candidate is
358353 bytes, SHA-256 `7fa6b3477959a68e04987ca84752f9685fa787d22913b42fe99d5721179a80e5`.
The strict harness reproduces complete native artifacts and build records and verifies all six
frozen inputs through one historical C emitter. Different external tools constitute a new
experiment even when its two subjects match each other.

To repeat timing after preparation passes and the machine is isolated, use the same command
with a fresh output directory and omit `--prepare-only`. Preserve the frozen subjects and
options. The harness retains all 240 rotated cells: one discarded warmup and seven measured
rounds for five arms across six inputs. New timing is separate evidence and does not replace
this rejected result. The arithmetic archive recomputes all reported medians and retains
every elapsed-time, CPU, memory and phase-growth increase; equal inherited peak RSS does not
establish memory parity on the five smaller inputs.
