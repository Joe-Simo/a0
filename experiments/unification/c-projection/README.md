# Rejected generic C projection comparison

The measured candidate remains experimental. Its smaller frontend binary did not establish the
required no-regression result: frontend latency increased on three inputs and frontend RSS
increased on boot. The complete decision, every measured cell and all observed losses are in
`results/source-cost-c-projection-decision.json`, `results/source-cost-c-projection.json`,
`results/source-cost-c-projection-samples.json` and `results/source-cost-c-projection-analysis.json`.
This archive does not change the production compiler or its default artifact.

`results/source-cost-c-projection-source-bundle.json` contains a base64-encoded incremental Git
bundle. It preserves the exact source, tests and strict comparison framework for these commits:

| Subject | Commit | Tree |
| --- | --- | --- |
| Common control | `b9c35ca6d162e60e7e1945ca41c8652f5b22cc7d` | `1961e784af14d290fc1fa719974a93bb8f362feb` |
| Projection candidate | `41682e2265077a3d69adfd6cbdc9fa8f5e140a95` | `9b2ae63db6634b1eff424fc20521c3583081550c` |

The bundle includes five common framework commits followed by the projection change and its
compiler-version invalidation. It excludes prerequisite commit
`12fe5c8f646f2d339e2c4cf15bd0120f77084ae5` and its reachable history, which the publication branch
already contains. The historical Canonical/Dense control commit
`764de84ab99a156e41164518f14cc0676b6343dd` is in that prerequisite history. A shallow clone must
fetch the full prerequisite history before importing the bundle.

The decoded bundle is 32405 bytes with SHA-256
`a3a797a943866b33912647471f7898935d4e8b7b074b72c9a818a29e25efca07`.
The JSON records each commit, tree, parent, bundle ref and the bundle-creation configuration.
Two creations produced identical bytes. An isolated repository containing only the prerequisite
history successfully imported the bundle and recovered every recorded commit and tree; both
experimental commits were confirmed absent before import. Those checks did not rebuild or
rerun the measured experiment.

## Import the frozen sources

Run from a full checkout containing the prerequisite. The commands create experimental refs and
separate detached worktrees; they do not merge the candidate into the current branch.

```sh
projectionRoot=$PWD
projectionReplay=$(dirname "$projectionRoot")/a0-c-projection-replay
mkdir -p "$projectionReplay"
projectionBundle=$projectionReplay/sources.bundle
node --input-type=module - \
  results/source-cost-c-projection-source-bundle.json "$projectionBundle" <<'JS'
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
assert.equal(archive.sha256, 'a3a797a943866b33912647471f7898935d4e8b7b074b72c9a818a29e25efca07');
writeFileSync(bundlePath, bytes, { flag: 'wx' });
JS
git cat-file -e '12fe5c8f646f2d339e2c4cf15bd0120f77084ae5^{commit}'
git bundle verify "$projectionBundle"
git fetch "$projectionBundle" \
  refs/heads/measure/c-projection-common:refs/heads/experiment/c-projection-replay-control \
  refs/heads/measure/c-projection-candidate:refs/heads/experiment/c-projection-replay-candidate
git worktree add --detach "$projectionReplay/control" b9c35ca6d162e60e7e1945ca41c8652f5b22cc7d
git worktree add --detach "$projectionReplay/candidate" 41682e2265077a3d69adfd6cbdc9fa8f5e140a95
git worktree add --detach "$projectionReplay/historical" 764de84ab99a156e41164518f14cc0676b6343dd
```

## Rebuild and verify preparation

The recorded compiler environment is Node v24.19.0, TypeScript 5.9.3, Debian Clang 19.1.7
and Debian LLD 19.1.7. Install locked dependencies in each worktree. Select the matching Clang,
LLD, WASI sysroot and builtins explicitly; the complete flags, library hashes, actual header
inventory and effective compiler command hash are in
`results/source-cost-c-projection-preparation.json`. The source archive does not include these
external tools or libraries.

Set the following paths for that toolchain, then run:

```sh
export A0_WASM_CLANG="$(command -v clang-19)"
export A0_WASM_LD="$(command -v wasm-ld-19)"
projectionSysroot=/path/to/wasi/usr
projectionBuiltins=/path/to/libclang_rt.builtins-wasm32.a
mkdir -p "$projectionReplay/tmp"
export TMPDIR="$projectionReplay/tmp"
for projectionSubject in control candidate historical; do
  (cd "$projectionReplay/$projectionSubject" && bun install --frozen-lockfile && bun run build)
done
for projectionSubject in control candidate; do
  (cd "$projectionReplay/$projectionSubject" && \
    node dist/tools/source-native-build.js \
      --out=.a0-tmp/projection-replay-artifact \
      --sysroot="$projectionSysroot" --builtins="$projectionBuiltins" \
      --opt-level=O3 --wasm-features=mvp --symbols=strip --diagnostic-ports=disabled)
done
projectionCandidateArtifact=$projectionReplay/candidate/.a0-tmp/projection-replay-artifact
projectionControlArtifact=$projectionReplay/control/.a0-tmp/projection-replay-artifact
cd "$projectionReplay/candidate"
node dist/tools/source-cost-bench.js --compiler-codegen \
  --baseline="$projectionReplay/historical" \
  --artifact="$projectionCandidateArtifact" --control-artifact="$projectionControlArtifact" \
  --control-checkout="$projectionReplay/control" \
  --sysroot="$projectionSysroot" --builtins="$projectionBuiltins" \
  --out=.a0-tmp/projection-replay-preparation --prepare-only
```

The expected control artifact is 358233 bytes with SHA-256
`48e232862ed57f335c84cf3cd46bc12bbff482ac0c75bb242763409de5298926`; the candidate is
357264 bytes with SHA-256 `e859a2d54955ac7f922d6bdf2da5df11237f5e14850f3b5fa18f7ac152fc8e14`.
Verify these identities against the archived preparation report. The strict harness also
rebuilds each artifact with its own compiler, compares the full build provenance and checks all
six frozen source inputs through the historical C emitter. A different toolchain is a new
experiment even if its two subjects match each other.

To repeat timing after preparation passes and the machine is isolated, run the same benchmark
command with another fresh `--out` directory and omit `--prepare-only`. Keep the frozen code,
artifacts and options unchanged. The harness runs five rotated arms, one warmup and seven
measured rounds across six inputs, retaining all 240 cells and checking output hashes and load.
New timing is separate evidence; it does not replace the archived rejected result.
