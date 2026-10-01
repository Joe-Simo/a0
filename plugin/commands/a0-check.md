---
description: Check A0 files and fix every diagnostic
argument-hint: "[file.a0...]"
allowed-tools: Bash(a0 check:*), Bash(git ls-files:*)
---
Run `a0 check $ARGUMENTS` (with no arguments, check every file from `git ls-files '*.a0'`).
For each `error: <code>: ... fix: ...` line, apply the stated fix with the a0 MCP tools
(`a0_open` or `a0_program`, then `a0_apply`, then `a0_save`) and check again until all files pass.
Report the functions and revisions the final check printed.
