# The a0lang.com benchmarks page (site/bench.a0), a template of the site generator (site/gen/sitegen.a0).
# Every number comes from the results files below; the home page (page.tpl) shows one chart from each.
f tags site/gen/tags.tpl
f css site/gen/style.css
f glsl site/gen/scene.glsl
f exec results/exec-benchmark-full.json
f cost 1 sonnet min results/ai-edit-experiment.b.sonnet-min.json
f cost 1 sonnet langs results/ai-edit-experiment.b.sonnet-langs.json
f cost 1 haiku min results/ai-edit-experiment.b.haiku-min.json
f cost 1 haiku langs results/ai-edit-experiment.b.haiku-langs.json
f cost 40 sonnet min results/ai-edit-experiment.c.sonnet-min.json
f cost 40 sonnet langs results/ai-edit-experiment.c.sonnet-langs.json
f cost 40 haiku min results/ai-edit-experiment.c.haiku-min.json
f cost 40 haiku langs results/ai-edit-experiment.c.haiku-langs.json
f cost 400 sonnet min results/ai-edit-experiment.c400.sonnet-min.json
f cost 400 sonnet langs results/ai-edit-experiment.c400.sonnet-langs.json
f cost 400 haiku min results/ai-edit-experiment.c400.haiku-min.json
f cost 400 haiku langs results/ai-edit-experiment.c400.haiku-langs.json
f cost 4000 sonnet min results/ai-edit-experiment.c4000.sonnet-min.json
f cost 4000 sonnet langs results/ai-edit-experiment.c4000.sonnet-langs.json
f cost 4000 haiku min results/ai-edit-experiment.c4000.haiku-min.json
f cost 4000 haiku langs results/ai-edit-experiment.c4000.haiku-langs.json
f editq results/edit-loop.quiet.json
f edit results/edit-loop.json
f par results/parallel.json
f axes results/lang-axes.json
f hw results/hardware.json
f tokfx results/tokens.json
f b48 results/ai-edit-b48-dense.json
f densetok results/dense-tokens.json
f ver results/verification.json
# Cost rows, in order: representation -> results file kind and label.
m cost a0 min A0
m cost ts min TypeScript
m cost rust min Rust
m cost python langs Python
m cost go langs Go
m cost java langs Java
m cost csharp langs C#
m cost cpp langs C++
# Validation rows: edit-loop kind -> label; language of a kind (the part before the first dot) -> label.
m el a0.structured A0 structured
m el a0.conventional A0 whole file
m el ts.warm TypeScript warm
m el ts.cold TypeScript cold
m el rust.warm Rust warm
m el rust.cold Rust cold
m el go.build.warm Go build warm
m el go.build.cold Go build cold
m el go.vet.warm Go vet warm
m ellang a0 A0
m ellang ts TypeScript
m ellang rust Rust
m ellang go Go
# Parallel rows, in order: implementation -> label; the language a label counts as in the coverage line.
m par a0_auto A0
m par c_openmp C + OpenMP
m par c C
m par rust Rust
m par zig Zig
m par go Go
m par java Java
m par js JavaScript
m par python Python
m parcov c_openmp C
# The well-known languages that open each chart of the many-language sections; every other language is behind a disclosure.
m top A0
m top C
m top C++
m top Rust
m top Zig
m top Go
m top Swift
m top Java
m top Kotlin
m top C#
m top JavaScript
m top TypeScript
m top Python
m top Ruby
# The best of the three optimized baselines per test program, as named by arm64VsBestFlags in results/exec-benchmark-full.json.
m bestflag cO3Native C -O3 native
m bestflag rustO3Native Rust -O3 native
m bestflag zigReleaseFast Zig ReleaseFast
1# a0lang.com home page, authored in A0. An io program speaking the A0 UI protocol (see ui.a0):
1#   input : event x y ntext text[ntext] nstate state[nstate]   (this page keeps no state)
1#   tags: 1 h1 2 p 3 button 4 code 5 div 6 span 7 ul 8 li 9 a 10 pre 11 h2 12 input 13 section
1#         14 nav 15 h3 16 strong 17 footer 18 header 19 table 20 tr 21 td 22 th 23 small
1#   attr keys: 1 id 2 class 3 href 4 type 5 placeholder 6 aria-label
1# The browser runtime (site/app.ts) builds DOM from this stream and reports events back.
1use "ui.a0"
2
2fn session io -> u32
2r0 read p0
2event at r0 0
2tok at r0 1
# The stylesheet is one text literal of a byte per operand; the A0 toolchain keeps a function's operands in a
# table of 32768 pairs, so it is spread over two functions by byte range (the chunks that start in each range).
# tools/site-gen.ts fails the build when a function is over 75% of that table: then add a range here.
{css_a
s 9 css 0 9000
}
{css_b
s 9 css 9000
}
c nav
{sec_bhead
.div center bench
=h1 Benchmarks
=p Execution benchmarks, source token counts and verification coverage.
<p
.a pill
+href https://github.com/Joe-Simo/a0/tree/main/scripts/bench-repro
"Reproduce a result
>
"\s
.a pill ghost
+href #limits
"Where A0 loses
>
>
>
}
{sec_rail
<div
+class layout bench
+id content
.nav rail
+aria-label Sections
.div rh
"Contents
>
<a
+href #tokens
"Source tokens
>
<a
+href #method
"Method
>
<a
+href #limits
"Where A0 loses
>
<a
+href #native
"Native speed
>
<a
+href #languages
"$n_langs$ languages
>
<a
+href #startup
"Startup
>
<a
+href #wasm
"WebAssembly
>
<a
+href #validation
"Validation
>
<a
+href #parallel
"Parallel folds
>
<a
+href #hardware
"Hardware
>
<a
+href #targets
"Verification
>
>
<div
+id benchmarks
+class main
}
{sec_source_tokens
<section
+id tokens
=h2 Source token counts
# claim-ok: all 29 rows of results/source-tokens.json, checked against the fixed KERNELS corpus by test/source-tokens.test.ts
=p Complete source fragments for the same 29 fixed benchmark programs, including helpers and literal data. Lower means fewer source tokens in this corpus.
.div chart token-chart
.h3 ct
"Source tokens · o200k_base
>
# claim-ok: all totals and bar widths derive from results/source-tokens.json; common linear scale 0–10000
.div bars token-bars
+role group
+aria-label Source tokens, lower is better, linear scale from zero to ten thousand
.div brow me
.span lbl
"A0
>
.div track
+aria-hidden true
.div fill grown token-a0
>
>
.span val
"9,028
>
>
.div brow
.span lbl
"C
>
.div track
+aria-hidden true
.div fill grown token-c
>
>
.span val
"6,402
>
>
.div brow
.span lbl
"JavaScript
>
.div track
+aria-hidden true
.div fill grown token-js
>
>
.span val
"6,400
>
>
.div brow
.span lbl
"Rust
>
.div track
+aria-hidden true
.div fill grown token-rust
>
>
.span val
"6,565
>
>
>
.p token-axis
"0 → 10,000 tokens · lower is better
>
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Source-only totals; all 29 execution-benchmark programs, measured 30 October 2026
<tr
=th Language
=th o200k_base tokens
=th cl100k_base tokens
>
<tr
# claim-ok: row of results/source-tokens.json, checked by test/bench-tables.test.ts
=td A0
.td mono
"9028
>
.td mono
"9053
>
>
<tr
# claim-ok: row of results/source-tokens.json, checked by test/bench-tables.test.ts
=td C
.td mono
"6402
>
.td mono
"6400
>
>
<tr
# claim-ok: row of results/source-tokens.json, checked by test/bench-tables.test.ts
=td JavaScript
.td mono
"6400
>
.td mono
"6399
>
>
<tr
# claim-ok: row of results/source-tokens.json, checked by test/bench-tables.test.ts
=td Rust
.td mono
"6565
>
.td mono
"6509
>
>
>
>
=p Local js-tiktoken measurements of the exact source text in the dataset. A0 uses the implemented source formatter; all 29 programs round-trip to the same IR and pass native-parser and JavaScript boundary controls. These are public tokenizer encodings, not a claim about any particular model's tokenizer. Prompts, tools, reasoning, retries and repairs are excluded: this is not an AI editing-cost or accuracy result.
<p
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/source-tokens.json
"Exact sources, counts and validation
>
" ·\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/tools/source-token-bench.ts
"Reproduce the count
>
>
>
}
{sec_headline
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Summary; each linked section contains the method and source data
<tr
=th Question
=th A0's result
=th Where it loses
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #native
"Is native code fast?
>
>
=td $c_ratio$x the time of hand-written C, geometric mean over $bk_n$ test programs on an Apple M3
=td Slower than the best of C, Rust and Zig on $bk_nloss$ of $bk_n$ test programs, worst $bk_slow$x on $bk_slowk$
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #languages
"How does it compare with other languages?
>
>
=td $n_ties$ of $n_langs$ other languages are within 5% of A0's speed and the rest are slower
=td $n_ahead$ of $n_langs$ languages are more than 5% faster
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #startup
"Does it start quickly?
>
>
=td $start_a0$ ms from launch to first result, place $start_rank$ of $n_starts$ languages
=td Every language placed above it starts faster
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #validation
"Is an edit checked quickly?
>
>
=td 2 to 23 ms per edit in a warm session, against 531 to 3918 ms for a whole-project tsc check
=td Checking from scratch in a fresh process is slower than tsc-rs and tsgo on macOS, and level with tsc-rs on Linux
>
>
>
# claim-ok: the headline row values are the cells of results/app-edit-keys.json (Sonnet 14 of 14, 1485.2 against 7277.3 tokens, Haiku 10 and 13) and results/check-latency-*.json (A0 edit medians 5.2, 1.7 and 22.7 ms; tsc medians 531, 872 and 3918 ms), checked by test/bench-tables.test.ts
.p cap
"Sources: results/exec-benchmark-full.json, results/lang-axes.json and results/check-latency-*.json. Source token counts are in results/source-tokens.json.
>
}
{sec_method
<section
+id method
=h2 Method
.p q
"Machines, tool versions, sampling and load limits.
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption How the numbers were taken; each machine's own file in results/ records its details
<tr
=th Item
=th What we did
>
<tr
=td Machine
=td Native speed: one Apple M3, 2026-09-30 and 2026-10-01. WebAssembly: one Windows x64 PC. Edit-check latency: that PC, a Linux x64 runner and a macOS arm64 runner. Results are grouped by machine.
>
<tr
=td OS and cores
=td macOS (darwin-arm64), 8 cores; Windows x64, 8 CPUs; Linux x64, 4 CPUs; macOS arm64 runner, 3 CPUs.
>
<tr
=td Tool versions
=td Native: Node v24.14.0, Apple clang 21.0.0, rustc 1.96.0. WebAssembly: Node v22.21.1, clang 22.1.8. Checkers: TypeScript 5.9.3, tsgo 7.0.0-dev.20260707.2, tsc-rs 0.1.0.
>
<tr
=td Runs and statistic
=td Native: 7 samples per side. WebAssembly and edit-check latency: 15. Each time is the median of interleaved runs, and each result is checked against a checksum, or for a check a clean exit, before it is timed. Edit costs are tokens per accepted edit with one repair round.
>
<tr
=td Load rule
=td Native runs started only while the 1-minute load average was at or below 10 (highest at a sample start: $bk_load$). Linux and macOS report that load average. Windows has none, so its load is CPU use: 5.57 of 10 allowed for WebAssembly, and 8 of 8 CPUs for edit-check latency, which makes those Windows rows contended.
>
>
>
.p cap
# claim-ok: the load and sample figures are copied from results/exec-benchmark-full.json, results/wasm-benchmark.json and results/check-latency-win32-x64.json (loadGate, samples, load.max), checked by test/bench-tables.test.ts
"Sources: results/exec-benchmark-full.json, results/wasm-benchmark.json, results/check-latency-*.json. The exact commands, run times and the field to read for each figure are in\s
<a
+href https://github.com/Joe-Simo/a0/tree/main/scripts/bench-repro
"scripts/bench-repro/README.md
>
". Experiments that need a model cannot be re-run without one, so their replies are committed.
>
>
}
{sec_limits
<section
+id limits
=h2 Where A0 loses
.p q
# claim-ok: a statement of what the section lists; the figures are in the table below, each with its results file
"Recorded performance regressions, editing failures and unsupported features.
>
.div limits
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Known losses and their source data
<tr
=th Where
=th What
=th Source
>
<tr
=td Native speed
=td Up to $bk_slow$x behind the best of C, Rust and Zig ($bk_slowk$), and up to $rk_max$x behind each language's own inlined driver.
=td results/exec-benchmark-full.json
>
<tr
=td WebAssembly
=td Slower than clang on the test programs in the first WebAssembly table below, and slower to compile and instantiate on a further set counted in the ledger.
=td results/wasm-benchmark.json, results/loss-ledger.json
>
<tr
=td Emitted JavaScript
=td One recorded loss against hand-written JavaScript (the noop kernel); a quiet Windows rerun tied, and the loss stays in the ledger.
=td results/exec-benchmark-noop-win32.json
>
<tr
=td Checking from scratch
=td A whole-front-end check in a fresh process is slower than tsc-rs and tsgo on macOS; the macOS and Windows A0 numbers in that table were recorded before edits were checked incrementally.
=td results/check-latency-darwin-arm64.json, results/check-latency-linux-x64.json, results/loss-ledger.json
>
<tr
=td Evidence
=td Native timings come from one machine, and the compiler versions of the other languages are not recorded in the results file.
=td STATUS.md, Known limits
>
<tr
=td The language
=td No floating point, no heap, no recursion, and no GPU or x86-64 speed claim.
=td STATUS.md, Known limits
>
>
>
>
>
}
{sec_native
<section
+id native
=h2 Native speed on small test programs
.p q
"A0, C, Rust and Zig run the same small functions.
>
.p take
"The slowest test program is $bk_slow$x slower on $bk_slowk$ against baselines with the same calling convention, and $rk_max$x slower on $rk_maxk$ against each language's own inlined driver. Same calling convention (A0 and the best of C, Rust and Zig, both called out of line): $bk_nwin$ wins, $bk_ntie$ ties, $bk_nloss$ losses of $bk_n$. Inlined drivers: $rk_nw2$ wins, $rk_nt2$ ties, $rk_nl2$ losses. Against hand-written C alone, A0 takes $c_ratio$x as long, a geometric mean over the test programs; 1.00x would be equal.
>
<p
"A test program is one small function (benchmark authors call it a kernel), written by hand in every language, timed on the same inputs and checked against a checksum first. A0 here is machine code from its own AArch64 code generator, with no runtime, no garbage collector and no C compiler in between.
>
}
{chart_both
.div chart reveal
+role group
+aria-labelledby chart-1
.p ct
+id chart-1
"A0 under both baselines, per test program
>
.p sub
"Two baselines, because they answer different questions. Same calling convention: A0 and the best of C, Rust and Zig are all called out of line from a C driver. Inlined: each language's fastest result with its own driver, which the compiler can inline. Speedup = the baseline's time divided by A0's: below 1.00x A0 is slower. Win = at least 1.2x faster; loss = more than 10% slower; the file gives verdicts only for the first baseline, the second uses the same win rule and a 10% tie band (results/exec-benchmark-full.json).
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Speed against the best of C, Rust and Zig and against each language's own inlined driver, per test program
<tr
=th Test program
=th Same calling convention: speedup, verdict
=th Own inlined driver: speedup, verdict
>
[bkrows
<tr
.td mono
"$bk_name$
>
.td mono{bk_win| first}{bk_loss| loss}
"$bk_sp$x {bk_win|win}{bk_tie|tie}{bk_loss|loss}
>
.td mono{rk_w2| first}{rk_l2| loss}
"$rk_sp2$x {rk_w2|win}{rk_t2|tie}{rk_l2|loss}
>
>
]
>
>
.p cap
"Every loss under either baseline is in bold. A0's code is called out of line from a C driver while the other languages' drivers are inlined, so the second baseline is the harder one for A0.
>
>
}
{rank_table
.div chart reveal
+role group
+aria-labelledby chart-3
.p ct
+id chart-3
"Where A0 places on each test program
>
.p take
"First of the languages that ran each program on $rk_nwin$ of $rk_nk$ test programs (a language is timed only on the programs it has source for, so fewer languages ran the later programs); on every one, A0 takes at most $rk_max$x as long as the fastest language.
>
.p sub
"Baseline: each language's own driver, inlined. Place 1 = fastest of the languages that ran that test program (every language ran the first ten; later ones only some). Time per call, median of 7 interleaved runs, every result checksum-verified (results/exec-benchmark-full.json).
>
.p cov mono{cov_langs_part| part}
"measured: $cov_langs$ of $n_all$ languages
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption A0's place among the languages that ran each test program
<tr
=th Test program
=th A0's place (1 = fastest)
=th Fastest language other than A0
=th A0 takes this many times as long
>
[ranks
<tr
.td mono
"$rk_name$
>
.td mono{rk_first| first}
n a mov $rk_rank$
c putnum %a
" of $rk_n$
>
=td $rk_best$, $rk_bv$ ns
.td mono {rk_win|first|behind}
n a mov $rk_ratio$
c putratio %a
"x{rk_same|\s(same speed)}{rk_fast|\s(A0 is faster)}{rk_slow|\s(A0 is slower)}
>
>
]
>
>
.p cap
"Reading a row: the third column names the fastest of the other languages and its time per call; the last column is A0's time divided by that time. Below 1.00x, A0 is faster than every other language on that test program; above 1.00x, that language is faster and the number gives the ratio.
>
>
}
{endsec$k$
>
}
{sec_langs
<section
+id languages
=h2 Speed against $n_langs$ other languages
.p q
"Execution time across languages, normalized to A0.
>
.p take
"$n_ahead$ of the other $n_langs$ languages are more than 5% faster than A0{ahead| ($ahead$)}; $n_ties$ are within 5% of A0; the rest are slower.
>
}
{chart_langs
.div chart langs reveal ls
+role group
+aria-labelledby chart-4
.p ct
+id chart-4
"How long each language takes, as a multiple of A0's time
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Each bar is one language's time per call divided by A0's, as a geometric mean over the test programs it has source for. 1.00x = the same speed as A0; a longer bar = slower than A0; a bar marked A0 slower belongs to a language faster than A0. Bar length is logarithmic. Interleaved runs, medians; JIT rows warm; interpreters at their own iteration tier.
>
.p cov mono{cov_langs_part| part}
"measured: $cov_langs$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lnat
"compiled
>
.span ljit
"JIT or VM
>
.span lint
"interpreted
>
>
[langs lg_top
.div lrow{lg_me| me}
.span lbl
"$lg_label$
>
.div track $lg_cls$
.div fill
w 12
w 1
w $lg_pct$
>
.span val
n a mov $lg_g100$
c putratio %a
"x
>
>
>
]
.details more
<summary
"Show all $n_langs1$ languages
>
[langs
.div lrow{lg_me| me}
.span lbl
"$lg_label$
>
.div track $lg_cls$
.div fill
w 12
w 1
w $lg_pct$
>
.span val
n a mov $lg_g100$
c putratio %a
"x
>
>
>
]
>
.p cap
"Shown first: A0 and selected languages. All $n_langs1$ languages are behind the disclosure, in the same order. A0 here is machine code from A0's own AArch64 code generator, with no C compiler in between. Numbers, toolchains and iteration tiers are in results/exec-benchmark.json.
>
>
}
{endsec$k$
>
}
{sec_start
<section
+id startup
=h2 Startup
.p q
"Time from process launch to the first result.
>
.p take
"A0 takes $start_a0$ ms from launch to first result: place $start_rank$ of $n_starts$ languages (1 = fastest). Node takes $start_node$ ms and Python $start_py$ ms.
>
<p
"Startup is the time for one process launch to run one iteration of a test program and print its result; compile time is separate ($a0_build$ ms for the ten test programs with A0, $rs_build$ ms with rustc).
>
}
{chart_start
.div chart langs reveal ls
+role group
+aria-labelledby chart-5
.p ct
+id chart-5
"Time from launch to first result
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Milliseconds, shorter bar = faster start. Bar length is logarithmic. JVM and .NET rows include their runtime start.
>
.p cov mono{cov_start_part| part}
"measured: $cov_start$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lnat
"compiled
>
.span ljit
"JIT or VM
>
.span lint
"interpreted
>
>
[starts st_top
.div lrow{st_me| me}
.span lbl
"$st_label$
>
.div track $st_cls$
.div fill
w 12
w 1
w $st_pct$
>
.span val
n a mov $st_v100$
c putfix %a
" ms
>
>
>
]
.details more
<summary
"Show all $n_starts$ languages
>
[starts
.div lrow{st_me| me}
.span lbl
"$st_label$
>
.div track $st_cls$
.div fill
w 12
w 1
w $st_pct$
>
.span val
n a mov $st_v100$
c putfix %a
" ms
>
>
>
]
>
.p cap
"Shown first: A0 and selected languages; all $n_starts$ are behind the disclosure, in the same order. The A0 binary for startup is the C-path build; startup of the direct AArch64 binary is not yet measured.
>
>
}
{endsec$k$
>
}
{sec_wasm
<section
+id wasm
=h2 WebAssembly on Windows
.p q
"A0 and clang WebAssembly output, measured on Windows x64.
>
.p take
"clang's time divided by A0's has a geometric mean of 1.08 over 19 test programs: A0 is faster on 7, ties on 7 and is slower on 5, the worst being arrfill at 0.78. Source: results/wasm-benchmark.json.
>
}
{chart_wasm
.div chart langs reveal
+role group
+aria-labelledby chart-16
.p ct
+id chart-16
"A0 against clang, WebAssembly, Windows x64
>
.p sub
# claim-ok: the method note for the table; the values are the rows of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
"Both sides run the same driver inside the module: a chain of dependent trips of one function. A0 is the direct wasm32 backend; clang is -O3 on the hand-written C kernel. Time per trip is the median of 15 interleaved samples in Node v22.21.1; module size is in bytes. Windows has no load average, so load is CPU use: highest 8 of 10 allowed. A ratio below 1.00x means clang is faster.
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Wasm on Windows x64: the 5 test programs where A0 is slower than clang, worst first
<tr
=th Test program
=th Time per trip, ns (A0 / clang)
=th clang time divided by A0 time
=th Module bytes (A0 / clang)
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td arrfill
.td mono
"4.64 / 3.63
>
.td mono loss
"0.78x A0 slower
>
.td mono
"334 / 485
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td noop
.td mono
"0.69 / 0.58
>
.td mono loss
"0.84x A0 slower
>
.td mono
"173 / 512
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td rotl
.td mono
"2.49 / 2.23
>
.td mono loss
"0.89x A0 slower
>
.td mono
"220 / 491
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td filter2
.td mono
"2812 / 2547
>
.td mono loss
"0.91x A0 slower
>
.td mono
"589 / 741
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td ident
.td mono
"0.73 / 0.66
>
.td mono loss
"0.91x A0 slower
>
.td mono
"173 / 512
>
>
>
>
>
.details more
<summary
"Show the other 14 test programs
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Wasm on Windows x64: the other 14 test programs, ties and wins
<tr
=th Test program
=th Time per trip, ns (A0 / clang)
=th clang time divided by A0 time
=th Module bytes (A0 / clang)
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td prefix1k
.td mono
"1279 / 1254
>
.td mono
"0.98x tie
>
.td mono
"348 / 633
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td clamp
.td mono
"4.48 / 4.45
>
.td mono
"0.99x tie
>
.td mono
"241 / 422
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td affine
.td mono
"3.52 / 3.50
>
.td mono
"1.00x tie
>
.td mono
"229 / 557
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td mix
.td mono
"4.41 / 4.40
>
.td mono
"1.00x tie
>
.td mono
"242 / 411
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td hist256
.td mono
"6564 / 6607
>
.td mono
"1.01x tie
>
.td mono
"385 / 641
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td chain3
.td mono
"2.39 / 2.41
>
.td mono
"1.01x tie
>
.td mono
"209 / 521
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td branchy
.td mono
"3.68 / 3.86
>
.td mono
"1.05x tie
>
.td mono
"241 / 421
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td xs4k
.td mono
"10083 / 10755
>
.td mono
"1.07x A0 faster
>
.td mono
"354 / 580
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td loop64
.td mono
"133 / 145
>
.td mono
"1.09x A0 faster
>
.td mono
"247 / 519
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td fnv4k
.td mono
"18558 / 22306
>
.td mono
"1.20x A0 faster
>
.td mono
"354 / 608
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td minmax1k
.td mono
"1379 / 1729
>
.td mono
"1.25x A0 faster
>
.td mono
"372 / 656
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td mat4
.td mono
"166 / 236
>
.td mono
"1.42x A0 faster
>
.td mono
"4000 / 1512
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td dot1k
.td mono
"1180 / 1761
>
.td mono
"1.49x A0 faster
>
.td mono
"267 / 653
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td arrfill4k
.td mono
"625 / 1500
>
.td mono
"2.40x A0 faster
>
.td mono
"358 / 519
>
>
>
>
>
.p cap
"Load time (compile plus instantiate) is a separate result: A0 is slower than clang on some test programs, noisy between runs; every one is in the loss ledger. results/wasm-benchmark.json, results/loss-ledger.json.
>
}
{endsec$k$
>
}
{sec_val
<section
+id validation
=h2 Validation
.p q
"Time to validate an edit. These checks do not prove that it meets the requested behavior.
>
.p take
"After an edit, A0's native checker answers in $ck_a0$ ms: place $ck_rank$ of $ckrows$ languages that have a separate check step (1 = fastest). Checking and running the edit takes A0 $cr_a0$ ms: place $cr_rank$ of $crrows$ languages.
>
<p
"The check is the build or type-check of the edited program. Check and run adds compiling to an executable when the language needs it, and one run whose checksum must match. The first chart times an edit to a real 4,100-line front end; the others time the small test programs, each language with its own toolchain from a cold process.
>
}
{chart_lat
.div chart langs reveal
+role group
+aria-labelledby chart-17
.p ct
+id chart-17
"Checking an edit to a 4,100-line front end: A0 per edit against whole-project TypeScript checkers
>
.p take
# claim-ok: the sentence restates results/check-latency-*.json (A0 edit medians 5.2, 1.7 and 22.7 ms; fresh-process verdicts against tsgo and tsc-rs), checked by test/bench-tables.test.ts
"A0 validates one edit in 2 to 23 ms in a warm session. In a fresh process, checking the whole front end from scratch takes 73 ms on macOS and 69 ms on Linux, slower than tsc-rs and tsgo on macOS and level with tsc-rs on Linux.
>
.p sub
"Two different jobs, stated in each row. One edit, warm session: A0 applies the edit in process on a session that is already open, and the others are whole-project checks that start a fresh process every time, wall time. Whole front end, fresh process: both sides start cold and check everything, the like-for-like row, which A0 loses on macOS. On Linux that row is the shipped command, `a0 check` of the release executable; the macOS row predates it and times a node process that imports the checker. The same front end is 4,103 lines in A0 and 637 lines in TypeScript. The macOS and Windows edit times were recorded before edits were validated incrementally (results/edit-incremental.json: 7.24 ms before and 1.82 ms after, median of the same 14 edits). Windows was measured on a saturated machine, so tsc and tsgo moved by several times between runs there: read the Windows rows as contended and do not compare them as ratios.
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption A0 against TypeScript checkers, medians of 15 interleaved runs, by machine
<tr
=th Machine and load
=th What A0 is timed on
=th A0
=th tsc 5.9.3
=th tsgo 7.0.0-dev
=th tsc-rs 0.1.0
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td macOS arm64, 3 CPUs, load average 10, at the limit
.td mono
"one edit, warm session
>
.td mono
"5.2 ms
>
.td mono
"531 ms
>
.td mono
"56.7 ms
>
.td mono
"53.7 ms
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td same machine
.td mono
"whole front end, fresh process
>
.td mono
"72.6 ms
>
.td mono
"531 ms
>
.td mono loss
"56.7 ms A0 slower
>
.td mono loss
"53.7 ms A0 slower
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td Linux x64, 4 CPUs, load average 1.19
.td mono
"one edit, warm session
>
.td mono
"1.7 ms
>
.td mono
"872 ms
>
.td mono
"120 ms
>
.td mono
"86.0 ms
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td same machine
.td mono
"whole front end, fresh process
>
.td mono
"69.2 ms
>
.td mono
"872 ms
>
.td mono
"120 ms
>
.td mono
"86.0 ms tie
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td Windows x64, 8 CPUs, CPU use 8 of 8 (contended)
.td mono
"one edit, warm session
>
.td mono
"22.7 ms
>
.td mono
"3918 ms
>
.td mono
"25652 ms
>
.td mono
"not run
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td same machine
.td mono
"whole front end, fresh process
>
.td mono
"847 ms
>
.td mono
"3918 ms
>
.td mono
"25652 ms
>
.td mono
"not run
>
>
>
>
.p cap
"Medians of 15 interleaved runs, 3 warm-ups, every sample asserting success. Not run: tsc-rs on Windows (no binary) and bun check (not a command). results/check-latency-darwin-arm64.json, results/check-latency-linux-x64.json, results/check-latency-win32-x64.json.
>
>
}
{chart_ck
.div chart langs reveal ls
+role group
+aria-labelledby chart-12
.p ct
+id chart-12
"Time to check one edited test program
>
.p take
"A0 (native) checks in $ck_a0$ ms: place $ck_rank$ of $ckrows$ (1 = fastest). Fastest: $ck_bestl$, $ck_best$ ms. Median language: $ck_med$ ms. A0 (Node CLI), the previous path, took $ck_node$ ms.
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Median milliseconds over the test programs, shorter bar = faster. Bar length is logarithmic.
>
.p cov mono{ck_covpart| part}
"measured: $ck_cov$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lnat
"compiled
>
.span ljit
"JIT or VM
>
.span lint
"interpreted
>
>
[ckrows ck_top
.div lrow wide{ck_me| me}
.span lbl
"$ck_label$
>
.div track $ck_cls$
.div fill
w 12
w 1
w $ck_pct$
>
.span val
n a mov $ck_val$
c putfix %a
" ms
>
>
>
]
.details more
<summary
"Show all $ckrows$ languages
>
[ckrows
.div lrow wide{ck_me| me}
.span lbl
"$ck_label$
>
.div track $ck_cls$
.div fill
w 12
w 1
w $ck_pct$
>
.span val
n a mov $ck_val$
c putfix %a
" ms
>
>
>
]
>
.p cap
"Languages with no separate check step (they run the file directly) are only in the next chart. A0 here is the native self-hosted checker, run as a cold process with no Node (A0 (Node CLI) is the previous path). Shown first: A0 and selected languages; all $ckrows$ are behind the disclosure, in the same order. results/lang-axes.json.
>
>
}
{chart_val
.div chart langs reveal ls
+role group
+aria-labelledby chart-14
.p ct
+id chart-14
"Model edits: time from a reply to a type-checked program
>
.p take
"On the model edits below, A0 applies the edit and type-checks the whole program in $el_a0$ ms at the median; TypeScript with a warm compiler takes $el_tsw$ ms.
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Milliseconds from reply received to program type-checked, median per edit, over the accepted set-C Sonnet edits on the 40-function program; shorter bar = faster; bar length is logarithmic. Go uses hand translations of the reference edits.
>
.p cov mono{cov_val_part| part}
"measured: $cov_val$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lnat
"other toolchains
>
>
[el
.div lrow wide{el_a0row| me}
.span lbl
"$el_label$
>
.div track {el_a0row|a0|nat}
.div fill
w 12
w 1
w $el_pct$
>
.span val
n a mov $el_med100$
c putfix %a
" ms
>
>
>
]
.p cap
"{el_loaded|Measured on a loaded machine (load average up to $el_load$ on 8 cores); absolute times will move on a quiet run, which will replace these. }Cold rows start the compiler per edit; warm rows reuse a running one. Only these languages have model-written edits to replay, because the model-edit experiment exists only for them (Cost section); every language is checked on a fixed edit in the two charts above. results/edit-loop{el_quiet|.quiet}.json.
>
>
}
{endsec$k$
>
}
{sec_par
<section
+id parallel
=h2 Parallel folds
.p q
"Automatic parallel folds compared with manually parallelized implementations.
>
.p take
"A0 --parallel is the fastest implementation on $par_nwin$ of $par_nk$ test programs; on the others, at least one other implementation is faster (listed under the chart).
>
<p
"A fold whose step is an associative reduction can be split across cores without changing its result.\s
=strong a0 emit c --parallel
" does that from a cost model, and every result is checked exact against serial A0 and the reference interpreter.
>
}
{chart_par
.div chart langs reveal
+role group
+aria-labelledby chart-15
.p ct
+id chart-15
"Each implementation's time as a multiple of A0 --parallel's, per test program
>
.p sub
"1.00x = the same speed as A0 --parallel; above 1.00x A0 --parallel is faster; below 1.00x (red) the other implementation is faster. Bar length is logarithmic. $par_cpus$ cores, median of $par_samples$ interleaved samples.
>
.p cov mono{cov_par_part| part}
"measured: $cov_par$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lnat
"other languages
>
>
}
# The parallel chart is two section functions: the self-hosted checker takes at most 2730 nodes in one
# chunk (compiler/parse.a0 `fecap`), and the kernel loop expands to a group of nodes for each kernel.
{chart_par2
[pk
.p kh mono
"$pk_name$: $pk_trips$ iterations, A0 $pk_ms$ ms
>
[pr
.div lrow wide{pr_a0| me}
.span lbl
"$pr_label$
>
.div track {pr_a0|a0|nat}
.div fill
w 12
w 1
w $pr_pct$
>
.span val{pr_loss| loss}
n a mov $pr_r100$
c putratio %a
"x
>
>
>
]
]
.p cap
"{par_loaded|Measured on a loaded machine (load average up to $par_load$ on $par_cpus$ cores when timing started); ratios are interleaved, absolute times will move on a quiet run. }Hand-parallel C is OpenMP parallel-for with a reduction. Where another implementation is faster, its time as a multiple of A0 --parallel's is in parentheses: $par_losses$. On the 64K-element kernels the cost model keeps A0 serial. results/parallel.json.
>
>
}
{endsec$k$
>
}
{sec_hw
<section
+id hardware
=h2 Hardware
.p q
"Generated circuit size and cycle counts.
>
.p take
"The $hw_fns$ corpus functions compile to $hw_mods$ synthesized modules (the shared divider counts as one): $hw_cells$ generic cells in all, $hw_max$ in the largest, simulated on $hw_cases$ oracle cases.
>
<p
"A0 compiles the same programs to clocked SystemVerilog. A cell is one gate-level element after Yosys generic synthesis, so fewer cells means a smaller circuit; cell counts are relative size, not area on a real chip. Every number here is read from results/hardware.json.
>
.div tiles
.div tile
.div n
"$hw_mods$
>
.p
"synthesized modules
>
>
.div tile
.div n
"$hw_cells$
>
.p
"generic cells in all modules
>
>
.div tile
.div n
"$hw_max$
>
.p
"cells in the largest module
>
>
.div tile
.div n
"$hw_cases$
>
.p
"oracle cases simulated
>
>
>
.p take
"Of the $hw_sim$ modules simulated, $hw_clk$ are clocked: they take a median of $hw_cmed$ clock cycles per case, from $hw_cmin$ to $hw_cmax$. The rest are combinational and answer within the same cycle.
>
<p
"A cycle count is how many clock ticks a module needs from receiving its inputs (start) to raising its done signal, averaged over the simulated oracle cases. Division, remainder and loops make a module clocked, because they run over several cycles.
>
.div tiles
.div tile
.div n
"$hw_cmin$
>
.p
"fewest mean cycles, any clocked module
>
>
.div tile
.div n
"$hw_cmed$
>
.p
"median mean cycles across clocked modules
>
>
.div tile
.div n
"$hw_cmax$
>
.p
"most mean cycles, any clocked module
>
>
>
}
{endsec$k$
>
}
{sec_targets
<section
+id targets
=h2 Verification
.p q
"Verification coverage by target.
>
=p One source, checked against one oracle: $vr_nfull$ paths (the interpreter, the optimizer, JavaScript, native C, C++, WebAssembly and the JVM) ran all $vr_full$ generated cases; the native assembly targets ran the $vr_part$ cases that need no io ($vr_npart$ targets); SystemVerilog is simulated separately on $hw_cases$ cases and is unverified in this run ($vr_nskip$ target).
>
}
{sec_close
>
>
}
c foot
w 6
w 0
2
2ret event
2end
