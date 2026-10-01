---
name: a0
description: Write, edit, check, run and compile A0 programs (.a0 files), the programming language built for AI. Use when the user mentions A0, a0lang or .a0 files, or wants one source compiled to native code, wasm, JavaScript, the JVM, .NET, Metal or SystemVerilog.
license: MIT
compatibility: Needs the a0 binary from https://github.com/Joe-Simo/a0/releases/latest on PATH, or the a0 MCP server.
---

# A0

1. If the `a0_*` MCP tools are available (`a0_open`, `a0_program`, `a0_apply`, `a0_check`, `a0_run`, `a0_emit`, `a0_save`), use them for all reading and editing. Do not edit .a0 files as text.
   - `a0_open` a function (or `a0_program` for whole-program work), send bare edit lines to `a0_apply` under the handle, then `a0_check` or `a0_run`, and `a0_save` only after a successful apply.
   - On a diagnostic, apply its `fix` and resend under the same handle.
2. Without the MCP tools, use the CLI: `a0 check f.a0`, `a0 run f.a0 FN ARGS...`, `a0 emit TARGET f.a0`. `a0 mcp <dir>` starts the MCP server.

Load on demand:
- [references/primer.txt](references/primer.txt): the whole language (syntax, types, ops, edit lines). Read it before writing or editing A0.
- [references/edit-protocol.md](references/edit-protocol.md): handles, edit forms and rejection rules. Read it when an apply is rejected or an edit spans functions.
