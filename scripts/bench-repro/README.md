# Reproducing the A0 numbers

Every figure on [a0lang.com/benchmarks](https://a0lang.com/benchmarks) comes from a file in `results/`. This folder says
how to produce each file again on a fresh machine, what it needs, how long it takes, and which experiments cannot be
re-run without a model. Scripts are POSIX `sh` plus Node; no Python, no network, no key. On Windows use Git Bash.

```sh
git clone https://github.com/Joe-Simo/a0 && cd a0
sh scripts/bench-repro/check.sh        # machine, tool versions, current load; nothing is written
```

Output goes to `scripts/bench-repro/out/` (git-ignored). `speed.sh` never overwrites a committed file in `results/`.
`tokens.sh` and `verify.sh` run tools that write into `results/`; they save the committed copy and put it back.

## Needs

| Tool | Version used | Needed for |
|---|---|---|
| Bun | 1.4.2 here; CI pins 1.3.4 | install, build, `bun run` entry points |
| Node | 22 or newer; 22.21.1 here, 24.14.0 for the native results | everything (the tools run as `node dist/tools/*.js`) |
| clang | 22.1.8 here (MSYS2); Apple clang 21.0.0 for the native results; Ubuntu 24.04 package in CI | exec-bench, wasm-bench (needs `wasm32` and `wasm-ld`), C-based checks |
| rustc | 1.96.0 for the native results | the Rust row of exec-bench (without it that row fails, the rest run) |
| Zig, Go, JDK, .NET SDK, other compilers | any recent release; JDK 21.0.12 and .NET 10.0.401 here, .NET 10.0.x in CI | one exec-bench row each; a missing toolchain is a skipped row, never a number |
| gcc, g++, iverilog, yosys, z3, qemu | CI installs `clang lld gcc g++ iverilog yosys` | `verify`, `equiv`, `hw`, `behavior` targets; a missing one is reported as blocked or skipped |

The per-language compiler versions of the native run are not recorded in `results/exec-benchmark-full.json`; only
`node`, `clang` and `rustc` are (see Known problems on the benchmarks page).

## What each result needs, how long, where it lands

| What | Command | Needs | Runtime | Output | Field to read |
|---|---|---|---|---|---|
| Setup check, not a result | `sh scripts/bench-repro/speed.sh quick` | clang | about 1 min (measured) | `out/exec-quick.json`, `out/wasm-quick.json` | none: 3 samples |
| wasm against clang | `sh scripts/bench-repro/speed.sh wasm` | clang with wasm32 | about 2 min (measured) | `out/wasm-benchmark.json` | `geomeanSpeedup` (above 1 is A0 faster), `rows[].verdict`, `loadGate` |
| Speed against C, Rust, Zig and 45 other languages | `sh scripts/bench-repro/speed.sh full` | clang, rustc, as many other toolchains as you have | not timed on this machine; tens of minutes to hours, growing with the languages installed | `out/exec-benchmark.json` | `geomeans` (baseline time over A0's emitted C, per language), `arm64VsBestFlags` (the same-calling-convention baseline), `loadGate` |
| Token and edit-cost tables | `sh scripts/bench-repro/tokens.sh` | none beyond Bun and Node | about 1 min (measured) | `results/app-edit.json`, `app-edit-deps.json`, `app-edit-keys.json`, `tokens.json`, `dense-tokens.json`, compared with the committed copies | the script prints `same` or `DIFFERENT` per file |
| Loss ledger | `sh scripts/bench-repro/verify.sh ledger` | none | under 1 min (measured) | `results/loss-ledger.json` (checked, not rewritten) | `entries` (586 at the time of writing), `history` |
| Test suite | `sh scripts/bench-repro/verify.sh test` | clang, JDK, .NET for the target tests | see the number printed by the script at the end | none | exit status |
| Verification and behavior table | `sh scripts/bench-repro/verify.sh full` | clang, gcc, JDK, .NET SDK, Z3, iverilog, yosys, qemu, a POSIX shell | not timed on this machine | `results/verification.json`, `results/behavior.json` (new copies in `out/`) | per-target `pass`; blocked targets are listed, not counted as passes |
| Per-language token counts and validation times | `bun run lang-axes` | every language toolchain; POSIX only (`native-check` builds with `realpath`) | not timed on this machine | `results/lang-axes.json` | `tokens`, `validation`, `coverage` |

## The load gate (why a run may wait)

A timing is only a claim if the machine was quiet. `tools/quiet.ts` blocks before every sample group until the load is at
or below `LOAD_LIMIT` = 10 (the repository's rule for performance claims; override with `A0_MAX_LOAD`, but a number recorded
above 10 is then not publishable). It records what it saw in the result's `loadGate`: `checks`, `waits`, `waitedSeconds`,
`loadSource` and `highestLoadAtSampleStart`. `a0-dev check bench-validity` classifies a recorded run as publishable,
loaded-discard or needs-rerun, and `bun run loss-ledger` marks any loss recorded above 10 as `unverified`.

How the load is measured (`tools/system-load.ts`, one definition for every gate):

- **macOS and Linux:** the kernel's 1-minute load average, `os.loadavg()[0]` (`loadSource` is `loadavg`).
- **Windows:** `os.loadavg()` is always 0 there, so the load is estimated from CPU utilisation: two samples of the
  per-core time counters (100 ms apart) give utilisation times CPU count (`loadSource` is `cpu-utilisation`). A fully busy
  machine reads the CPU count, so the limit 10 orders "busy" the same way, but it is an instantaneous reading, not a
  1-minute average, and cannot see queued tasks. On an 8-core machine the gate rarely trips, so close other programs yourself.

Timings are medians of interleaved samples (7 per side for exec-bench, 15 for wasm-bench), each result checked against a
checksum before it is timed. Never compare numbers from different machines in one claim.

## Experiments that need model access

These cannot be re-run from this repository without model access and, in the case of the subjects, without the same
sealed task sets and fresh model sessions. Their raw data is committed, and the summaries are recomputed by `tokens.sh`:

- **AI-edit experiments** (`results/ai-edit-*.json`, `ai-edit-experiment.*.replies.json`): each subject was a fresh model
  session (Haiku or Sonnet) given the same task in A0 and in each other language; the committed `*.replies.json` files hold
  the replies, the others the scored results. Task sets are in `tools/ai-edit-tasks-*.ts`, sealed by the `.sha256` files
  next to them.
- **Application-scale edit benchmark** (`results/app-edit/report.<model>.<side>.json`, `app-edit-loop/`, `app-edit-deps/`,
  `app-edit-keys/`, `app-edit-wording/`): the subject replies are the raw data; `app-edit-summary`, `app-edit-deps-summary`
  and `app-edit-keys-summary` (run by `tokens.sh`) recompute the counts, intervals and tokens per accepted edit from them.
  Pre-registrations are in `docs/history/`.

What can be recomputed without a model: the summaries above, tokenizer counts (`token-bench`, `dense-tokens`) and the
scoring of the committed replies (`bun tools/app-edit-bench.ts run REPLIES.json OUT.json a0|ts model` scores scripted
replies and calls no model). What cannot: a new reply from a model. To run the experiment again, `bun tools/app-edit-bench.ts
dump` writes the exact prompts, you obtain replies from your own fresh model sessions, and `run` scores them.

## What was and was not tested for this folder

Written and run on one Windows 11 x64 machine (8 vCPU, AMD EPYC 7543P, Git Bash, MSYS2 clang 22.1.8): `check.sh`,
`speed.sh quick` and `speed.sh wasm`, `tokens.sh` (all five files `same`), `verify.sh ledger`. Not run here: `speed.sh
full` (no rustc, Zig or Go on this machine; the quick run showed the missing-toolchain rows are skipped, not failed),
`verify.sh full` (needs Z3 plus iverilog, yosys and qemu, which are not installed), `lang-axes` (does not run on Windows),
and every script on macOS or Linux.
