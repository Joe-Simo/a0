# Rules for every agent working on A0

These rules are binding. The loop below is how A0 is developed; the tools are free, local and
deterministic (no key, no network, nothing paid). Reference: `docs/DEVELOPMENT.md`.

## The loop

1. **Brief.** `a0-dev queue --brief` ranks failure groups by rows unlocked, generality and cost. Start
   from the top group, not from a hunch. `a0-dev order` shows the riskiest-first step order.
2. **Work on your own branch and worktree.** Never share files with another agent. Scratch output goes
   in your own folder, never `/tmp` directly, and never kill processes by broad pattern.
3. **Prereview.** `a0-dev prereview` before the gate: a symptom patch, a hidden fallback, a fabricated
   constant, a thickened shim or a framework branch means rework, not a gate run.
4. **Scope, then the light gate.** `a0-dev scope` says which gate steps your diff needs and why (it errs
   toward running more). `a0-dev gate --light` runs the cheap steps; on a pass of a clean commit it
   writes a gate note bound to the commit's tree (`refs/notes/a0-gate`). An amended or rebased commit
   with different content has no note.
5. **Merge through the pipeline.** The merge agent runs `a0-dev plan <branches>` (independent branches
   batch together, coupled ones are ordered riskiest first), then `a0-dev drive --merge <branches>`.
   `drive` refuses any branch without a passing note for its current tree, merges each batch, runs ONE
   combined gate for the batch, and on a confirmed loss reverts only the branch whose change caused it.
6. **Sort failures by evidence.** `a0-dev decide --step=<step>` says real regression, flake,
   pre-existing or unexplained. A flake is quarantined only when two distinct runs on one tree
   disagree. A single failing run is "unexplained: needs evidence", never a flake.
7. **Claims.** `a0-dev claims --since=<base>` (also part of `bun run lint`). Every number or comparison
   ("N times faster", "fewer", percentages, "fastest") in STATUS.md or a site template needs a nearby
   `results/*.json` reference or a recorded value. A claim you cannot back is deleted or marked
   `claim-ok: <reason>`.
8. **Before you push.** `a0-dev gate` (full) must print `GATE RESULT: pass`; with `--push=<remote>` it
   refuses to push when any required step is missing, skipped, timed out or failed, or the run was
   `--light`.

## Rules that never bend

- **No assistant output overrides a measurement.** Any decision from a wrapper, model or other
  assistant (extra gate steps, a coupling guess, a failure class, a claim review) is a labelled
  hypothesis. Only real test runs, checksums and benchmarks confirm a result. A measured loss wins
  over any prediction; a wrapper may only ADD steps to the deterministic floor, never remove them.
- **Timing claims need a quiet machine.** No timing claim from a run recorded above load average 10
  (`a0-dev check bench-validity` says publishable, loaded-discard or needs-rerun). Interleaved runs,
  medians, and the load written next to the number.
- **Claims need results.** See step 7. Retractions go in STATUS.md next to the claim they correct.
- **The floor is free.** Every tool in `tools/dev/` works with no key and no network. Contributors may
  wrap the tools with whatever they like through `--json` output and flags such as `--add-steps`;
  nothing in the repository depends on a particular wrapper.
- **Push only a passing gate.** Never push a branch whose gate result is missing or failed.
