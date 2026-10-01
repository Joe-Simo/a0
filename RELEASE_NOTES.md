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
  The macOS binaries are ad-hoc signed, not notarized, and the Windows binary is unsigned (no paid certificates). The install
  scripts and Homebrew show no warning. A binary downloaded by hand in a browser can: on macOS run
  `xattr -d com.apple.quarantine ./a0-darwin-arm64` (or right-click, Open); on Windows choose More info, Run anyway, or run
  `Unblock-File .\a0-windows-x64.exe`.
- MCP Bundles for Claude Desktop, one per binary: `a0-mcp-darwin-arm64.mcpb`, `a0-mcp-darwin-x64.mcpb`,
  `a0-mcp-linux-arm64.mcpb`, `a0-mcp-linux-x64.mcpb`, `a0-mcp-windows-x64.mcpb`.
- `checksums.txt` (the ten files above) and `server.json` (the MCP registry manifest with the bundles' URLs and SHA-256).

## What changed

- `a0 --version`, and the MCP and LSP servers report the release version.
- Homebrew: this repository is the tap (`Formula/a0.rb`); there is no separate tap repository.
- One release workflow builds the five binaries and five bundles, publishes them with `checksums.txt` and `server.json`,
  records the checksums in `Formula/a0.rb` on `main`, then installs the release on macOS, Linux and Windows through the
  install scripts and runs `a0 --version`, `check`, `run` and an MCP handshake. Maintainer steps are in [docs/RELEASING.md](docs/RELEASING.md).
- Compiler `a0c-0.1.6` to `a0c-0.1.36`: see [STATUS.md](STATUS.md) for what exists now (targets, self-hosting, the optimizer and
  its equivalence proof) and `docs/history/` for the dated record.

## Results, as recorded

Every number is in the results file named beside it. Measurements are small test programs on one machine (arm64 macOS, 8
cores); model-based ones use fresh model sessions, not a trained model. Nothing here is a claim that A0 is best.

### Speed (A0's own AArch64 code generator)

From `results/exec-benchmark-full.json`: 19 test programs, A0's direct arm64 backend against the fastest of C (clang -O3), Rust
and Zig on each, in a run whose load gate peaked at 9.78 (limit 10). A win needs A0 at least 1.2x faster; a loss is slower
beyond the tie band. Result: 2 wins, 9 ties, 8 losses.

- Wins: filter2 (A0 takes 0.50 of the time) and arrfill4k (0.76).
- Losses, A0's time over the best baseline's: mat4 4.30x, prefix1k 2.52x, affine 1.59x, hist256 1.50x, clamp 1.45x, xs4k 1.36x,
  minmax1k 1.33x, branchy 1.11x.
- Worst slowdown: mat4, 4.3x against the best baseline and 7.58x against hand-written C with its own inlined driver.
- A0's code is called out of line from a C driver, so it pays a call per iteration; the other languages' drivers are inlined.
- The losses are mostly loop kernels, which are being worked on. No result from that work is claimed here.

### Edit validation

From `results/lang-axes.json` (clean run, load gate peak 9.77, 5 rounds, 3 timed test programs, 48 other languages): the native
`a0 check` takes a median of 2.8 ms and check-and-run 2.5 ms, the lowest of the languages that have each row (next: Perl 6.1 ms
check, Lua 2.8 ms check-and-run).

### Tokens and edit cost

- Source tokens, ten kernels (`results/lang-axes.json`, `results/dense-tokens.json`): canonical A0 is 559, rank 41 of 49
  (lowest is Forth at 323); the dense form is 202, rank 1. Dense is opt-in with its own primer; canonical is the default.
- Equal context (`results/ai-edit-scoped.json`, set b, tokens per task for 1 task, a session of 10 and unbounded): canonical A0
  311, 183 and 169 against TypeScript 389, 165 and 140, so a cold-task lead and a higher cost once the primer is cached. Dense
  with callee bodies is 273, 117 and 99, cheapest on every row, with a larger primer (145 tokens against 118). One hand
  translation per language, 24 trials per cell; differences of about one task are noise.
- 49 languages, set b (`results/ai-edit-b48-dense.json`): canonical A0 costs 311, 184 and 170 for the same three sessions,
  rank 1, 12 and 24 of 49, with 24 of 24 accepted after one repair. That table uses the clarified edit protocol, which adds
  tokens to the other 48 languages; with the earlier protocol text the ranks are 2, 20 and 22. Dense with callee bodies is
  274, 117 and 100, rank 1 on all three.

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

Not claimed: `results/parallel.json` and `results/edit-loop.json` were recorded under heavy load and are not publishable
timings.
