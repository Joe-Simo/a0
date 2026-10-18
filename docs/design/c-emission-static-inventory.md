# Static C emission inventory

`results/c-emission-static-inventory.json` records a lexical census of the two
frozen C artifacts from `results/c-arena-stage.json`. Both compile the identical
original compiler implementation, S0. The checked-in legacy seed represents a
different function closure and is excluded from this comparison.

`python3 tools/c-emission-inventory.py OLD_C NEW_C` reproduces the census without
compiling or executing either artifact. The tool masks C strings and comments,
matches generated function headers, balances their braces and counts exact
ASCII bytes. It reports duplicate preprocessor definitions separately. Its
call-looking token counts describe these fixtures; they are not a general C
parser or an analysis of machine code. All input hashes are recorded.

The inventory separates public bodies, owned/ref/view variants, helpers and
bytes outside functions. The new emitter has the same owned/ref variant and
call-token counts as the old emitter. It has fewer by-value aggregate local
declarations, so an explosion of those declarations does not explain the text
growth. Common body spelling, canonical structural type names, unused parameter
statements and emitted aggregate helpers all contribute.

The separately frozen standard-optimized implementation, Sopt, is identified by
`results/c-stage-standard-optimizer.json`. The package lower bound adds its actual
C and source bytes, the portable C host/runtime/script snapshot, and the retained
frontend fixture and notices. It omits other final package metadata and is not a
complete proposed package. Even deleting every aggregate type-name token cannot
meet the unchanged seed ceiling. A private typedef experiment was therefore
deferred without modifying any emitter or generated output.

Canonical C typedefs, signatures and helper names are interoperability contracts.
Replacing them with module-local type IDs can break cross-translation-unit C++
aggregate parameter names, host headers and disjoint modules included together.
Function-local aliases of an already-declared canonical type would preserve its
identity, but still require exact byte break-even accounting and validation.
Buffering all C bodies into a new typed output representation also adds compiler
work and memory; the inventory makes no claim that this would improve total cost.

A separate lowering hypothesis is to retain a public by-value entry and share
its implementation with its existing mutable owned core. Small states with
scalar-only extras are the conservative first candidate: the public argument is
already a private C value, and no extra aggregate changes from owned to borrowed.
The reported public definition bytes are a raw upper bound before replacement
wrapper bytes, not measured savings. Large states have borrowed public inputs
and require a separate output/alias proof. Aggregate extras can introduce
first-write copies and require separate analysis.

This differs from rejected experiment
`bf7c9bc0ce193b7186a790972a9ff531a7ce71a8`, which introduced a new read-only
borrow body for every aggregate-taking function and redirected ordinary internal
calls to it, while retaining the owned cores. That changed parameter ownership
and call alias information. Its rejection remains in force. A wrapper around an
existing mutable core must preserve public signatures and callable symbols,
instrumentation and effect order, and still needs independent C/C++ ownership,
ABI and runtime checks. Static text counts establish no compilation or execution
performance improvement and authorize no default or seed change.
