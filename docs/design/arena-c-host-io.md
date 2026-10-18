# Host word streams in the arena C emitter

`compiler/emit_c_arena.a0` emits the existing buffered IO runtime by default.
The configured input/output capacities still bound array access and output;
an exhausted canonical read returns zero without advancing its position.

An embedding host can instead define both `A0_IO_READ(token, out)` and
`A0_IO_WRITE(token, word)` before including the emitted C. This follows the
public C backend's host IO contract: the caller defines `struct a0_io`, READ
returns a boolean indicating whether it supplied a word, and WRITE receives
every word. A false READ produces zero even if the hook changed `*out`.
The runtime returns the exact token pointer it received. Hooks must keep their
context live for the call.

The hook interface itself does not prohibit reentry. Generated modules that use
the existing large-aggregate arena reserve storage through `a0arena_top`; its
capacity is planned for the A0 call graph. A hook must not reenter code that
allocates from that same arena while the outer call holds it. Host-induced
recursion is outside that storage plan. Functions using C local storage do not
share this restriction.

Defining either public hook selects host IO and requires the complete pair.
The emitter does not define a buffered `struct a0_io` in that branch. Configured
buffer capacities apply to the buffered branch; a host stream owns its own
limits. `puts` sends its length prefix and every element through WRITE.

The older `A0_COMPILER_READ(token)` and `A0_COMPILER_WRITE(token, word)` hooks
remain available for existing generic arena drivers when public hooks are
absent. They retain the buffered struct ABI and may be defined independently;
the other direction keeps its buffered implementation. The compiler READ
contract supplies a word directly and has no separate end-of-input flag.
The public hook pair takes precedence when both interfaces are present.

This extension adds no source-language mode or `c_emit` flag. Existing strict
ordinary reads still refuse with status 9 before producing C: this change does
not implement a strict input-trap runtime or turn strict exhaustion into zero.
Other emitter refusal and publication rules remain unchanged.

The native regression fixture is
`test/fixtures/arena-c-metal/host-io.mjs`. It compiles C returned by the actual
A0 emitter, checks host and buffered streams, and exercises emitted generic
arena service functions against `arena_runtime.c`. These are emitter component
tests; they do not establish a new public compiler route, a source frontend
cutover, or a self-hosting fixed point.
