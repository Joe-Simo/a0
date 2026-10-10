# The a0lang.com reference (site/docs.a0), as a template of the site generator (site/gen/sitegen.a0,
# where the template language is described).
f tags site/gen/tags.tpl
f css site/gen/style.css
f primer MODEL_GUIDE.min.txt
1# a0lang.com/docs, authored in A0. Same protocol and runtime as page.a0 (see ui.a0).
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
{sec_head
.div docs
<section
+id top
+class hero
.h1 name pixel
"Docs
>
>
<div
+class layout
+id content
.nav rail
+aria-label On this page
.details toc
<summary
"On this page
>
.div rh
"Start
>
<a
+href #quickstart
"Quick start
>
<a
+href #primer
"The primer
>
.div rh
"The language
>
<a
+href #programs
"Programs and functions
>
<a
+href #types
"Types and values
>
<a
+href #iteration
"Iteration
>
<a
+href #modules
"Modules
>
.div rh
"Editing with a model
>
<a
+href #editing
"Views and edits
>
<a
+href #diagnostics
"Diagnostics
>
.div rh
"Reference
>
<a
+href #operations
"Operations
>
<a
+href #bounds
"Bounds and safety
>
<a
+href #cli
"Targets and CLI
>
>
>
.div main
<section
+id quickstart
=h2 Quick start
=p A0 is a small language written by AI models, one operation per line, with exact integer arithmetic. A model edits a function through a view and a short reply instead of rewriting the file.
=h3 1. Install
.pre code
<code
"brew install a0\n
"curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh \| sh
>
>
=h3 2. Write and run
.pre code
<code
.span cm
"# hello.a0: compute p0 * p1 + p2\n
>
"fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend\n\n
.span cm
"# a0 run hello.a0 affine 6 7 1\n
>
"43
>
>
=h3 3. Edit it
<p
"Ask for a view with\s
=code a0 view hello.a0 affine
"; it prints the function under a handle (e0) with its revision. Reply with the handle, then edits, one per line:
>
.pre code
<code
"id op args           replace instruction id, or insert it before ret\n
"id op args @ x       insert after instruction x\n
"-id                  delete instruction id\n
"ret x                change the result\n
"fn ... end           add or replace a whole function (program handle g0)\n
"-fn name             remove a function
>
>
=p The edit is applied only if it parses, type-checks and was written against the current revision. Otherwise it is rejected with a code and the one fix that resolves it, and the handle stays valid.
=h3 4. Connect an agent
<p
=code a0 mcp .
"\sserves A0 to an agent over stdio with seven tools: a0_open, a0_program, a0_apply, a0_check, a0_run, a0_emit and a0_save. In Claude Code:
>
.pre code
<code
"claude mcp add a0 -- a0 mcp .\n
"npx skills add Joe-Simo/a0
>
>
=p The second line installs the Agent Skill, which loads the primer and the edit protocol on demand. Configurations for other agents are in the repository.
<a
+href https://github.com/Joe-Simo/a0#readme
"Configurations for other agents
>
>
}
{sec_lang
<section
+id primer
=h2 The primer
=p This is everything a model is told before it writes or edits A0. The sections below say the same thing in full.
.pre code wrap
<code
l primer
>
>
>
<section
+id programs
=h2 Programs and functions
<p
"A program is a list of functions. A function is a header\s
=code fn NAME T... -> T
", then one instruction per line\s
=code ID OP ARGS
", then\s
=code ret ARG
"\s(or\s
=code ret OP ARGS
", which names a fresh node), then\s
=code end
". Names are lowercase identifiers. Parameters are p0, p1, ... in header order. An argument is an earlier ID in the same function, a parameter, a u32 literal, true, or false. There are no forward references, no recursion, and no nested expressions.
>
.pre code
<code
.span cm
"# clamp p0 into [p1, p2]\n
>
"fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\nhi lt p2 p0\na select lo p1 p0\nr select hi p2 a\nret r\nend
>
>
>
<section
+id types
=h2 Types and values
=p u32 is an exact 32-bit unsigned integer; every arithmetic result wraps modulo 2^32. bool is true or false, never a number. Arrays u32xN and records (T,T,...) are values: get, set, at, and put return a copy, they never alias. io is a linear token, meaning every io value is used exactly once; that is what makes output order checkable.
>
<section
+id iteration
=h2 Iteration
=p A function body has no loops. Repetition is fold and loop over an earlier function: the step function receives the state, the index, and any extra arguments, and returns the next state. loop adds a predicate function that is checked before each iteration. A literal count is checked against a per-function budget when the program is checked. A variable count is bounded by fuel (a step budget) in the reference interpreter, the plain slow implementation that every target is compared with; compiled targets have no execution budget.
.pre code
<code
.span cm
"# sum of squares 0..n-1 with fold; the step is an earlier function\n
>
"fn sqstep u32 u32 -> u32\ns mul p1 p1\nr add p0 s\nret r\nend\nfn sumsq -> u32\nr fold sqstep 10 0\nret r\nend
>
>
>
<section
+id modules
=h2 Modules
<p
"A file starts with zero or more\s
=code use "path.a0"
"\slines, relative to the file. The linker loads every used file once, orders them by dependency, and checks the result as one program with one namespace. Cycles and duplicate function names are rejected, and diagnostics name the file and line.
>
.pre code
<code
"use "ui.a0"\nuse "../examples/life.a0"\nfn page io -> io\na call open p0 5\nb call close a\nret b\nend
>
>
>
}
{sec_iter
<section
+id editing
=h2 Views and edits
=p A model never sees a whole file. It asks for a view of one function: the function with a handle line on top (e0), one signature line per callee, and a program handle (g0). The program view is scoped to the target, its transitive callees and its direct callers, so it stays the same size as the program grows. The revision is a short hash of the program text; an edit written against an older revision is rejected rather than applied to code that has moved. A reply is the handle line followed by edits, one per line, as in the quick start.
.pre code
<code
.span cm
"# a view of clamp, then a reply that fixes the upper bound\n
>
"e0 fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\nhi lt p2 p0\na select lo p1 p0\nr select hi p2 a\nret r\n\n
.span cm
"# reply\n
>
"e0\nhi lt p2 a\nr select hi p2 a
>
>
>
<section
+id diagnostics
=h2 Diagnostics
=p Every rejection carries a stable code (parse, type, structure, handle, revision, limit), what was expected, what was seen, and the one fix that resolves it. The compiler never guesses: an ambiguous reply is rejected with the fix, not applied approximately.
>
}
{sec_run
<section
+id operations
=h2 Operations
.table ops
+aria-label Operations
<tr
=th Operation
=th Meaning
>
<tr
.td mono
"mov x
>
=td the value x
>
<tr
.td mono
"add sub mul a b
>
=td wrapping arithmetic modulo 2^32
>
<tr
.td mono
"and or xor a b
>
=td bitwise on two u32; logical on two bool
>
<tr
.td mono
"shl shr a n
>
=td shift by n & 31; shr is logical
>
<tr
.td mono
"div a b
>
=td unsigned quotient; b = 0 gives 4294967295
>
<tr
.td mono
"rem a b
>
=td unsigned remainder; b = 0 gives a
>
<tr
.td mono
"eq ne a b
>
=td equality on two u32 or two bool, result bool
>
<tr
.td mono
"lt le gt ge a b
>
=td unsigned comparison, result bool
>
<tr
.td mono
"select c x y
>
=td x if c else y; both are computed, so no effects inside
>
<tr
.td mono
"call F a...
>
=td call an earlier function
>
<tr
.td mono
"fold F n s a...
>
=td state = s; for i in 0..n-1: state = F(state, i, a...)
>
<tr
.td mono
"loop P F n s a...
>
=td fold that stops before iteration i when P(state, i, a...) is false
>
<tr
.td mono
"arr e... / rec e...
>
=td build an array or a record
>
<tr
.td mono
"text "..."
>
=td an array of UTF-8 bytes
>
<tr
.td mono
"get a i / set a i v
>
=td read or copy-with-update at index i mod N
>
<tr
.td mono
"at r k / put r k v
>
=td read or copy-with-update of field k (a literal)
>
<tr
.td mono
"read t / write t v / puts t a
>
=td io: read one word (0 when exhausted) as (u32,io); write one word; write length then elements
>
>
>
<section
+id bounds
=h2 Bounds and safety
=p Static caps: 65536 functions per program (also after linking), 4096 instructions per function, 64 parameters, arrays up to 65536 elements (1024 on the hardware and GPU targets), literal iteration budget 2^24 per function. io output is bounded by the caller's buffer. There is no heap, no recursion, no exceptions, and no undefined behavior: div and rem by zero are defined, shifts mask the count, indices wrap modulo the array length.
>
<section
+id cli
=h2 Targets and CLI
.pre code
<code
"a0 check <file.a0>                     # parse, type, validate; diagnostics with codes\n
"a0 run <file.a0> <fn> <args...>        # reference interpreter\n
"a0 emit <target> <file.a0> [out]      # arm64 x86_64 riscv64 arm32 avr wasm c js java sv\n
"a0 emit c --parallel[=auto\|gpu] <file.a0>  # automatic parallel folds: threads, or Metal\n
"a0 wasm <file.a0> <out.wasm>           # wasm32 through the C backend, Clang, and wasm-ld\n
"a0 view <file.a0> <fn>                 # dependency-scoped view with an edit handle\n
"a0 patch <file.a0> <patch>             # apply a revision-checked patch
>
>
=p Targets: AArch64, x86-64, 64-bit RISC-V, 32-bit ARM and AVR from A0's own code generators; wasm32 directly (emit wasm) or through C (a0 wasm); C; JavaScript; the JVM (Java source); .NET (C# source); Metal for the GPU; and clocked SystemVerilog for FPGA and ASIC. Native output exports C-ABI symbols named a0_NAME. JavaScript output is an ES module; Java output is an ordinary class. C# and Metal come from the verification tools (bun run dotnet, bun run gpu). The home page Targets section gives the verified split: which targets are checked against the reference interpreter, and on which cases.
=p --parallel makes the C backend split reductions (add, mul, and, or, xor, min, max) and element-wise array maps across threads when a cost model says the loop is large enough; --parallel=gpu also offloads to Metal when built as Objective-C. Results are the same bits as the serial program.
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
