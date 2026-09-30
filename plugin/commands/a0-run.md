---
description: Run an A0 function in the reference interpreter
argument-hint: "<file.a0> <function> [args...]"
allowed-tools: Bash(a0 run:*), Bash(a0 check:*)
---
Run `a0 run $ARGUMENTS` and report the result. Arguments are decimal u32 values or `true`/`false`.
If it fails, show the diagnostic with its `fix:`, apply the fix through the a0 MCP tools, and run again.
