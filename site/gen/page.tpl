# The a0lang.com home page (site/page.a0), as a template of the site generator (site/gen/sitegen.a0,
# where the template language is described). Every number comes from the results files below. The benchmarks are on bench.tpl.
f tags site/gen/tags.tpl
f css site/gen/style.css
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
s 9 css 45000 54000
}
{css_g
s 9 css 54000
}
c nav
# The hero: statement, install line (one pane per shell; the runtime's `.switch` hook shows one at a
# time, both without JS), and an agent edit typed into a terminal over the code rain. The runtime
# turns `.rain` into a canvas (its text is the words that fall) and replays `.typing` (each `.beat`
# span lands whole after a pause); without JS the terminal shows its final state.
{sec_hero
<div
+class home
<div
+id content
+class hwrap
<section
+id top
+class hhero
.div rain
+aria-hidden true
"fn add mul ret u32 end
>
.div hfade
>
.div hcopy
=h1 A language for agents to edit.
.p lead
"A small typed language your agent edits one function at a time. Every edit is type-checked before it reaches the file.
>
.div switch
.div hcmd pane on
<code
.span pr
"\$
>
"\scurl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
>
<button
+type button
+class copy
+aria-label Copy the macOS and Linux install command
^curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
"Copy
>
>
.div hcmd pane
<code
.span pr
"PS>
>
"\sirm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 \| iex
>
<button
+type button
+class copy
+aria-label Copy the Windows install command
^irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 \| iex
"Copy
>
>
.div os
+role group
+aria-label Shell
<button
+type button
"macOS / Linux
>
<button
+type button
"Windows
>
>
>
.p connect
+id connect
"Then connect your agent:\s
<code
"claude mcp add a0 -- a0 mcp .
>
>
>
.div hside
.div hterm
+role group
+aria-label An agent edit being checked
.div bar
<span
"kernels.a0
>
.span tstat
"checked
>
>
.pre typing
.span c-m
"agent\s\sedit_function affine\n
>
"fn affine u32 u32 u32 -> u32\n\s\sa mul p0 p1\n\s\sb add a p3\n\s\sret b\nend\n
.span c-r beat
"✕ refused\s\sp3: affine takes 3 parameters\n\s\sfile unchanged\n\n
>
.span c-m
"agent\s\sedit_function affine\n
>
"fn affine u32 u32 u32 -> u32\n\s\sa mul p0 p1\n\s\sb add a p2\n\s\sret b\nend\n
.span c-g beat
"✓ checked\s\swritten to kernels.a0\n\n
>
.span c-m
"\$ a0 run examples/kernels.a0 affine 3 4 5\n
>
"17\n
>
>
>
>
}
# Kernel source tokens (o200k) of the $tk_nk$ token programs: A0's dense form from results/dense-tokens.json,
# the languages' sumKernelTokens from results/lang-axes.json; bars are a share of the longest shown (Rust).
{sec_tokens
<section
+id tokens
+class hsec reveal
<div
=h2 $tk_dv$ tokens. Forth takes $tk_forth$.
.p body
"The same $tk_nk$ programs written in $tk_nl$ languages. Forth is the shortest after A0.
>
.span src
"results/lang-axes.json, results/dense-tokens.json
>
>
.div hbars
+role group
+aria-label Source tokens of the same programs
.div hrow a0
.span lbl
"A0
>
.div htrack
n a mov $tk_dv$
n m mov $tk_rs$
c fill %a %m
>
.span n
"$tk_dv$
>
>
.div hrow
.span lbl
"Forth
>
.div htrack
n a mov $tk_forth$
n m mov $tk_rs$
c fill %a %m
>
.span n
"$tk_forth$
>
>
.div hrow
.span lbl
"Python
>
.div htrack
n a mov $tk_py$
n m mov $tk_rs$
c fill %a %m
>
.span n
"$tk_py$
>
>
.div hrow
.span lbl
"TypeScript
>
.div htrack
n a mov $tk_ts$
n m mov $tk_rs$
c fill %a %m
>
.span n
"$tk_ts$
>
>
.div hrow
.span lbl
"Rust
>
.div htrack
n a mov $tk_rs$
n m mov $tk_rs$
c fill %a %m
>
.span n
"$tk_rs$
>
>
>
>
}
{sec_how
<section
+id how
+class reveal
.div head
=h2 How it works.
>
.div how
<div
.span k
"01
>
=h3 The agent asks for one function.
=pre edit_function affine
>
<div
.span k
"02
>
=h3 A0 type-checks the edit.
<pre
"b add a p3\n
.span c-r
"✕ affine takes 3 parameters
>
>
>
<div
.span k
"03
>
=h3 The file changes only if it passes.
<pre
.span c-g
"✓ written to kernels.a0
>
>
>
>
>
}
{sec_limits
<section
+id limits
+class reveal
.div head
=h2 Where it loses.
>
.div limits
<div
<p
"Slower than the best of C, Rust and Zig on\s
<strong
"$bk_nloss$ of $bk_n$ programs
>
".
>
.span src
"results/exec-benchmark-full.json
>
>
>
.p nofit
"Unsigned integers, booleans and fixed arrays. No floats, heap or recursion; for those, use C, Rust or TypeScript.
>
>
}
{sec_end
<section
+id install
+class hend reveal
=h2 Install A0.
.div hcmd
<code
.span pr
"\$
>
"\scurl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
>
<button
+type button
+class copy
+aria-label Copy the install command
^curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
"Copy
>
>
.p connect
"Then connect your agent:\s
<code
"claude mcp add a0 -- a0 mcp .
>
>
.a gh
+href https://github.com/Joe-Simo/a0
"github.com/Joe-Simo/a0 ›
>
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
