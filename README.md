# A0

**The programming language built for AI, not for people.** [a0lang.com](https://a0lang.com) · [Docs](https://a0lang.com/docs/)

**A0 is a small programming language that AI agents edit through checked, structured edits and compile to native code, wasm, JavaScript, the JVM, .NET, Metal and SystemVerilog from one source.**

## Start in 30 seconds

Pick one. All are free, local, with no account and no key.

**1. Agent skill** (Claude Code, Codex, Cursor, Copilot, Gemini CLI and many other agents, through the [skills CLI](https://github.com/vercel-labs/skills)):

```bash
npx skills add Joe-Simo/a0
```

**2. MCP server** (needs the `a0` binary on PATH, see the next item). Paste into Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) or any client that takes `mcpServers`; Claude Code: `claude mcp add a0 -- a0 mcp .`; VS Code: `.vscode/mcp.json` from [`integrations/vscode.mcp.json`](integrations/vscode.mcp.json).

```json
{ "mcpServers": { "a0": { "command": "a0", "args": ["mcp", "."] } } }
```

**3. The binary** (one file, no Node, SHA-256 verified against the release's `checksums.txt`):

```bash
curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh | sh     # macOS / Linux
irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 | iex           # Windows (PowerShell)
```

Honest status: A0 has no floating point, no heap and no recursion, and strings are bytes. It is a kernel and edit-loop language, not a general-purpose one. The numbers below are measured on one machine that was not quiet, and the loss ledger in [STATUS.md](STATUS.md) lists where A0 is slower. Correctness is split: every target is checked by execution against one oracle, and the optimizer is proved equivalent by Z3 on 48 corpus functions; the rest is tested, not proved. License: [MIT](LICENSE). More: [a0lang.com](https://a0lang.com), [a0lang.com/benchmarks](https://a0lang.com/benchmarks).

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
instructions, [STATUS.md](STATUS.md) for the current results, loss ledger, known limits, and next actions
(session history in [docs/history/](docs/history/)), and `results/` for machine-readable evidence.

## Install

A0 is a single self-contained binary: no Node, no Bun.

```bash
# macOS / Linux: Homebrew (this repository is the tap; no separate tap repository)
brew tap Joe-Simo/a0 https://github.com/Joe-Simo/a0
brew install a0

# macOS / Linux: script (detects OS/arch, verifies SHA-256, installs to ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh | sh
```

```powershell
# Windows (installs to %LOCALAPPDATA%\Programs\a0 and adds it to your user PATH)
irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 | iex
```

Both scripts accept `A0_VERSION=v0.8.16` to pin a release and `A0_INSTALL_DIR` to change the destination. Or download a binary from the [latest release](https://github.com/Joe-Simo/a0/releases/latest) by hand and check it against `checksums.txt`. `a0 --version` prints the release and compiler version. Then:

```bash
printf 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n' > sq.a0
a0 run sq.a0 sq 12            # 144
a0 emit arm64 sq.a0           # A0's own machine code; or c, js, java, sv
a0 check sq.a0                # diagnostics with codes; --json for fields, --fix applies the exact fixes
a0 explain A0102              # what a diagnostic means, with a failing and a fixed example
```

Binaries: `a0-darwin-arm64`, `a0-darwin-x64`, `a0-linux-x64`, `a0-linux-arm64`, `a0-windows-x64.exe`. A C compiler (clang or gcc) is needed only to link native output on your machine.

## MCP server

`a0 mcp <file-or-dir>` serves A0 to AI agents over stdio (Model Context Protocol), so they edit through tools instead of text files: `a0_open` (function view with a handle), `a0_program` (program handle, optionally scoped to a target), `a0_apply` (edit under a handle; returns the new view or a diagnostic with code (class), id (A0nnnn), message, expected/actual, fix and applicability; the reply `fix all` applies every exact fix of the last rejected edit, atomically), `a0_check`, `a0_run` (reference interpreter, fuel-bounded), `a0_emit` (any target), `a0_save` (only after a successful apply). Paths are confined to the launch root (symlink escapes and `use` escapes rejected); no shell is run; output is bounded.

## Language server

`a0 lsp [root]` is a Language Server Protocol server over stdio (built on `vscode-languageserver`; `--stdio` is accepted and ignored). Point any LSP client at it for `.a0` files: diagnostics on open and change from the linker and checker (the diagnostic `code` is the class, `data` carries the table code `id`, the fix and its applicability, and an exact fix is a quick fix), hover (function signatures, op docs), go-to-definition across `use` files, document symbols, completion of ops and in-scope functions, and formatting through the canonical printer. Files are confined to `root` (default: the working directory) exactly as in the MCP server; a document outside it gets one `limit` diagnostic and nothing else.

## Use with AI agents

Put `a0` on your PATH first (see Install). Every entry below runs the same local stdio server, `a0 mcp <dir>`, with no hosting and no account. Ready-to-copy configs are in [`integrations/`](integrations/). The Agent Skill in [`skills/a0/`](skills/a0/SKILL.md) (install with `npx skills add Joe-Simo/a0`) teaches the language and loads the primer and the edit protocol only when they are needed.

| Agent | Install | Local stdio |
|---|---|---|
| Claude Code | `claude mcp add a0 -- a0 mcp .` (MCP only), or `/plugin marketplace add Joe-Simo/a0` then `/plugin install a0@a0` (MCP plus skill) | yes |
| Claude Desktop | Double-click `a0-mcp-<os>-<arch>.mcpb` from the [latest release](https://github.com/Joe-Simo/a0/releases/latest), or add [`integrations/mcp.json`](integrations/mcp.json) to `claude_desktop_config.json` | yes |
| Claude.ai | Zip `plugin/skills/a0/` and upload it under Settings > Capabilities > Skills (skill only; claude.ai connectors are remote-only) | skill only |
| Cursor | [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=a0&config=eyJjb21tYW5kIjoiYTAiLCJhcmdzIjpbIm1jcCIsIiR7d29ya3NwYWNlRm9sZGVyfSJdfQ==), or [`integrations/mcp.json`](integrations/mcp.json) in `.cursor/mcp.json` | yes |
| VS Code / GitHub Copilot | `code --add-mcp '{"name":"a0","command":"a0","args":["mcp","${workspaceFolder}"]}'`, or [`integrations/vscode.mcp.json`](integrations/vscode.mcp.json) as `.vscode/mcp.json`; skill in `.github/skills/` or `~/.copilot/skills/` | yes |
| GitHub Copilot CLI | `copilot mcp add` or `~/.copilot/mcp-config.json` ([`mcp.json`](integrations/mcp.json) shape) | yes |
| OpenAI Codex CLI/IDE | `codex mcp add a0 -- a0 mcp .`, or [`integrations/codex.config.toml`](integrations/codex.config.toml); skill in `.agents/skills/`; plugin in `plugin/.codex-plugin/` | yes |
| Gemini CLI | `gemini extensions install https://github.com/Joe-Simo/a0` (MCP plus `GEMINI.md`) | yes |
| Qwen Code | `qwen mcp add a0 a0 mcp .`, or `qwen extensions install https://github.com/Joe-Simo/a0` (reads Gemini extensions) | yes |
| Windsurf / Devin Desktop | [`mcp.json`](integrations/mcp.json) in `~/.codeium/windsurf/mcp_config.json` | yes |
| Devin CLI | `devin mcp add a0 -- a0 mcp .` | yes |
| Zed | [`integrations/zed.settings.json`](integrations/zed.settings.json) in Zed settings | yes |
| Cline | [`mcp.json`](integrations/mcp.json) in `cline_mcp_settings.json` | yes |
| Roo Code | [`mcp.json`](integrations/mcp.json) in `.roo/mcp.json` | yes |
| Kilo Code | [`integrations/kilo.jsonc`](integrations/kilo.jsonc) in `kilo.jsonc` | yes |
| Continue | [`integrations/continue.a0.yaml`](integrations/continue.a0.yaml) as `.continue/mcpServers/a0.yaml` (Agent mode) | yes |
| JetBrains AI Assistant / Junie | Settings > Tools > AI Assistant > MCP, paste [`mcp.json`](integrations/mcp.json); Junie: `.junie/mcp/mcp.json`, skill in `.junie/skills/` | yes |
| Augment | `auggie mcp add`, or Import from JSON with [`mcp.json`](integrations/mcp.json); skill in `.augment/skills/` | yes |
| opencode | [`integrations/opencode.json`](integrations/opencode.json) as `opencode.json`; skill in `.opencode/skills/` | yes |
| Amp | `amp mcp add a0 -- a0 mcp .`; `amp skill add Joe-Simo/a0` | yes |
| Goose | `goose session --with-extension "a0 mcp ."`, or [`integrations/goose.config.yaml`](integrations/goose.config.yaml) | yes |
| Warp | [`mcp.json`](integrations/mcp.json) in `.warp/.mcp.json` | yes |
| Crush | [`integrations/crush.json`](integrations/crush.json) in `crush.json` | yes |
| Factory Droid | `droid mcp add a0 "a0 mcp ."` | yes |
| Grok Build CLI (xAI) | `[mcp_servers.a0]` from [`integrations/codex.config.toml`](integrations/codex.config.toml) in `~/.grok/config.toml` | yes |
| Mistral Vibe CLI | [`integrations/mistral-vibe.config.toml`](integrations/mistral-vibe.config.toml) | yes |
| Kimi CLI | `kimi mcp add a0 --transport stdio -- a0 mcp .` | yes |
| LM Studio | [`mcp.json`](integrations/mcp.json) in LM Studio's `mcp.json`, or `lmstudio://add_mcp?name=a0&config=eyJjb21tYW5kIjoiYTAiLCJhcmdzIjpbIm1jcCIsIi4iXX0=` | yes |
| Perplexity (Mac app) | Connectors > Add > Simple: `a0 mcp /path/to/project` (needs the PerplexityXPC helper) | yes |
| Hugging Face smolagents | `MCPClient(StdioServerParameters(command="a0", args=["mcp", "."]))` | yes |
| Hugging Face tiny-agents | `"servers": [{"type": "stdio", "command": "a0", "args": ["mcp", "."]}]` in `agent.json` | yes |
| Aider | No MCP. `aider --read plugin/skills/a0/references/primer.txt` and use the `a0` CLI | no MCP |
| Open WebUI (Ollama) | Streamable HTTP only; A0 does not ship a hosted server | needs remote MCP |
| ChatGPT (developer mode / Apps) | Remote HTTPS only | needs remote MCP |
| Mistral Le Chat | Remote connectors only | needs remote MCP |
| xAI Grok API | Remote MCP tool only (HTTP/SSE) | needs remote MCP |
| Replit Agent, Bolt.new, Lovable, v0 | Remote HTTPS only | needs remote MCP |

Replace `.` with the folder the server may read and write when your agent does not start servers in the project folder.

### Project rules, hooks and CI

- `a0 init [dir]` writes `AGENTS.md` (read by Codex, Cursor, Copilot, Jules and others) with the MCP tool workflow, the edit protocol and the primer path (`.a0/MODEL_GUIDE.txt`, copied in when available, otherwise the GitHub URL), plus `@AGENTS.md` pointers in `CLAUDE.md` and `GEMINI.md`, glob rules for Cursor (`.cursor/rules/a0.mdc`), Windsurf (`.windsurf/rules/a0.md`) and Copilot (`.github/instructions/a0.instructions.md`), and a Gemini CLI `AfterTool` hook (`.gemini/settings.json`). Existing instruction files get the A0 section appended once; other existing files are kept.
- `a0 hook` is the after-edit check: it reads a hook's tool-call JSON on stdin and, when an edited `*.a0` file fails `a0 check`, prints a blocking response whose reason is the exact diagnostic with its `fix:`.
- Claude Code plugin (`plugin/`): a `PostToolUse` hook on `Edit|Write|MultiEdit` (`plugin/hooks/hooks.json`, runs `a0 hook`; set `A0_BIN` if `a0` is not on `PATH`) and the slash commands `/a0-check`, `/a0-emit`, `/a0-run` (`plugin/commands/`).
- CI: `uses: Joe-Simo/a0@main` (root `action.yml`, input `version`, default `latest`) downloads the release binary for the runner and checks every tracked `.a0` file. pre-commit: `repo: https://github.com/Joe-Simo/a0`, hook id `a0-check` (needs `a0` on `PATH`).
- `a0 check` accepts several files and exits 1 if any fails, printing `<file>: error: <code>: ... fix: ...` per failure.

### Privacy

The a0 MCP server and the `.mcpb` bundles run entirely on your machine. They collect no data, make no network requests, and read or write only inside the folder you give them.

## Contributing

Contributions are welcome and need no account, key or paid service. The short version:

1. **Fork** this repository and clone your fork; add this repository as `upstream`.
2. **Branch** from `upstream/main` (one branch per change), make the change with a test, and run `bun run lint`, `bun run typecheck` and `bun run test`.
3. **Push** to your fork and **open a pull request** against `main`. CI runs on it; a maintainer runs the full gate before merging.

The details (layout, build, the rules that keep the measurements honest, adding a backend or a language to the experiments, Windows notes) are in
[CONTRIBUTING.md](CONTRIBUTING.md). Please read the [Code of Conduct](CODE_OF_CONDUCT.md); report a security problem as described in [SECURITY.md](SECURITY.md).
Open an issue first for a change to the language itself.

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

## Errors built for agents

Every diagnostic is one row of `src/diagnostics.ts`: a stable code (`A0nnnn`), a coarse class (`parse`, `type`, `structure`, `limit`, `edit`, `patch`, `revision`, `handle`, `runtime`, `cli`, unchanged), a message template, the fix, and `a0 explain` text with one failing and one fixed example. A diagnostic reaches an agent as `{code, id, message, line, expected, actual, fix, applicability, edits}` from `a0 check --json`, the edit protocol, the MCP server and the LSP. An unknown name (op, function, node, fold body, loop predicate, type) gets a did-you-mean by TypeScript's spelling rule. A fix is `exact` (safe to apply blindly, with `edits` that do it) or `maybe`. In the edit protocol the reply `fix all` applies every exact fix of the last rejected reply and validates the result before it commits. `test/diagnostics.test.ts` runs every explain example, and `corpus/reject/` holds rejected programs and replies with the diagnostic each must raise and the program its fix produces (`node dist/tools/reject-corpus.js [--bless] [--coverage]`).
