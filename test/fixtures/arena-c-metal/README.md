# Experimental A0 C and Metal component regression

`test/arena-c-metal.test.ts` builds the repository's verified native A0 seed,
links the transitive closure of the actual `compiler/emit_metal.a0` entrypoints,
and asks that seed to parse, check and emit the component's C. Clang then builds
this component and the generic `arena_runtime.c` transport at O0 and O2, with
warnings as errors and UndefinedBehaviorSanitizer without recovery. Each test
owns and removes its temporary directory. Clang absence is the only optional
skip. There are no retained compiler binaries or installation dependencies.

Run after the ordinary TypeScript build:

```
node --test dist/test/arena-c-metal.test.js
```

The host supplies linked compiler source during bootstrap, checked table
fixtures, process invocation and independent reference oracles. These are
component tests: they do not prove that the new full-word A0 frontend or
optimizer compiled the original fixture sources. All C/Metal emission and
refusal decisions exercised by the component execute in native A0.

* `driver.c` uploads word arrays, invokes the A0 entrypoint, checks both original
  and shaped input arrays, completes the arena session and publishes bytes only
  after success. It contains no language, target, ABI or ownership decisions.
* `transport.mjs` serializes those arrays and asserts status, immutable input/IO,
  zero retained allocations, exact output length and atomic file publication.
* `semantics-c.mjs` checks 86 directed/corpus groups at O0/O2 and 14,746 execution
  rows against `tools/corpus.ts`'s independent BigInt/control-flow oracle.
* `semantics-metal.mjs` checks 86 directed/corpus groups, the reference kernel
  wrapper ABI through a token lexer, and 12,482 execution rows against the same
  independent oracle. Generated MSL runs through an explicit C++14 CPU shim.
* `controls.mjs` checks 72 groups: refusal ordering and shaped-original policy;
  unknown operations/type kinds/name bytes; integer geometry and range errors;
  allocation/output failures; configured IO capacities; large owned/ref ABI and
  arena cleanup; and node/function/name/parameter/aggregate boundaries. The
  publication failure allows a partial internal transport buffer but requires
  that no output file is published.

The CPU shim defines Metal's kernel/device/thread markers away and permits
unknown Metal attributes. It does not validate the Metal compiler, GPU
execution, address spaces, synchronization or performance. Large ABI Metal is
explicitly refused with status 14 while that implementation remains incomplete.
The reference's mapped C thread-local arena is retained only as a boundary
control, not claimed as valid Metal. Experimental C options and unsafe strict
programs also have explicit refusal controls; this package establishes neither
complete public C/Metal parity nor production routing.
