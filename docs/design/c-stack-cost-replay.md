# Replay the archived C stack cost measurements

The [cost archive](../../results/source-frontend-c-stack-cost.json) uses
`subjects/` and `inputs/` directories. The unchanged
analyzer expects the original preparation layout and the measured source commit
`3b60ea376dbd32efd52f8a8f6b1cf6f8c54178b8`. Running it from a later evidence commit
correctly refuses that checkout. Replaying the existing observations does not
require running another benchmark.

From a checkout containing the restore helper and cost archive, create a
separate frozen worktree and build its SDK. The example sibling directory must
not already exist:

```sh
git worktree add --detach ../a0-stack-cost-replay 3b60ea376dbd32efd52f8a8f6b1cf6f8c54178b8
(cd ../a0-stack-cost-replay && bun install --frozen-lockfile && bun run build)
python3 test/fixtures/c-stack-cost/restore.py \
  results/source-frontend-c-stack-cost-artifacts.zip \
  --checkout ../a0-stack-cost-replay --out .a0-tmp/archive-replay
(cd ../a0-stack-cost-replay && \
  python3 test/fixtures/c-stack-cost/analyze.py .a0-tmp/archive-replay)
cmp ../a0-stack-cost-replay/.a0-tmp/archive-replay/analysis.json \
  ../a0-stack-cost-replay/.a0-tmp/archive-replay/expected-analysis.json
```

The helper verifies the fixed archive SHA256, all 322 members, the clean source
commit/tree, and every recorded SDK output hash before writing. Use the recorded
dependencies if a build produces different SDK bytes; the helper does not relax
the hashes. It refuses an existing output directory and writes only under the
frozen worktree's `.a0-tmp` directory.

It copies `subjects/{baseline,candidate}` into `baseline/` and `candidate/`, and
recreates `archive/inputs/build.json`, `archive/final/relink.json`, each final
Wasm/proof pair, `archive/frozen/`, and the six top-level input files. Raw child
outputs, preparation, proof, samples and status remain byte-identical. The
archived analysis becomes `expected-analysis.json`; the original analyzer writes
a fresh `analysis.json`. The final comparison checks that replay reproduces the
archived result without changing the original cohort or any source guard.
