# A0

**The programming language built for AI, not for people.** [a0lang.com](https://a0lang.com) · [Docs](https://a0lang.com/docs/)

A0 is a compact, exactly specified language that models write and edit through revision-checked structured edits. A model reads only what an edit touches, writes only the changed lines, and nothing invalid lands. One program compiles to native machine code (A0's own AArch64 code generator, or C), the browser (wasm32), JavaScript, the JVM, .NET, Metal GPU kernels, and clocked SystemVerilog, and every target is verified against one oracle.

Measured on the repository's benchmarks (Apple M3, 8 cores, `results/*.json`). The machine was not quiet: `results/exec-benchmark.json` records a 1/5/15-minute load average of 6.4-8.0 for the main and arm64 runs and 32-40 for the JavaScript remeasurement; a quiet-machine rerun is pending:

| | |
|---|---|
| Native A0 vs hand-written C | 1.00x time per call (parity) |
| Native A0 vs Python / JavaScript | 174x / 8.0x faster (geometric mean, 10 kernels) |
| Tokens a model reads per edit | 7.3x fewer than reading the whole file |
| Languages benchmarked, checksum-verified | 48 (9 tie A0 within 5%, the rest slower) |
| Oracle cases passing on every target | 5262 / 5262 |
| Optimizer proved equivalent (Z3) | 48 / 48 corpus functions |
| Whole-task tokens vs TypeScript | 3.0x cheaper in a 40-function program; 1.46x more on single-function tasks (both published) |

The site a0lang.com is itself two A0 programs (`site/page.a0`, `site/docs.a0`).

See [DESIGN.md](DESIGN.md) for intent and
semantics, [MODEL_GUIDE.txt](MODEL_GUIDE.txt) for the AI-facing language
instructions, [STATUS.md](STATUS.md) for the current implemented scope, evidence
ledger, blockers, and next action, and `results/` for machine-readable evidence.

## Install

A0 needs no package manager, no Node, and no Bun. Download the `a0` binary for your platform from the [latest release](https://github.com/Joe-Simo/a0/releases/latest) and run it:

```bash
curl -L https://github.com/Joe-Simo/a0/releases/latest/download/a0-darwin-arm64 -o a0 && chmod +x a0
printf 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n' > sq.a0
./a0 run sq.a0 sq 12            # 144
./a0 emit arm64 sq.a0           # A0's own machine code; or c, js, java, sv
./a0 check sq.a0                # diagnostics with codes
```

Binaries: `a0-darwin-arm64`, `a0-darwin-x64`, `a0-linux-x64`, `a0-linux-arm64`, `a0-windows-x64.exe`. A C compiler (clang or gcc) is needed only to link native output on your machine.

## MCP server

`a0 mcp <file-or-dir>` serves A0 to AI agents over stdio (Model Context Protocol), so they edit through tools instead of text files: `a0_open` (function view with a handle), `a0_program` (program handle, optionally scoped to a target), `a0_apply` (edit under a handle; returns the new view or a diagnostic with code/expected/actual/fix), `a0_check`, `a0_run` (reference interpreter, fuel-bounded), `a0_emit` (any target), `a0_save` (only after a successful apply). Paths are confined to the launch root (symlink escapes and `use` escapes rejected); no shell is run; output is bounded.

## Agent integration

- `a0 init [dir]` writes `AGENTS.md` (read by Codex, Cursor, Copilot, Jules and others) with the MCP tool workflow, the edit protocol and the primer path (`.a0/MODEL_GUIDE.txt`, copied in when available, otherwise the GitHub URL), plus `@AGENTS.md` pointers in `CLAUDE.md` and `GEMINI.md`, glob rules for Cursor (`.cursor/rules/a0.mdc`), Windsurf (`.windsurf/rules/a0.md`) and Copilot (`.github/instructions/a0.instructions.md`), and a Gemini CLI `AfterTool` hook (`.gemini/settings.json`). Existing instruction files get the A0 section appended once; other existing files are kept.
- `a0 hook` is the after-edit check: it reads a hook's tool-call JSON on stdin and, when an edited `*.a0` file fails `a0 check`, prints a blocking response whose reason is the exact diagnostic with its `fix:`.
- Claude Code plugin (`plugin/`): a `PostToolUse` hook on `Edit|Write|MultiEdit` (`plugin/hooks/hooks.json`, runs `a0 hook`; set `A0_BIN` if `a0` is not on `PATH`) and the slash commands `/a0-check`, `/a0-emit`, `/a0-run` (`plugin/commands/`).
- CI: `uses: Joe-Simo/a0@main` (root `action.yml`, input `version`, default `latest`) downloads the release binary for the runner and checks every tracked `.a0` file. pre-commit: `repo: https://github.com/Joe-Simo/a0`, hook id `a0-check` (needs `a0` on `PATH`).
- `a0 check` accepts several files and exits 1 if any fails, printing `<file>: error: <code>: ... fix: ...` per failure.

## Contributing to the compiler

The compiler is being rewritten in A0 (see `compiler/` and DESIGN.md section 7a). Until that lands, the compiler itself is TypeScript, and working on it needs Bun or Node 22+. Users of A0 never need this: the released `a0` binary is self-contained.

```bash
bun install
bun run lint        # Biome
bun run typecheck   # tsc --noEmit
bun run test        # node --test on dist/test
bun run verify      # cross-toolchain differential execution -> results/verification.json
bun run hw          # Icarus simulation + Yosys synthesis  -> results/hardware.json
bun run bench       # in-process timings + byte fixture     -> results/benchmark.json
bun run tokens      # tokenizer probe (js-tiktoken)         -> results/tokens.json
bun run exec-bench  # emitted vs 45+ hand-written baselines  -> results/exec-benchmark.json
bun run app         # Life application acceptance, 7 targets -> results/app.json
bun run site        # browser demo (wasm + DOM adapter)     -> site/dist/
bun run gpu         # Metal GPU execution of the corpus     -> results/gpu.json
bun run dotnet      # C# / .NET execution of the corpus     -> results/dotnet.json
```

CLI (after `bun run build`):

```bash
node dist/src/cli.js check examples/kernels.a0
node dist/src/cli.js run examples/kernels.a0 affine 10 3 7      # 37
node dist/src/cli.js emit js|c|java|sv examples/kernels.a0 [out]
node dist/src/cli.js wasm examples/kernels.a0 kernels.wasm       # needs clang + wasm-ld
node dist/src/cli.js revision examples/kernels.a0 affine
node dist/src/cli.js patch examples/kernels.a0 edit.patch [out.a0]
```

Layout: `src/core.ts` grammar/validation/interpreter, `src/edit.ts` revisions and
edit sessions, `src/optimize.ts`, `src/backends.ts` JS/C/Java/SystemVerilog emission
and emission cache, `src/toolchain.ts` installed-tool integration, `src/cli.ts`,
`test/`, `tools/` (corpus + oracle, verify, hw-verify, bench, token-bench).
