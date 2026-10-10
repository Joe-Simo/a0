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
# The languages each home chart shows (A0's rows always show); the benchmarks page has them all.
m top A0
m top C
m top C++
m top Rust
m top Zig
m top Go
m top Java
m top C#
m top TypeScript
m top JavaScript
m top Python
m top Ruby
m top OCaml
m top PHP
m top Forth
m top Lua
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
# The hero: statement, install line (one pane per shell; the runtime's `.switch` hook shows one at a
# time, both without JS) over the code rain (the runtime turns `.rain` into a canvas; its text is the
# words that fall), and the measured charts, one tab each (the same `.switch` hook).
{sec_hero
<div
+class home
<div
+id content
<section
+id top
+class hero first
.div rain
+aria-hidden true
"fn let match ret u32 end check A0
>
.div wrap
.div hcopy
.a badge
+href /benchmarks
<b
"MEASURED
>
"\sEvery number links to its results file
>
=h1 A typed language AI edits one function at a time.
.p lede
"A model changes one function; A0 checks it against the whole program and compiles to C, native arm64 and WebAssembly.
>
.div switch
.div install pane on
<code
.span pr
">
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
.div install pane
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
+aria-label Operating system
<button
+type button
"macOS & Linux
>
<button
+type button
"Windows
>
>
>
.div row
<a
+href https://github.com/Joe-Simo/a0/blob/main/install.sh
"View install script
>
<a
+href /docs/#quickstart
"Then follow the quick start
>
>
>
}
{sec_hero1
.div panel switch tab
.div os
+role group
+aria-label Chart
<button
+type button
"Edit cost
>
<button
+type button
"Tokens
>
<button
+type button
"Speed
>
>
}
{sec_edit
.div pane chart on
.h3 ct
"One AI edit, start to accepted
>
.p sub
"Tokens per task · Haiku and Sonnet pooled · $ec_c_n$ tasks a language · lower is better
>
.div bars
[etrows et_top
.div brow{et_me| me}
.span lbl
"$et_label$
>
.div track $et_cls$
.div fill
w 12
w 1
w $et_pct$
>
>
.span val
"$et_val$
>
>
]
>
.p alt
"A0 dense, lean view (not shipped):\s
.span mono
"$et_dv$
>
>
.p verdict
"{et_win|+ Fewest tokens of $etrows$ languages: A0 $et_a0$|A0: $et_a0$, place $et_rank$ of $etrows$}
>
<ul
+class losses
<li
"− Session of 10 edits: place $ec_cr10$ of $n_langs1$
>
>
.p src
"Source:\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/ai-edit-b48-dense.json
"results/ai-edit-b48-dense.json
>
"\s·\s
<a
+href /benchmarks#cost
"method →
>
>
>
}
{sec_hero2
.div pane chart
.h3 ct
"The same $tk_nk$ programs, written by hand
>
.p sub
"o200k tokens · sum over the programs · lower is better
>
.div bars
[tkrows tk_top
.div brow{tk_me| me}
.span lbl
"$tk_label$
>
.div track $tk_cls$
.div fill
w 12
w 1
w $tk_pct$
>
>
.span val
"$tk_val$
>
>
]
>
.p verdict
"{tk_dwin|+ A0 dense: $tk_dv$ against Forth $tk_forth$|A0 dense: $tk_dv$, place $tk_dr$}
>
<ul
+class losses
<li
"− A0 canonical: $tk_cv$, place $tk_cr$ of $n_langs1$
>
>
.p src
"Source:\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/lang-axes.json
"results/lang-axes.json
>
"\s·\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/dense-tokens.json
"results/dense-tokens.json
>
"\s·\s
<a
+href /benchmarks#tokens
"method →
>
>
>
}
{sec_hero3
.div pane chart
.h3 ct
"Small programs, compiled
>
.p sub
# claim-ok: axis note of the chart; every value is a variable from results/exec-benchmark-full.json
"Time per call as a multiple of A0's · geometric mean · log scale · shorter is faster
>
.div bars
[langs lg_top
.div brow{lg_me| me}
.span lbl
"$lg_label$
>
.div track $lg_cls$
.div fill
w 12
w 1
w $lg_pct$
>
>
.span val
n a mov $lg_g100$
c putratio %a
"x
>
>
]
>
.p verdict
"$n_ties$ of $n_langs$ languages within 5% of A0; $n_ahead$ faster
>
<ul
+class losses
<li
"− Slower than the best of C, Rust and Zig on $bk_nloss$ of $bk_n$ programs, worst $bk_slow$x ($bk_slowk$)
>
>
.p src
"Source:\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/exec-benchmark-full.json
"results/exec-benchmark-full.json
>
"\s·\s
<a
+href /benchmarks#native
"method →
>
>
>
>
>
>
}
{sec_what
<section
+id what
.div wrap
.p eyebrow
"01 / What A0 is
>
=h2 A typed language built for model edits.
.div grid
.div card
.span tag
"Language
>
=h3 Typed, explicit, short
=p Every function states its types. One operation per line.
.div cmd
"a0 check sq.a0
>
>
.div card
.span tag
"Edits
>
=h3 One function, checked
=p A patch replaces one function; A0 re-validates the program or rejects the patch with a diagnostic.
.div cmd
"a0 patch sq.a0 edit.patch
>
>
.div card
.span tag
"Targets
>
=h3 C, arm64, WebAssembly
=p One front end; the same behaviour table runs on every target.
.div cmd
"a0 emit arm64 sq.a0
>
>
.div card
.span tag
"Agents
>
=h3 MCP server
=p Models read, edit and check A0 through tools instead of raw text.
.div cmd
"a0 mcp .
>
>
>
>
>
}
{sec_minute
<section
+id minute
.div wrap
.p eyebrow
"02 / A minute with A0
>
=h2 From install to a checked edit.
.ul steps
<li
.div cmd
"printf 'fn sq u32 -> u32\\na mul p0 p0\\nret a\\nend\\n' > sq.a0
>
=p One typed function.
>
<li
.div cmd
"a0 run sq.a0 sq 12
>
=p Prints the square.
>
<li
.div cmd
"a0 check sq.a0
>
<p
"Reports type and bounds errors.\s
.span mono
"--fix
>
"\sapplies the exact fixes.
>
>
<li
.div cmd
"a0 emit arm64 sq.a0
>
=p A0's own machine code; also c, js, java, sv.
>
<li
.div cmd
"a0 mcp .
>
=p Serves the folder to an agent over MCP.
>
>
<p
+class small mute
"Full list in\s
<a
+href /docs/#cli
"the CLI reference
>
".
>
>
>
}
{sec_vs
<section
+id against
.div wrap
.p eyebrow
"03 / Against other languages
>
=h2 Edit cost and speed against other languages.
<p
+class lede
"Full tables and methods on\s
<a
+href /benchmarks
"Benchmarks
>
".
>
.div grid two
.div panel chart
.h3 ct
"The same $tk_nk$ programs, written by hand
>
.p sub
"o200k tokens · sum over the programs · lower is better
>
.div bars
[tkrows tk_top
.div brow{tk_me| me}
.span lbl
"$tk_label$
>
.div track $tk_cls$
.div fill
w 12
w 1
w $tk_pct$
>
>
.span val
"$tk_val$
>
>
]
>
.p verdict
"{tk_dwin|+ A0 dense: $tk_dv$ against Forth $tk_forth$|A0 dense: $tk_dv$, place $tk_dr$}
>
<ul
+class losses
<li
"− A0 canonical: $tk_cv$, place $tk_cr$ of $n_langs1$
>
>
.p src
"Source:\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/lang-axes.json
"results/lang-axes.json
>
"\s·\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/dense-tokens.json
"results/dense-tokens.json
>
"\s·\s
<a
+href /benchmarks#tokens
"method →
>
>
>
}
{sec_vs2
.div panel chart
.h3 ct
"Small programs, compiled
>
.p sub
# claim-ok: axis note of the chart; every value is a variable from results/exec-benchmark-full.json
"Time per call as a multiple of A0's · geometric mean · log scale · shorter is faster
>
.div bars
[langs lg_top
.div brow{lg_me| me}
.span lbl
"$lg_label$
>
.div track $lg_cls$
.div fill
w 12
w 1
w $lg_pct$
>
>
.span val
n a mov $lg_g100$
c putratio %a
"x
>
>
]
>
.p verdict
"$n_ties$ of $n_langs$ languages within 5% of A0; $n_ahead$ faster
>
<ul
+class losses
<li
"− Slower than the best of C, Rust and Zig on $bk_nloss$ of $bk_n$ programs, worst $bk_slow$x ($bk_slowk$)
>
>
.p src
"Source:\s
<a
+href https://github.com/Joe-Simo/a0/blob/main/results/exec-benchmark-full.json
"results/exec-benchmark-full.json
>
"\s·\s
<a
+href /benchmarks#native
"method →
>
>
>
>
>
>
}
{sec_limits
<section
+id limits
.div wrap
.p eyebrow
"04 / Where A0 loses
>
=h2 Measured losses.
.div tblwrap
+tabindex 0
+role group
+aria-label Table, scrolls sideways
<table
+class loss
<tr
=th Loss
=th Measured
=th Source
>
<tr
=td Native speed against the best of C, Rust and Zig
.td mono
"slower on $bk_nloss$ of $bk_n$ programs, worst $bk_slow$x
>
.td mono small
"exec-benchmark-full.json
>
>
<tr
=td Sessions of 10 AI edits
.td mono
"place $ec_cr10$ of $n_langs1$
>
.td mono small
"ai-edit-b48-dense.json
>
>
<tr
=td Canonical source size
.td mono
"$tk_cv$ tokens, place $tk_cr$ of $n_langs1$
>
.td mono small
"lang-axes.json
>
>
<tr
=td What the language lacks
.td mono
"floats, heap, recursion
>
.td mono small
"STATUS.md
>
>
>
>
>
>
}
{sec_end
<section
+id install
.div wrap
.p eyebrow
"05 / Install
>
=h2 Install
.div install
<code
.span pr
">
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
.div row
.a btn
+href /docs/#quickstart
"Quick start
>
<a
+href https://github.com/Joe-Simo/a0
"Source on GitHub ↗
>
>
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
