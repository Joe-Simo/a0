# Distribution drafts (nothing here has been posted)

Every text below is a DRAFT for the owner to review and post. Nothing was submitted, pushed or published.
Versions and URLs assume release v0.8.16 and the repository `Joe-Simo/a0`; check them before posting.
`server.schema.json` is the official MCP registry schema (2025-12-11), kept here so `test/distribution.test.ts`
validates `server.json` offline.

## 1. Vercel skills directory (skills.sh)

The `skills` CLI discovers `skills/a0/SKILL.md` straight from the repository
(`npx skills add Joe-Simo/a0`, checked locally with `npx skills add <checkout> --list`: finds 1 skill, `a0`).
The directory lists a skill once people install it; there is no form.

Owner checklist:
- [ ] Push `main` and tag the release so `npx skills add Joe-Simo/a0` resolves.
- [ ] Run `npx skills add Joe-Simo/a0` once from a clean directory; the directory counts installs.
- [ ] Optional: a tweet or post that says: "A0 skill: `npx skills add Joe-Simo/a0`".

## 2. MCP registries

Official registry (`registry.modelcontextprotocol.io`): the root `server.json` is the manifest
(name `io.github.Joe-Simo/a0`, five `.mcpb` bundles with SHA-256, stdio). It validates against the schema.

Owner checklist:
- [ ] Release the tag (the workflow attaches the `.mcpb` bundles and rewrites `server.json`).
- [ ] Install `mcp-publisher` (from the modelcontextprotocol/registry releases).
- [ ] `mcp-publisher login github` (GitHub device flow for the `Joe-Simo` namespace).
- [ ] From the repository root: `mcp-publisher publish`.
- [ ] Check `https://registry.modelcontextprotocol.io/v0/servers?search=a0`.
- [ ] Other registries (Smithery, Glama, PulseMCP, mcp.so) take a repository URL: paste
      `https://github.com/Joe-Simo/a0` in each submit form.

Listing text (short):

> A0: write, check, run and compile A0 programs through revision-checked structured edits. Tools: a0_open,
> a0_program, a0_apply, a0_check, a0_run, a0_emit, a0_save. Local stdio, no network, no account; paths
> confined to the folder you give it.

## 3. Awesome lists

Candidates: awesome-mcp-servers (punkpeye), awesome-claude-code, awesome-agent-skills, awesome-programming-languages.
One line per list, alphabetical position as that list requires:

> - [A0](https://github.com/Joe-Simo/a0) - Programming language for AI agents: revision-checked structured edits, one source to native, wasm, JS, JVM, .NET, Metal and SystemVerilog. MCP server and agent skill included.

Owner checklist:
- [ ] Read each list's CONTRIBUTING (category, ordering, emoji or badge conventions).
- [ ] Fork, add the line, open a pull request from the owner's account.

## 4. Hacker News: Show HN

Title: `Show HN: A0, a programming language that AI agents edit through checked structured edits`

Text:

> A0 is a small language I built for models to write, not people. Instead of rewriting files, an agent reads
> one function, sends the changed lines under a revision handle, and an invalid edit is rejected with a stable
> diagnostic code and an exact fix. One source compiles to native AArch64 (own code generator) or C, wasm,
> JavaScript, JVM, .NET, Metal and SystemVerilog, and every target is checked by execution against one oracle.
>
> It is free and local: `npx skills add Joe-Simo/a0` for the agent skill, `a0 mcp .` for an MCP server, or one
> binary from the releases page (SHA-256 verified install script).
>
> What it is not: no floating point, no heap, no recursion, strings are bytes. It is a kernel and edit-loop
> language, not a general-purpose one. The benchmark numbers are from one machine that was not quiet (load
> average recorded in the results), and the loss ledger lists where A0 is slower than hand-written C or
> another language, including many wasm-load and per-trip timings. Whole-task tokens are 3.0x cheaper than
> TypeScript in a 40-function program and 1.46x more on single-function tasks; both are published. Only
> the optimizer is proved (Z3, 48 corpus functions); the rest is tested, not proved.
>
> https://a0lang.com, https://a0lang.com/benchmarks, https://github.com/Joe-Simo/a0

Owner checklist:
- [ ] Re-read the numbers against `results/*.json` for the version you ship (quiet-machine rerun pending).
- [ ] Submit at news.ycombinator.com/submit with the GitHub URL (not the site) as the link, text above as the first comment.
- [ ] Post on a weekday morning US Eastern; stay to answer for a few hours.
