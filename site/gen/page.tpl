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
s 9 css 36000 45000
}
{css_f
s 9 css 45000
}
c nav
{sec_hero
<div
+class home
<section
+id top
+class hero
.div stage
s 13 glsl
>
>
<div
+class layout
+id content
<div
+class main
<section
+id intro
+class intro
=h1 A0 is a small language for code an AI agent edits one function at a time, each edit checked before it lands; it has no floats, heap or recursion, so use C, Rust or TypeScript for those.
=p Slower than the best of C, Rust and Zig on $bk_nloss$ of $bk_n$ test programs. On a one-function file it costs $cmin_100$x TypeScript's tokens.
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
.p ctas
.a pill
+href #install
^curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
"Install A0
>
"\s
.a pill ghost
+href #connect
"Connect your agent
>
>
>
}
{sec_install
<section
+id install
=h2 Install and connect
=p A0 is one binary with no package manager. Install it, then connect your agent.
.small cmdlabel
"macOS and Linux
>
.div cmd
.pre code
<code
"curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
>
>
<button
+type button
+class copy
+aria-label Copy the macOS and Linux install command
^curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
"Copy
>
>
.small cmdlabel
"Windows, PowerShell
>
.div cmd
.pre code
<code
"irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 \| iex
>
>
<button
+type button
+class copy
+aria-label Copy the Windows install command
^irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 \| iex
"Copy
>
>
<div
+id connect
<h3
"Connect your agent
>
=p Claude Code: add the a0 MCP server with this one line. The a0 binary must be on PATH.
.div cmd
.pre code
<code
"claude mcp add a0 -- a0 mcp .
>
>
<button
+type button
+class copy
+aria-label Copy the Claude Code command
^claude mcp add a0 -- a0 mcp .
"Copy
>
>
>
=p Targets: machine code, C, wasm, JavaScript, JVM, .NET, Metal and SystemVerilog. $vr_full$ test cases ran on $vr_nfull$ paths. The native assembly targets ran the $vr_part$ that need no input or output, and SystemVerilog is simulated separately on $hw_cases$ (results/verification.json).
=p MIT license, free for any use. Copyright 2026 Joe Simo.
<p
"Works? Then see where A0 loses:\s
<a
+href #fast
"Where A0 is slower than C
>
>
>
}
{sec_fast
<section
+id fast
=h2 Where A0 is slower than C
.p take
"A0 is slower than the best of C, Rust and Zig on $bk_nloss$ of $bk_n$ test programs, by up to $bk_slow$x on $bk_slowk$. Over all of them its machine code takes $c_ratio$x as long as hand-written C, a geometric mean (on an Apple M3; results/exec-benchmark-full.json).
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
<p
"Speed is not the point; edits are.\s
<a
+href #edit
"What does an edit cost?
>
>
>
}
{sec_edit
<section
+id edit
=h2 How much does an edit cost?
.p take
"On a one-function file A0 costs $cmin_100$x TypeScript's tokens, because the instructions dominate. Over a session of 10 edits it costs $ec_c_t10$ tokens per task in its canonical form and $ec_d_t10$ in its dense form (place $ec_cr10$ and $ec_dr10$ of $n_langs1$ languages, 1 = fewest); results/ai-edit-b48-dense.json and results/ai-edit-experiment.b.sonnet-min.json.
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
<p
"Cheap only if it is also caught:\s
<a
+href #check
"How quickly do I know an edit is wrong?
>
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
<p
"Every number here is read from a file in results/.\s
<a
+href /benchmarks
"The benchmarks page shows the method and the losses.
>
>
>
}
{sec_close
>
>
>
}
c foot
w 6
w 0
2
2ret event
2end
