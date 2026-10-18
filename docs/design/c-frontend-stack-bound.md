# C frontend stack proof

The existing final-Wasm analyzer can now prove the C-derived frontend's fixed
linear-memory frames. It previously refused normally restored void-return
functions because its epilogue pattern required a final scalar result load.
Void and scalar epilogues now share the same restoration, global-access, frame
local and control-flow checks. Unknown code still refuses a proof.

[The static proof](../../results/source-frontend-c-stack.json) binds both original
artifacts and every function's frame, direct callees, cumulative bound and depth:

| Original artifact | Wasm bytes | Linked functions | Conservative linear C-stack bound |
| --- | ---: | ---: | ---: |
| Frontend with diagnostic ports | 359944 | 109 | 127888 bytes |
| Bundled MVP frontend | 359424 | 102 | 127888 bytes |

All linked functions, including libc, are checked. Independent WABT disassembly
confirms the function/frame/global/call inventories and chain arithmetic. The
synthetic controls cover mixed return types, branches around restoration,
modified frame locals, unexpected global accesses and recursion, including a
recursive private function unreachable from exports. An independent source
review found no unsafe acceptance in the extension.

The bounds conservatively sum constant frames over an acyclic direct-call
graph. They describe the linear-memory C stack per invocation, excluding the
engine's operand/call stack, heap and process RSS. Normal return restoration is
proved; a trapping invocation does not authorize subsequent instance reuse.

Both artifacts and builders retain the original 16MiB stack reservation. The
archive preserves their complete original build records and Wasm bytes; they
were not rebuilt at the analyzer commit. No smaller-stack artifact, memory
saving, execution or latency improvement is established by this proof.

A builder change needs a separately linked candidate, a fresh proof of every
function, independent source/check/spec/IR and lifecycle controls, the applicable
repository and platform gates, and RSS/latency measurements. Existing frontend
cost losses remain binding. This analyzer change does not alter the source
grammar, compiler frontend, seed or public defaults.

The [isolated relink experiment](../../results/source-frontend-c-stack-relink.json)
subsequently reproduced the original frontend from the exact retained object,
then changed only its link-time stack reservation to 131072 bytes. The final
module retains the same 127888-byte bound across all 109 linked functions.
All eleven control groups passed, including six sealed applications, exact
retained state and arena payload comparisons, frozen C emissions, allocation
refusals, lifetimes and the unchanged formatter/diagnostic companions. The
archive retains an initial fixture failure and its correction.

This establishes correctness for the recorded experiment. Its smaller linear
buffer capacities and heap offsets do not establish lower process RSS or faster
execution. Production builders and released artifacts still reserve 16MiB;
platform gates and independent RSS/latency measurements remain pending before
any adoption.

The [preregistered cost comparison](../../results/source-frontend-c-stack-cost.json)
then ran 144 fresh children across those six applications, including twelve
declared warmups. The results are mixed: frontend latency medians decreased in
three applications and increased in three; whole-child wall medians increased
in five of six. Physical peak RSS also moved in both directions, including an
increase for the parser application despite its smaller logical buffer. The
archive preserves all raw observations and the independent replay of every
metric. These measurements do not justify adopting the smaller reservation or
claiming a general speed or resident-memory improvement.
