# A0 landing page copy (draft for owner review)

Variable names marked (?) are the closest match in `site/gen/sgwords.a0`; confirm before wiring. Not committed.

## 1. Hero

**Headline:** A small language AI models can edit without breaking your build.

**Subhead:** A0 is a compact language with exact rules. A model reads only the functions an edit touches, and an edit that would not compile is rejected before it lands.

**Proof points**
1. **14 of 14** front-end edits accepted for Sonnet, same as TypeScript. Haiku: 10 of 14 against TypeScript's 13. (`app-edit-keys.json`: `cells["sonnet/a0-keys"].acceptedCount`, `cells["haiku/a0-keys"].acceptedCount`, `cells["haiku/ts"].acceptedCount`)
2. **4.9x fewer tokens per accepted edit** than TypeScript for Sonnet (1485 against 7277); 3.7x for Haiku (2144 against 7960), in a 10-edit session. (`app-edit-keys.json`: `cells[...].cost`)
3. **5262 test cases** run on 10 execution paths, including JavaScript, C, C++, wasm and the JVM; 4297 input-and-output-free cases on 5 native assembly targets. (`verification.json`: `inputCases`, `targets.*.cases`)

**Code (real, `examples/kernels.a0`, output checked by running it):**
```
fn affine u32 u32 u32 -> u32
a mul p0 p1
b add a p2
ret b
end
$ a0 run examples/kernels.a0 affine 3 4 5     # prints 17
```

**Buttons:** [Install] and [See the benchmarks (including where A0 loses)]

**License:** MIT, free for any use. Copyright 2026 Joe Simo (`LICENSE`).

**Scope:** Not for floating point, heap-heavy or recursive code. A0 has none of the three.

## 2. Glossary (8 terms)

- **Test case:** one input with its known correct output.
- **Oracle:** a separate, simple calculator (plain BigInt arithmetic) whose answers every target must match.
- **Target:** what A0 compiles to: machine code, C, wasm, JavaScript, JVM, .NET, Metal, SystemVerilog.
- **Handle:** a revision token. An edit that names an old handle is refused, so a stale edit cannot overwrite newer code.
- **View:** the text a model is shown. A scoped view holds one function plus the signatures it calls.
- **Dense view:** an optional shorter spelling of the same program, with fewer tokens.
- **Test program:** one small function written in every language and timed (the benchmark term is "kernel").
- **Generic cell:** a basic logic gate or register in the hardware output, before mapping to any chip.

## 3. Landing sections

**What is A0, and what can't it do?** Conway's Life is 240 lines of A0 and passes 134 cases against an independent TypeScript version on seven targets (`app.json`; line count from `examples/life.a0`). *Where it loses:* it has no floats, no heap and no recursion, so many programs cannot be written.

**Can a model edit it without breaking the build?** Sonnet had 14 of 14 front-end edits accepted, equal to TypeScript (`app-edit-keys.json`). *Where it loses:* Haiku had 10 of 14 accepted against TypeScript's 13.

**Is an edit cheaper?** Sonnet spent 4.9x fewer tokens per accepted edit than TypeScript in a 10-edit session on the same front end (`app-edit-keys.json` `cost`). *Where it loses:* on a one-function file A0 costs 2.42x TypeScript's tokens (page text, `$cmax_ratio$` (?)).

**Is it fast?** On an Apple M3, A0's machine code takes 1.16x as long as hand-written C, geometric mean over 19 test programs (`$c_ratio$`). *Where it loses:* 8 of 19 programs are losses against the best of C, Rust and Zig (`$bk_nloss$`), the worst 4.31x slower on mat4 (`$bk_slow$`, `$bk_slowk$`).

**Is it checked on every target?** 5262 cases pass on 10 paths, and the optimizer is proved equivalent by Z3 on 48 of 48 corpus functions (`$hw_cases$`, `equivalence.json`). *Where it loses:* SystemVerilog is simulated separately (5262 cases, Icarus), and place-and-route, timing, area and power are not run (`hardware.json` `stagesNotRun`).

**Does it start quickly?** A0 takes 2.50 ms from launch to first result, 9th of 48 languages (`$start_a0$`, `$start_rank$`). *Where it loses:* 8 languages start faster, including Swift, C++, Zig and C.

**How big is the hardware output?** 55530 generic cells for the 48 corpus functions (`$hw_cells$`). *Where it loses:* that is relative complexity only, not mapped to an FPGA or chip library.

**How do I try it?** One binary, no Node or Bun, for Windows, macOS and Linux (`README.md` Install; `$bin_kb$` for size). *Where it loses:* linking native output needs clang or gcc on your machine.

## 4. /benchmarks outline

