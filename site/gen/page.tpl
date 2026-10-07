# The a0lang.com home page (site/page.a0), as a template of the site generator (site/gen/sitegen.a0,
# where the template language is described). Every number comes from the results files below. The benchmarks are on bench.tpl.
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
m top Rust
m top TypeScript
m top Go
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
s 9 css 36000
}
c nav
{sec_hero
<section
+id top
+class hero
.div stage
s 13 glsl
>
.h1 name pixel
"A0
>
.p tag pixel
"for AI
>
>
}
{sec_pitch
.div center
=h2 A small language AI models can edit without breaking your build.
=p A0 is a compact language with exact rules. A model reads only the functions an edit touches, and an edit that would not compile is rejected before it lands.
>
<div
+class layout
+id content
<div
+class main
}
{sec_sample
<section
+id start
.pre code
<code
"fn affine u32 u32 u32 -> u32\n
"a mul p0 p1\n
"b add a p2\n
"ret b\n
"end\n
.span cm
"\$\sa0 run examples/kernels.a0 affine 3 4 5\n
>
"17
>
>
<p
.a pill
+href #try
"Install
>
"\s
.a pill ghost
+href /benchmarks
"Benchmarks, including where A0 loses
>
>
=p MIT license, free for any use. Copyright 2026 Joe Simo. Not for floating point, heap-heavy or recursive code: A0 has none of the three.
>
}
{sec_fast
<section
+id fast
=h2 Is it as fast as C?
.p take
"On an Apple M3, A0's machine code takes $c_ratio$x as long as hand-written C, a geometric mean over the test programs. It loses on $bk_nloss$ of $bk_n$: slower than the best of C, Rust and Zig, the worst by $bk_slow$x on $bk_slowk$ (results/exec-benchmark-full.json).
>
.div chart langs reveal
+role group
+aria-labelledby chart-1
.p ct
+id chart-1
"How long each language takes, as a multiple of A0's time
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
>
>
}
{sec_edit
<section
+id edit
=h2 How much does an edit cost?
.p take
"Over a session of 10 edits A0 costs $ec_c_t10$ tokens per task in its canonical form and $ec_d_t10$ in its dense form (place $ec_cr10$ and $ec_dr10$ of $n_langs1$ languages, 1 = fewest). On a one-function file it costs $cmin_100$x TypeScript's tokens, because the instructions dominate (results/ai-edit-b48-dense.json, results/ai-edit-experiment.b.sonnet-min.json).
>
.div chart langs reveal
+role group
+aria-labelledby chart-2
.p ct
+id chart-2
"Tokens per task, session of 10 edits
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
>
>
}
{sec_check
<section
+id check
=h2 How quickly do I know an edit is wrong?
.p take
"A0 applies a model's edit and type-checks the whole program in $el_a0$ ms at the median. TypeScript with a warm compiler takes $el_tsw$ ms (results/edit-loop.json).
>
.div chart langs reveal
+role group
+aria-labelledby chart-3
.p ct
+id chart-3
"Milliseconds from a model's reply to a type-checked program
>
[el el_a0row
.div lrow wide me
.span lbl
"$el_label$
>
.div track a0
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
>
>
}
{sec_targets
<section
+id targets
=h2 What does one source compile to?
.div legend
.span lnat
"machine code
>
.span lnat
"C
>
.span lnat
"wasm
>
.span lnat
"JavaScript
>
.span lnat
"JVM
>
.span lnat
".NET
>
.span lnat
"Metal
>
.span lnat
"SystemVerilog
>
>
.p take
"$vr_full$ test cases ran on $vr_nfull$ paths. The native assembly targets ran the $vr_part$ that need no input or output, and SystemVerilog is simulated separately on $hw_cases$ (results/verification.json).
>
>
}
{sec_try
<section
+id try
=h2 Try it
.pre code
<code
.span cm
"# one binary, no package manager\n
>
"# macOS and Linux: pick the binary for your machine, a0-darwin-arm64, a0-darwin-x64, a0-linux-arm64 or a0-linux-x64\n
"curl -L https://github.com/Joe-Simo/a0/releases/latest/download/a0-linux-x64 -o a0 && chmod +x a0\n
"# Windows, PowerShell: a0-windows-x64.exe, then use .\\a0.exe where this page says ./a0\n
"Invoke-WebRequest https://github.com/Joe-Simo/a0/releases/latest/download/a0-windows-x64.exe -OutFile a0.exe\n
"printf 'fn sq u32 -> u32\\na mul p0 p0\\nret a\\nend\\n' > sq.a0\n
"./a0 run sq.a0 sq 12          # 144\n
"./a0 emit arm64 sq.a0         # A0's own machine code; or x86_64, c, js, java, sv\n
"./a0 check sq.a0              # diagnostics with the fix
>
>
>
}
{sec_terms
<section
+id terms
=h2 Words used here
<p
=strong Test case:
"\sone input with its known correct output.
>
<p
=strong Oracle:
"\sa separate, simple calculator (plain BigInt arithmetic) whose answers every target must match.
>
<p
=strong Target:
"\swhat A0 compiles to: machine code, C, wasm, JavaScript, JVM, .NET, Metal, SystemVerilog.
>
<p
=strong Handle:
"\sa revision token. An edit that names an old handle is refused, so a stale edit cannot overwrite newer code.
>
<p
=strong View:
"\sthe text a model is shown. A scoped view holds one function plus the signatures it calls.
>
<p
=strong Dense view:
# claim-ok: a definition of the dense form, not a measured comparison; the token counts are in results/dense-tokens.json
"\san optional shorter spelling of the same program, with fewer tokens.
>
<p
=strong Test program:
"\sone small function written in every language and timed.
>
<p
=strong Generic cell:
"\sa basic logic gate or register in the hardware output, before mapping to any chip.
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
