# The a0lang.com home page (site/page.a0), as a template of the site generator (site/gen/sitegen.a0,
# where the template language is described). Every number comes from the results files below.
f tags site/gen/tags.tpl
f css site/gen/style.css
f glsl site/gen/scene.glsl
f exec results/exec-benchmark.json
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
f cost 1 sonnet min results/ai-edit-experiment.b.sonnet-min.json
f cost 1 sonnet langs results/ai-edit-experiment.b.sonnet-langs.json
f cost 1 haiku min results/ai-edit-experiment.b.haiku-min.json
f cost 1 haiku langs results/ai-edit-experiment.b.haiku-langs.json
f editq results/edit-loop.quiet.json
f edit results/edit-loop.json
f par results/parallel.json
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
s 9 css
c nav
{sec_hero
<section
+id top
+class hero
.div stage
s 13 glsl
>
<div
+id live
+class live mono reveal
"\n\s\s\s\s
<div
+class col view
"\n\s\s\s\s\s\s
<h6
"view\s
<b
"clamp
>
>
"\n\s\s\s\s\s\s
<div
+id v0
+class ln
<span
+id v0t
+class ty
"e0
>
>
"\n\s\s\s\s\s\s
<div
+id v1
+class ln
<span
+id v1t
+class ty
"fn clamp u32 u32 u32 -> u32
>
>
"\n\s\s\s\s\s\s
<div
+id v2
+class ln
<span
+id v2t
+class ty
"lo lt p0 p1
>
>
"\n\s\s\s\s\s\s
<div
+id v3
+class ln mark
<span
+id v3t
+class ty
"hi lt p2 p0
>
<span
+id v3n
+class alt
"a select lo p1 p0
>
>
"\n\s\s\s\s\s\s
<div
+id v4
+class ln mark
<span
+id v4t
+class ty
"a select lo p1 p0
>
<span
+id v4n
+class alt
"hi lt p2 a
>
>
"\n\s\s\s\s\s\s
<div
+id v5
+class ln
<span
+id v5t
+class ty
"r select hi p2 a
>
>
"\n\s\s\s\s\s\s
<div
+id v6
+class ln
<span
+id v6t
+class ty
"ret r
>
>
"\n\s\s\s\s\s\s
<div
+id v7
+class ln
<span
+id v7t
+class ty
"end
>
>
"\n\s\s\s\s
>
"\n\s\s\s\s
<div
+class col model
"\n\s\s\s\s\s\s
<h6
"model\s
<b
"reply
>
>
"\n\s\s\s\s\s\s
<div
+id r0
+class ln
<span
+id r0t
+class ty
"e0
>
>
"\n\s\s\s\s\s\s
<div
+id r1
+class ln
<span
+id r1t
+class ty
"hi lt p2 a
>
>
"\n\s\s\s\s\s\s
<div
+class stamp
<i
>
<b
"accepted
>
<span
"· rev fe014071
>
>
"\n\s\s\s\s
>
"\n\s\s\s\s
<div
+class col asm
"\n\s\s\s\s\s\s
<h6
"aarch64\s
<b
"native
>
>
"\n\s\s\s\s\s\s
<div
+id a0
+class ln
"cmp w10, w11
>
"\n\s\s\s\s\s\s
<div
+id a1
+class ln
"cset w12, lo
>
"\n\s\s\s\s\s\s
<div
+id a2
+class ln
"cmp w9, #0
>
"\n\s\s\s\s\s\s
<div
+id a3
+class ln
"csel w12, w10, w11, ne
>
"\n\s\s\s\s\s\s
<div
+id a4
+class ln
"ret
>
"\n\s\s\s\s\s\s
<div
+class ns
<b
>
" ns per call
>
"\n\s\s\s\s
>
"\n\s\s
>
.h1 name pixel
"A0
>
.p tag pixel
"for AI
>
>
}
{sec_intro
.div center
=h2 Native speed. Verified edits. Every target.
=p A model writes A0 directly. Nothing invalid lands. One source runs on every target, checked against one oracle.
>
.div trio
.div tcard native reveal
.div k
"Native
>
.div t pixel
"Machine code
>
.div big pixel
"$py_geomean$x
>
.p d
"faster than Python, $js_geomean$x faster than JavaScript, measured against $n_langs$ languages. Machine code from A0's own code generator.
>
>
.div tcard edits reveal
.div k
"Edits
>
.div t pixel
"Made by models
>
.div big pixel
"$cmax_ratio$x
>
.p d
"fewer tokens per edit than TypeScript in a 4000-function program, $cmax_acc$% accepted (Sonnet). On a one-function file A0 costs more.
>
>
.div tcard hw reveal
.div k
"Hardware
>
.div t pixel
"Gates and cycles
>
.div big pixel
"70%
>
.p d
"fewer gates for the same programs, proved equivalent with Z3.
>
>
>
}
{sec_rail
.div layout
.nav rail
.div rh
"Benchmarks
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
.div rh
"More
>
<a
+href #targets
"Targets
>
<a
+href #developers
"Developers
>
>
<div
+id benchmarks
+class main
}
{sec_native
<section
+id native
=h2 Native speed
<p
"No runtime, no garbage collector.\s
=strong $c_ratio$x
" the time of hand-written C across $n_k$ kernels, from A0's own AArch64 code generator; no C compiler is involved.
>
}
{rank_table
.div chart reveal
.p ct
"A0's rank on each kernel, among all $n_langs1$ languages
>
.p sub
"Time per call, lower is better. Median of 7 interleaved runs; every result checksum-verified.
>
.p cov mono{cov_langs_part| part}
"measured: $cov_langs$ of $n_all$ languages
>
.div tblwrap
.table ops rank
<tr
=th kernel
=th A0 rank
=th fastest other
=th A0 vs fastest other
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
=td $rk_best$ ($rk_bv$ ns)
.td mono {rk_win|first|behind}
n a mov $rk_ratio$
c putratio %a
"x
>
>
]
>
>
.p cap
"A0 is machine code from A0's own AArch64 code generator. At 1.00x or below A0 is fastest; above, the gap to close.
>
>
}
{endsec$k$
>
}
{sec_langs
<section
+id languages
=h2 Against $n_langs$ languages
<p
"The same ten kernels, hand-written in $n_langs$ languages, every result checksum-verified before it is timed. Time per call relative to native A0, geometric mean.\s
=strong $n_ties$ tie A0 within 5%
", $n_ahead$ are faster today{ahead| ($ahead$; closing that gap is the current compiler work)}, and the rest are slower.
>
}
{chart_langs
.div chart langs reveal
.p ct
"Time per call relative to native A0, lower is better
>
.p sub
"Bar length is logarithmic in the ratio; 1.00x is parity with A0. Interleaved runs, medians; JIT rows warm; interpreters at their own iteration tier.
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
.p cap
"A0 here is machine code from A0's own AArch64 code generator, no C compiler in between. Numbers, toolchains, and iteration tiers are in results/exec-benchmark.json.
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
<p
=strong $start_a0$ ms
" from launch to first result. Node takes $start_node$ ms and Python $start_py$ ms. Build: $a0_build$ ms for ten kernels, $rs_build$ ms with rustc.
>
}
{chart_start
.div chart langs reveal
.p ct
"Milliseconds from launch to first result, $n_starts$ languages
>
.p sub
"Lower is better; bar length is logarithmic. A0 is number $start_rank$. One process launch running one iteration; JVM and .NET rows include their runtime start.
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
.p cap
"The A0 binary for startup is the C-path build; startup of the direct AArch64 binary is not yet measured.
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
<p
"A model reads one function and its callees, not the file.\s
=strong 7.3x fewer tokens read
" per edit; the reply is 9 tokens where a unified diff is 79.
>
}
{chart1
.div chart single reveal
.p ct
"Tokens read to edit one function
>
.p sub
"Life, 17 functions, o200k tokenizer. Lower is better.
>
.div legend
.span lc
"whole program
>
.span la0
"A0 scoped view
>
>
.div row
.span lbl
"life.a0
>
.div bars
n a mov 1746
n b mov 239
n m call max2 %a %b
.div track c
c fill %a %m
.span val
c putnum %a
" tok
>
>
.div track a0
c fill %b %m
.span val
c putnum %b
" tok
>
>
>
n r mul %a 100
n q div %r %b
.span ratio win
c putratio %q
"x fewer
>
>
.p cap
"The view: one function, its callees' signatures, one handle.
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
<p
"A model edits one function through a scoped view: the function, the signatures it depends on, and its callers. The view stays the same size as the program grows; a numbered whole file does not. At 4000 functions an A0 edit costs\s
<strong
n a mov $cmax_a0$
c putnum %a
" tokens
>
" against\s
<strong
n a mov $cmax_ts$
c putnum %a
>
" for TypeScript ($cmax_ratio$x), cache-adjusted, Sonnet. On a one-function file the primer dominates and A0 is\s
<strong
n a mov $cmin_100$
c putfix %a
"x
>
" the cost of TypeScript: a loss, shown in the first row below.
>
}
{chart2
.div chart reveal
.p ct
"Tokens per edit by program size, Sonnet
>
.p sub
"Cache-adjusted; lower is better. Ratio is TypeScript over A0: below 1 A0 costs more.
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
"x vs TS
>
>
]
.p cap
"Bars are linear within each row. The per-size charts below add every other measured language.
>
>
}
[csz
{cost_$cz_size$
.div chart langs reveal
.p ct
"$cz_size$ function{cz_many|s}: tokens per edit, $cz_n$ languages{cz_loss| (the loss)}
>
.p sub
"Sonnet, cache-adjusted, lower is better; bar length is logarithmic. Languages not listed were not measured at this size.
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
.table ops rank
<tr
=th language
=th primer
=th code read
=th write
=th total
=th vs A0
=th Sonnet
=th Haiku
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
"Primer: language and workflow instructions, first read at the 1.25x cache-write rate. Code read: the view or numbered file. Write: the reply. vs A0 is the row total over A0; below 1.00x (red) that language is cheaper. Sonnet and Haiku columns: accepted by the tests, one shot, 12 tasks each.
>
>
}
]
.p cap
"Tasks are the same edits in every language; sets 400 and 4000 are one shared program grown to that size. Subjects are fresh Sonnet and Haiku contexts that see only the primer. Numbers: results/ai-edit-experiment.\{b,c,c400,c4000\}.*.json.
>
{endsec$k$
>
}
{sec_val
<section
+id validation
=h2 Validation
<p
"After a reply arrives, the edit must be applied and the whole program known to type-check. For A0 that is\s
=strong $el_a0$ ms
" at the median; TypeScript with a warm compiler takes $el_tsw$ ms.
>
}
{chart_val
.div chart langs reveal
.p ct
"Milliseconds from reply received to program type-checked, median per edit
>
.p sub
"The accepted set-C Sonnet edits on the 40-function program; lower is better; bar length is logarithmic. Go uses hand translations of the reference edits.
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
"{el_loaded|Measured on a loaded machine (load average up to $el_load$ on 8 cores); absolute times will move on a quiet run, which will replace these. }Cold rows start the compiler per edit; warm rows reuse a running one. Python is not measured (no mypy on the machine). results/edit-loop{el_quiet|.quiet}.json.
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
<p
"A fold whose step is an associative reduction can be split across cores without changing its result.\s
=strong a0 emit c --parallel
" does that from a cost model; every result is checked exact against serial A0 and the reference interpreter.
>
}
{chart_par
.div chart langs reveal
.p ct
"Time per call relative to A0 --parallel, per kernel
>
.p sub
"Lower is faster; below 1.00x (red) that implementation beats A0. Bar length is logarithmic. $par_cpus$ cores, median of $par_samples$ interleaved samples.
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
"{par_loaded|Measured on a loaded machine (load average up to $par_load$ on $par_cpus$ cores when timing started); ratios are interleaved, absolute times will move on a quiet run. }Hand-parallel C is OpenMP parallel-for with a reduction. A0 is behind on $par_losses$. On the 64K-element kernels the cost model keeps A0 serial. results/parallel.json.
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
<p
"The same programs compile to clocked SystemVerilog. A 32-cycle divider took the 48 corpus modules from\s
=strong 260,146 to 78,835 cells
".
>
}
{chart3
.div chart single reveal
.p ct
"Synthesized cells, Yosys generic
>
.p sub
"Lower is better.
>
.div legend
.span lc
"single-cycle divide
>
.span la0
"clocked divider
>
>
.div row
.span lbl
"all 48 modules
>
.div bars
n a mov 260146
n b mov 78835
n m call max2 %a %b
.div track c
c fill %a %m
.span val
c putnum %a
" cells
>
>
.div track a0
c fill %b %m
.span val
c putnum %b
" cells
>
>
>
n r mul %a 100
n q div %r %b
.span ratio win
c putratio %q
"x smaller
>
>
.div row
.span lbl
"largest module
>
.div bars
n a mov 104460
n b mov 1175
n m call max2 %a %b
.div track c
c fill %a %m
.span val
c putnum %a
" cells
>
>
.div track a0
c fill %b %m
.span val
c putnum %b
" cells
>
>
>
n r mul %a 100
n q div %r %b
.span ratio win
c putratio %q
"x smaller
>
>
.p cap
"Simulated on the oracle cases; optimizer proved equivalent with Z3.
>
>
}
{endsec$k$
>
}
{sec_targets
<section
+id targets
=h2 Targets
=p One source, 5262 oracle cases, every target.
.div grid four
.div card reveal
=h3 AArch64
=p A0's own code generator, no C in between
>
.div card reveal
=h3 x86-64
=p A0's own code generator, verified under Rosetta
>
.div card reveal
=h3 RISC-V, ARM32, AVR
=p A0's own code generators for 64-bit RISC-V, 32-bit ARM, and 8-bit AVR
>
.div card reveal
=h3 wasm32
=p A0's own wasm backend, or the C path through Clang: this site
>
.div card reveal
=h3 Native C
=p through clang or gcc, UBSan-clean, parity with hand-written C; --parallel for threads
>
.div card reveal
=h3 JavaScript
=p typed arrays, in-place updates, boundary guards only
>
.div card reveal
=h3 JVM
=p Java source, compiled and verified with javac
>
.div card reveal
=h3 .NET
=p C# source, verified on .NET 10
>
.div card reveal
=h3 GPU
=p Metal Shading Language kernels, verified on Apple silicon
>
.div card reveal
=h3 FPGA / ASIC
=p clocked SystemVerilog, simulated and synthesized
>
>
>
}
{sec_dev
<section
+id developers
=h2 Developers
.div grid two
.div card reveal
=h3 How big is the runtime?
=p There is none. A native binary of the ten benchmark kernels is about $bin_kb$ KB including its driver; the wasm behind this page is under a megabyte.
>
.div card reveal
=h3 What happens when a model makes a mistake?
=p The edit is rejected before it lands, with a stable code (parse, type, structure, handle, revision), what was expected, what was seen, and the one fix that resolves it.
>
.div card reveal
=h3 Can a wrong program run forever?
=p Literal iteration counts are bounded statically. Variable counts are bounded by fuel in the reference interpreter; compiled targets have no execution budget, so a variable count runs as long as it says. io output is bounded by the caller's buffer, and there is no heap or recursion.
>
.div card reveal
=h3 How is correctness checked?
=p A BigInt oracle runs 5262 generated cases through every backend, Z3 proves the optimizer equivalent to the source on all 48 corpus functions, and hardware is simulated and synthesized.
>
>
=h3 Not yet
.div limits
=p No floating point, no heap, no recursion. Token cost above TypeScript on single-function tasks. AArch64 backend up to 1.4x behind clang on array and loop kernels. Emitted JavaScript slower than hand-written.
>
=h3 Try it
.pre code
<code
.span cm
"# one binary, no package manager\n
>
"curl -L https://github.com/Joe-Simo/a0/releases/latest/download/a0-darwin-arm64 -o a0 && chmod +x a0\n
"printf 'fn sq u32 -> u32\\na mul p0 p0\\nret a\\nend\\n' > sq.a0\n
"./a0 run sq.a0 sq 12          # 144\n
"./a0 emit arm64 sq.a0         # A0's own machine code; or x86_64, c, js, java, sv\n
"./a0 check sq.a0              # diagnostics with the fix
>
>
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
