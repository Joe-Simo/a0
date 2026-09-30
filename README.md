# A0

**The programming language built for AI, not for people.** [a0lang.com](https://a0lang.com) · [Docs](https://a0lang.com/docs/)

A0 is a compact, exactly specified language that models write and edit through revision-checked structured edits. A model reads only what an edit touches, writes only the changed lines, and nothing invalid lands. One program compiles to native machine code (A0's own AArch64 code generator, or C), the browser (wasm32), JavaScript, the JVM, .NET, Metal GPU kernels, and clocked SystemVerilog, and every target is verified against one oracle.

Measured on the repository's benchmarks (Apple M3, quiet machine, `results/*.json`):

| | |
|---|---|
| Native A0 vs hand-written C | 1.00x time per call (parity) |
| Native A0 vs Python / JavaScript | 289x / 10x faster (geometric mean, 10 kernels) |
| Tokens a model reads per edit | 7.3x fewer than reading the whole file |
| Oracle cases passing on every target | 5262 / 5262 |
| Optimizer proved equivalent (Z3) | 48 / 48 corpus functions |
| Whole-task tokens vs TypeScript | 1.46x (a loss, published) |

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

## Building the compiler from source

The compiler itself is written in TypeScript (A0 is not self-hosted yet), so building it from source needs Bun or Node 22+. Users of A0 do not need this.

Requires Node 22+ and Bun (npm equivalents work: `npm install`, `npm run <script>`).

```bash
bun install
bun run lint        # Biome
bun run typecheck   # tsc --noEmit
bun run test        # node --test on dist/test
bun run verify      # cross-toolchain differential execution -> results/verification.json
bun run hw          # Icarus simulation + Yosys synthesis  -> results/hardware.json
bun run bench       # in-process timings + byte fixture     -> results/benchmark.json
bun run tokens      # tokenizer probe (js-tiktoken)         -> results/tokens.json
bun run exec-bench  # emitted vs hand-written C/JS kernels  -> results/exec-benchmark.json
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
