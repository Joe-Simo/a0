# Session 2026-10-01: the hung stage executable

Moved here from STATUS.md (concise since the hygiene cleanup).

## Design decisions recorded from the user (2026-09-29)

- Human readability is not a constraint. The representation is optimized for AI read/write
  cost and correctness; audit views may be derived, never the primary form.
- Any change must be rejected before commit if it fails parsing, typing, or revision
  matching; well-typed wrong behavior is caught by acceptance tests, not by syntax.
- Execution performance across targets is a goal with a ledger, not a claim; ties and
  losses stay visible.

## Session 2026-10-01 (x86-64 steps blocked while Rosetta 2 is stuck)

Rosetta 2's translation service on the gate machine stopped running any x86-64 binary that had not run before (a fresh `clang -arch x86_64` program never exits; already translated binaries such as `arch -x86_64 /usr/bin/true` still do). `rosettaStuck()` in src/toolchain.ts detects it, so the x86-64 target is reported as blocked ("needs Rosetta 2 to run new x86-64 binaries ...") instead of hanging the tests. The gate below passed with that target blocked. Rerun after the Mac restarts: `verify` (the native x86-64 row of results/verification.json), `test` (the x86-64 tests of test/core.test.ts are skipped) and `behavior` (its x86_64 column); regenerate results/verification.json and results/behavior.json from the gate.

### Same task definition for every A0 cell, and the two tasks every form failed

**1. Comparability.** `b-sumfrom-eight` now names its target, which changes the A0 view only. The task was re-collected fresh (one shot; every cell passed, so no retry was needed) for canonical A0, dense, lean and lean3, Haiku and Sonnet, and the 12-task cells were rescored with that trial replaced (`results/ai-edit-experiment.b.{haiku,sonnet}-a0.json` for canonical; the dense cells in `...-dense*-retry.json`). Every A0 cell of `results/ai-edit-b48-dense.json` now uses the same task definition. Corrected canonical A0 (replaces the 326 / 199 / 185 row of the 49-language table above; its Haiku trial now passes one shot): one shot 22/24, after repair 24/24 (rank 1, 33 ties), 311 / 184 / 170 tokens for 1 task / 10 tasks / unbounded, ranks 1 / 12 / 24.

**2. The two tasks every form failed first (`b-bounds-largest`, `b-checksum-poly`; Haiku only, Sonnet passes both).** Read from the replies and the checker rejection: not model error and not task wording. In `bounds` the bug is in the helper `minmax` (second field wrong) and in `checksum` the seed `0` is shown but the missing `* 31` is in `mixel`; the `deps` view shows a callee as a signature line only, so the helper bodies were invisible. Haiku fixed what it could see (swapped the seed, set seed 7) and the checker rejected the wrong output; Sonnet rewrote the helpers from the instruction. The other 48 languages show the whole source, so this was a missing capability of the A0 views, fixed generally: `scope: 'bodies'` (`src/edit.ts` `scopedViewDense`, MCP `a0_open` `scope: 'bodies'`) prints each direct callee as dense text instead of a signature line (about 8 tokens more for a function with a helper; no cost for one without). Test: `dense edits: scope bodies ...` (test/dense.test.ts) and a case in test/mcp.test.ts. Canonical views have the same limit (`bodies` is dense only; canonical treats it as `deps`); canonical A0 is not changed.

**Result with callee bodies** (lean view plus `bodies`, primer 145; `results/ai-edit-experiment.*-dense-bodies*.json`, harness `A0_EXPERIMENT_DENSE_VIEW=bodies`). Set b: one shot 24/24 (both tasks pass for both models). All sets a, b, d, e, f, fresh Haiku and Sonnet, 124 trials (one retry each; the d-set Haiku trial `d-rename-twice` that the subject left unanswered was re-asked fresh):

| form | one shot | after 1 retry | read/task | cost 1 task / 10 / unbounded |
|---|---|---|---|---|
| canonical | 112 | 120 | 89 | 284 / 157 / 143 |
| dense (program view) | 111 | 114 | 75 | 299 / 143 / 125 |
| dense lean | 114 | 122 | 54 | 272 / 115 / 98 |
| dense lean + bodies | 120 | 123 | 56 | 264 / 107 / 90 |

Set-B 49-language table, the subject against the 48 languages (24 trials per cell; W/T/L on cost uses the 1% band):

