# Task set F errata

Original seal (`ai-edit-tasks-f.sha256` as delivered): `c10b9d4b1d5bd54c6a0c039de0bc8c58c93f532050c64a549efa575a025b653a`.

The file in the working tree hashes to
`0e648bc5420684e9b6782661895f5149bcb8f73ec5ac6845028dca0a73f1be30`. Its mtime (12:20:42) falls
inside a gate run whose `biome check --write .` step reported "Fixed 1 file" on an untracked file
under tools/**, so the difference is most likely formatter-only; the sealed bytes were not
available to confirm.

Harness self-check (`A0_EXPERIMENT_TASKSET=f`, empty replies): ok, no details. No task content
was changed. Resealed to the current bytes.
