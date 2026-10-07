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
# table of 32768 pairs, so it is spread over five functions by byte range (the chunks that start in each range).
# tools/site-gen.ts fails the build when a function is over 75% of that table: then add a range here.
{css_a
s 9 css 0 9000
}
{css_b
s 9 css 9000 18000
}
{css_c
s 9 css 18000 27000
}
{css_d
s 9 css 27000 36000
}
{css_e
s 9 css 36000 45000
}
{css_f
s 9 css 45000
}
c nav
{sec_bhead
.div center bench
=h1 Benchmarks
=p What we measured, how, and where A0 loses.
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
+href #tokens
"Tokens
>
<a
+href #cost
"Cost
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
{sec_headline
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption The headline numbers, one question per row; the section named in the first column has the chart, the method and the files
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
+href #cost
"Is an edit cheaper?
>
>
=td At 4000 functions, $cmax_ratio$x fewer tokens than TypeScript shown the whole file
=td At 1 function, $cmin_100$x TypeScript's tokens
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #cost
"Do models get the edit right?
>
>
=td Sonnet: 14 of 14 front-end edits accepted after one repair, equal to TypeScript, at 4.9x fewer tokens per accepted edit
=td Haiku: 10 of 14 accepted against TypeScript's 13
>
<tr
# claim-ok: headline row, every figure is a variable from the results files named in the caption or a cell of results/app-edit-keys.json and results/check-latency-*.json
<td
<a
+href #validation
"Is an edit checked quickly?
>
>
=td 5 to 23 ms per edit in a warm session, against 531 to 3918 ms for a whole-project tsc check
=td Checking from scratch in a fresh process is slower than tsc-rs on Linux and macOS, and than tsgo on macOS
>
>
>
# claim-ok: the headline row values are the cells of results/app-edit-keys.json (Sonnet 14 of 14, 1485.2 against 7277.3 tokens, Haiku 10 and 13) and results/check-latency-*.json (A0 edit medians 5.2, 5.8 and 22.7 ms; tsc medians 531, 779 and 3918 ms), checked by test/bench-tables.test.ts
.p cap
"Sources: results/exec-benchmark-full.json, results/lang-axes.json, results/ai-edit-experiment.*.json, results/app-edit-keys.json, results/check-latency-*.json.
>
}
{sec_method
<section
+id method
=h2 Method
.p q
"How every number on this page was produced, so you can decide whether to trust it.
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
=td Native speed: one Apple M3, 2026-09-30 and 2026-10-01. WebAssembly: one Windows x64 PC. Edit-check latency: that PC, a Linux x64 runner and a macOS arm64 runner. Results from different machines are never combined into one claim.
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
.p nx
"Next: where A0 loses, then the measurements.\s
<a
+href #limits
"Where A0 loses
>
>
>
}
{sec_limits
<section
+id limits
=h2 Where A0 loses
.p q
# claim-ok: a statement of what the section lists; the figures are in the table below, each with its results file
"Every place A0 is slower, costlier or unable, one line each, with the file that records it.
>
.div limits
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Known losses; the loss ledger lists every one and can only shrink
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
=td Slower than clang on 8 of 19 test programs, and slower to compile and instantiate on 14; that ratio moved by up to 0.27 between two runs.
=td results/wasm-benchmark.json, results/loss-ledger.json
>
<tr
=td Emitted JavaScript
=td One recorded loss against hand-written JavaScript (the noop kernel); a quiet Windows rerun tied, and the loss stays in the ledger.
=td results/exec-benchmark-noop-win32.json
>
<tr
=td Tokens
=td A0 costs more than TypeScript on single-function tasks: 377 of the recorded losses are kernel token counts, measured with OpenAI's o200k_base tokenizer, not a Claude tokenizer.
=td results/lang-axes.json, results/loss-ledger.json
>
<tr
=td Editing a front end
=td Haiku had more edits accepted in TypeScript than in A0 (13 against 10; Sonnet ties at 14).
=td results/app-edit-keys.json
>
<tr
=td Checking from scratch
=td A whole-front-end check in a fresh process is slower than tsc-rs on Linux and macOS and than tsgo on macOS; the A0 numbers in that table were recorded before edits were checked incrementally.
=td results/check-latency-darwin-arm64.json, results/check-latency-linux-x64.json, results/loss-ledger.json
>
<tr
=td Evidence
=td Each edit cell uses fresh model sessions, one subject per cell and 24 trials per cell; native timings come from one machine, and the compiler versions of the other languages are not recorded in the results file.
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
.p nx
"Next: the measurements, starting with native speed.\s
<a
+href #native
"Native speed
>
>
>
}
{sec_native
<section
+id native
=h2 Native speed on small test programs
.p q
"Is machine code from A0 as fast as C, Rust and Zig on the same small functions?
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
"Reading a row: the third column names the fastest of the other languages and its time per call; the last column is A0's time divided by that time. Below 1.00x, A0 is faster than every other language on that test program; above 1.00x, that language is faster and the number is the gap A0 has to close.
>
>
.p nx
"Next: the same programs against $n_langs$ other languages.\s
<a
+href #languages
"Languages
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
"Where does A0 stand among every language we could run on the same test programs?
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
"Shown first: A0 and the best-known languages. All $n_langs1$ languages are behind the disclosure, in the same order. A0 here is machine code from A0's own AArch64 code generator, with no C compiler in between. Numbers, toolchains and iteration tiers are in results/exec-benchmark.json.
>
>
.p nx
"Next: how quickly each language starts.\s
<a
+href #startup
"Startup
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
"How long from launching a program to its first result?
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
"Shown first: A0 and the best-known languages; all $n_starts$ are behind the disclosure, in the same order. The A0 binary for startup is the C-path build; startup of the direct AArch64 binary is not yet measured.
>
>
.p nx
"Next: A0's WebAssembly output against clang, on another machine.\s
<a
+href #wasm
"WebAssembly
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
"Does A0's own WebAssembly output run as fast as clang's, on a machine that is not the one used for native speed?
>
.p take
"clang's time divided by A0's has a geometric mean of 1.06 over 19 test programs: A0 is faster on 6, ties on 5 and is slower on 8, the worst being arrfill at 0.78. Source: results/wasm-benchmark.json.
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
"Both sides run the same driver inside the module: a chain of dependent trips of one function. A0 is the direct wasm32 backend; clang is -O3 on the hand-written C kernel. Time per trip is the median of 15 interleaved samples in Node v22.21.1; module size is in bytes. Windows has no load average, so load is CPU use: highest 5.57 of 10 allowed. A ratio below 1.00x means clang is faster.
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Wasm on Windows x64: the 8 test programs where A0 is slower than clang, worst first
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
"4.00 / 3.13
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
=td prefix1k
.td mono
"873 / 740
>
.td mono loss
"0.85x A0 slower
>
.td mono
"348 / 633
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td rotl
.td mono
"2.66 / 2.33
>
.td mono loss
"0.88x A0 slower
>
.td mono
"220 / 491
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td chain3
.td mono
"2.61 / 2.31
>
.td mono loss
"0.88x A0 slower
>
.td mono
"209 / 521
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td noop
.td mono
"0.66 / 0.59
>
.td mono loss
"0.90x A0 slower
>
.td mono
"173 / 512
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td affine
.td mono
"3.75 / 3.42
>
.td mono loss
"0.91x A0 slower
>
.td mono
"229 / 557
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td filter2
.td mono
"2392 / 2267
>
.td mono loss
"0.95x A0 slower
>
.td mono
"589 / 741
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td ident
.td mono
"0.62 / 0.59
>
.td mono loss
"0.95x A0 slower
>
.td mono
"173 / 512
>
>
>
>
.details more
<summary
"Show the other 11 test programs
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Wasm on Windows x64: the other 11 test programs, ties and wins
<tr
=th Test program
=th Time per trip, ns (A0 / clang)
=th clang time divided by A0 time
=th Module bytes (A0 / clang)
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td hist256
.td mono
"5808 / 5602
>
.td mono
"0.96x tie
>
.td mono
"385 / 641
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td clamp
.td mono
"4.85 / 4.76
>
.td mono
"0.98x tie
>
.td mono
"241 / 422
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td branchy
.td mono
"3.31 / 3.33
>
.td mono
"1.01x tie
>
.td mono
"241 / 421
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td mix
.td mono
"4.41 / 4.46
>
.td mono
"1.01x tie
>
.td mono
"242 / 411
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td xs4k
.td mono
"8106 / 8295
>
.td mono
"1.02x tie
>
.td mono
"354 / 580
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td loop64
.td mono
"131 / 141
>
.td mono
"1.07x A0 faster
>
.td mono
"247 / 519
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td fnv4k
.td mono
"18620 / 22089
>
.td mono
"1.19x A0 faster
>
.td mono
"354 / 608
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td minmax1k
.td mono
"1241 / 1566
>
.td mono
"1.26x A0 faster
>
.td mono
"372 / 656
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td dot1k
.td mono
"1014 / 1406
>
.td mono
"1.39x A0 faster
>
.td mono
"267 / 653
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td mat4
.td mono
"156 / 224
>
.td mono
"1.44x A0 faster
>
.td mono
"3996 / 1512
>
>
<tr
# claim-ok: row of results/wasm-benchmark.json, checked by test/bench-tables.test.ts
=td arrfill4k
.td mono
"558 / 1294
>
.td mono
"2.32x A0 faster
>
.td mono
"358 / 519
>
>
>
>
>
.p cap
"Load time (compile plus instantiate) is a separate result: A0 is slower than clang on 14 test programs, and that ratio moved by up to 0.27 between two runs. results/wasm-benchmark.json, results/loss-ledger.json.
>
>
.p nx
"Next: tokens, what it costs to read and write the same program.\s
<a
+href #tokens
"Tokens
>
>
}
{endsec$k$
>
}
{sec_tok
<section
+id tokens
=h2 Tokens
.p q
"How many tokens does it take to write the same program in each language, and one small edit to it?
>
.p take
"Writing the $tk_nk$ token test programs, A0 (canonical) takes $tk_cv$ tokens: place $tk_cr$ of $n_langs1$ (1 = fewest), fewer than $tk_cw$ of the other $n_langs$ languages, equal to $tk_ct$ and more than $tk_cl$. A0 (dense) takes $tk_dv$: place $tk_dr$, fewer than $tk_dw$, equal to $tk_dt$, more than $tk_dl$; its lossless form, with the same ids and node order, takes $tk_dx$: place $tk_xr$. The dense totals are over the same $tk_nk$ programs (results/dense-tokens.json); the speed tests below time more programs ($bk_n$), but only $tk_nk$ of them are counted for tokens.
>
<p
# claim-ok: a definition of why a token count matters, not a measured comparison; the counts are in results/lang-axes.json
"A token is the unit a model reads and writes, so fewer tokens means less to read, write and pay for. Counts use the o200k tokenizer on the source of the same test programs. Dense is the same A0 program in a shorter surface form that converts losslessly to the canonical form; both are plotted.
>
}
{chart_tk
.div chart langs reveal lm
+role group
+aria-labelledby chart-6
.p ct
+id chart-6
"Source tokens of the $tk_nk$ token test programs, per language
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Sum over the test programs of the o200k tokens of each program as written in that language, shorter bar = fewer tokens. Bar length is proportional to the count.
>
.p cov mono{tk_covpart| part}
"measured: $tk_cov$ of $n_all$ languages
>
.div legend
.span la0
"A0 (canonical and dense)
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
[tkrows tk_top
.div lrow{tk_me| me}
.span lbl
"$tk_label$
>
.div track $tk_cls$
.div fill
w 12
w 1
w $tk_pct$
>
.span val
n a mov $tk_val$
c putnum %a
" tok
>
>
>
]
.details more
<summary
"Show all $tkrows$ rows ($n_langs1$ languages, A0 in two forms)
>
[tkrows
.div lrow{tk_me| me}
.span lbl
"$tk_label$
>
.div track $tk_cls$
.div fill
w 12
w 1
w $tk_pct$
>
.span val
n a mov $tk_val$
c putnum %a
" tok
>
>
>
]
>
.p cap
"Program length is one input; what a whole edit costs, measured with models, is in the Cost section. Shown first: A0 and the best-known languages; all $tkrows$ rows are behind the disclosure, in the same order. Source: results/lang-axes.json, and the dense totals in results/dense-tokens.json.
>
>
}
{chart_edit
.div chart single reveal
+role group
+aria-labelledby chart-7
.p ct
+id chart-7
"Tokens to make one small edit, A0 against other languages
>
.p take
"To change one operator in a one-function file, A0 reads $tf_a0_view$ tokens and writes a $tf_a0_edit$-token reply. TypeScript reads $tf_ts_file$ and writes $tf_ts_line$ as a line edit, $tf_ts_sr$ as a search-and-replace block or $tf_ts_diff$ as a unified diff; C reads $tf_c_file$ and writes $tf_c_diff$ as a unified diff.
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"o200k tokens for the same edit, in each language's usual form. Shorter bar = fewer tokens. A0 reads more than C on this tiny file; the scoped view pays off as programs grow (Cost section).
>
.p kh mono
"Read: the code in front of the model
>
n a mov $tf_c_file$
n b mov $tf_a0_file$
n c mov $tf_a0_view$
n d mov $tf_py_file$
n e mov $tf_ts_file$
n f call max3 %a %b %c
n m call max3 %d %e %f
.div lrow wide
.span lbl
"C file
>
.div track nat
c fill %a %m
.span val
c putnum %a
" tok
>
>
>
.div lrow wide me
.span lbl
"A0 scoped view
>
.div track a0
c fill %c %m
.span val
c putnum %c
" tok
>
>
>
.div lrow wide
.span lbl
"A0 whole file
>
.div track a0
c fill %b %m
.span val
c putnum %b
" tok
>
>
>
.div lrow wide
.span lbl
"Python file
>
.div track int
c fill %d %m
.span val
c putnum %d
" tok
>
>
>
.div lrow wide
.span lbl
"TS file
>
.div track jit
c fill %e %m
.span val
c putnum %e
" tok
>
>
>
.p kh mono
"Write: the model's reply
>
n a mov $tf_a0_edit$
n b mov $tf_ts_line$
n c mov $tf_ts_sr$
n d mov $tf_a0_patch$
n e mov $tf_c_diff$
n f call max3 %a %b %c
n g call max3 %d %e %f
n h mov $tf_ts_diff$
n m call max2 %g %h
.div lrow wide me
.span lbl
"A0 line edit
>
.div track a0
c fill %a %m
.span val
c putnum %a
" tok
>
>
>
.div lrow wide
.span lbl
"TS line edit
>
.div track jit
c fill %b %m
.span val
c putnum %b
" tok
>
>
>
.div lrow wide
.span lbl
"TS search/replace
>
.div track jit
c fill %c %m
.span val
c putnum %c
" tok
>
>
>
.div lrow wide
.span lbl
"A0 patch
>
.div track a0
c fill %d %m
.span val
c putnum %d
" tok
>
>
>
.div lrow wide
.span lbl
"C unified diff
>
.div track nat
c fill %e %m
.span val
c putnum %e
" tok
>
>
>
.div lrow wide
.span lbl
"TS unified diff
>
.div track jit
c fill %h %m
.span val
c putnum %h
" tok
>
>
>
.p cap
"Bars are linear within each group. The fixtures are the edit of affine in results/tokens.json; a model's real replies (Cost section) include the instructions it must be given first.
>
>
}
{tokens_next
.p nx
"Next: what a whole edit costs with real models.\s
<a
+href #cost
"Cost
>
>
}
{endsec$k$
>
}
{sec_cost
<section
+id cost
=h2 Cost
.p q
"What does a whole edit cost a model, counting the instructions, the code it reads and its reply?
>
.p take
"At 4000 functions an A0 edit costs $cmax_a0$ tokens against $cmax_ts$ for TypeScript, which is $cmax_ratio$x fewer than TypeScript shown the whole numbered file (A0's scoped view against a whole-file workflow, not both with scoped views). At 1 function A0 costs $cmin_100$x TypeScript's tokens and $cmin_rs100$x Rust's. Sonnet, cache-adjusted.
>
<p
"Cost here is every token a model reads and writes to make one edit: the instructions it is first given (the primer), the code it reads, and its reply. A model edits one function through a scoped view: the function, the signatures it depends on, and its callers. The view stays the same size as the program grows; a numbered whole file does not, so against a whole-file workflow A0's advantage grows with program size and reverses on a one-function file, where the primer dominates.
>
<p
"That is an advantage of the workflow, not of the language. When TypeScript, Rust, Python, Go, Java, C and Ruby are given an equal view (a parse-derived function and its callees, numbered line edits), pooled over the four program sizes (96 trials per cell) A0 canonical costs 318 tokens for one cold task and 176 in an unbounded session, against 386 and 138 for TypeScript and 375 and 115 for Ruby, so it is cheaper cold and dearer once the primer is cached; A0 dense costs 273 and 99. results/ai-edit-scoped.json.
>
}
{chart_ec
.div chart langs reveal lm
+role group
+aria-labelledby chart-9
.p ct
+id chart-9
"Edit cost across $n_langs1$ languages, with A0 in two forms
>
.p take
"Over a session of 10 edits, A0 (canonical) costs $ec_c_t10$ tokens per task: place $ec_cr10$ of $n_langs1$ (1 = fewest), cheaper than $ec_cw10$ of the other $n_langs$ languages, equal to $ec_ct10$, dearer than $ec_cl10$. A0 (dense, lean view with callee bodies) costs $ec_d_t10$: place $ec_dr10$, cheaper than $ec_dw10$, equal to $ec_dt10$, dearer than $ec_dl10$.
>
<p
"Dense is the same program in a shorter surface form; it converts losslessly to the canonical form. A0 (dense) is shown with the lean view: only the function to edit, with its direct callees as dense text. Both A0 subjects are measured on the same twelve tasks of set b (one function to edit) as the other languages, one fresh Haiku and one fresh Sonnet subject per task, one shot and one repair. Losses first: the dense primer is larger ($ec_d_S$ tokens against $ec_c_S$ for canonical), so in a session of 1 task the two cost $ec_d_t1$ and $ec_c_t1$; each cell is $ec_c_n$ tasks, one task is $ec_trial$ points of acceptance, and differences of about one task are within noise. This chart is set b only.
>
.p sub
"Tokens per task, session of 10 tasks (primer paid on the first call at 1.25x and on later calls at 0.05x; view and replies at 1x, as recorded in results/ai-edit-b48-dense.json); shorter bar = fewer tokens. Bar length is proportional.
>
.p cov mono{ec_covpart| part}
"measured: $ec_cov$ of $n_all$ languages
>
.div legend
.span la0
"A0 (canonical and dense)
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
[ecrows ec_top
.div lrow{ec_me| me}
.span lbl
"$ec_label$
>
.div track $ec_cls$
.div fill
w 12
w 1
w $ec_pct$
>
.span val
n a mov $ec_val$
c putnum %a
" tok
>
>
>
]
}
# The edit-cost chart is two section functions: one function holds at most 2816 nodes in the A0 toolchain
# (tools/site-budget.ts) and each row loop expands to a node per language.
{chart_ec2
.details more
<summary
"Show all $ecrows$ rows ($n_langs1$ languages, A0 in two forms)
>
[ecrows
.div lrow{ec_me| me}
.span lbl
"$ec_label$
>
.div track $ec_cls$
.div fill
w 12
w 1
w $ec_pct$
>
.span val
n a mov $ec_val$
c putnum %a
" tok
>
>
>
]
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank
=caption A0 (canonical and dense) place and wins, ties and losses on each edit measure
<tr
=th Measure
=th A0 (canonical): place
# claim-ok: column labels; the cells are the win, tie and loss counts of results/ai-edit-b48-dense.json
=th A0 (canonical): cheaper than, equal to, dearer than
=th A0 (dense): place
=th A0 (dense): cheaper than, equal to, dearer than
>
[emrows
<tr
.td mono
"$em_name$
>
.td mono first
"$em_cr$ of $n_langs1$ ($em_ct$ tied)
>
.td mono first
"$em_cw$, $em_cx$, $em_cl$
>
.td mono first
"$em_dr$ of $n_langs1$ ($em_dt$ tied)
>
.td mono first
"$em_dw$, $em_dx$, $em_dl$
>
>
]
>
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank
=caption Edit acceptance and token cost per subject
<tr
=th Subject
=th Accepted first try
=th Accepted after one repair
=th Primer
=th Tokens read
=th Tokens written
=th Session of 1 task
=th Session of 10 tasks
=th Long session
>
<tr
.td first
"A0 (canonical)
>
.td mono
"$ec_c_one$ of $ec_c_n$
>
.td mono
"$ec_c_acc$ of $ec_c_n$
>
.td mono
"$ec_c_S$
>
.td mono
"$ec_c_read$
>
.td mono
"$ec_c_write$
>
.td mono
"$ec_c_t1$
>
.td mono
"$ec_c_t10$
>
.td mono
"$ec_c_tinf$
>
>
<tr
.td first
"A0 (dense)
>
.td mono
"$ec_d_one$ of $ec_d_n$
>
.td mono
"$ec_d_acc$ of $ec_d_n$
>
.td mono
"$ec_d_S$
>
.td mono
"$ec_d_read$
>
.td mono
"$ec_d_write$
>
.td mono
"$ec_d_t1$
>
.td mono
"$ec_d_t10$
>
.td mono
"$ec_d_tinf$
>
>
>
>
.p cap
"Measures: one-shot = accepted on the first try; after repair = accepted after one repair; cost 1, cost 10 and cost inf = tokens per task over a session of 1 task, of 10 tasks and of unbounded length (the primer's share vanishes). Place 1 = fewest tokens or most accepted; every rank is the subject against the same $n_langs$ other languages, and the three numbers beside it count the languages it beats, ties and loses to. Tokens in the second table are averages per task. The other dense variants measured (dense view with program view, lean view, lean view with a shorter primer) are in results/ai-edit-b48-dense.json. Numbers: results/ai-edit-b48-dense.json.
>
>
}
{chart2
.div chart reveal
+role group
+aria-labelledby chart-10
.p ct
+id chart-10
"Tokens a model reads and writes per edit, by program size, Sonnet
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Cache-adjusted; shorter bar = fewer tokens. The number on the right is TypeScript's tokens divided by A0's: above 1.00x A0 uses fewer tokens than TypeScript, below 1.00x (red) A0 uses more.
>
.p cov mono{cov_sum_part| part}
"measured: $cov_sum$ of $n_all$ languages
>
.div legend
.span la0
"A0
>
.span lc
"TypeScript
>
.span lrust
"Rust
>
>
[csum
.div row
.span lbl
"$cs_size$ function{cs_many|s}
>
.div bars
n a mov $cs_a0$
n b mov $cs_ts$
n c mov $cs_rust$
n m call max3 %a %b %c
.div track a0
c fill %a %m
.span val
c putnum %a
" tok
>
>
.div track c
c fill %b %m
.span val
c putnum %b
" tok
>
>
.div track rust
c fill %c %m
.span val
c putnum %c
" tok
>
>
>
n r mul %b 100
n q div %r %a
.span ratio $cs_cls$
c putratio %q
"x TS ÷ A0
>
>
]
.p cap
"These size charts are A0 (canonical); A0 (dense) was measured at one function only, in the chart above. Bars are linear within each row. The per-size charts below add every other language that has data at that size. Languages with no model-edit data: $cost_missing$. Each needs a hand-written translation of every edit task, a build-and-run acceptance check and paid model calls; only the languages shown have them.
>
>
}
[csz
{cost_$cz_size$
.div chart langs reveal lm
+role group
+aria-labelledby chart-size-$cz_size$
.p ct
+id chart-size-$cz_size$
"Edits in a $cz_size$-function program: tokens read and written, $cz_n$ languages{cz_loss| (a loss for A0)}
>
.p take
"At $cz_size$ function{cz_many|s}, A0 uses $cz_a0$ tokens per edit: place $cz_rank$ of $cz_n$ languages (1 = fewest). The fewest is $cz_bestl$ with $cz_best$.
>
.p sub
# claim-ok: axis and reading note for the chart, not a measured claim; the values come from the results files this section names
"Sonnet, cache-adjusted, shorter bar = fewer tokens; bar length is logarithmic. A language is listed only if it was measured at this size.
>
.p cov mono{cz_covpart| part}
"measured: $cz_cov$ of $n_all$ languages
>
[cb
.div lrow wide{cb_a0| me}
.span lbl
"$cb_label$
>
.div track {cb_a0|a0|nat}
.div fill
w 12
w 1
w $cb_pct$
>
.span val
n a mov $cb_total$
c putnum %a
" tok
>
>
>
]
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank
=caption Tokens per edit, by language
<tr
=th Language
=th Primer (instructions)
=th Code read
=th Reply written
=th Total tokens
=th Total as a multiple of A0's
=th Sonnet edits accepted
=th Haiku edits accepted
>
[ct
<tr
.td {ct_a0|first}
"$ct_label$
>
.td mono
n a mov $ct_primer$
c putnum %a
>
.td mono
n a mov $ct_code$
c putnum %a
>
.td mono
n a mov $ct_write$
c putnum %a
>
.td mono
n a mov $ct_total$
c putnum %a
>
.td mono $ct_cls$
n a mov $ct_ratio$
c putratio %a
"x
>
.td mono
"$ct_acc$%
>
.td mono
"{ct_hk|$ct_hk$%|not run}
>
>
]
>
>
.p cap
"Primer: language and workflow instructions, first read at the 1.25x cache-write rate. Code read: the view or numbered file. Reply written: the model's edit. Total as a multiple of A0's: the row total divided by A0's total; below 1.00x (red) that language needs fewer tokens than A0. Edits accepted: the share of the 12 tasks whose edit passed the tests on the first try, for each model.
>
>
}
]
.p cap
"Tasks are the same edits in every language; sets 400 and 4000 are one shared program grown to that size. Subjects are fresh Sonnet and Haiku contexts that see only the primer. In the 400 and 4000 rows the other languages read the whole numbered file and A0 its scoped view (a workflow comparison); the equal-context comparison is results/ai-edit-scoped.json. Numbers: results/ai-edit-experiment.\{b,c,c400,c4000\}.*.json.
>
.div chart reveal
+role group
+aria-labelledby chart-18
.p ct
+id chart-18
"Editing a real front end: 14 change requests to a lexer and parser
>
.p take
# claim-ok: the sentence restates the cells of results/app-edit-keys.json in the table below, checked by test/bench-tables.test.ts
"Sonnet had all 14 edits accepted in A0 after one repair, equal to TypeScript, at 1485 tokens per accepted edit against 7277. Haiku had 10 accepted in A0 against 13 in TypeScript, so on Haiku A0 lost on correctness and won on tokens.
>
.p sub
"Each request is the same plain-language instruction on both sides; an edit is accepted when hidden tests pass, with one repair round allowed. Tokens per accepted edit are for a session of 10 edits. One fresh subject per cell, 14 tasks per cell, so a difference of one task is within noise. results/app-edit-keys.json.
>
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
.table ops rank fit
=caption Fourteen edits to one front end: edits accepted and tokens per accepted edit (10-edit session)
<tr
=th Model, language
=th Accepted first try
=th Accepted after one repair
=th Tokens per accepted edit
>
<tr
# claim-ok: row of results/app-edit-keys.json, checked by test/bench-tables.test.ts
=td Sonnet, A0
.td mono
"13 of 14
>
.td mono
"14 of 14
>
.td mono
"1485
>
>
<tr
# claim-ok: row of results/app-edit-keys.json, checked by test/bench-tables.test.ts
=td Sonnet, TypeScript
.td mono
"14 of 14
>
.td mono
"14 of 14
>
.td mono
"7277
>
>
<tr
# claim-ok: row of results/app-edit-keys.json, checked by test/bench-tables.test.ts
=td Haiku, A0
.td mono
"8 of 14
>
.td mono
"10 of 14
>
.td mono
"2144
>
>
<tr
# claim-ok: row of results/app-edit-keys.json, checked by test/bench-tables.test.ts
=td Haiku, TypeScript
.td mono
"11 of 14
>
.td mono
"13 of 14
>
.td mono
"7960
>
>
>
>
>
.p nx
"Next: how fast an edit is known to be right.\s
<a
+href #validation
"Validation
>
>
{endsec$k$
>
}
{sec_val
<section
+id validation
=h2 Validation
.p q
"How long after an edit is it known to be right?
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
# claim-ok: the sentence restates results/check-latency-*.json (A0 edit medians 5.2, 5.8 and 22.7 ms; fresh-process verdicts against tsgo and tsc-rs), checked by test/bench-tables.test.ts
"A0 validates one edit in 5 to 23 ms in a warm session. In a fresh process, checking the whole front end from scratch takes 73 ms on macOS and 91 ms on Linux, slower than tsc-rs on both and than tsgo on macOS.
>
.p sub
"Two different jobs, stated in each row. One edit, warm session: A0 applies the edit in process on a session that is already open, and the others are whole-project checks that start a fresh process every time, wall time. Whole front end, fresh process: both sides start cold and check everything, the like-for-like row, and the one that A0 loses. The same front end is 4,103 lines in A0 and 637 lines in TypeScript. The A0 edit times were recorded before edits were validated incrementally (results/edit-incremental.json: 7.24 ms before and 1.82 ms after, median of the same 14 edits). Windows was measured on a saturated machine, so tsc and tsgo moved by several times between runs there: read the Windows rows as contended and do not compare them as ratios.
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
=td Linux x64, 4 CPUs, load average 1.4
.td mono
"one edit, warm session
>
.td mono
"5.8 ms
>
.td mono
"779 ms
>
.td mono
"88.3 ms
>
.td mono
"55.7 ms
>
>
<tr
# claim-ok: row of results/check-latency-*.json, checked by test/bench-tables.test.ts
=td same machine
.td mono
"whole front end, fresh process
>
.td mono
"91.4 ms
>
.td mono
"779 ms
>
.td mono
"88.3 ms tie
>
.td mono loss
"55.7 ms A0 slower
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
"Languages with no separate check step (they run the file directly) are only in the next chart. A0 here is the native self-hosted checker, run as a cold process with no Node (A0 (Node CLI) is the previous path). Shown first: A0 and the best-known languages; all $ckrows$ are behind the disclosure, in the same order. results/lang-axes.json.
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
.p nx
"Next: splitting a loop across cores.\s
<a
+href #parallel
"Parallel folds
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
"Does A0's automatic multi-core split beat hand-parallel code in other languages?
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
.p nx
"Next: the hardware output.\s
<a
+href #hardware
"Hardware
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
"How big is the circuit A0 generates, and how many clock cycles does it take?
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
.p nx
"Next: which targets are checked against the oracle.\s
<a
+href #targets
"Verification
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
"Is every target checked against the same oracle, and what is not checked?
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