| subject | 1 task | 10 tasks | unbounded | one shot | after repair |
|---|---|---|---|---|---|
| canonical A0 | 311, rank 1 | 184, rank 12 | 170, rank 24 | 22/24, rank 21 | 24/24, rank 1 |
| dense (program view) | 314, rank 1 | 157, rank 2 | 140, rank 8 | 23/24, rank 6 | 23/24, rank 34 |
| dense lean | 297, rank 1 | 141, rank 1 (ties Ruby) | 123, rank 2 (Ruby 115 ahead) | 22/24, rank 21 | 24/24, rank 1 |
| dense lean + bodies | 274, rank 1 (48/0/0) | 117, rank 1 (48/0/0) | 100, rank 1 (48/0/0) | 24/24, rank 1 (43/5/0) | 24/24, rank 1 (15/33/0) |

From results/ai-edit-b48-dense.json: the earlier statement that the unbounded row is a loss to Ruby by a few tokens holds for the lean view without callee bodies (123 against 115) and is gone with `bodies` (100 against 115), where the gain is fewer retries (calls per task 1.00) rather than fewer tokens; with 24 trials per cell, a one-trial change in acceptance moves a cost by about 8 tokens, so the row is won by a margin of that order and should be read with that noise. Recommendation from the numbers: the lean view with callee bodies is the best dense form on every measured row, and canonical remains the default (its 49-language ranks are 1 / 12 / 24). Whether to make it the recommended dense form of the MCP and docs is left to the owner: the evidence supports it for the dense view (non-inferior or better on acceptance in all five sets, 20 to 40% fewer tokens per task), but dense still needs a 145-token primer, and Haiku's one-shot failures on arity (`f-divrem-pair`, `d-isdiv-bool`) remain.

## Session 2026-10-01 (the hung stage executable: Node's stdin pipe on macOS 27 beta)

- **Symptom.** In `bun run bootstrap` the arm64 stage executable sometimes never finished a chunk: `sample` showed its main thread in `read` (first read of stdin, 1248 KB footprint, 0% CPU) and the parent in `uv__io_poll`/`kevent` inside spawnSync, no data moving.
- **Cause: not our executable, not the driver's protocol.** It reproduces with a 12-line C child that only reads stdin to EOF and writes 120,000 bytes back (below), spawned by Node's `spawnSync(..., { input })` from 12 concurrent processes: 17 stalls in 5400 runs (about 0.3%), 16 stalls in 1800 with the real stage executable (about 1%, a larger executable: more exec time). Controls with the same child and the same 120,953-byte input, 5400 runs each: a Python parent (`subprocess.run(input=...)`, pipes) 0 stalls; a C parent modelled on libuv (AF_UNIX socketpair stdio, nonblocking, kqueue write/read events) 0; Bun's spawnSync 0 (3600); Node with the input as an open file descriptor (`stdio: [fd, 'pipe', 'pipe']`) 0. Small `.bss` (2 MiB) did not stall in 1800 runs, 32 MiB `.bss` did, so the window is the child's start-up time. `lsof` of a stalled child shows stdin as a unix socket (libuv's stdio for `input`), the parent's end open. So the fault is in the path Node's libuv uses to hand a freshly started child its stdin socketpair (macOS 27.2 beta, node v24.14, libuv 1.5x), reproducible without any A0 code.
- **Fix.** `spawnWithInput` (src/toolchain.ts) writes the input to a temp file and gives the child that descriptor as stdin; used by the stage driver (tools/bootstrap.ts `runStageChunk`), the a0w driver (tools/selfhost-wasm.ts) and the site generator (tools/site-gen.ts). The real arm64 stage executable, 12 concurrent loops x 150 runs x 2: 0 stalls (before: 3%). test/spawn-input.test.ts checks the helper. The 120 s watchdog with retries in `runStageChunk` stays only as a safety net (the cause is external).
- **Reproducer** (stalls about once in 300 runs under 12-way concurrency; node v24, macOS 27.2): child `static char big[32u << 20]; int main(void){ long n=0,r; while((r=read(0,big+n,1<<20))>0) n+=r; for(long o=0;o<120000;){ long w=write(1,big,120000-o>n?n:120000-o); if(w<=0) return 1; o+=w; } return 0; }`; parent `spawnSync(child, [], { input: Buffer.alloc(120953), timeout: 20000 })` in a loop in 12 concurrent Node processes. Not reported upstream.
