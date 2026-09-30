# Task set E errata

Original seal (`ai-edit-tasks-e.sha256` as delivered): `8a3595ddd04241e9d516a527df938f4e0b319246e3c3d556ce7cd52fd24d702a`.

The file as received in the working tree already hashed to
`369eee40bac262227f943908d148dabda88462e8d49b3ad5ec31dc4d10337e5e` (its mtime is 40 s after the
seal file's), so the sealed bytes were not available; the changes below are relative to the
received file. The file is under `biome check --write` (tools/**), which can reformat it.

Harness self-check (`A0_EXPERIMENT_TASKSET=e`, empty replies) before the changes failed with:

- `e-merge-funcs` a0/ts/rust original-must-fail: original already passes.
- `e-inrange-bool` a0/ts original-must-fail: original already passes.

Changes:

1. Removed `e-merge-funcs`. It is a pure refactor (inline `addone` and `dbl` into `bump`): the
   original already computes the required values, so the acceptance tests cannot tell an edited
   program from an unedited one, and it cannot be a held-out edit task.
2. Removed `e-inrange-bool`. The requested change is a result-type change only (u32 1/0 to bool);
   the harness's acceptance equality (`sameValue` in tools/ai-edit-experiment.ts) treats u32 1/0
   and true/false as equal, so the A0 and TypeScript originals already pass and the edit is not
   measurable. Rewriting the task would change its intent, so it is removed.

No expected values, references, instructions or primer syntax were changed: every remaining
expected value was checked by hand under u32 wrapping rules and every reference passes its tests
in all three languages. 11 tasks remain. Self-check after the changes: ok.

New seal: `ai-edit-tasks-e.sha256`.
