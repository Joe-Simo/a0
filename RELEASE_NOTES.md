# A0 v0.8.16

A0 is a programming language built for AI: a compact, exactly specified language that models write and edit through
revision-checked structured edits. This release carries compiler `a0c-0.1.36` (v0.8.15 carried `a0c-0.1.6`). The current
state, limits and next actions are in [STATUS.md](STATUS.md); every number below is in the `results/` file named beside it.

## Install

```bash
brew tap Joe-Simo/a0 https://github.com/Joe-Simo/a0 && brew install a0   # macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 | iex   # Windows
```

`a0 --version` prints `a0 0.8.16 (compiler a0c-0.1.36)`. Each binary below is checked against `checksums.txt`
(SHA-256) by the install scripts and by the Homebrew formula.

## Assets

- Binaries, no Node or Bun needed: `a0-darwin-arm64`, `a0-darwin-x64`, `a0-linux-arm64`, `a0-linux-x64`, `a0-windows-x64.exe`.
  The macOS binaries are ad-hoc signed, not notarized; the Windows binary is unsigned.
- MCP Bundles for Claude Desktop, one per binary: `a0-mcp-darwin-arm64.mcpb`, `a0-mcp-darwin-x64.mcpb`,
  `a0-mcp-linux-arm64.mcpb`, `a0-mcp-linux-x64.mcpb`, `a0-mcp-windows-x64.mcpb`.
- `checksums.txt` (the ten files above) and `server.json` (the MCP registry manifest with the bundles' URLs and SHA-256).

## What changed

- `a0 --version`, and the MCP and LSP servers report the release version.
- Homebrew: this repository is the tap (`Formula/a0.rb`); there is no separate tap repository.
- One release workflow builds the five binaries and five bundles, publishes them with `checksums.txt` and `server.json`,
  and records the checksums in `Formula/a0.rb` on `main`. Maintainer steps are in [docs/RELEASING.md](docs/RELEASING.md).
- Compiler `a0c-0.1.6` to `a0c-0.1.36`: see [STATUS.md](STATUS.md) for what exists now (targets, self-hosting, the optimizer and
  its equivalence proof) and `docs/history/` for the dated record.

## Results, as recorded

### Wins and ties

Wins, from `results/exec-benchmark.json` (10 kernels; geometric mean of the baseline's time per call over A0's emitted C, so a
number above 1 means A0 is faster): Python 173.6, Go 1.66, TypeScript 1.52, Java 1.41. The run was not on a quiet machine: the
recorded 1-, 5- and 15-minute load averages are 6.4, 6.8 and 8.0 on 8 cores, under the gate of 10 but not idle. The JavaScript
row was re-measured on a heavily loaded machine (`jsRemeasured` in the same file) and is not claimed.

Ties, from the same file: hand-written C 0.996, Rust 0.999, C++ 1.005, Zig 0.995, Nim 1.045, Crystal 1.016, D 1.009, V 1.033 and
Odin 1.004 are within 5% of A0; no other language in the benchmark set is within 5%.

### Losses

From `results/loss-ledger.json`: 446 recorded cases where a competitor beats A0 beyond the tie band, 21 of them
unverified (recorded above load 10, or with no load recorded). By axis: kernel tokens 377, whole-task tokens for conventional
edits 24 and for structured edits 20, wasm load time 12, wasm ns per trip 9, structured acceptance 2, emitted JavaScript
against hand-written JavaScript 1, wasm bytes 1. Single-function tasks cost A0 more tokens than TypeScript and Rust because the
primer is paid on every call.

### Correctness and limits

From the results files named in [STATUS.md](STATUS.md):

- 48 generated functions, 5262 input cases: the interpreter, optimizer, JavaScript, C (clang and gcc), C++, parallel C, wasm and
  JVM pass all of them; direct arm64, x86-64, RISC-V, AVR and ARM32 pass the 4297 io-free cases (`results/verification.json`).
- Optimizer proved equivalent with Z3 on 48 of 48 corpus functions, no counterexample, none unknown (`results/equivalence.json`).
- Behavior table: 718 rows on 20 targets, 19 pass, 1 skipped with a recorded reason, 0 fail (`results/behavior.json`).
- Not run: FPGA place-and-route, ASIC cell library, timing, area, power (`results/hardware.json`); no GPU speed claim and no x86-64
  speed claim.

Model-based measurements use fresh model sessions, not a trained model: set b, 24 trials per cell, tokens per accepted edit for
1 task, 10 tasks and an unbounded session are 311, 184 and 170 for canonical A0 (rank 1, 12 and 24 of 49 languages), acceptance
24 of 24 after one repair (`results/ai-edit-b48-dense.json`).

Not claimed: `results/parallel.json` and `results/edit-loop.json` were recorded under heavy load and are not publishable
timings.
