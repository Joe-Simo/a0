# Declaration: the token axis counts A0's noop as the identity it is everywhere else (written before re-measuring)

Date: 2026-10-09. Written and committed before `tools/lang-axes.ts --tokens-only` or `tools/dense-tokens.ts` was re-run with the change below.

## What changes

The exec-bench `noop` kernel in A0 (`tools/exec-bench-kernels.ts`) is `a add p0 0 / b mul a 1 / c xor b 0 / ret c` on purpose: the execution benchmark checks that the optimizer removes the three identity operations and adds no work. That text stays exactly as it is for every timed run.

Every competitor's `noop` source (C, Rust and JavaScript in `exec-bench-kernels.ts`, and all 45 table-language sources in `tools/exec-bench-languages.ts` and `exec-bench-languages-more.ts`, checked one by one) is the plain identity, `return x` or its spelling. The token axis therefore compared a four-line A0 program against one-line identities: different programs. The 52 `lang-axes|noop|tokens-kernel|*` and `lang-axes-dense|noop|tokens-kernel|*` ledger entries (26 languages in two views) came from that difference, not from the language.

From this commit on, the token axis only (`tools/lang-axes.ts` tokens, `tools/dense-tokens.ts`) counts a separate, clearly named A0 text, `a0TokenSource` on the kernel: `fn noop u32 -> u32 / ret p0 / end`, the same meaning as every competitor's source. The canonical and dense views both derive from that text. No other kernel changes; no competitor source changes (none needed it).

## Why it is decided now

`tools/canon-syntax-tokens.ts` recorded the mismatch earlier and kept the losses "as they are, not redefined". This note reverses that for the token axis with the reason above, before seeing the new numbers. Whatever the re-count shows (a win, a tie or a loss against the best language) is recorded as measured; ledger entries that close are removed with `--update --reason` citing this note.