1. **Method.** Same test programs in every language, checksum-verified before timing; median of 7 interleaved runs; load gate of 10 (highest 9.78). Two baselines: same calling convention, and each language's own inlined driver.
2. **Machines.** Native speed: Apple M3, darwin-arm64, 2026-09-30 and 2026-10-01. Wasm: Windows x64, 2026-10-07. Never combined into one claim.
3. **Reproduce.** Commands from `STATUS.md`; each figure names its `results/*.json`.
4. **Native speed.** Caption: "A0 against C, Rust and Zig, 19 test programs." Conditions: AArch64, out-of-line call. Losses first: 8 of 19, slowest 4.31x (mat4); against the inlined baseline 7.58x.
5. **Versus 48 languages.** Caption: "Time per call as a multiple of A0's." Conditions: geometric mean over the programs each language ran. Losses: 8 languages are more than 5% faster (`$n_ahead$`).
6. **Startup.** 2.50 ms, 9th of 48; faster languages named.
7. **Wasm (Windows x64).** Own table, own load and date; per-program losses shown (`wasm-benchmark-win32.json`).
8. **Edits.** Front-end task (14 edits) with the legend; the 4000-function whole-file comparison labelled as a different workflow; the one-function loss shown.
9. **Hardware and verification.** Counts split by target group as in section 3.
10. **Loss ledger.** 586 recorded entries (`loss-ledger.json`), linked.

## 5. How we measured (footer)

Speed figures come from one Apple M3 (8 cores), 2026-09-30 to 10-01. Each is a median of 7 interleaved runs, checksum-verified, with the 1-minute load average at or below 10. Wasm figures come from a different machine (Windows x64, 2026-10-07) and are not compared with them. Edit costs are tokens per accepted edit with one repair round. Raw files are in `results/`, and every loss is in the loss ledger.

## 6. Claim table

| Claim | File | Field | Value | Exists today? |
|---|---|---|---|---|
| Sonnet 14/14 accepted | app-edit-keys.json | cells["sonnet/a0-keys"].acceptedCount | 14 | yes |
| Sonnet TypeScript 14 | app-edit-keys.json | cells["sonnet/ts"].acceptedCount | 14 | yes |
| Haiku A0 10, TS 13 of 14 | app-edit-keys.json | cells["haiku/a0-keys"], ["haiku/ts"] .acceptedCount, .n | 10, 13, 14 | yes |
| Sonnet 4.9x fewer tokens | app-edit-keys.json | cells[...].cost | 7277.3 / 1485.2 = 4.90 | yes (ratio computed) |
| Haiku 3.7x fewer | app-edit-keys.json | cells[...].cost | 7960 / 2143.5 = 3.71 | yes (computed) |
| 5262 cases, 10 paths | verification.json | targets.*.cases | 5262 (10 entries) | yes (counts interpreter and optimizer as paths) |
| 4297 on 5 asm targets | verification.json | native_arm64, x86_64, riscv64, avr, arm32 | 4297 | yes |
| Metal 4297 on 30 kernels | gpu.json | not re-read (STATUS table) | 4297 | confirm |
| SystemVerilog 5262 simulated | hardware.json | simulation.cases | 5262 | yes |
| Z3 48 of 48 | equivalence.json | summary.proved | 48 | yes |
| 1.16x C | exec-benchmark-full.json | geomean of kernels.*.c.arm64 / c.handwritten | 1.164 (n 19) | yes, computed; no stored field |
| 2 wins, 9 ties, 8 losses | exec-benchmark-full.json | arm64VsBestFlags | 2 / 9 / 8 | yes |
| Slowest 4.31x on mat4 | exec-benchmark-full.json | kernels.mat4.c.arm64VsBestFlags.speedup | 0.23 (1/0.23 = 4.3) | yes; 4.31 as on page |
| 7.58x inlined | exec-benchmark-full.json | page `$rk_max$` | 7.58 | not re-read; confirm |
| Load gate 9.78 | exec-benchmark-full.json | loadGate.highestLoadAtSampleStart | 9.78 | yes |
| Startup 2.50 ms, 9 of 48 | exec-benchmark-full.json | startupMs, page `$start_a0$` | 2.50 | not re-read; confirm |
| 55530 cells | hardware.json | sum of synthesis.modules.*.cells | 55530 | yes |
| Life 240 lines, 134 cases | examples/life.a0; app.json | wc -l; cases | 240; 134 | line count yes; cases from STATUS only |
| One-function 2.42x TS | page text line 755 | source file not found | 2.42 | unverified source |
| 586 ledger entries | loss-ledger.json | entries.length | 586 | yes |
| MIT license | LICENSE | line 1 | MIT | yes |
| `affine 3 4 5` prints 17 | run locally | n/a | 17 | yes |
| 169x Python (not used) | exec-benchmark-full.json | geomeans.python | 163.27 (page shows 169) | mismatch; kept out of copy |
