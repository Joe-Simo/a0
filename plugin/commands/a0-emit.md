---
description: Compile an A0 file to a target (js, c, java, sv, arm64, x86_64, riscv64, avr, wasm, arm32)
argument-hint: "<target> <file.a0> [out]"
allowed-tools: Bash(a0 emit:*), Bash(a0 check:*)
---
Run `a0 emit $ARGUMENTS`. If it fails, show the diagnostic, apply its `fix:` through the a0 MCP
tools, run `a0 check` on the file, and emit again. Without an `out` argument, summarize the
emitted code instead of pasting all of it.
