# Existing mutable owned-core sharing archive

This preserves exact feature commit `c636c7550037e97a2605926c60243cf2b5f7719e` and
proof commit `74aa08f465e67904fd9ace084aa3fa3470d184b5`. The feature remains an isolated
experiment. This archive adds no shipping compiler implementation and adopts no
default or bootstrap seed. The retained proof contains no timing claim.

The feature makes eligible small public by-value entries call their existing
mutable owned cores. It adds no variant class and changes no ordinary-call route,
large-state policy, aggregate-extra policy, public signature or callable symbol.
The original proof and its independent C/C++ controls are recovered verbatim from
the proof commit at `docs/design/c-existing-owned-sharing-experiment.md` and
`results/c-existing-owned-sharing-experiment.json`.

The original size rejection remains: same-S0 C is 2,100,570 bytes, already 3,418
bytes above the unchanged 2,097,152-byte seed ceiling. The candidate's actual S1
stable C is 2,113,267 bytes. No package was assembled. These recorded byte counts
are also pinned in `metadata.json`; they establish no runtime or memory result.

`source.bundle` is a real binary Git v2 bundle, 19,717 bytes, SHA-256
`13a8fc4c72565be2e98e8ab1e6519e1f51de83019decbfc83999d300cdbc916c`.
It contains exactly the feature and proof commits and requires only
`aded1f97d0add593913fad765c7130467c8eb7d7`, which is reachable from archive base
`ca3cc4e07791edc4a33a601d760eb949df474911`. Two bundle creations were byte-identical.
The exposed refs and all commit/tree/parent identities are in `metadata.json`.
Shallow checkouts must fetch the prerequisite's complete history first.

The archived `original-source.a0.txt` contains the exact 439,967-byte frozen S0,
SHA-256 `289d3fab2ff8c56b3380d18db5d748e8e6a0059c39f745d209563cb553ac06e5`.
Archival A0 text uses `.a0.txt` so ordinary corpus discovery does not treat it as
an active input. The bundle preserves original filenames inside the immutable
experimental commits, restored only in isolated worktrees. The 2,453,258-byte raw
baseline C is regenerated and checked against
`a02367c160c970a54a6340b029b0c8bce0e7ef14be3c59491a74c3f6e781fbf3`.

Run from a checkout containing this archive and the prerequisite history. Select
explicit Clang C/C++ executables with ASan/UBSan support. The original native proof
used Debian Clang 19.1.7; Node.js 24, Bun, Python 3, `nm`, POSIX shell tools and
pthreads are required. Locked JavaScript dependencies are installed separately in
each isolated worktree; external tools and libraries are not bundled.

```sh
export A0_CLANG="$(command -v clang-19)"
export A0_CLANGXX="$(command -v clang++-19)"
ownedReplay=$(dirname "$PWD")/a0-existing-owned-sharing-replay
node experiments/unification/compiler-codegen/existing-owned-sharing/replay.mjs \
  "$ownedReplay"
```

Use a new sibling output directory on every run, keeping the experimental
worktrees outside the invoking checkout's source-tool discovery. The replay
performs these checks in order:

1. Verify the bundle and archived S0 byte identities and the sole prerequisite.
2. Fetch only prerequisite ancestry into an empty repository, clone it without
   local object hardlinks or alternates, and prove both experimental commits are
   absent before importing the bundle.
3. Import the bundle, check both exact commit/tree/parent identities, and create
   detached worktrees at the prerequisite and proof commits. No patch is applied
   or reimplemented, and neither feature commit is merged into the invoking tree.
4. Build the existing TypeScript tools in both worktrees. At the prerequisite,
   invoke `tools/c-arena-stage.js --prepare`, then the existing
   `tools/c-arena-stage.sh` C-only stages 2, 3 and 4. Require exact S0 bytes and the
   recorded baseline C hash for all three stages before candidate controls run.
5. At the exact proof commit, invoke its original `experiment.mjs` with that
   verified stage4 C, frozen S0 and a caller-owned artifact directory, then invoke
   its original `host-mutation.mjs`. Check the same-S0 candidate hash, 263 wrappers,
   all 12 independent ABI/effect/ownership controls, all 12 original host-mutation
   controls, and the candidate's own S1 native stages 2, 3 and 4.

Generated C is consumed verbatim. The recipe adds no A0 parser, patch adapter or
output rewrite. Reports and command logs stay in the new output directory. A
scrubbed replay summary is written as `replay-report.json`; the committed archive
verification is `verification.json`. Replaying records no timing samples and
changes no seed or default.

For Git recovery verification without rebuilding the experiment:

```sh
node experiments/unification/compiler-codegen/existing-owned-sharing/replay.mjs \
  "$(dirname "$PWD")/a0-existing-owned-sharing-import" --import-only
```
